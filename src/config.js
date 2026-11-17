import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..');

// 轻量 .env 载入：只在进程环境没有该键时写入，避免覆盖外部注入的配置。
function loadDotEnv(root) {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.hasOwn(process.env, key)) process.env[key] = value;
  }
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const MODES = new Set(['dynamic', 'article']);

export function loadConfig(env = process.env, root = PROJECT_ROOT) {
  loadDotEnv(root);
  const dataDir = resolve(root, env.DATA_DIR || 'data');
  const config = {
    root,
    host: env.HOST || '127.0.0.1',
    port: toInt(env.PORT, 3100),
    dataDir,
    dbPath: resolve(root, env.DB_PATH || resolve(dataDir, 'galaxy.sqlite')),
    mediaDir: resolve(root, env.MEDIA_DIR || resolve(dataDir, 'media')),
    publishTimeoutMs: Math.max(5000, toInt(env.PUBLISH_TIMEOUT_MS, 20000)),
    announcementProxy: String(env.ANNOUNCEMENT_PROXY || '').trim(),
    maxTitleLength: Math.min(200, Math.max(10, toInt(env.MAX_TITLE_LENGTH, 100))),
    bili: {
      mid: String(env.BILI_USER_MID || '').trim(),
      name: String(env.BILI_USER_NAME || '').trim(),
      mode: MODES.has(env.BILI_SOURCE_MODE) ? env.BILI_SOURCE_MODE : 'dynamic',
      cookieFile: String(env.BILI_COOKIE_FILE || '').trim(),
    },
    gamekee: {
      baseUrl: String(env.GAMEKEE_BASE_URL || 'https://www.gamekee.com').replace(/\/+$/, ''),
      gameId: String(env.GAMEKEE_GAME_ID || '829').trim(),
      alias: String(env.GAMEKEE_GAME_ALIAS || 'ba').trim(),
      cookieFile: String(env.GAMEKEE_COOKIE_FILE || '').trim(),
      // 可选：直接给出 cookie 文本（设置页保存的优先）。
      cookieText: String(env.GAMEKEE_COOKIE_TEXT || '').trim(),
    },
    ai: {
      enabled: toBool(env.AI_ENABLED, false),
      baseUrl: String(env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: String(env.AI_API_KEY || ''),
      model: String(env.AI_MODEL || 'gpt-4o-mini'),
      timeoutMs: Math.max(5000, toInt(env.AI_TIMEOUT_MS, 60000)),
      minConfidence: Math.min(1, Math.max(0, toFloat(env.AI_MIN_CONFIDENCE, 0.6))),
    },
    allowedOrigins: String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(value => value.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
  config.allowedOrigins = [...new Set([
    `http://${config.host}:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...config.allowedOrigins,
  ])];
  return config;
}

export function validateConfig(config) {
  const errors = [];
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) errors.push('PORT must be 1..65535');
  if (!Number.isInteger(config.publishTimeoutMs) || config.publishTimeoutMs < 5000) errors.push('PUBLISH_TIMEOUT_MS must be >= 5000');
  if (!Number.isInteger(config.maxTitleLength) || config.maxTitleLength < 10) errors.push('MAX_TITLE_LENGTH must be >= 10');
  if (!MODES.has(config.bili.mode)) errors.push('BILI_SOURCE_MODE must be dynamic or article');
  if (!Number.isFinite(config.ai.minConfidence)) errors.push('AI_MIN_CONFIDENCE must be a number');
  if (config.ai.enabled && !config.ai.baseUrl) errors.push('AI_BASE_URL is required when AI_ENABLED=true');
  return errors;
}

const config = loadConfig();
export default config;
