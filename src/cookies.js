import { readFileSync, statSync } from 'node:fs';

/**
 * Cookie 工具：支持 Netscape 文件、JSON 导出、以及设置页直接粘贴的 Cookie 头。
 * 所有读取都只返回状态/掩码，绝不向接口回显 cookie 值。
 */

export function parseNetscape(text, { fallbackDomain = '' } = {}) {
  const cookies = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, flag, path, secure, expiry, name, ...rest] = parts;
    const value = rest.join('\t');
    const expiration = Number.parseInt(expiry, 10) || 0;
    cookies.push({
      domain: domain.trim().replace(/^\./, ''),
      includeSubdomains: String(flag).toLowerCase() === 'true' || domain.trim().startsWith('.'),
      path: path.trim() || '/',
      secure: String(secure).toLowerCase() === 'true',
      expiration,
      name: name.trim(),
      value: value.trim(),
    });
  }
  if (!cookies.length && fallbackDomain) return [];
  return cookies;
}

export function parseJsonCookies(text, { fallbackDomain = '' } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data?.cookies;
  if (Array.isArray(list)) {
    return list
      .filter(item => item && typeof item.name === 'string' && item.name)
      .map(item => ({
        domain: String(item.domain || fallbackDomain || '').replace(/^\./, ''),
        includeSubdomains: String(item.domain || '').startsWith('.') || Boolean(item.hostOnly === false),
        path: String(item.path || '/'),
        secure: Boolean(item.secure),
        expiration: Number(item.expirationDate ?? item.expires ?? 0) || 0,
        name: item.name,
        value: String(item.value ?? ''),
      }));
  }
  if (data && typeof data === 'object') {
    return Object.entries(data)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([name, value]) => ({
        domain: fallbackDomain,
        includeSubdomains: true,
        path: '/',
        secure: true,
        expiration: 0,
        name,
        value: String(value),
      }));
  }
  return [];
}

/**
 * 设置页粘贴的 cookie：优先 Netscape，其次 JSON，最后按 `a=b; c=d` 解析。
 * 兼容 `Cookie: a=b; c=d` 前缀与多行输入。
 */
export function parseCookieText(text, { fallbackDomain = '' } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  if (lines.some(line => line.split('\t').length >= 7)) {
    const parsed = parseNetscape(raw, { fallbackDomain });
    if (parsed.length) return parsed;
  }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const parsed = parseJsonCookies(raw, { fallbackDomain });
    if (parsed.length) return parsed;
  }
  const cookies = [];
  const seen = new Set();
  for (const part of raw.split(/[;\n]/)) {
    const trimmed = part.trim().replace(/^cookie:\s*/i, '');
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cookies.push({
      domain: fallbackDomain,
      includeSubdomains: true,
      path: '/',
      secure: true,
      expiration: 0,
      name,
      value,
    });
  }
  return cookies;
}

export function domainMatches(cookieDomain, host, includeSubdomains = true) {
  const domain = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const target = String(host || '').toLowerCase();
  if (!domain) return false;
  if (target === domain) return true;
  return includeSubdomains && target.endsWith(`.${domain}`);
}

function activeCookies(cookies) {
  const now = Date.now() / 1000;
  return cookies.filter(cookie => {
    if (cookie.name === 'obs_client_params') return true; // 内部 timeout_at 才可信
    return !(cookie.expiration > 0 && cookie.expiration < now);
  });
}

function getValue(cookies, domain, name) {
  return cookies.find(cookie => cookie.name === name && domainMatches(cookie.domain, domain, cookie.includeSubdomains))?.value ?? null;
}

