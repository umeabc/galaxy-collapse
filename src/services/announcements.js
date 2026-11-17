import { AppError, dateKeyOf, truncate } from '../util.js';
import { blocksToMarkdown, imagesFromMarkdown, markdownToBlocks, summaryFromMarkdown } from '../convert/markdown.js';
import { htmlToBlocks } from '../announcements/html.js';
import { TAG_LABELS, fetchAnnouncementSource } from '../announcements/sources.js';
import { translateAnnouncement, limitAnnouncementMarkdown } from '../announcements/translate.js';

function resolveImages(blocks, baseUrl) {
  for (const block of blocks) {
    if (block.type !== 'image' || !block.url) continue;
    try { block.url = new URL(block.url, baseUrl).href; } catch { block.url = ''; }
  }
  return blocks;
}

/**
 * 碧蓝档案三服公告：抓当天公告 → 日服/国际服 AI 翻译 → 公告草稿（type=2）→ 自动审核/入队。
 */
export class AnnouncementService {
  constructor({ store, settings, log, queue, fetchImpl = globalThis.fetch, translateImpl = translateAnnouncement }) {
    this.store = store;
    this.settings = settings;
    this.log = log;
    this.queue = queue;
    this.fetchImpl = fetchImpl;
    this.translateImpl = translateImpl;
    this.running = false;
    this.lastRunAt = 0;
  }

  /** 调度视图：下次抓取时间、间隔、是否开启定时抓取。 */
  getSchedule() {
    const snapshot = this.settings.getSnapshot();
    const intervalSeconds = Math.max(60, Number(snapshot.announcementSyncIntervalSeconds) || 900);
    const now = Date.now();
    const sources = this.store.listAnnouncementSources().map(source => ({
      ...source,
      nextSyncAt: source.enabled
        ? (source.last_sync_at ? source.last_sync_at + intervalSeconds * 1000 : now)
        : null,
    }));
    const nextSyncAt = sources.reduce((min, source) => {
      if (!source.nextSyncAt) return min;
      return min === null ? source.nextSyncAt : Math.min(min, source.nextSyncAt);
    }, null);
    return {
      autoSync: Boolean(snapshot.announcementAutoSync),
      intervalSeconds,
      running: this.running,
      lastRunAt: this.lastRunAt,
      nextSyncAt,
    };
  }

  async syncNow({ source = null, reason = 'manual', dueOnly = false } = {}) {
    if (this.running) return { skipped: true, reason: 'already_running', created: [], errors: [], sources: [] };
    this.running = true;
    try {
      const snapshot = this.settings.getSnapshot();
      const timeZone = snapshot.timeZone || 'Asia/Shanghai';
      const todayKey = dateKeyOf(Date.now(), timeZone);
      let sources = this.store.listAnnouncementSources().filter(item => item.enabled);
      if (source) {
        const one = this.store.getAnnouncementSource(source);
        if (!one) throw new AppError('公告源不存在', { code: 'ANNOUNCEMENT_SOURCE_NOT_FOUND', status: 404 });
        if (!one.enabled) throw new AppError('该公告源已暂停', { code: 'ANNOUNCEMENT_SOURCE_DISABLED', status: 409 });
        sources = [one];
      }
      if (dueOnly) sources = sources.filter(item => !item.lastSyncAt || Date.now() - item.lastSyncAt >= snapshot.announcementSyncIntervalSeconds * 1000);
      if (dueOnly && !sources.length) return { skipped: true, created: [], errors: [], sources: [] };
      if (!sources.length) throw new AppError('没有启用的公告源', { code: 'ANNOUNCEMENT_SOURCE_REQUIRED', status: 400 });
      if (dueOnly) {
        const intervalMs = Math.max(60, Number(snapshot.announcementSyncIntervalSeconds) || 900) * 1000;
        sources = sources.filter(item => !item.last_sync_at || Date.now() - item.last_sync_at >= intervalMs);
        if (!sources.length) return { skipped: true, reason: 'not_due', created: [], errors: [], sources: [] };
      }

      const results = [];
      for (const announcementSource of sources) {
        try {
          results.push(await this._syncSource(announcementSource, snapshot, todayKey, reason));
        } catch (error) {
          const message = truncate(error?.message ?? '公告同步失败', 260);
          this.store.updateAnnouncementSource(announcementSource.key, {
            lastSyncAt: Date.now(),
            lastError: message,
          });
          this.log.write({
            level: 'error',
            scope: 'sync',
            event: 'announcement.source_failed',
            message: `${announcementSource.label}公告同步失败：${message}`,
            details: { source: announcementSource.key, code: error?.code ?? null },
          });
          results.push({ source: announcementSource.key, label: announcementSource.label, created: [], errors: [{ message }] });
        }
      }
      this.lastRunAt = Date.now();
      const created = results.flatMap(result => result.created);
      const errors = results.flatMap(result => result.errors);
      this.log.write({
        level: errors.length ? 'warn' : 'info',
        scope: 'sync',
        event: 'announcement.finished',
        message: `公告同步：新草稿 ${created.length}，失败 ${errors.length}`,
        details: { reason, sources: results.map(result => ({ source: result.source, created: result.created.length, errors: result.errors.length })) },
      });
      return { skipped: false, sources: results, created, errors };
    } finally {
      this.running = false;
    }
  }

