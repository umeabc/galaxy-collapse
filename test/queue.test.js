import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServices } from './helpers.js';
import { materializeDraft } from '../src/services/sync.js';
import { zonedParts } from '../src/util.js';

function draft(services) {
  const snapshot = services.settings.getSnapshot();
  return materializeDraft({
    store: services.store,
    snapshot,
    item: {
      sourceKey: `q:${Math.random().toString(16).slice(2)}`,
      kind: 'manual',
      title: '排队测试',
      author: '',
      url: '',
      publishedAt: Date.now(),
      blocks: [{ type: 'text', text: '正文' }],
    },
  });
}

const WIDE = { publishWindowStart: '00:00', publishWindowEnd: '23:59' };

test('闸门：暂停优先', () => {
  const services = makeServices({ settings: { ...WIDE, paused: true } });
  const gate = services.queue.gate();
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'QUEUE_PAUSED');
});

test('闸门：每日上限', () => {
  const services = makeServices({ settings: { ...WIDE, dailyLimit: 1 } });
  const d = draft(services);
  const item = services.store.enqueue(d.id);
  const { dateKey } = zonedParts(new Date(), 'Asia/Shanghai');
  services.store.updateQueueItem(item.id, { state: 'PUBLISHED', publishedAt: Date.now(), publishedDay: dateKey });
  const gate = services.queue.gate();
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'DAILY_LIMIT');
});

test('闸门：发布间隔', () => {
  const services = makeServices({ settings: { ...WIDE, publishIntervalSeconds: 3600 } });
  const d = draft(services);
  const item = services.store.enqueue(d.id);
  const { dateKey } = zonedParts(new Date(), 'Asia/Shanghai');
  services.store.updateQueueItem(item.id, { state: 'PUBLISHED', publishedAt: Date.now(), publishedDay: dateKey });
  const gate = services.queue.gate();
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'INTERVAL');
});

test('闸门：窗口外', () => {
  const now = new Date();
  const { minutes } = zonedParts(now, 'Asia/Shanghai');
  const fmt = value => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const start = fmt((minutes + 120) % 1440);
  const end = fmt((minutes + 180) % 1440);
  const services = makeServices({ settings: { publishWindowStart: start, publishWindowEnd: end } });
  const gate = services.queue.gate();
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'OUTSIDE_WINDOW');
});

test('队列：tick 自动发布并把草稿标记为 PUBLISHED', async () => {
  const services = makeServices({ settings: { ...WIDE, autoPublish: true, publishIntervalSeconds: 10 } });
  services.publish.publishDraft = async () => ({ contentId: '42', url: 'https://www.gamekee.com/ba/42.html', editorType: 1, images: 0 });
  const d = draft(services);
  const item = services.queue.enqueue(d.id);
  await services.queue.tick();
  const after = services.store.getQueueItem(item.id);
  assert.equal(after.state, 'PUBLISHED');
  assert.equal(after.content_id, '42');
  assert.equal(services.store.getDraft(d.id).status, 'PUBLISHED');
});

test('队列：连续失败 3 次后置 FAILED', async () => {
  const services = makeServices({ settings: { ...WIDE, publishIntervalSeconds: 10 } });
  services.publish.publishDraft = async () => {
    throw Object.assign(new Error('mock boom'), { code: 'MOCK_FAIL' });
  };
  const d = draft(services);
  const item = services.queue.enqueue(d.id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(services.queue.publishNow(item.id, { force: true }));
    if (attempt < 2) services.store.updateQueueItem(item.id, { state: 'QUEUED', nextAttemptAt: 0 });
  }
  const after = services.store.getQueueItem(item.id);
  assert.equal(after.state, 'FAILED');
  assert.equal(after.attempts, 3);
  assert.equal(services.store.getDraft(d.id).status, 'FAILED');
});
