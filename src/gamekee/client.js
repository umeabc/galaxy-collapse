import { createCookieSource } from '../cookies.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export class GamekeeError extends Error {
  constructor(message, { code = 'GAMEKEE_ERROR', status = 502, httpStatus = null, endpoint = null } = {}) {
    super(message);
    this.name = 'GamekeeError';
    this.code = code;
    this.status = status;
    this.httpStatus = httpStatus;
    this.endpoint = endpoint;
  }
}

/**
 * 文章 payload 构造（纯函数，便于单测）。
 * 字段来自站点编辑页 articleForm 默认值 + savePage 实际提交形态（2026-11 抓取 bundle）。
 */
export function buildArticlePayload({
  title,
  summary = '',
  thumb = '',
  imageList = [],
  content = '',
  contentJson = '',
  editorType = 1,
  type = 4,
  tag = '2',
  gameId = '829',
}) {
  const gameIdValue = /^\d+$/.test(String(gameId)) ? Number(gameId) : String(gameId);
  return {
    title,
    summary,
    thumb,
    image_list: imageList,
    content: editorType === 0 ? content : '',
    content_json: editorType === 1 ? contentJson : '',
    editor_type: Number(editorType),
    type: Number(type),
    tag: String(tag),
    game: { game_id: gameIdValue },
    seo: { title: '', key: '', desc: '' },
    server_id: 0,
    content_type: 0,
    is_admin: 0,
    force_release: false,
    model_ids: '',
    video: null,
  };
}

export class GamekeeClient {
  constructor({
    cookieFile = '',
    cookieText = '',
    cookieStore = null,
    baseUrl = 'https://www.gamekee.com',
    gameId = '829',
    alias = 'ba',
    timeoutMs = 20000,
    fetchImpl = globalThis.fetch,
    userAgent = UA,
  } = {}) {
    this.cookieStore = cookieStore ?? createCookieSource({ text: cookieText, filePath: cookieFile, fallbackDomain: 'www.gamekee.com' });
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.gameId = String(gameId);
    this.alias = String(alias);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
  }

  cookieStatus() {
    return this.cookieStore.sessionInfo('www.gamekee.com');
  }

  _headers(extra = {}) {
    const domain = 'www.gamekee.com';
    const cookie = this.cookieStore.headerFor(domain);
    const token = this.cookieStore.get(domain, 'userToken');
    if (!cookie || !token) {
      throw new GamekeeError('AUTH_REQUIRED: GameKee cookie/token missing', { code: 'AUTH_REQUIRED', status: 401 });
    }
    const headers = {
      Cookie: cookie,
      'User-Agent': this.userAgent,
      Accept: 'application/json, text/plain, */*',
      'Access-Token': token,
      'game-id': this.gameId,
      'game-alias': this.alias,
      'device-num': '1',
      'X-Requested-With': 'XMLHttpRequest',
      'Lang': 'zh-cn',
      ...extra,
    };
    // 固定 target 头不可被 extra 覆盖。
    headers['game-id'] = this.gameId;
    headers['game-alias'] = this.alias;
    return headers;
  }

  async _request(method, path, { body = null, query = null } = {}) {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) qs.append(key, String(value));
      const suffix = qs.toString();
      if (suffix) url += `?${suffix}`;
    }
    const headers = this._headers(body !== null ? { 'Content-Type': 'application/json;charset=utf-8' } : {});
    const secrets = [headers.Cookie, headers['Access-Token']].filter(Boolean);
    for (const pair of headers.Cookie.split(';')) {
      const trimmed = pair.trim();
      if (trimmed) secrets.push(trimmed);
    }
    secrets.sort((a, b) => b.length - a.length);
    const clean = text => {
      let value = String(text);
      for (const secret of secrets) value = value.split(secret).join('[redacted]');
      return value;
    };

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GamekeeError(`GameKee request failed: ${method} ${path}`, { code: 'NETWORK_ERROR', endpoint: path });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new GamekeeError(`Invalid JSON from GameKee (${response.status})`, {
        code: 'INVALID_RESPONSE',
        httpStatus: response.status,
        endpoint: path,
      });
    }
    if (payload?.code !== 0) {
      const code = typeof payload?.code === 'string' ? clean(payload.code) : payload?.code;
      throw new GamekeeError(`GameKee API ${code}: ${clean(payload?.msg ?? 'unknown error')}`, {
        code: String(code),
        httpStatus: response.status,
        endpoint: path,
      });
    }
    return payload;
  }

  /** 新建文章：POST /v1/protected/content/add，返回 data.id（实测字段）。 */
  async addArticle(payload) {
    const response = await this._request('POST', '/v1/protected/content/add', { body: payload });
    return { contentId: response?.data?.id ?? response?.data ?? null, raw: response };
  }

  /** 修改已有文章：POST /v1/protected/content/edit（正文/标题/tag 全量覆盖）。 */
  async editArticle(id, payload) {
    const body = { ...payload, id: Number(id) };
    const response = await this._request('POST', '/v1/protected/content/edit', { body });
    return { contentId: id, raw: response };
  }

  /** 文章详情（回读校验；content 可能走 content_cdn）。 */
  async getArticle(id) {
    const response = await this._request('GET', `/v1/content/detail/${Number(id)}`);
    return response.data;
  }

  /** 删除文章（仅用于对账/回滚，需显式调用）。 */
  async deleteArticle(id) {
    return this._request('POST', '/v1/protected/content/delete', { body: { id: Number(id) } });
  }

  /** 登录态探针：protected 接口返回 0 即 cookie 有效。 */
  async myInfo() {
    const response = await this._request('GET', '/v1/protected/user/myInfo');
    return response.data;
  }

  articleUrl(contentId) {
    return `${this.baseUrl}/${this.alias}/${Number(contentId)}.html`;
  }
}

export default GamekeeClient;
