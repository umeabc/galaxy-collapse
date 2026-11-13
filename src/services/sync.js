import { AppError, truncate } from '../util.js';
import { blocksToMarkdown, imagesFromMarkdown, summaryFromMarkdown } from '../convert/markdown.js';
import { paragraphsToBlocks } from '../bili/page.js';
import { extractArticleItem, extractDynamicItem } from '../bili/extract.js';

const MAX_FEED_PAGES = 20;
const MAX_ARTICLE_PAGES = 10;

/** 转载声明：来源与原文链接必须保留，便于目标站审核与读者回溯。 */
export function buildDraftMarkdown({ blocks, author, url, includeAttribution = true }) {
  const body = blocksToMarkdown(blocks ?? []);
  const attribution = url
    ? `本文转载自 B 站${author ? ` @${author}` : ''}，[原文链接](${url})。`
    : '';
  return [body, includeAttribution ? attribution : ''].filter(Boolean).join('\n\n').trim();
}

/** 把统一素材落库为 post + draft（同步与手工加入共用）。 */
export function materializeDraft({ store, item, snapshot }) {
  const post = store.upsertPost({
    sourceKey: item.sourceKey,
    kind: item.kind,
    title: item.title || '未命名',
    author: item.author || '',
    authorMid: item.authorMid || '',
    url: item.url || '',
    publishedAt: item.publishedAt ?? null,
    blocks: item.blocks ?? [],
    markdown: '',
    status: 'FETCHED',
  }).post;
  const markdown = buildDraftMarkdown({
    blocks: item.blocks,
    author: post.author,
    url: post.url,
    includeAttribution: snapshot.includeAttribution,
  });
  if (!markdown) throw new AppError('正文为空（可能被风控或内容不可见）', { code: 'EMPTY_CONTENT' });
  return store.createDraft({
    postId: post.id,
    title: truncate(post.title || '未命名', snapshot.maxTitleLength),
    markdown,
    summary: summaryFromMarkdown(markdown),
    images: imagesFromMarkdown(markdown),
    editorType: snapshot.editorType,
    type: snapshot.gamekeeType,
    tag: snapshot.gamekeeTag,
    status: 'DRAFT',
  });
}

/**
 * 老版本只有单个 sourceMid 配置：首次启动时迁移成一个「从现在开始」的订阅，
 * 然后清空旧字段，避免每次启动重复创建。
 */
export function migrateLegacySubscription({ store, settings, log }) {
  if (!store || !settings) return null;
  if (store.listSubscriptions().length) return null;
  const snapshot = settings.getSnapshot();
  if (!snapshot.sourceMid) return null;
  const { subscription } = store.addSubscription({
    mid: snapshot.sourceMid,
    name: snapshot.sourceName || '',
    mode: snapshot.sourceMode || 'dynamic',
    includeForwards: true,
    subscribedAt: Date.now(),
  });
  settings.update({ sourceMid: '', sourceName: '' });
  log?.write?.({
    level: 'info',
    scope: 'sync',
    event: 'sync.legacy_migrated',
    message: `已将旧配置迁移为订阅：mid=${subscription.mid}（从迁移时刻开始抓取）`,
    details: { subscriptionId: subscription.id, mid: subscription.mid, mode: subscription.mode },
  });
  return subscription;
}

/** 抓取订阅账号：只处理「订阅时间之后」的动态/专栏，全部进入草稿流程。 */
export class SyncService {
  constructor({ store, settings, review, log, biliFactory, config }) {
    this.store = store;
    this.settings = settings;
    this.review = review;
    this.log = log;
    this.biliFactory = biliFactory;
    this.config = config;
    this.running = false;
    this.lastRunAt = 0;
  }

