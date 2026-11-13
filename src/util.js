import { createHash, randomBytes } from 'node:crypto';

/** 时间与时区工具：日限按配置时区的「当天」计数。 */
export function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function isHHMM(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function minutesOfHHMM(value) {
  if (!isHHMM(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

/** 支持跨午夜窗口（22:00 - 02:00）。 */
export function isWithinWindow(minutes, start, end) {
  const startMinutes = minutesOfHHMM(start);
  const endMinutes = minutesOfHHMM(end);
  if (startMinutes === null || endMinutes === null) return false;
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return minutes >= startMinutes && minutes < endMinutes;
  return minutes >= startMinutes || minutes < endMinutes;
}

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function randomKey(length = 16) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 并发受限的 map，用于图片下载/上传（顺序可控、失败可定位）。 */
export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const SECRET_KEY = /(token|cookie|authorization|password|secret|api[-_]?key|credential|session|ct0|sessdata)/i;

/** 递归脱敏：日志、错误、接口回显都不能带 cookie/token。 */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return redact({ name: value.name, code: value.code, message: value.message }, depth + 1);
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
    return out;
  }
  return String(value);
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}…${text.slice(-2)}`;
}

export function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

/** 业务错误：带稳定 code，便于前端与日志区分。 */
export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 400, details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
