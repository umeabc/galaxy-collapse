import express from 'express';
import { AppError, truncate } from './util.js';
import { GamekeeClient } from './gamekee/client.js';
import { BiliClient } from './bili/client.js';
import { paragraphsToBlocks } from './bili/page.js';
import { materializeDraft } from './services/sync.js';
import { imagesFromMarkdown, markdownToBlocks, summaryFromMarkdown } from './convert/markdown.js';
import { reviewWithAi } from './review/ai.js';
import { fetchWithProxy } from './net/proxy.js';
import { fetchGlobalAnnouncements } from './announcements/sources.js';

const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function parseId(value, field = 'id') {
  const id = Number.parseInt(String(value), 10);
  if (!Number.isFinite(id) || id <= 0) throw new AppError(`${field} 不合法`, { code: 'INVALID_INPUT', status: 400 });
  return id;
}

function biliClients(snapshot) {
  return new BiliClient({ cookieFile: snapshot.biliCookieFile, timeoutMs: 20000 });
}

function gamekeeClient(snapshot, config) {
  return new GamekeeClient({
    cookieFile: snapshot.gamekeeCookieFile,
    cookieText: snapshot.gamekeeCookieText,
    baseUrl: config.gamekee.baseUrl,
    gameId: snapshot.gamekeeGameId,
    alias: snapshot.gamekeeAlias,
    timeoutMs: config.publishTimeoutMs,
  });
}

/** 手工输入 → B 站素材：支持 read/cv、opus、纯 ID（配合 kind）。 */
export async function fetchManualSource({ input, kind = 'auto', bili }) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new AppError('请填写 B 站链接或 ID', { code: 'INPUT_REQUIRED', status: 400 });

  let articleId = null;
  let opusUrl = null;
  let opusId = null;
  const readMatch = raw.match(/bilibili\.com\/read\/cv(\d+)/i);
  const opusMatch = raw.match(/bilibili\.com\/opus\/(\d+)/i);
  if (readMatch) articleId = readMatch[1];
  else if (opusMatch) opusId = opusMatch[1];
  else if (/^\d+$/.test(raw)) {
    if (kind === 'article') articleId = raw;
    else if (kind === 'opus') opusId = raw;
    else articleId = raw;
  } else if (/video\/(BV|av)/i.test(raw)) {
    throw new AppError('暂不支持视频链接，请使用专栏/图文动态链接', { code: 'UNSUPPORTED_SOURCE', status: 400 });
  } else {
    throw new AppError('无法识别链接，请提供 bilibili.com/read/cv<id> 或 bilibili.com/opus/<id>', { code: 'UNSUPPORTED_SOURCE', status: 400 });
  }

  if (articleId) {
    const detail = await bili.articlePage(articleId);
    return {
      sourceKey: `article:${articleId}`,
      kind: 'article',
      title: detail.title,
      author: detail.author,
      authorMid: detail.authorMid,
      url: detail.url,
      publishedAt: detail.publishedAt,
      blocks: paragraphsToBlocks(detail.paragraphs),
    };
  }

  opusUrl = `https://www.bilibili.com/opus/${opusId}`;
  const detail = await bili.opusPage(opusUrl);
  return {
    sourceKey: `opus:${opusId}`,
    kind: 'article',
    title: detail.title,
    author: detail.author,
    authorMid: detail.authorMid,
    url: detail.url || opusUrl,
    publishedAt: detail.publishedAt,
    blocks: paragraphsToBlocks(detail.paragraphs),
  };
}

