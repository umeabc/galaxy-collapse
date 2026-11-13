import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServices } from './helpers.js';
import { materializeDraft } from '../src/services/sync.js';

function seedDraft(services, text = '这是一篇关于碧蓝档案的攻略') {
  const snapshot = services.settings.getSnapshot();
  const draft = materializeDraft({
    store: services.store,
    snapshot,
    item: {
      sourceKey: `test:${Math.random().toString(16).slice(2)}`,
      kind: 'article',
      title: '测试文章',
      author: '作者',
      authorMid: '1',
      url: 'https://www.bilibili.com/read/cv1',
      publishedAt: Date.now(),
      blocks: [{ type: 'text', text }],
    },
  });
  return draft;
}

test('审核：命中允许词自动通过', async () => {
  const services = makeServices({ settings: { keywordAllow: '碧蓝档案' } });
  const draft = seedDraft(services);
  const { review } = await services.review.reviewDraft(draft.id);
  assert.equal(services.store.getDraft(draft.id).status, 'APPROVED');
  assert.equal(review.stage, 'keyword');
  assert.equal(review.verdict, 'approve');
});

test('审核：命中拦截词自动拒绝', async () => {
  const services = makeServices({ settings: { keywordBlock: '代充' } });
  const draft = seedDraft(services, '低价代充，私聊');
  await services.review.reviewDraft(draft.id);
  const after = services.store.getDraft(draft.id);
  assert.equal(after.status, 'REJECTED');
  assert.match(after.review.reason, /代充/);
});

test('审核：未命中且未启用 AI → 待人工', async () => {
  const services = makeServices();
  const draft = seedDraft(services);
  await services.review.reviewDraft(draft.id);
  assert.equal(services.store.getDraft(draft.id).status, 'NEEDS_REVIEW');
});

test('审核：AI 审核通过并保留模型理由', async () => {
  const services = makeServices({ settings: { aiEnabled: true, aiBaseUrl: 'http://mock/v1', aiPrompt: '审核 {{title}}' } });
  services.review.fetchImpl = async (url, init) => {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: 'mock-1', choices: [{ message: { content: '{"decision":"approve","confidence":0.95,"reason":"内容正常"}' } }] }),
    };
  };
  const draft = seedDraft(services);
  const { review } = await services.review.reviewDraft(draft.id);
  assert.equal(services.store.getDraft(draft.id).status, 'APPROVED');
  assert.equal(review.stage, 'ai');
  assert.equal(review.model, 'mock-1');
});

test('审核：AI 失败按设置回落（review）', async () => {
  const services = makeServices({ settings: { aiEnabled: true, aiBaseUrl: 'http://mock/v1', aiOnError: 'review' } });
  services.review.fetchImpl = async () => {
    throw new Error('network down');
  };
  const draft = seedDraft(services);
  const { review } = await services.review.reviewDraft(draft.id);
  assert.equal(services.store.getDraft(draft.id).status, 'NEEDS_REVIEW');
  assert.equal(review.error, true);
});

test('审核通过且开启自动发布 → 自动入队', async () => {
  const services = makeServices({ settings: { keywordAllow: '碧蓝档案', autoPublish: true, publishWindowStart: '00:00', publishWindowEnd: '23:59' } });
  services.review.onApproved = draftId => services.queue.enqueue(draftId);
  const draft = seedDraft(services);
  await services.review.reviewDraft(draft.id);
  const after = services.store.getDraft(draft.id);
  assert.equal(after.status, 'QUEUED');
  assert.ok(services.store.activeQueueItem(draft.id));
});
