import { AppError, truncate, zonedParts } from '../util.js';
import { checkSchedule } from './schedule.js';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 300000;

/** 队列：审核通过 → 排队 → 按窗口/日限/间隔发布；失败退避重试。 */
export class QueueService {
  constructor({ store, settings, log, publish, tickIntervalMs = 2000 }) {
    this.store = store;
    this.settings = settings;
    this.log = log;
    this.publish = publish;
    this.tickIntervalMs = tickIntervalMs;
    this.timer = null;
    this.ticking = false;
  }

  enqueue(draftId) {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
    if (['REJECTED', 'PUBLISHING'].includes(draft.status)) {
      throw new AppError(`草稿状态 ${draft.status} 不能加入队列`, { code: 'INVALID_STATE', status: 409 });
    }
    if (draft.status === 'PUBLISHED') {
      throw new AppError('已发布的草稿不能重复加入队列', { code: 'ALREADY_PUBLISHED', status: 409 });
    }
    const item = this.store.enqueue(draftId);
    if (draft.status !== 'QUEUED') this.store.setDraftStatus(draftId, 'QUEUED');
    this.log.write({ level: 'info', scope: 'queue', event: 'queue.enqueued', message: `草稿 #${draftId} 已入队`, details: { draftId, queueId: item.id } });
    return this.store.getQueueItem(item.id);
  }

  gate() {
    return checkSchedule({ settings: this.settings, store: this.store });
  }

  async publishDraftNow(draftId, { force = false, actor = 'manual' } = {}) {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
    if (draft.status === 'PUBLISHED') throw new AppError('该草稿已发布', { code: 'ALREADY_PUBLISHED', status: 409 });
    const gate = this.gate();
    if (!gate.allowed && !force) throw new AppError(gate.reason, { code: gate.code, status: 429, details: gate.details });
    const item = this.store.activeQueueItem(draftId) ?? this.store.enqueue(draftId);
    return this.publishNow(item.id, { force: true, actor });
  }

  async publishNow(queueId, { force = false, actor = 'manual' } = {}) {
    const item = this.store.getQueueItem(queueId);
    if (!item) throw new AppError('队列项不存在', { code: 'QUEUE_NOT_FOUND', status: 404 });
    if (item.state === 'PUBLISHED') throw new AppError('该队列项已发布', { code: 'ALREADY_PUBLISHED', status: 409 });
    if (item.state === 'PUBLISHING') throw new AppError('该队列项正在发布中', { code: 'PUBLISHING', status: 409 });
    const gate = this.gate();
    if (!gate.allowed && !force) throw new AppError(gate.reason, { code: gate.code, status: 429, details: gate.details });
    if (item.state !== 'QUEUED') this.store.updateQueueItem(queueId, { state: 'QUEUED', nextAttemptAt: 0 });
    if (!this.store.claimQueueItem(queueId)) throw new AppError('无法认领队列项（状态已变化）', { code: 'CLAIM_FAILED', status: 409 });
    return this._execute(queueId, item.draft_id, actor);
  }

  async _execute(queueId, draftId, actor) {
    try {
      const result = await this.publish.publishDraft(draftId, { mode: 'new', force: true, actor });
      const { dateKey } = zonedParts(new Date(), this.settings.get('timeZone'));
      this.store.updateQueueItem(queueId, {
        state: 'PUBLISHED',
        contentId: result.contentId ?? null,
        publishedAt: Date.now(),
        publishedDay: dateKey,
        lastError: null,
      });
      this.store.setDraftStatus(draftId, 'PUBLISHED', { error: null });
      return result;
    } catch (error) {
      const current = this.store.getQueueItem(queueId);
      const attempts = (current?.attempts ?? 0) + 1;
      const message = truncate(error?.message ?? '发布失败', 300);
      const fatal = error?.code === 'AUTH_REQUIRED' || attempts >= MAX_ATTEMPTS;
      if (fatal) {
        this.store.updateQueueItem(queueId, { state: 'FAILED', attempts, lastError: message });
        this.store.setDraftStatus(draftId, 'FAILED', { error: message });
        this.log.write({ level: 'error', scope: 'queue', event: 'queue.failed', message: `发布失败（${attempts} 次）：${message}`, details: { queueId, draftId, code: error?.code ?? null } });
      } else {
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * attempts);
        this.store.updateQueueItem(queueId, { state: 'QUEUED', attempts, lastError: message, nextAttemptAt: Date.now() + delay });
        this.store.setDraftStatus(draftId, 'QUEUED', { error: message });
        this.log.write({ level: 'warn', scope: 'queue', event: 'queue.retry', message: `发布失败，${Math.round(delay / 1000)} 秒后重试：${message}`, details: { queueId, draftId, attempts } });
      }
      throw error;
    }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const snapshot = this.settings.getSnapshot();
      if (!snapshot.autoPublish || snapshot.paused) return;
      const gate = this.gate();
      if (!gate.allowed) return;
      const item = this.store.dueQueueItem(Date.now());
      if (!item) return;
      if (!this.store.claimQueueItem(item.id)) return;
      try {
        await this._execute(item.id, item.draft_id, 'auto');
      } catch {
        // 失败已落库并写日志；下一 tick 继续。
      }
    } finally {
      this.ticking = false;
    }
  }

  retry(queueId) {
    const item = this.store.getQueueItem(queueId);
    if (!item) throw new AppError('队列项不存在', { code: 'QUEUE_NOT_FOUND', status: 404 });
    if (item.state === 'PUBLISHED') throw new AppError('已发布的队列项不能重试', { code: 'INVALID_STATE', status: 409 });
    this.store.updateQueueItem(queueId, { state: 'QUEUED', nextAttemptAt: 0, lastError: null });
    this.store.setDraftStatus(item.draft_id, 'QUEUED', { error: null });
    return this.store.getQueueItem(queueId);
  }

  cancel(queueId) {
    const item = this.store.getQueueItem(queueId);
    if (!item) throw new AppError('队列项不存在', { code: 'QUEUE_NOT_FOUND', status: 404 });
    if (item.state === 'PUBLISHED') throw new AppError('已发布的队列项不能取消', { code: 'INVALID_STATE', status: 409 });
    this.store.updateQueueItem(queueId, { state: 'CANCELLED' });
    this.store.setDraftStatus(item.draft_id, 'APPROVED', { error: null });
    return this.store.getQueueItem(queueId);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
