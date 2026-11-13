import { CookieJar } from '../cookies.js';
import { sleep } from '../util.js';
import { signParams, wbiKeysFromNav } from './wbi.js';
import { extractInitialState, parseOpusDetail } from './page.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const WEB = 'https://www.bilibili.com';

export class BiliError extends Error {
  constructor(message, { code = 'BILI_ERROR', status = 502, hint = null } = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

function isBiliHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'bilibili.com' || value.endsWith('.bilibili.com');
}

/**
 * B 站只读客户端。
 * 匿名可用：动态空间流需要 WBI 签名 + buvid 指纹；专栏列表与 opus 页面匿名可读。
 * 配置 cookie 文件（SESSDATA 等）可提高成功率并访问登录可见内容。
 */
export class BiliClient {
  constructor({ cookieFile = '', timeoutMs = 20000, fetchImpl = globalThis.fetch, userAgent = UA } = {}) {
    this.jar = new CookieJar(cookieFile, { fallbackDomain: '.bilibili.com' });
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.extraCookies = new Map();
    this.wbi = { key: null, at: 0 };
    this.lastCallAt = 0;
    this.minIntervalMs = 350;
  }

  _cookieHeader(host) {
    const fromFile = this.jar.headerFor(host);
    const extras = [...this.extraCookies.entries()].map(([name, value]) => `${name}=${value}`);
    return [fromFile, ...extras].filter(Boolean).join('; ');
  }

  _rememberCookies(response) {
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of setCookies) {
      const pair = String(line).split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (['buvid3', 'buvid4', 'b_nut', 'b_lsid'].includes(name)) this.extraCookies.set(name, value);
    }
  }

  async _throttle() {
    const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  async _fetch(url, { headers = {}, retries = 2 } = {}) {
    const host = new URL(url).host;
    const cookie = isBiliHost(host) ? this._cookieHeader(host) : '';
    let attempt = 0;
    for (;;) {
      await this._throttle();
      let response;
      try {
        response = await this.fetchImpl(url, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt++ < retries) {
          await sleep(800 * attempt);
          continue;
        }
        throw new BiliError('Bilibili request failed (network/timeout)', { code: 'BILI_NETWORK', status: 504 });
      }
      this._rememberCookies(response);
      if (response.status >= 500 && attempt++ < retries) {
        await sleep(800 * attempt);
        continue;
      }
      return response;
    }
  }

  async _json(url, { referer = WEB, retries = 2, allowCodes = [] } = {}) {
    const response = await this._fetch(url, { headers: { Referer: referer }, retries });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new BiliError('Bilibili returned a non-JSON page (risk control or blocked)', {
        code: 'BILI_RISK_CONTROL',
        status: 502,
        hint: '配置 BILI_COOKIE_FILE（浏览器导出的 Netscape cookie，含 SESSDATA/buvid3）后重试',
      });
    }
    if (payload?.code !== 0 && !allowCodes.includes(payload?.code)) {
      const code = `BILI_${payload?.code}`;
      const hint = [-352, -412, -509].includes(payload?.code)
        ? '触发风控：稍后重试，或配置 BILI_COOKIE_FILE 提高成功率'
        : null;
      throw new BiliError(`Bilibili API error ${payload?.code}: ${payload?.message ?? ''}`.trim(), {
        code,
        status: 502,
        hint,
      });
    }
    return payload.data;
  }

  async ensureFingerprint() {
    if (this.extraCookies.has('buvid3')) return;
    try {
      const data = await this._json(`${API}/x/frontend/finger/spi`, { referer: 'https://www.bilibili.com/' });
      if (data?.b_3) this.extraCookies.set('buvid3', data.b_3);
      if (data?.b_4) this.extraCookies.set('buvid4', data.b_4);
      this.extraCookies.set('b_nut', String(Math.floor(Date.now() / 1000)));
    } catch {
      // 指纹失败不阻断：某些接口（专栏列表/SSR 页面）不需要它。
    }
  }