  /**
   * @param {{reason?: string, subscriptionId?: number|null, dueOnly?: boolean}} options
   */
  async syncNow({ reason = 'manual', subscriptionId = null, dueOnly = false } = {}) {
    if (this.running) return { skipped: true, reason: 'already_running', created: [], errors: [], subscriptions: [] };
    this.running = true;
    try {
      const snapshot = this.settings.getSnapshot();
      let subscriptions = this.store.listSubscriptions({ enabledOnly: true });
      if (subscriptionId !== null && subscriptionId !== undefined) {
        const one = this.store.getSubscription(Number(subscriptionId));
        if (!one) throw new AppError('订阅不存在', { code: 'SUBSCRIPTION_NOT_FOUND', status: 404 });
        if (!one.enabled) throw new AppError('该订阅已暂停', { code: 'SUBSCRIPTION_DISABLED', status: 409 });
        subscriptions = [one];
      }
      if (!subscriptions.length) {
        throw new AppError('还没有订阅账号：请到「设置 → 订阅账号」添加', { code: 'SUBSCRIPTION_REQUIRED', status: 400 });
      }
      if (dueOnly) subscriptions = subscriptions.filter(subscription => this._isDue(subscription, snapshot));
      if (!subscriptions.length) {
        return { skipped: true, reason: 'not_due', created: [], errors: [], subscriptions: [] };
      }

      const results = [];
      for (const subscription of subscriptions) {
        try {
          results.push(await this._syncOne(subscription, snapshot, reason));
        } catch (error) {
          const message = truncate(error?.message ?? '同步失败', 240);
          this.store.touchSubscription(subscription.id, { lastSyncAt: Date.now(), lastError: message });
          this.log.write({
            level: 'error',
            scope: 'sync',
            event: 'sync.subscription_failed',
            message: `订阅 ${subscription.mid} 同步失败：${message}`,
            details: { subscriptionId: subscription.id, code: error?.code ?? null },
          });
          results.push({
            subscriptionId: subscription.id,
            mid: subscription.mid,
            name: subscription.name,
            mode: subscription.mode,
            candidates: 0,
            created: [],
            errors: [{ sourceKey: null, message }],
            truncated: false,
          });
        }
      }

      this.settings.update({ lastSyncAt: Date.now() });
      this.lastRunAt = Date.now();
      const created = results.flatMap(result => result.created);
      const errors = results.flatMap(result => result.errors);
      const candidates = results.reduce((sum, result) => sum + result.candidates, 0);
      const truncated = results.some(result => result.truncated);
      this.log.write({
        level: errors.length ? 'warn' : 'info',
        scope: 'sync',
        event: 'sync.finished',
        message: `同步完成：订阅 ${results.length} 个，新草稿 ${created.length}，失败 ${errors.length}${truncated ? '（本轮达到上限，剩余内容下次继续）' : ''}`,
        details: { reason, subscriptions: results.map(result => ({ mid: result.mid, mode: result.mode, created: result.created.length, errors: result.errors.length })) },
      });
      return { skipped: false, subscriptions: results, candidates, created, errors, truncated };
    } finally {
      this.running = false;
    }
  }

  _isDue(subscription, snapshot) {
    if (!subscription.enabled) return false;
    const intervalMs = Math.max(60, Number(snapshot.sourceSyncIntervalSeconds) || 600) * 1000;
    const last = subscription.last_sync_at || 0;
    return !last || Date.now() - last >= intervalMs;
  }

  async _syncOne(subscription, snapshot, reason) {
    const bili = this.biliFactory(snapshot);
    const since = Number(subscription.subscribed_at) || 0;
    const cap = Math.max(1, Number(snapshot.syncMaxNewPerRun) || 50);
    const collected = subscription.mode === 'article'
      ? await this._collectArticles(bili, subscription, since, cap)
      : await this._collectDynamics(bili, subscription, since, cap);

    const created = [];
    const errors = [];
    for (const item of collected.items) {
      try {
        const hydrated = await this._hydrate(bili, item);
        const draft = materializeDraft({ store: this.store, item: hydrated, snapshot });
        this.log.write({
          level: 'info',
          scope: 'sync',
          event: 'sync.draft_created',
          message: `新草稿 #${draft.id}：${draft.title}`,
          details: { subscriptionId: subscription.id, mid: subscription.mid, sourceKey: item.sourceKey },
        });
        if (snapshot.autoReview) await this.review.reviewDraft(draft.id);
        created.push({ draftId: draft.id, sourceKey: item.sourceKey, title: draft.title });
      } catch (error) {
        const message = truncate(error?.message ?? '抓取失败', 240);
        errors.push({ sourceKey: item.sourceKey, message });
        this.log.write({
          level: 'error',
          scope: 'sync',
          event: 'sync.item_failed',
          message: `${item.sourceKey}: ${message}`,
          details: { subscriptionId: subscription.id, code: error?.code ?? null },
        });
      }
    }

    const lastError = errors.length ? truncate(errors[0].message, 240) : null;
    this.store.touchSubscription(subscription.id, { lastSyncAt: Date.now(), lastError });
    this.log.write({
      level: errors.length ? 'warn' : 'info',
      scope: 'sync',
      event: 'sync.subscription_finished',
      message: `订阅 ${subscription.name || subscription.mid}：新草稿 ${created.length}，失败 ${errors.length}${collected.truncated ? '，达到单轮上限' : ''}`,
      details: { subscriptionId: subscription.id, mid: subscription.mid, mode: subscription.mode, reason, since },
    });
    return {
      subscriptionId: subscription.id,
      mid: subscription.mid,
      name: subscription.name,
      mode: subscription.mode,
      candidates: collected.items.length,
      created,
      errors,
      truncated: collected.truncated,
    };
  }

