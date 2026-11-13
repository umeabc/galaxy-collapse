import { AppError, mapLimit, truncate } from '../util.js';
import { imagesFromMarkdown } from '../convert/markdown.js';
import { buildHtml, buildSlate } from '../convert/slate.js';
import { buildArticlePayload, GamekeeClient } from '../gamekee/client.js';
import { editorCdnUrl, ObsUploader, parseImageSize } from '../gamekee/obs.js';
import { checkSchedule } from './schedule.js';

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGES = 30;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function refererFor(url) {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('hdslb.com') || host.endsWith('bilibili.com')) return 'https://www.bilibili.com/';
  } catch {
    return null;
  }
  return null;
}

/** 图片下载 → OBS → 编辑器 CDN 地址；发布与预览共用同一套解析。 */
export class PublishService {
  constructor({ store, settings, log, config, fetchImpl = globalThis.fetch, gamekeeFactory = null }) {
    this.store = store;
    this.settings = settings;
    this.log = log;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.gamekeeFactory = gamekeeFactory ?? (snapshot => new GamekeeClient({
      cookieFile: snapshot.gamekeeCookieFile,
      cookieText: snapshot.gamekeeCookieText,
      baseUrl: config.gamekee.baseUrl,
      gameId: snapshot.gamekeeGameId,
      alias: snapshot.gamekeeAlias,
      timeoutMs: config.publishTimeoutMs,
    }));
  }

