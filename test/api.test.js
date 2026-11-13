import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { testConfig } from './helpers.js';

async function withServer(fn) {
  const { app, close } = createApp({ config: testConfig(), startWorker: false });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
    close();
  }
}

const json = async (response) => ({ status: response.status, body: await response.json() });

test('API：state / settings / 手工草稿 / 审核 / 拒绝', async () => {
  await withServer(async base => {
    const state = await json(await fetch(`${base}/api/state`));
    assert.equal(state.status, 200);
    assert.ok(state.body.gate);

    const patched = await json(await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { sourceMid: '2', keywordAllow: '碧蓝档案', autoReview: true, publishWindowStart: '00:00', publishWindowEnd: '23:59' } }),
    }));
    assert.equal(patched.status, 200);
    assert.equal(patched.body.values.sourceMid, '2');
    assert.equal(patched.body.values.keywordAllow, '碧蓝档案');

    const manual = await json(await fetch(`${base}/api/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '手工测试', markdown: '这是碧蓝档案的测试正文。' }),
    }));
    assert.equal(manual.status, 201);
    assert.equal(manual.body.draft.status, 'APPROVED');
    assert.equal(manual.body.draft.review.stage, 'keyword');

    const list = await json(await fetch(`${base}/api/drafts`));
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some(item => item.id === manual.body.draft.id));

    const detail = await json(await fetch(`${base}/api/drafts/${manual.body.draft.id}`));
    assert.equal(detail.status, 200);
    assert.ok(detail.body.preview.html.includes('测试正文'));

    const rejected = await json(await fetch(`${base}/api/drafts/${manual.body.draft.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '人工测试拒绝' }),
    }));
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.draft.status, 'REJECTED');
  });
});

test('API：设置校验与错误响应', async () => {
  await withServer(async base => {
    const bad = await json(await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { publishWindowStart: '25:99' } }),
    }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_SETTING');

    const unknown = await json(await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { nope: 1 } }),
    }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'UNKNOWN_SETTING');

    const missing = await json(await fetch(`${base}/api/drafts/999`));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'DRAFT_NOT_FOUND');
  });
});

test('API：没有订阅时同步给出明确错误', async () => {
  await withServer(async base => {
    const sync = await json(await fetch(`${base}/api/sync`, { method: 'POST' }));
    assert.equal(sync.status, 400);
    assert.equal(sync.body.error.code, 'SUBSCRIPTION_REQUIRED');
  });
});


test('API：订阅的增删改查', async () => {
  await withServer(async base => {
    const created = await json(await fetch(`${base}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mid: '12345', name: '测试账号', mode: 'dynamic' }),
    }));
    assert.equal(created.status, 201);
    assert.equal(created.body.subscription.mid, '12345');
    const id = created.body.subscription.id;

    const duplicate = await json(await fetch(`${base}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mid: '12345', mode: 'dynamic' }),
    }));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'SUBSCRIPTION_EXISTS');

    const list = await json(await fetch(`${base}/api/subscriptions`));
    assert.equal(list.body.items.length, 1);

    const patched = await json(await fetch(`${base}/api/subscriptions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, name: '改名' }),
    }));
    assert.equal(patched.status, 200);
    assert.equal(patched.body.subscription.enabled, false);
    assert.equal(patched.body.subscription.name, '改名');

    const removed = await json(await fetch(`${base}/api/subscriptions/${id}`, { method: 'DELETE' }));
    assert.equal(removed.status, 200);
  });
});
