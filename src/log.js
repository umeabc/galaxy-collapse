import { redact } from './util.js';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SCOPES = new Set(['system', 'sync', 'ingest', 'review', 'publish', 'queue', 'http', 'auth']);
const MAX_ROWS = 20000;
const RETENTION_DAYS = 30;

/** SQLite 日志：写入永不抛错；查询支持级别/关键字/游标。 */
export function createLogStore(db) {
  const insert = db.prepare('INSERT INTO logs(ts,level,scope,event,message,details) VALUES(?,?,?,?,?,?)');
  let writes = 0;

  function write(entry = {}) {
    try {
      const level = LEVELS.has(entry.level) ? entry.level : 'info';
      const scope = SCOPES.has(entry.scope) ? entry.scope : 'system';
      const details = entry.details === undefined || entry.details === null
        ? null
        : JSON.stringify(redact(entry.details)).slice(0, 8000);
      const info = insert.run(
        Date.now(),
        level,
        scope,
        String(entry.event ?? 'event').slice(0, 120),
        String(entry.message ?? '').slice(0, 2000),
        details,
      );
      writes += 1;
      if (writes % 500 === 0) prune();
      return Number(info.lastInsertRowid);
    } catch {
      return null;
    }
  }

  function query({ level, scope, q, before, limit = 100 } = {}) {
    const where = [];
    const params = {};
    if (level && LEVELS.has(level)) {
      where.push('level = @level');
      params.level = level;
    }
    if (scope && SCOPES.has(scope)) {
      where.push('scope = @scope');
      params.scope = scope;
    }
    if (q) {
      where.push('(message LIKE @q OR event LIKE @q OR details LIKE @q)');
      params.q = `%${q}%`;
    }
    if (Number.isFinite(before)) {
      where.push('ts < @before');
      params.before = before;
    }
    params.limit = Math.min(500, Math.max(1, Number(limit) || 100));
    const sql = `SELECT id, ts, level, scope, event, message, details FROM logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT @limit`;
    return db.prepare(sql).all(params).map(row => ({
      ...row,
      details: row.details ? JSON.parse(row.details) : null,
    }));
  }

  function prune() {
    try {
      db.prepare('DELETE FROM logs WHERE ts < ?').run(Date.now() - RETENTION_DAYS * 86400000);
      db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)').run(MAX_ROWS);
    } catch {
      /* 日志裁剪失败不影响业务 */
    }
  }

  return { write, query, prune };
}