  async _syncSource(source, snapshot, todayKey, reason) {
    const fetchOptions = {
      proxy: snapshot.announcementProxy,
      fetchImpl: this.fetchImpl,
      todayKey,
      timeZone: snapshot.timeZone || 'Asia/Shanghai',
    };
    let items;
    try {
      items = await fetchAnnouncementSource(source.key, fetchOptions);
    } catch (error) {
      // 日服/国服直连通常可用；代理只是国际服必需。代理线路故障时回退直连。
      if (source.key !== 'global' && snapshot.announcementProxy && ['SOURCE_NETWORK', 'SOURCE_HTTP_ERROR', 'SOURCE_BAD_RESPONSE'].includes(error?.code)) {
        items = await fetchAnnouncementSource(source.key, { ...fetchOptions, proxy: '' });
      } else {
        throw error;
      }
    }
    const timeZone = snapshot.timeZone || 'Asia/Shanghai';
    const maxItems = Math.max(1, Number(snapshot.announcementMaxItemsPerRun) || 10);
    const fresh = [];
    for (const item of items.sort((a, b) => a.publishedAt - b.publishedAt)) {
      if (!item.publishedAt || dateKeyOf(item.publishedAt, timeZone) < todayKey) continue;
      const sourceKey = `announcement:${source.key}:${item.externalId}`;
      if (this.store.findPostByKey(sourceKey)) continue;
      item.sourceKey = sourceKey;
      fresh.push(item);
      if (fresh.length >= maxItems) break;
    }
    fresh.sort((a, b) => a.publishedAt - b.publishedAt);

    const created = [];
    const errors = [];
    for (const item of fresh) {
      try {
        const draft = await this._createDraft(source, item, snapshot);
        created.push({ draftId: draft.id, title: draft.title, source: source.key, sourceUrl: item.url });
      } catch (error) {
        const message = truncate(error?.message ?? '公告处理失败', 260);
        errors.push({ sourceKey: item.sourceKey, message });
        this.log.write({
          level: 'error',
          scope: 'sync',
          event: 'announcement.item_failed',
          message: `${source.label}公告处理失败：${message}`,
          details: { source: source.key, externalId: item.externalId, code: error?.code ?? null },
        });
      }
    }
    this.store.updateAnnouncementSource(source.key, {
      lastSyncAt: Date.now(),
      lastError: errors.length ? errors[0].message : null,
      lastCount: created.length,
    });
    this.log.write({
      level: errors.length ? 'warn' : 'info',
      scope: 'sync',
      event: 'announcement.source_finished',
      message: `${source.label}公告：新草稿 ${created.length}，失败 ${errors.length}`,
      details: { source: source.key, reason, todayKey },
    });
    return { source: source.key, label: source.label, created, errors };
  }