  async _wbiKey() {
    if (this.wbi.key && Date.now() - this.wbi.at < 10 * 60 * 1000) return this.wbi.key;
    // 未登录时 nav 返回 code=-101，但 data.wbi_img 仍然有效。
    const data = await this._json(`${API}/x/web-interface/nav`, { referer: WEB, allowCodes: [-101] });
    const key = wbiKeysFromNav(data);
    if (!key) throw new BiliError('Cannot derive WBI key from nav response', { code: 'BILI_WBI_UNAVAILABLE' });
    this.wbi = { key, at: Date.now() };
    return key;
  }

  /** 空间动态流（WBI 签名 + buvid 指纹）。 */
  async dynamicFeed({ mid, offset = '' } = {}) {
    if (!mid) throw new BiliError('Bilibili mid is required', { code: 'BILI_MID_REQUIRED', status: 400 });
    await this.ensureFingerprint();
    const key = await this._wbiKey();
    // 匿名请求偶尔会拿到 code=0 但空列表（风控的软拦截）；每次重试都重新签名。
    let data = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const query = signParams({
        host_mid: String(mid),
        offset: offset || '',
        timezone_offset: -480,
        platform: 'web',
        features: 'itemOpusStyle',
      }, key);
      data = await this._json(`${API}/x/polymer/web-dynamic/v1/feed/space?${query}`, {
        referer: `https://space.bilibili.com/${mid}/dynamic`,
      });
      if (Array.isArray(data?.items) && data.items.length) break;
      await sleep(600 + attempt * 600);
    }
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      offset: data?.offset ?? '',
      hasMore: Boolean(data?.has_more),
    };
  }

  /** 专栏列表（匿名可用；按发布时间倒序）。 */
  async articleList({ mid, page = 1, pageSize = 20 } = {}) {
    if (!mid) throw new BiliError('Bilibili mid is required', { code: 'BILI_MID_REQUIRED', status: 400 });
    const data = await this._json(
      `${API}/x/space/article?mid=${encodeURIComponent(mid)}&pn=${page}&ps=${pageSize}`,
      { referer: `https://space.bilibili.com/${mid}/article` },
    );
    return Array.isArray(data?.articles) ? data.articles : [];
  }

  /** opus / read 页面全文（SSR 结构化段落）。空壳页/风控页会重试一次。 */
  async opusPage(url) {
    let lastReason = 'BILI_PARSE_FAILED';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this._fetch(url, { headers: { Referer: WEB, Accept: 'text/html,application/xhtml+xml' } });
      const finalUrl = response.url || url;
      const html = await response.text();
      if (!response.ok || /<title>出错啦/.test(html)) {
        lastReason = 'BILI_RISK_CONTROL';
      } else {
        const state = extractInitialState(html);
        const detail = parseOpusDetail(state, { url: finalUrl });
        if (detail && Array.isArray(detail.paragraphs) && detail.paragraphs.length) return detail;
        lastReason = 'BILI_PARSE_FAILED';
      }
      if (attempt === 0) await sleep(700);
    }
    if (lastReason === 'BILI_RISK_CONTROL') {
      throw new BiliError('Bilibili opus page is not available (risk control or removed)', {
        code: 'BILI_RISK_CONTROL',
        status: 502,
        hint: '稍后重试，或配置 BILI_COOKIE_FILE（Netscape cookie，含 SESSDATA）',
      });
    }
    throw new BiliError('Bilibili page returned no structured content (likely anti-bot shell)', {
      code: 'BILI_PARSE_FAILED',
      status: 502,
      hint: 'B 站对匿名请求下发空壳页时会出现该错误：稍后重试，或配置 BILI_COOKIE_FILE',
    });
  }

  async articlePage(articleId) {
    return this.opusPage(`${WEB}/read/cv${articleId}`);
  }

  /** 诊断：返回 cookie 状态（不含值）。 */
  cookieStatus() {
    const info = this.jar.sessionInfo('www.bilibili.com');
    return {
      configured: Boolean(this.jar.filePath),
      file: this.jar.filePath || null,
      error: info.error,
      hasSessdata: Boolean(this.jar.get('.bilibili.com', 'SESSDATA')),
    };
  }
}

export default BiliClient;