export function createApiRouter({ store, settings, log, review, publish, queue, sync, announcements, config }) {
  const router = express.Router();

  router.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

  router.get('/announcements', (req, res) => {
    const schedule = announcements.getSchedule();
    const sources = store.listAnnouncementSources().map(source => ({
      ...source,
      nextSyncAt: source.enabled && schedule.autoSync
        ? (source.last_sync_at ? source.last_sync_at + schedule.intervalSeconds * 1000 : schedule.nextSyncAt || Date.now())
        : null,
    }));
    res.json({ sources, schedule, recent: store.listAnnouncementDrafts() });
  });
  router.post('/announcements/sync', wrap(async (req, res) => {
    res.json(await announcements.syncNow({ source: req.body?.source || null }));
  }));
  router.patch('/announcements/sources/:key', wrap(async (req, res) => {
    if (!store.getAnnouncementSource(req.params.key)) throw new AppError('公告源不存在', { code: 'ANNOUNCEMENT_SOURCE_NOT_FOUND', status: 404 });
    if (typeof req.body?.enabled !== 'boolean') throw new AppError('enabled 必须是布尔值', { code: 'INVALID_INPUT', status: 400 });
    res.json({ source: store.updateAnnouncementSource(req.params.key, { enabled: req.body.enabled }) });
  }));

  // 预览图片代理：B 站图片有防盗链，浏览器直连带 localhost Referer 会 403。
  // 仅允许白名单域，避免把本服务变成任意 URL 代理（SSRF）。
  router.get('/proxy/image', wrap(async (req, res) => {
    let target;
    try {
      target = new URL(String(req.query.url ?? ''));
    } catch {
      throw new AppError('图片地址不合法', { code: 'INVALID_INPUT', status: 400 });
    }
    const host = target.hostname.toLowerCase();
    const announcementImage = store.listAnnouncementDrafts({ limit: 200 }).some(draft => imagesFromMarkdown(draft.markdown).includes(target.href));
    const allowed = announcementImage || ['hdslb.com', 'bilibili.com', 'gamekee.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
    if (!/^https?:$/.test(target.protocol) || !allowed) {
      throw new AppError('不允许代理该域名的图片', { code: 'IMAGE_HOST_NOT_ALLOWED', status: 403 });
    }
    let upstream;
    try {
      upstream = await fetchWithProxy(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: host.endsWith('.gamekee.com') ? 'https://www.gamekee.com/' : announcementImage ? target.origin : 'https://www.bilibili.com/',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      }, announcementImage ? settings.getSnapshot().announcementProxy : '', publish.fetchImpl);
    } catch {
      throw new AppError('图片代理请求失败', { code: 'IMAGE_PROXY_FAILED', status: 502 });
    }
    // 跟随重定向后再次校验最终域名，避免被白名单站点重定向到内网。
    try {
      const finalHost = new URL(upstream.url || target).hostname.toLowerCase();
      const finalAllowed = (announcementImage && finalHost === host) || ['hdslb.com', 'bilibili.com', 'gamekee.com'].some(domain => finalHost === domain || finalHost.endsWith(`.${domain}`));
      if (!finalAllowed) throw new Error('redirect host not allowed');
    } catch {
      throw new AppError('图片重定向到不允许的域名', { code: 'IMAGE_HOST_NOT_ALLOWED', status: 403 });
    }
    const type = String(upstream.headers.get('content-type') || '');
    if (!upstream.ok || (type && !type.startsWith('image/'))) {
      throw new AppError('上游未返回图片', { code: 'IMAGE_PROXY_FAILED', status: 502 });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > 15 * 1024 * 1024) {
      throw new AppError('图片过大', { code: 'IMAGE_TOO_LARGE', status: 413 });
    }
    res.setHeader('Content-Type', type || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  }));

  router.get('/state', wrap(async (req, res) => {
    const snapshot = settings.getSnapshot();
    const gate = queue.gate();
    const stats = store.stats();
    const draftCounts = stats.drafts;
    let gamekeeStatus;
    let biliStatus;
    try {
      gamekeeStatus = gamekeeClient(snapshot, config).cookieStatus();
    } catch (error) {
      gamekeeStatus = { error: error?.code ?? 'UNKNOWN', valid: false };
    }
    try {
      biliStatus = biliClients(snapshot).cookieStatus();
    } catch (error) {
      biliStatus = { error: error?.code ?? 'UNKNOWN' };
    }
    res.json({
      serverTime: Date.now(),
      draftCounts,
      queueCounts: stats.queue,
      gate,
      source: {
        subscriptions: store.listSubscriptions().map(subscription => ({
          id: subscription.id,
          mid: subscription.mid,
          name: subscription.name,
          mode: subscription.mode,
          enabled: subscription.enabled,
          subscribedAt: subscription.subscribed_at,
          lastSyncAt: subscription.last_sync_at,
          lastError: subscription.last_error,
        })),
        count: store.listSubscriptions().length,
        autoSync: snapshot.sourceAutoSync,
        interval: snapshot.sourceSyncIntervalSeconds,
        lastSyncAt: snapshot.lastSyncAt,
      },
      publish: {
        autoPublish: snapshot.autoPublish,
        autoReview: snapshot.autoReview,
        editorType: snapshot.editorType,
        alias: snapshot.gamekeeAlias,
        gameId: snapshot.gamekeeGameId,
      },
      cookies: { gamekee: gamekeeStatus, bilibili: biliStatus },
      syncRunning: sync.running,
    });
  }));

  router.get('/settings', wrap(async (req, res) => {
    res.json({ values: settings.getPublic() });
  }));

  router.patch('/settings', wrap(async (req, res) => {
    const patch = req.body?.values && typeof req.body.values === 'object' ? req.body.values : req.body;
    const values = settings.update(patch ?? {});
    res.json({ values });
  }));

  router.post('/settings/test', wrap(async (req, res) => {
    const target = String(req.body?.target ?? '').trim();
    const snapshot = settings.getSnapshot();
    if (target === 'proxy') {
      const started = Date.now();
      try {
        await fetchGlobalAnnouncements({ proxy: snapshot.announcementProxy, fetchImpl: announcements.fetchImpl, todayKey: '9999-12-31', maxPages: 1 });
        return res.json({ ok: true, status: 200, elapsedMs: Date.now() - started, message: `代理可用，国际服 HTTP 200，耗时 ${Date.now() - started}ms` });
      } catch (error) {
        return res.json({ ok: false, status: error.details?.httpStatus ?? null, elapsedMs: Date.now() - started, code: error.code || 'PROXY_FAILED', message: error.code === 'ANNOUNCEMENT_PROXY_REQUIRED' ? '国际服必须在设置中配置公告代理' : '代理测试失败，请检查代理出口或源站状态' });
      }
    }
    if (target === 'gamekee') {
      try {
        const client = gamekeeClient(snapshot, config);
        const status = client.cookieStatus();
        if (!status.hasUserToken) return res.json({ ok: false, code: 'AUTH_REQUIRED', message: 'cookie 缺少 userToken', status });
        const info = await client.myInfo();
        return res.json({ ok: true, message: `登录有效${info?.username ? `：${info.username}` : ''}`, status });
      } catch (error) {
        return res.json({ ok: false, code: error?.code ?? 'ERROR', message: truncate(error?.message ?? '验证失败', 200), status: gamekeeClient(snapshot, config).cookieStatus() });
      }
    }
    if (target === 'bilibili') {
      try {
        const bili = biliClients(snapshot);
        const mid = snapshot.sourceMid || '2';
        const articles = await bili.articleList({ mid, pageSize: 1 });
        return res.json({ ok: true, message: `B 站可访问（mid=${mid}，取到 ${articles.length} 条专栏）`, status: bili.cookieStatus() });
      } catch (error) {
        return res.json({ ok: false, code: error?.code ?? 'ERROR', message: truncate(error?.message ?? 'B 站不可访问', 200) });
      }
    }
    if (target === 'ai') {
      if (!snapshot.aiBaseUrl) return res.json({ ok: false, message: 'AI_BASE_URL 未配置' });
      try {
        const result = await reviewWithAi({
          title: '连接测试',
          author: 'system',
          sourceUrl: '',
          content: '这是一条用于测试审核接口连通性的示例内容，主题为游戏攻略。',
          prompt: snapshot.aiPrompt,
          baseUrl: snapshot.aiBaseUrl,
          apiKey: snapshot.aiApiKey,
          model: snapshot.aiModel,
          minConfidence: 0,
          timeoutMs: 30000,
        });
        return res.json({ ok: true, message: `AI 返回：${result.decision}（${result.reason || '无理由'}）`, result });
      } catch (error) {
        return res.json({ ok: false, code: error?.code ?? 'AI_ERROR', message: truncate(error?.message ?? 'AI 调用失败', 200) });
      }
    }
    throw new AppError('未知的测试目标', { code: 'INVALID_INPUT', status: 400 });
  }));

  router.post('/sync', wrap(async (req, res) => {
    const subscriptionId = req.body?.subscriptionId ?? req.body?.id ?? null;
    res.json(await sync.syncNow({ reason: 'manual', subscriptionId: subscriptionId === null ? null : Number(subscriptionId) }));
  }));

  // ------------------------------------------------------------- subscriptions

  router.get('/subscriptions', wrap(async (req, res) => {
    res.json({ items: store.listSubscriptions().map(publicSubscription) });
  }));

  router.post('/subscriptions', wrap(async (req, res) => {
    const mid = String(req.body?.mid ?? '').trim();
    const mode = String(req.body?.mode ?? 'dynamic');
    if (!/^\d{1,20}$/.test(mid)) throw new AppError('B 站 UID 必须是数字', { code: 'INVALID_MID', status: 400 });
    if (!['dynamic', 'article'].includes(mode)) throw new AppError('模式必须是 dynamic 或 article', { code: 'INVALID_MODE', status: 400 });
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    const includeForwards = req.body?.includeForwards === undefined ? true : Boolean(req.body.includeForwards);
    const result = store.addSubscription({ mid, name, mode, includeForwards, subscribedAt: Date.now() });
    if (!result.created) {
      return res.status(409).json({
        error: {
          code: 'SUBSCRIPTION_EXISTS',
          message: '该账号与模式已经订阅过了',
          details: { subscription: publicSubscription(result.subscription) },
        },
      });
    }
    log.write({ level: 'info', scope: 'sync', event: 'sync.subscription_added', message: `新增订阅 ${mid}（${mode}）`, details: { subscriptionId: result.subscription.id, mid, mode } });
    res.status(201).json({ subscription: publicSubscription(result.subscription) });
  }));

  router.patch('/subscriptions/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id, 'subscription id');
    const current = store.getSubscription(id);
    if (!current) throw new AppError('订阅不存在', { code: 'SUBSCRIPTION_NOT_FOUND', status: 404 });
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim().slice(0, 60);
    if (req.body?.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
    if (req.body?.includeForwards !== undefined) patch.includeForwards = Boolean(req.body.includeForwards);
    const subscription = store.updateSubscription(id, patch);
    res.json({ subscription: publicSubscription(subscription) });
  }));

  router.delete('/subscriptions/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id, 'subscription id');
    const removed = store.deleteSubscription(id);
    if (!removed) throw new AppError('订阅不存在', { code: 'SUBSCRIPTION_NOT_FOUND', status: 404 });
    log.write({ level: 'info', scope: 'sync', event: 'sync.subscription_removed', message: `删除订阅 #${id}`, details: { subscriptionId: id } });
    res.json({ ok: true });
  }));

  router.post('/subscriptions/:id/sync', wrap(async (req, res) => {
    const id = parseId(req.params.id, 'subscription id');
    res.json(await sync.syncNow({ reason: 'manual-subscription', subscriptionId: id }));
  }));

  router.get('/logs', wrap(async (req, res) => {
    res.json({ items: log.query({
      level: req.query.level,
      scope: req.query.scope,
      q: req.query.q,
      before: req.query.before ? Number(req.query.before) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    }) });
  }));

  // ------------------------------------------------------------- drafts

  router.get('/drafts', wrap(async (req, res) => {
    const items = store.listDrafts({
      status: req.query.status || null,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    });
    res.json({ items: items.map(toDraftSummary) });
  }));

  router.get('/drafts/:id', wrap(async (req, res) => {
    const draft = mustDraft(store, req.params.id);
    const publication = store.getPublicationByDraft(draft.id);
    const preview = await publish.previewDraft(draft.id);
    res.json({ draft, publication, preview: { html: preview.html, nodes: preview.nodes, images: preview.images } });
  }));

  router.patch('/drafts/:id', wrap(async (req, res) => {
    const draft = mustDraft(store, req.params.id);
    const snapshot = settings.getSnapshot();
    const body = req.body ?? {};
    const title = body.title === undefined ? draft.title : String(body.title).trim();
    if (!title) throw new AppError('标题不能为空', { code: 'TITLE_REQUIRED', status: 400 });
    if (title.length > snapshot.maxTitleLength) throw new AppError(`标题最多 ${snapshot.maxTitleLength} 字`, { code: 'TITLE_TOO_LONG', status: 400 });
    const markdown = body.markdown === undefined ? draft.markdown : String(body.markdown);
    if (markdown.length > 200000) throw new AppError('正文过长', { code: 'CONTENT_TOO_LONG', status: 400 });

    const changed = title !== draft.title || markdown !== draft.markdown;
    const updated = store.updateDraft(draft.id, {
      title,
      markdown,
      summary: summaryFromMarkdown(markdown),
      images: imagesFromMarkdown(markdown),
      editorType: body.editorType ?? draft.editor_type,
    });

    if (changed && draft.status !== 'PUBLISHED') {
      const active = store.activeQueueItem(draft.id);
      if (active) store.updateQueueItem(active.id, { state: 'CANCELLED' });
      store.setDraftStatus(draft.id, 'DRAFT', { error: null, review: null });
    }
    res.json({ draft: store.getDraft(updated.id) });
  }));

  router.post('/drafts/:id/review', wrap(async (req, res) => {
    const id = parseId(req.params.id, 'draft id');
    res.json(await review.reviewDraft(id));
  }));

  router.post('/drafts/:id/approve', wrap(async (req, res) => {
    const draft = mustDraft(store, req.params.id);
    if (draft.status === 'PUBLISHED') throw new AppError('已发布的草稿不能再次审核', { code: 'ALREADY_PUBLISHED', status: 409 });
    const snapshot = settings.getSnapshot();
    const reviewData = {
      at: Date.now(),
      stage: 'manual',
      verdict: 'approve',
      confidence: 1,
      reason: String(req.body?.reason ?? '人工审核通过').slice(0, 200),
    };
    store.setDraftStatus(draft.id, 'APPROVED', { review: reviewData, error: null });
    log.write({ level: 'info', scope: 'review', event: 'review.manual_approve', message: `草稿 #${draft.id} 人工通过`, details: { draftId: draft.id } });
    let queueItem = null;
    if (snapshot.autoPublish) queueItem = queue.enqueue(draft.id);
    res.json({ draft: store.getDraft(draft.id), queueItem });
  }));

  router.post('/drafts/:id/reject', wrap(async (req, res) => {
    const draft = mustDraft(store, req.params.id);
    const reason = String(req.body?.reason ?? '人工拒绝').slice(0, 200);
    const active = store.activeQueueItem(draft.id);
    if (active) store.updateQueueItem(active.id, { state: 'CANCELLED' });
    store.setDraftStatus(draft.id, 'REJECTED', {
      review: { at: Date.now(), stage: 'manual', verdict: 'reject', confidence: 1, reason },
      error: null,
    });
    res.json({ draft: store.getDraft(draft.id) });
  }));

  router.post('/drafts/:id/queue', wrap(async (req, res) => {
    const draft = mustDraft(store, req.params.id);
    if (!['APPROVED', 'DRAFT', 'FAILED'].includes(draft.status)) {
      throw new AppError(`状态 ${draft.status} 不能入队`, { code: 'INVALID_STATE', status: 409 });
    }
    const item = queue.enqueue(draft.id);
    res.json({ draft: store.getDraft(draft.id), queueItem: item });
  }));

  router.post('/drafts/:id/publish', wrap(async (req, res) => {
    const draft = mustDraft(store, req.params.id);
    const result = await queue.publishDraftNow(draft.id, { force: Boolean(req.body?.force), actor: 'manual' });
    res.json({ result, draft: store.getDraft(draft.id), publication: store.getPublicationByDraft(draft.id) });
  }));

  router.get('/drafts/:id/preview', wrap(async (req, res) => {
    const draft = mustDraft(store, req.params.id);
    res.json(await publish.previewDraft(draft.id));
  }));

  // ------------------------------------------------------------- queue

  router.get('/queue', wrap(async (req, res) => {
    res.json({ items: store.listQueue({ state: req.query.state || null, limit: req.query.limit ? Number(req.query.limit) : 100 }) });
  }));

  router.post('/queue/pause', wrap(async (req, res) => {
    settings.update({ paused: true });
    res.json({ paused: true });
  }));

  router.post('/queue/resume', wrap(async (req, res) => {
    settings.update({ paused: false });
    res.json({ paused: false });
  }));

  router.post('/queue/:id/publish', wrap(async (req, res) => {
    const id = parseId(req.params.id, 'queue id');
    const result = await queue.publishNow(id, { force: Boolean(req.body?.force), actor: 'manual' });
    res.json({ result, item: store.getQueueItem(id) });
  }));

  router.post('/queue/:id/retry', wrap(async (req, res) => {
    res.json({ item: queue.retry(parseId(req.params.id, 'queue id')) });
  }));

  router.post('/queue/:id/cancel', wrap(async (req, res) => {
    res.json({ item: queue.cancel(parseId(req.params.id, 'queue id')) });
  }));

  // ------------------------------------------------------------- manual add

  router.post('/manual', wrap(async (req, res) => {
    const snapshot = settings.getSnapshot();
    const body = req.body ?? {};
    const input = body.url ?? body.id ?? '';
    const markdownInput = typeof body.markdown === 'string' ? body.markdown : '';
    let draft;

    if (!String(input).trim() && markdownInput.trim()) {
      const markdown = markdownInput;
      const title = String(body.title ?? '').trim() || deriveTextTitle(markdown);
      if (!title) throw new AppError('请填写标题', { code: 'TITLE_REQUIRED', status: 400 });
      if (title.length > snapshot.maxTitleLength) throw new AppError(`标题最多 ${snapshot.maxTitleLength} 字`, { code: 'TITLE_TOO_LONG', status: 400 });
      const post = store.upsertPost({
        sourceKey: `manual:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`,
        kind: 'manual',
        title,
        author: String(body.author ?? '').slice(0, 80),
        authorMid: '',
        url: String(body.sourceUrl ?? '').slice(0, 500),
        publishedAt: Date.now(),
        blocks: markdownToBlocks(markdown),
        markdown,
        status: 'MANUAL',
      }).post;
      draft = store.createDraft({
        postId: post.id,
        title,
        markdown,
        summary: summaryFromMarkdown(markdown),
        images: imagesFromMarkdown(markdown),
        editorType: snapshot.editorType,
        type: snapshot.gamekeeType,
        tag: snapshot.gamekeeTag,
        status: 'DRAFT',
      });
    } else {
      const bili = biliClients(snapshot);
      const item = await fetchManualSource({ input, kind: body.kind ?? 'auto', bili });
      const existingPost = store.findPostByKey(item.sourceKey);
      if (existingPost) {
        const existingDraft = store.getDraftByPost(existingPost.id);
        if (existingDraft) return res.json({ draft: existingDraft, existing: true });
      }
      draft = materializeDraft({ store, item, snapshot });
    }

    if (snapshot.autoReview) await review.reviewDraft(draft.id);
    res.status(201).json({ draft: store.getDraft(draft.id) });
  }));

  // ------------------------------------------------------------- publications / 修改已有帖子（预留）

  router.get('/publications', wrap(async (req, res) => {
    res.json({ items: store.listPublications({ limit: req.query.limit ? Number(req.query.limit) : 100 }) });
  }));

  router.post('/publications/:id/update', wrap(async (req, res) => {
    const publication = store.getPublicationById(parseId(req.params.id, 'publication id'));
    if (!publication) throw new AppError('发布记录不存在', { code: 'PUBLICATION_NOT_FOUND', status: 404 });
    const draft = store.getDraft(publication.draft_id);
    if (!draft) throw new AppError('对应的草稿已不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
    if (req.body?.markdown !== undefined || req.body?.title !== undefined) {
      const snapshot = settings.getSnapshot();
      const title = req.body?.title === undefined ? draft.title : String(req.body.title).trim();
      const markdown = req.body?.markdown === undefined ? draft.markdown : String(req.body.markdown);
      if (!title) throw new AppError('标题不能为空', { code: 'TITLE_REQUIRED', status: 400 });
      if (title.length > snapshot.maxTitleLength) throw new AppError(`标题最多 ${snapshot.maxTitleLength} 字`, { code: 'TITLE_TOO_LONG', status: 400 });
      store.updateDraft(draft.id, { title, markdown, summary: summaryFromMarkdown(markdown), images: imagesFromMarkdown(markdown) });
    }
    const result = await publish.publishDraft(draft.id, {
      mode: 'edit',
      contentId: publication.content_id,
      force: true,
      actor: 'manual-edit',
    });
    store.touchPublication(publication.content_id);
    res.json({ result, publication: store.getPublicationById(publication.id), draft: store.getDraft(draft.id) });
  }));

  router.get('/gamekee/articles/:id', wrap(async (req, res) => {
    const snapshot = settings.getSnapshot();
    const id = parseId(req.params.id, 'article id');
    try {
      const detail = await gamekeeClient(snapshot, config).getArticle(id);
      res.json({
        article: {
          id: detail?.id ?? id,
          title: detail?.title ?? '',
          auditState: detail?.audit_state ?? null,
          status: detail?.status ?? null,
          updatedAt: detail?.updated_at ?? null,
          url: gamekeeClient(snapshot, config).articleUrl(id),
        },
      });
    } catch (error) {
      throw new AppError(truncate(error?.message ?? '读取 GameKee 文章失败', 200), {
        code: error?.code ?? 'GAMEKEE_ERROR',
        status: error?.code === 'AUTH_REQUIRED' ? 401 : 502,
      });
    }
  }));

  return router;
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    mid: subscription.mid,
    name: subscription.name,
    mode: subscription.mode,
    includeForwards: subscription.include_forwards,
    enabled: subscription.enabled,
    subscribedAt: subscription.subscribed_at,
    lastSyncAt: subscription.last_sync_at,
    lastError: subscription.last_error,
  };
}

function mustDraft(store, rawId) {
  const draft = store.getDraft(parseId(rawId, 'draft id'));
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  return draft;
}

function deriveTextTitle(markdown) {
  const line = String(markdown).split('\n').map(item => item.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function toDraftSummary(draft) {
  return {
    id: draft.id,
    postId: draft.post_id,
    title: draft.title,
    status: draft.status,
    summary: draft.summary,
    images: draft.images,
    editorType: draft.editor_type,
    type: draft.type,
    tag: draft.tag,
    review: draft.review,
    sourceUrl: draft.sourceUrl,
    sourceAuthor: draft.sourceAuthor,
    sourceKind: draft.sourceKind,
    error: draft.error,
    createdAt: draft.created_at,
    updatedAt: draft.updated_at,
  };
}