  /**
   * 动态抓取：从最新一页向前翻，直到出现早于订阅时间的动态。
   * 已存在的帖子不计入单轮上限，保证「续跑」能继续往更早的区间推进。
   */
  async _collectDynamics(bili, subscription, since, cap) {
    const out = [];
    let offset = '';
    let truncated = false;
    for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
      const feed = await bili.dynamicFeed({ mid: subscription.mid, offset });
      if (!feed.items.length) break;
      let lastTimestamp = null;
      for (const raw of feed.items) {
        const item = extractDynamicItem(raw, { includeForwards: subscription.include_forwards });
        if (!item || !item.publishedAt) continue;
        lastTimestamp = item.publishedAt;
        // 直播推荐/广告等没有可发布正文的动态直接跳过，避免制造失败草稿。
        if (!item.blocks?.length && !item.hydrateUrl) continue;
        if (item.publishedAt < since) continue;
        if (this.store.findPostByKey(item.sourceKey)) continue;
        out.push(item);
        if (out.length >= cap) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      if (lastTimestamp !== null && lastTimestamp < since) break;
      if (!feed.offset) break;
      offset = feed.offset;
    }
    out.sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));
    return { items: out, truncated };
  }

  async _collectArticles(bili, subscription, since, cap) {
    const out = [];
    let truncated = false;
    for (let page = 1; page <= MAX_ARTICLE_PAGES; page += 1) {
      const articles = await bili.articleList({ mid: subscription.mid, page, pageSize: 20 });
      if (!articles.length) break;
      let lastTimestamp = null;
      for (const article of articles) {
        const timestamp = Number(article.publish_time) ? Number(article.publish_time) * 1000 : 0;
        if (timestamp) lastTimestamp = timestamp;
        if (!timestamp || timestamp < since) continue;
        const item = extractArticleItem(article);
        if (!item) continue;
        if (this.store.findPostByKey(item.sourceKey)) continue;
        out.push(item);
        if (out.length >= cap) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      if (lastTimestamp !== null && lastTimestamp < since) break;
    }
    out.sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));
    return { items: out, truncated };
  }

  async _hydrate(bili, item) {
    if (item.kind === 'article' && item.articleId) {
      const detail = await bili.articlePage(item.articleId);
      return {
        ...item,
        title: detail.title || item.title,
        author: detail.author || item.author,
        authorMid: detail.authorMid || item.authorMid,
        url: detail.url || item.url,
        publishedAt: detail.publishedAt ?? item.publishedAt,
        blocks: paragraphsToBlocks(detail.paragraphs),
      };
    }
    if (item.hydrateUrl) {
      try {
        const detail = await bili.opusPage(item.hydrateUrl);
        const hydratedBlocks = paragraphsToBlocks(detail.paragraphs);
        return {
          ...item,
          title: detail.title || item.title,
          author: detail.author || item.author,
          authorMid: detail.authorMid || item.authorMid,
          url: detail.url || item.url,
          publishedAt: detail.publishedAt ?? item.publishedAt,
          blocks: item.forwardPrefix ? [...item.forwardPrefix, ...hydratedBlocks] : hydratedBlocks,
        };
      } catch (error) {
        this.log.write({
          level: 'warn',
          scope: 'sync',
          event: 'sync.hydrate_fallback',
          message: `全文抓取失败，使用动态摘要：${truncate(error?.message ?? error, 160)}`,
          details: { sourceKey: item.sourceKey, code: error?.code ?? null },
        });
      }
    }
    return item;
  }
}
