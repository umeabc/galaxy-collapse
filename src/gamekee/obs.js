import { createHmac } from 'node:crypto';
import { randomKey } from '../util.js';
import { CookieJar } from '../cookies.js';

const CDN_BASE = 'https://cdnimg-v2.gamekee.com';
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

/** 图片尺寸解析（JPEG/PNG/GIF/WebP），上传前无需再依赖上游元数据。 */
export function parseImageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
  }
  if (buffer.toString('ascii', 0, 4) === 'GIF8') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'gif' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xff || marker === 0x00) {
        offset += 1;
        continue;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: 'jpeg' };
      }
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        offset += 2;
        continue;
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return null;
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, format: 'webp' };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const packed = buffer.readUInt32LE(21);
      return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1, format: 'webp' };
    }
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return {
        width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
        height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
        format: 'webp',
      };
    }
  }
  return null;
}

/** 华为云 OBS V2（HMAC-SHA1）签名，与 GameKee 前端 OBS SDK 一致。 */
export function signObsV2({ method, bucket, key, headers = {}, credentials }) {
  if (!bucket) throw new Error('signObsV2: bucket is required');
  if (!credentials?.access_key_id || !credentials?.secret_access_key) {
    throw new Error('signObsV2: credentials are incomplete');
  }
  const normalized = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
  const canonical = Object.keys(normalized)
    .filter(name => name.startsWith('x-obs-'))
    .sort()
    .map(name => `${name}:${normalized[name]}\n`)
    .join('');
  const date = Object.hasOwn(normalized, 'x-obs-date') ? '' : (normalized.date || '');
  const stringToSign = `${method.toUpperCase()}\n${normalized['content-md5'] || ''}\n${normalized['content-type'] || ''}\n${date}\n${canonical}/${bucket}/${String(key).replace(/^\/+/, '')}`;
  const signature = createHmac('sha1', credentials.secret_access_key).update(stringToSign, 'utf8').digest('base64');
  return { authorization: `OBS ${credentials.access_key_id}:${signature}`, stringToSign };
}

export function normalizeObsServer(server) {
  const invalid = () => new Error('Invalid OBS server');
  if (typeof server !== 'string' || !server.trim()) throw invalid();
  const value = server.trim();
  if (/\s|\\/.test(value)) throw invalid();
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  const host = url.hostname;
  if (!host || url.username || url.password || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw invalid();
  return host;
}

export function regionFromServer(server) {
  const match = normalizeObsServer(server).match(/(?:^|\.)obs\.([a-z0-9-]+)\.myhuaweicloud\.com$/);
  return match ? match[1] : null;
}

export function publicUrl(key) {
  return `${CDN_BASE}/${String(key).replace(/^\/+/, '')}`;
}

/** 编辑器节点用协议相对地址（与站点真实数据一致）。 */
export function editorCdnUrl(keyOrUrl) {
  const value = String(keyOrUrl || '');
  if (value.startsWith('//')) return value;
  if (value.startsWith('https://cdnimg-v2.gamekee.com/')) return value.replace('https:', '');
  if (value.startsWith('http://cdnimg-v2.gamekee.com/')) return value.replace('http:', '');
  return `//${value.replace(/^\/+/, '')}`;
}

export function buildObjectKey({ basePath, uid, ext, width, height, now = new Date() }) {
  if (!basePath || !uid || !ext) throw new Error('buildObjectKey: basePath, uid and ext are required');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('buildObjectKey: width/height must be positive');
  }
  const base = String(basePath).replace(/\/+$/, '');
  return `${base}/w_${Math.round(width)}/h_${Math.round(height)}/${uid}/${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/${randomKey(10)}.${ext}`;
}

/** OBS 直传：凭证来自 GameKee cookie 的 obs_client_params。 */
export class ObsUploader {
  constructor({ cookieStore, cookieFile, timeoutMs = 20000, fetchImpl = globalThis.fetch, cdnHost = '' } = {}) {
    this.cookieStore = cookieStore ?? null;
    this.cookieFile = cookieFile ?? '';
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.cdnHost = cdnHost;
    this.override = null;
    this.cache = null;
  }

  credentials() {
    if (this.override) return this.override;
    if (this.cache) return this.cache;
    let raw = null;
    if (this.cookieStore) raw = this.cookieStore.getObsCredentials();
    else if (this.cookieFile) {
      raw = new CookieJar(this.cookieFile).reload().obsCredentials();
    }
    if (!raw) {
      const error = new Error('AUTH_REQUIRED: obs_client_params missing');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    const credentials = {
      access_key_id: raw.access_key_id || raw.accessKeyId,
      secret_access_key: raw.secret_access_key || raw.secretAccessKey,
      security_token: raw.security_token || raw.sessionToken,
      server: raw.server,
      bucket_name: raw.bucket_name || raw.bucket,
      path: raw.path || {},
    };
    if (!credentials.access_key_id || !credentials.secret_access_key || !credentials.security_token || !credentials.server || !credentials.bucket_name || !credentials.path.image) {
      const error = new Error('AUTH_REQUIRED: obs_client_params incomplete');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    this.cache = credentials;
    return credentials;
  }

  async upload(buffer, { uid, ext, width, height, now = new Date() } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('upload: buffer is required');
    const credentials = this.credentials();
    const region = regionFromServer(credentials.server);
    if (!region) throw new Error('Cannot parse OBS region');
    const key = buildObjectKey({ basePath: credentials.path.image, uid, ext, width, height, now }).replace(/^\/+/, '');
    const headers = {
      'content-type': MIME[String(ext).toLowerCase()] || 'application/octet-stream',
      'x-obs-date': now.toUTCString(),
      'x-obs-security-token': credentials.security_token,
    };
    const { authorization } = signObsV2({ method: 'PUT', bucket: credentials.bucket_name, key, headers, credentials });
    const host = `${credentials.bucket_name}.obs.${region}.myhuaweicloud.com`;
    let response;
    try {
      response = await this.fetchImpl(`https://${host}/${key}`, {
        method: 'PUT',
        headers: { ...headers, Authorization: authorization },
        body: buffer,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      const error = new Error('OBS upload network error');
      error.code = 'OBS_NETWORK';
      throw error;
    }
    if (!response.ok) {
      // 403/401 常见于临时凭证过期：清缓存，下一次重新从 cookie 读取。
      if ([401, 403].includes(response.status)) this.cache = null;
      const body = await response.text().catch(() => '');
      const upstream = String(body).match(/<Code>([A-Za-z0-9_]+)<\/Code>/)?.[1] ?? null;
      const error = new Error(`OBS upload failed: HTTP ${response.status}${upstream ? ` (${upstream})` : ''}`);
      error.code = 'OBS_UPLOAD_FAILED';
      throw error;
    }
    return { key, url: publicUrl(key), objectUrl: `https://${host}/${key}`, width, height, bytes: buffer.length };
  }
}

