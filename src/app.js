import express from 'express';
import { AnnouncementService } from './services/announcements.js';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { createLogStore } from './log.js';
import { createStore } from './store.js';
import { SettingsService } from './services/settings.js';
import { ReviewService } from './services/review.js';
import { PublishService } from './services/publish.js';
import { QueueService } from './services/queue.js';
import { SyncService, migrateLegacySubscription } from './services/sync.js';
import { BiliClient } from './bili/client.js';
import { createApiRouter } from './routes.js';
import config from './config.js';

export function buildServices({ config: cfg = config } = {}) {
  const db = openDatabase(cfg.dbPath);
  const log = createLogStore(db);
  const store = createStore(db);
  const settings = new SettingsService({ db, config: cfg });
  const biliFactory = snapshot => new BiliClient({ cookieFile: snapshot.biliCookieFile, timeoutMs: 20000 });
  const review = new ReviewService({ store, settings, log });
  const publish = new PublishService({ store, settings, log, config: cfg });
  const queue = new QueueService({ store, settings, log, publish });
  review.onApproved = draftId => {
    if (settings.getSnapshot().autoPublish) queue.enqueue(draftId);
  };
  const sync = new SyncService({ store, settings, review, log, biliFactory, config: cfg });
  const announcements = new AnnouncementService({ store, settings, log, queue });
  migrateLegacySubscription({ store, settings, log });
  return { db, log, store, settings, review, publish, queue, sync, announcements, biliFactory };
}

export function createApp({ config: cfg = config, startWorker = true } = {}) {
  const services = buildServices({ config: cfg });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // 同源白名单：状态变更请求只允许同 host 或显式配置的来源。
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return next();
    let allowed = false;
    try {
      allowed = new URL(origin).host === req.get('host');
    } catch {
      allowed = false;
    }
    if (!allowed) allowed = cfg.allowedOrigins.includes(origin);
    if (!allowed) {
      return res.status(403).json({ error: { code: 'FORBIDDEN_ORIGIN', message: 'Forbidden origin', details: null } });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    return next();
  });

  app.use('/api', createApiRouter({ ...services, config: cfg }));
  app.use(express.static(join(cfg.root, 'public')));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(cfg.root, 'public', 'index.html'));
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: null } });
    }
    return res.status(404).send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const parseError = error?.type === 'entity.parse.failed';
    const status = parseError ? 400 : (error?.status ?? 500);
    const code = parseError ? 'INVALID_JSON' : (error?.code ?? 'INTERNAL_ERROR');
    if (status >= 500) {
      services.log.write({
        level: 'error',
        scope: 'http',
        event: 'http.error',
        message: String(error?.message ?? error),
        details: { path: req.path, method: req.method, code },
      });
    }
    res.status(status).json({
      error: {
        code,
        message: status >= 500 && !error?.status ? 'Internal server error' : String(error?.message ?? 'Request failed'),
        details: error?.details ?? null,
      },
    });
  });

  let announcementScheduler = null;
  let scheduler = null;
  if (startWorker) {
    services.queue.start();
    announcementScheduler = setInterval(() => {
      services.announcements.syncNow({ reason: 'scheduler', dueOnly: true }).catch(() => {});
    }, 30000);
    announcementScheduler.unref?.();
    scheduler = setInterval(() => {
      try {
        const snapshot = services.settings.getSnapshot();
        if (!snapshot.sourceAutoSync || services.sync.running) return;
        const intervalMs = Math.max(60, Number(snapshot.sourceSyncIntervalSeconds) || 600) * 1000;
        const subscriptions = services.store.listSubscriptions({ enabledOnly: true });
        if (!subscriptions.length) return;
        const due = subscriptions.some(subscription => !subscription.last_sync_at || Date.now() - subscription.last_sync_at >= intervalMs);
        if (!due) return;
        services.sync.syncNow({ reason: 'scheduler', dueOnly: true }).catch(error => {
          services.log.write({ level: 'error', scope: 'sync', event: 'sync.scheduler_failed', message: String(error?.message ?? error) });
        });
      } catch {
        // 定时器永不抛出
      }
    }, 30000);
    scheduler.unref?.();
  }

  function close() {
    services.queue.stop();
    if (announcementScheduler) clearInterval(announcementScheduler);
    if (scheduler) clearInterval(scheduler);
    scheduler = null;
    try {
      services.db.close();
    } catch {
      // 已关闭
    }
  }

  return { app, services, close };
}

export default createApp;