  async downloadImage(url) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          ...(refererFor(url) ? { Referer: refererFor(url) } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.config.publishTimeoutMs),
      });
    } catch {
      throw new AppError(`图片下载失败（网络）：${truncate(url, 120)}`, { code: 'IMAGE_DOWNLOAD_FAILED', status: 502 });
    }
    if (!response.ok) {
      throw new AppError(`图片下载失败：HTTP ${response.status}`, { code: 'IMAGE_DOWNLOAD_FAILED', status: 502 });
    }
    const type = String(response.headers.get('content-type') || '');
    if (type && !type.startsWith('image/')) {
      throw new AppError('图片地址返回的不是图片（可能被防盗链拦截）', { code: 'IMAGE_NOT_IMAGE', status: 502 });
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_IMAGE_BYTES) {
      throw new AppError('图片超过 30MB 上限', { code: 'IMAGE_TOO_LARGE', status: 413 });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new AppError('图片超过 30MB 上限', { code: 'IMAGE_TOO_LARGE', status: 413 });
    }
    return buffer;
  }

  /** @returns {Promise<Map<string,{cdnUrl:string,width:number,height:number}>>} */
  async ensureMedia(urls, gamekee) {
    const map = new Map();
    if (!urls.length) return map;
    if (urls.length > MAX_IMAGES) {
      throw new AppError(`草稿包含 ${urls.length} 张图片，超过 ${MAX_IMAGES} 张上限`, { code: 'TOO_MANY_IMAGES', status: 400 });
    }
    const uid = gamekee.cookieStore.get('www.gamekee.com', 'userUid');
    if (!uid) throw new AppError('GameKee cookie 缺少 userUid', { code: 'AUTH_REQUIRED', status: 401 });

    const uploader = new ObsUploader({
      cookieStore: gamekee.cookieStore,
      timeoutMs: this.config.publishTimeoutMs,
      fetchImpl: this.fetchImpl,
    });

    const resolved = await mapLimit(urls, 2, async url => {
      const cached = this.store.getMedia(url);
      if (cached) return { url, cdnUrl: editorCdnUrl(cached.cdn_url), width: cached.width, height: cached.height, cached: true };
      const buffer = await this.downloadImage(url);
      const size = parseImageSize(buffer);
      if (!size) throw new AppError('无法识别图片格式/尺寸', { code: 'IMAGE_UNSUPPORTED', status: 415 });
      const ext = size.format === 'jpeg' ? 'jpg' : size.format;
      const uploaded = await uploader.upload(buffer, { uid, ext, width: size.width, height: size.height });
      this.store.putMedia({ sourceUrl: url, cdnUrl: uploaded.url, width: size.width, height: size.height, bytes: uploaded.bytes });
      return { url, cdnUrl: editorCdnUrl(uploaded.url), width: size.width, height: size.height, cached: false };
    });

    for (const entry of resolved) map.set(entry.url, { cdnUrl: entry.cdnUrl, width: entry.width, height: entry.height });
    return map;
  }

  /** 供预览使用：不下载、不上传；B 站图片走本服务代理以绕过防盗链。 */
  previewMedia(urls) {
    const map = new Map();
    for (const url of urls) {
      const cached = this.store.getMedia(url);
      if (cached) map.set(url, { cdnUrl: cached.cdn_url, width: cached.width, height: cached.height });
      else map.set(url, { cdnUrl: `/api/proxy/image?url=${encodeURIComponent(url)}`, width: 800, height: 600 });
    }
    return map;
  }

  async buildContent(draft, gamekee) {
    const urls = imagesFromMarkdown(draft.markdown);
    const imageMap = await this.ensureMedia(urls, gamekee);
    const slate = buildSlate(draft.markdown, { imageMap });
    if (slate.missingImages.length) {
      throw new AppError('部分图片无法转换到 GameKee CDN', {
        code: 'IMAGE_RESOLVE_FAILED',
        status: 502,
        details: { missing: slate.missingImages.slice(0, 5) },
      });
    }
    const html = draft.editor_type === 0 ? buildHtml(draft.markdown, { imageMap }) : null;
    const cdnUrls = [...imageMap.values()].map(entry => entry.cdnUrl);
    return { slate, html, cdnUrls };
  }

  async publishDraft(draftId, { mode = 'new', contentId = null, force = false, actor = 'manual' } = {}) {
    const snapshot = this.settings.getSnapshot();
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
    if (mode === 'new' && draft.status === 'PUBLISHED') {
      throw new AppError('该草稿已发布，如需修改请使用「更新已发布文章」', { code: 'ALREADY_PUBLISHED', status: 409 });
    }
    if (mode === 'edit' && !contentId) {
      throw new AppError('缺少要修改的 GameKee 文章 ID', { code: 'CONTENT_ID_REQUIRED', status: 400 });
    }

    if (!force) {
      const gate = checkSchedule({ settings: this.settings, store: this.store });
      if (!gate.allowed) {
        throw new AppError(gate.reason, { code: gate.code, status: 429, details: gate.details });
      }
    }

    const title = String(draft.title ?? '').trim();
    if (!title) throw new AppError('标题不能为空', { code: 'TITLE_REQUIRED', status: 400 });
    if (title.length > snapshot.maxTitleLength) {
      throw new AppError(`标题超过 ${snapshot.maxTitleLength} 字`, { code: 'TITLE_TOO_LONG', status: 400 });
    }

    const gamekee = this.gamekeeFactory(snapshot);
    const status = gamekee.cookieStatus();
    if (!status.hasUserToken || !status.hasObsParams) {
      throw new AppError('GameKee 登录 cookie 缺失或失效（需要 userToken / userUid / obs_client_params）', {
        code: 'AUTH_REQUIRED',
        status: 401,
        details: { hasUserToken: status.hasUserToken, hasObsParams: status.hasObsParams, error: status.error },
      });
    }

    const { slate, html, cdnUrls } = await this.buildContent(draft, gamekee);
    const payload = buildArticlePayload({
      title,
      summary: draft.summary,
      thumb: cdnUrls.slice(0, 3).join(','),
      imageList: cdnUrls,
      content: html?.html ?? '',
      contentJson: JSON.stringify(slate.nodes),
      editorType: draft.editor_type,
      type: draft.type,
      tag: draft.tag,
      gameId: snapshot.gamekeeGameId,
    });

    let result;
    try {
      result = mode === 'edit'
        ? await gamekee.editArticle(contentId, payload)
        : await gamekee.addArticle(payload);
    } catch (error) {
      this.log.write({
        level: 'error',
        scope: 'publish',
        event: 'publish.failed',
        message: truncate(error?.message ?? '发布失败', 200),
        details: { draftId, mode, code: error?.code ?? null, contentId },
      });
      throw error;
    }

    const newContentId = result.contentId ?? contentId;
    const url = newContentId ? gamekee.articleUrl(newContentId) : '';
    if (newContentId) {
      this.store.recordPublication({ draftId, contentId: newContentId, url, state: 'PUBLISHED' });
    } else {
      this.log.write({
        level: 'warn',
        scope: 'publish',
        event: 'publish.no_content_id',
        message: 'GameKee 未返回文章 ID，请到站点核对后再补记录',
        details: { draftId, mode },
      });
    }
    this.store.setDraftStatus(draftId, 'PUBLISHED', { error: null });
    this.log.write({
      level: 'info',
      scope: 'publish',
      event: mode === 'edit' ? 'publish.updated' : 'publish.ok',
      message: `已${mode === 'edit' ? '更新' : '发布'} GameKee 文章${newContentId ? ` #${newContentId}` : ''}（${actor}）`,
      details: { draftId, contentId: newContentId, url, images: cdnUrls.length, editorType: draft.editor_type },
    });
    return { contentId: newContentId, url, editorType: draft.editor_type, images: cdnUrls.length };
  }

  async previewDraft(draftId) {
    const draft = this.store.getDraft(draftId);
    if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
    const urls = imagesFromMarkdown(draft.markdown);
    const imageMap = this.previewMedia(urls);
    const slate = buildSlate(draft.markdown, { imageMap });
    return {
      title: draft.title,
      markdown: draft.markdown,
      images: urls,
      nodes: slate.nodes,
      html: buildHtml(draft.markdown, { imageMap }).html,
    };
  }
}