  async _createDraft(source, item, snapshot) {
    const parsed = htmlToBlocks(item.html, { maxImages: 30, maxChars: 30000 });
    const blocks = resolveImages(parsed.blocks, item.url);
    if (!blocks.length) throw new AppError('公告正文为空', { code: 'ANNOUNCEMENT_EMPTY' });

    let title = String(item.title || '公告').trim();
    let markdown = blocksToMarkdown(blocks);
    let translated = false;

    if (source.key !== 'cn') {
      if (!snapshot.announcementTranslate) {
        throw new AppError('日服/国际服公告需要开启 AI 翻译并配置 AI 接口', { code: 'TRANSLATE_REQUIRED', status: 400 });
      }
      const result = await this.translateImpl({
        title,
        markdown,
        sourceLabel: source.label,
        prompt: snapshot.announcementTranslatePrompt,
        baseUrl: snapshot.aiBaseUrl,
        apiKey: snapshot.aiApiKey,
        model: snapshot.aiModel,
        fetchImpl: this.fetchImpl,
      });
      title = result.title || title;
      markdown = result.markdown || markdown;
      translated = true;
    }

    const limited = limitAnnouncementMarkdown(markdown);
    markdown = limited.markdown;
    const prefix = `【${source.label}】`;
    if (!title.startsWith(prefix)) title = `${prefix}${title}`;
    title = truncate(title, snapshot.maxTitleLength);

    const footer = [
      '',
      '---',
      '',
      `来源：[${source.label}官方公告](${item.url})`,
      translated ? '> 本文由 AI 翻译整理，内容以官方原文为准。' : '',
      parsed.truncated ? '> 公告内容较长，部分内容/图片已省略，请查看原文。' : '',
    ].filter(line => line !== null).join('\n');
    markdown = `${markdown.trim()}\n${footer}`.trim();

    const autoApprove = Boolean(snapshot.announcementAutoApprove);
    const draft = this.store.db.transaction(() => {
      const post = this.store.upsertPost({
        sourceKey: item.sourceKey,
        kind: 'announcement',
        title,
        author: source.label,
        authorMid: '',
        url: item.url,
        publishedAt: item.publishedAt,
        blocks: markdownToBlocks(markdown),
        markdown,
        status: 'ANNOUNCED',
      }).post;

      const draft = this.store.createDraft({
        postId: post.id,
        title,
        markdown,
        summary: summaryFromMarkdown(markdown),
        images: imagesFromMarkdown(markdown),
        editorType: 1,
        type: 2,
        tag: String([2, 3, 4].includes(Number(item.tag)) ? Number(item.tag) : 2),
        status: autoApprove ? 'APPROVED' : 'DRAFT',
      });
      this.store.setDraftStatus(draft.id, autoApprove ? 'APPROVED' : 'DRAFT', {
        error: null,
        review: {
          at: Date.now(),
          stage: 'official',
          verdict: autoApprove ? 'approve' : 'review',
          confidence: 1,
          reason: `${source.label}官方公告${autoApprove ? '自动通过' : '等待审核'}（${TAG_LABELS[item.tag] || '公告'}）`,
        },
      });

      return this.store.getDraft(draft.id);
    })();

    this.log.write({
      level: 'info',
      scope: 'sync',
      event: 'announcement.draft_created',
      message: `公告草稿 #${draft.id}：${title}`,
      details: { source: source.key, externalId: item.externalId, tag: item.tag, translated, truncated: parsed.truncated },
    });

    if (autoApprove && snapshot.autoPublish) {
      try {
        this.queue.enqueue(draft.id);
      } catch (error) {
        this.log.write({
          level: 'warn',
          scope: 'sync',
          event: 'announcement.enqueue_failed',
          message: `公告草稿 #${draft.id} 入队失败：${truncate(error?.message ?? error, 160)}`,
          details: { draftId: draft.id, code: error?.code ?? null },
        });
      }
    }
    return this.store.getDraft(draft.id);
  }
}