function headerFor(cookies, domain) {
  return cookies
    .filter(cookie => domainMatches(cookie.domain, domain, cookie.includeSubdomains))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function obsFrom(cookies, domain) {
  const raw = getValue(cookies, domain, 'obs_client_params');
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function sessionFrom(cookies, { domain = 'www.gamekee.com', error = null, source = 'file' } = {}) {
  const token = getValue(cookies, domain, 'userToken');
  const uid = getValue(cookies, domain, 'userUid');
  const obs = getValue(cookies, domain, 'obs_client_params');
  const result = {
    source,
    present: cookies.length > 0,
    hasUserToken: Boolean(token),
    hasUserUid: Boolean(uid),
    hasObsParams: Boolean(obs),
    error,
    valid: false,
    expiresAt: null,
    uid: uid ? `${uid.slice(0, 2)}**${uid.slice(-2)}` : null,
  };
  if (token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      result.expiresAt = payload.exp ?? null;
      result.valid = Boolean(payload.exp && payload.exp * 1000 > Date.now()) && Boolean(uid);
      if (payload.exp && payload.exp * 1000 <= Date.now()) result.error = 'TOKEN_EXPIRED';
    } catch {
      result.error = 'TOKEN_UNPARSABLE';
    }
  }
  return result;
}

export class CookieJar {
  constructor(filePath, { fallbackDomain = '' } = {}) {
    this.filePath = filePath || '';
    this.fallbackDomain = fallbackDomain;
    this.cookies = [];
    this.mtimeMs = 0;
    this.error = null;
  }

  reload(force = false) {
    if (!this.filePath) {
      this.cookies = [];
      this.error = 'NO_COOKIE_FILE';
      return this;
    }
    let stat;
    try {
      stat = statSync(this.filePath);
    } catch {
      this.cookies = [];
      this.error = 'COOKIE_FILE_NOT_FOUND';
      return this;
    }
    if (!force && stat.mtimeMs === this.mtimeMs) return this;
    this.mtimeMs = stat.mtimeMs;
    let text = '';
    try {
      text = readFileSync(this.filePath, 'utf8');
    } catch {
      this.cookies = [];
      this.error = 'COOKIE_FILE_UNREADABLE';
      return this;
    }
    const fallbackDomain = this.fallbackDomain;
    let parsed = parseNetscape(text, { fallbackDomain });
    if (!parsed.length) parsed = parseJsonCookies(text, { fallbackDomain });
    this.cookies = activeCookies(parsed);
    this.error = this.cookies.length ? null : 'COOKIE_FILE_EMPTY';
    return this;
  }

  get(domain, name) {
    this.reload();
    return getValue(this.cookies, domain, name);
  }

  headerFor(domain) {
    this.reload();
    return headerFor(this.cookies, domain);
  }

  obsCredentials(domain = 'www.gamekee.com') {
    this.reload();
    return obsFrom(this.cookies, domain);
  }

  sessionInfo(domain = 'www.gamekee.com') {
    this.reload();
    return {
      cookieFile: this.filePath || null,
      ...sessionFrom(this.cookies, { domain, error: this.error, source: 'file' }),
    };
  }
}

/** 设置页直接粘贴的 cookies：与 CookieJar 相同的读取接口，但不可重载。 */
export class InlineCookieJar {
  constructor(text, { fallbackDomain = '', source = 'inline' } = {}) {
    this.fallbackDomain = fallbackDomain;
    this.source = source;
    const parsed = parseCookieText(text, { fallbackDomain });
    this.cookies = activeCookies(parsed);
    this.error = this.cookies.length ? null : 'COOKIE_TEXT_EMPTY';
  }

  get(domain, name) {
    return getValue(this.cookies, domain, name);
  }

  headerFor(domain) {
    return headerFor(this.cookies, domain);
  }

  obsCredentials(domain = 'www.gamekee.com') {
    return obsFrom(this.cookies, domain);
  }

  sessionInfo(domain = 'www.gamekee.com') {
    return {
      cookieFile: null,
      ...sessionFrom(this.cookies, { domain, error: this.error, source: this.source }),
    };
  }
}

export function createCookieJar(filePath, options) {
  return new CookieJar(filePath, options).reload();
}

/** 优先使用设置里粘贴的 cookie 文本，其次退回文件。 */
export function createCookieSource({ text = '', filePath = '', fallbackDomain = '' } = {}) {
  if (String(text || '').trim()) {
    return new InlineCookieJar(text, { fallbackDomain, source: 'inline' });
  }
  return new CookieJar(filePath, { fallbackDomain });
}
