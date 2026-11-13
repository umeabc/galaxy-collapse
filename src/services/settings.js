import { AppError, isHHMM, maskSecret } from '../util.js';
import { DEFAULT_PROMPT } from '../review/ai.js';

const COOKIE_PATH = /^[^\0]{0,500}$/;
const MODES = ['dynamic', 'article'];
const AI_ERROR_ACTIONS = ['review', 'approve', 'reject'];

const bool = { type: 'boolean' };
const int = (min, max) => ({ type: 'int', min, max });

export const SETTING_SPEC = {
  // 来源
  sourceMid: { type: 'string', pattern: /^\d{0,20}$/, message: 'sourceMid 必须是数字 UID' },
  sourceName: { type: 'string', max: 60 },
  sourceMode: { type: 'enum', values: MODES },
  sourceAutoSync: bool,
  sourceSyncIntervalSeconds: int(60, 86400),
  lastSyncAt: int(0, 4102444800000),
  syncMaxNewPerRun: int(1, 200),
  includeForwards: bool,
  biliCookieFile: { type: 'string', max: 500, pattern: COOKIE_PATH },
  // 目标
  gamekeeCookieFile: { type: 'string', max: 500, pattern: COOKIE_PATH },
  gamekeeCookieText: { type: 'string', max: 20000, secret: true },
  gamekeeAlias: { type: 'string', max: 20, pattern: /^[a-z0-9_]{1,20}$/i, message: 'gamekeeAlias 只能包含字母/数字/下划线' },
  gamekeeGameId: { type: 'string', max: 20, pattern: /^\d{1,20}$/, message: 'gamekeeGameId 必须是数字' },
  gamekeeType: int(1, 100),
  gamekeeTag: { type: 'string', max: 10, pattern: /^\d{1,10}$/, message: 'gamekeeTag 必须是数字字符串' },
  editorType: { type: 'enum', values: [0, 1] },
  maxTitleLength: int(10, 200),
  includeAttribution: bool,
  // 发布调度
  autoPublish: bool,
  paused: bool,
  publishIntervalSeconds: int(10, 86400),
  publishWindowStart: { type: 'hhmm' },
  publishWindowEnd: { type: 'hhmm' },
  dailyLimit: int(1, 10000),
  timeZone: { type: 'string', max: 64 },
  // 审核
  autoReview: bool,
  keywordAllow: { type: 'string', max: 5000 },
  keywordBlock: { type: 'string', max: 5000 },
  keywordFlag: { type: 'string', max: 5000 },
  aiEnabled: bool,
  aiBaseUrl: { type: 'string', max: 300 },
  aiApiKey: { type: 'string', max: 500, secret: true },
  aiModel: { type: 'string', max: 100 },
  aiPrompt: { type: 'string', max: 20000 },
  aiMinConfidence: { type: 'float', min: 0, max: 1 },
  aiOnError: { type: 'enum', values: AI_ERROR_ACTIONS },
};

export const SECRET_KEYS = Object.entries(SETTING_SPEC)
  .filter(([, spec]) => spec.secret)
  .map(([key]) => key);

export function defaultSettings(config) {
  return {
    sourceMid: config.bili.mid,
    sourceName: config.bili.name,
    sourceMode: config.bili.mode,
    sourceAutoSync: true,
    sourceSyncIntervalSeconds: 600,
    lastSyncAt: 0,
    syncMaxNewPerRun: 50,
    includeForwards: false,
    biliCookieFile: config.bili.cookieFile,
    gamekeeCookieFile: config.gamekee.cookieFile,
    gamekeeCookieText: config.gamekee.cookieText || '',
    gamekeeAlias: config.gamekee.alias,
    gamekeeGameId: config.gamekee.gameId,
    gamekeeType: 4,
    gamekeeTag: '2',
    editorType: 1,
    maxTitleLength: config.maxTitleLength,
    includeAttribution: true,
    autoPublish: false,
    paused: false,
    publishIntervalSeconds: 60,
    publishWindowStart: '08:30',
    publishWindowEnd: '23:30',
    dailyLimit: 50,
    timeZone: 'Asia/Shanghai',
    autoReview: true,
    keywordAllow: '',
    keywordBlock: '',
    keywordFlag: '',
    aiEnabled: config.ai.enabled,
    aiBaseUrl: config.ai.baseUrl,
    aiApiKey: config.ai.apiKey,
    aiModel: config.ai.model,
    aiPrompt: DEFAULT_PROMPT,
    aiMinConfidence: config.ai.minConfidence,
    aiOnError: 'review',
  };
}

function validateTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function coerceSetting(key, value, spec) {
  let result = value;
  switch (spec.type) {
    case 'boolean':
      if (typeof value === 'boolean') result = value;
      else if (['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) result = true;
      else if (['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) result = false;
      else throw new AppError(`设置 ${key} 必须是布尔值`, { code: 'INVALID_SETTING' });
      return result;
    case 'int': {
      const number = Number.parseInt(String(value), 10);
      if (!Number.isFinite(number)) throw new AppError(`设置 ${key} 必须是整数`, { code: 'INVALID_SETTING' });
      if (number < spec.min || number > spec.max) throw new AppError(`设置 ${key} 必须在 ${spec.min}..${spec.max}`, { code: 'INVALID_SETTING' });
      return number;
    }
    case 'float': {
      const number = Number.parseFloat(String(value));
      if (!Number.isFinite(number)) throw new AppError(`设置 ${key} 必须是数字`, { code: 'INVALID_SETTING' });
      if (number < spec.min || number > spec.max) throw new AppError(`设置 ${key} 必须在 ${spec.min}..${spec.max}`, { code: 'INVALID_SETTING' });
      return number;
    }
    case 'enum': {
      const found = spec.values.find(option => String(option) === String(value));
      if (found === undefined) throw new AppError(`设置 ${key} 必须是 ${spec.values.join('/')}`, { code: 'INVALID_SETTING' });
      return found;
    }
    case 'hhmm':
      if (!isHHMM(String(value))) throw new AppError(`设置 ${key} 必须是 HH:mm`, { code: 'INVALID_SETTING' });
      return String(value);
    default: {
      const text = value === null || value === undefined ? '' : String(value);
      if (spec.max && text.length > spec.max) throw new AppError(`设置 ${key} 过长`, { code: 'INVALID_SETTING' });
      if (spec.pattern && !spec.pattern.test(text)) throw new AppError(spec.message || `设置 ${key} 格式不正确`, { code: 'INVALID_SETTING' });
      if (key === 'timeZone' && text && !validateTimeZone(text)) throw new AppError('timeZone 不是合法时区', { code: 'INVALID_SETTING' });
      return text;
    }
  }
}

export class SettingsService {
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
    this.defaults = defaultSettings(config);
    this.cache = null;
    this.cacheAt = 0;
  }

  invalidate() {
    this.cache = null;
    this.cacheAt = 0;
  }

  readOverrides() {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all();
    const out = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value_json);
      } catch {
        // 忽略损坏值
      }
    }
    return out;
  }

  /** 完整设置（含默认值），5 秒缓存；写操作会失效缓存。 */
  getSnapshot() {
    if (this.cache && Date.now() - this.cacheAt < 5000) return this.cache;
    const overrides = this.readOverrides();
    const values = { ...this.defaults };
    for (const [key, value] of Object.entries(overrides)) {
      if (!SETTING_SPEC[key]) continue;
      try {
        values[key] = coerceSetting(key, value, SETTING_SPEC[key]);
      } catch {
        // 数据库里的坏值不能阻断服务启动
      }
    }
    this.cache = values;
    this.cacheAt = Date.now();
    return values;
  }

  get(key) {
    return this.getSnapshot()[key];
  }

  /** 前端视图：secret 只给掩码。 */
  getPublic() {
    const values = this.getSnapshot();
    const view = { ...values };
    for (const key of SECRET_KEYS) {
      // cookie 文本不做前后缀掩码（会泄露片段），只给「是否已保存」。
      view[key] = key === 'gamekeeCookieText' ? '' : (values[key] ? maskSecret(values[key]) : '');
      view[`${key}Set`] = Boolean(values[key]);
    }
    return view;
  }

  update(patch = {}) {
    if (!patch || typeof patch !== 'object') throw new AppError('设置必须是一个对象', { code: 'INVALID_SETTING' });
    const now = Date.now();
    const upsert = this.db.prepare('INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES(?,?,?)');
    const current = this.getSnapshot();
    const applied = {};
    const tx = this.db.transaction(items => {
      for (const [key, raw] of Object.entries(items)) {
        const spec = SETTING_SPEC[key];
        if (!spec) throw new AppError(`未知设置项: ${key}`, { code: 'UNKNOWN_SETTING' });
        // secret 掩码回传视为「不修改」
        if (spec.secret && typeof raw === 'string' && (raw.includes('…') || raw === '****' || raw === '')) {
          if (raw === '') {
            applied[key] = current[key];
            upsert.run(key, JSON.stringify(''), now);
          }
          continue;
        }
        const value = coerceSetting(key, raw, spec);
        applied[key] = value;
        upsert.run(key, JSON.stringify(value), now);
      }
    });
    tx(patch);
    this.invalidate();
    return this.getPublic();
  }
}
