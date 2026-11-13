import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServices } from './helpers.js';
import { migrateLegacySubscription } from '../src/services/sync.js';

const now = Date.now();

function wordItem(id, timestamp, text) {
  return {
    id_str: String(id),
    type: 'DYNAMIC_TYPE_WORD',
    basic: { jump_url: `//www.bilibili.com/opus/${id}` },
    modules: {
      module_author: { name: 'UP主', mid: 42, pub_ts: Math.floor(timestamp / 1000) },
      module_dynamic: { desc: { text }, major: null },
    },
  };
}

function forwardItem(id, timestamp, text, originalText) {
  return {
    id_str: String(id),
    type: 'DYNAMIC_TYPE_FORWARD',
    basic: { jump_url: `//www.bilibili.com/opus/${id}` },
    modules: {
      module_author: { name: '转发者', mid: 42, pub_ts: Math.floor(timestamp / 1000) },
      module_dynamic: { desc: { text }, major: null },
    },
    orig: wordItem(`${id}0`, timestamp - 1000, originalText),
  };
}

function fakeBili(feedPages) {
  return {
    dynamicFeed: async ({ offset }) => feedPages[offset ?? ''] ?? { items: [], offset: '', hasMore: false },
    articleList: async ({ page }) => feedPages[`article:${page}`] ?? [],
    articlePage: async id => ({
      title: `文章 ${id}`,
      author: 'UP主',
      authorMid: '42',
      url: `https://www.bilibili.com/read/cv${id}`,
      publishedAt: now - 1000,
      paragraphs: [{ text: { nodes: [{ type: 'TEXT_NODE_TYPE_WORD', word: { words: `正文 ${id}` } }] } }],
    }),
  };
}

test('订阅：只抓取订阅时间之后的动态，并跳过更早内容', async () => {
  const services = makeServices();
  const { subscription } = services.store.addSubscription({ mid: '42', mode: 'dynamic', subscribedAt: now - 60000, includeForwards: true });
  const pages = {
    '': {
      items: [
        wordItem(1, now - 600000, '很久以前的置顶动态'),
        wordItem(2, now - 5000, '订阅后的新动态'),
        wordItem(3, now - 120000, '订阅前的旧动态'),
      ],
      offset: 'p2',
      hasMore: true,
    },
    p2: { items: [wordItem(4, now - 900000, '更早的一页')], offset: '', hasMore: false },
  };
  services.sync.biliFactory = () => fakeBili(pages);

  const result = await services.sync.syncNow({ subscriptionId: subscription.id });
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].sourceKey, 'opus:2');
  const draft = services.store.getDraft(result.created[0].draftId);
  assert.match(draft.markdown, /订阅后的新动态/);
  assert.equal(services.store.listDrafts().length, 1);

  // 第二次同步：已存在的内容不再生成草稿
  const second = await services.sync.syncNow({ subscriptionId: subscription.id });
  assert.equal(second.created.length, 0);
});

test('订阅：转发动态包含原动态正文', async () => {
  const services = makeServices();
  const { subscription } = services.store.addSubscription({ mid: '42', mode: 'dynamic', subscribedAt: now - 60000, includeForwards: true });
  services.sync.biliFactory = () => fakeBili({
    '': { items: [forwardItem(10, now - 2000, '转发语', '原动态内容')], offset: '', hasMore: false },
  });
  const result = await services.sync.syncNow({ subscriptionId: subscription.id });
  assert.equal(result.created.length, 1);
  const draft = services.store.getDraft(result.created[0].draftId);
  assert.match(draft.markdown, /转发语/);
  assert.match(draft.markdown, /原动态内容/);
});

test('订阅：单轮上限达到后标记 truncated，下次继续抓取剩余内容', async () => {
  const services = makeServices({ settings: { syncMaxNewPerRun: 1 } });
  const { subscription } = services.store.addSubscription({ mid: '42', mode: 'dynamic', subscribedAt: now - 60000 });
  services.sync.biliFactory = () => fakeBili({
    '': {
      items: [wordItem(21, now - 1000, '第一条'), wordItem(22, now - 2000, '第二条')],
      offset: '',
      hasMore: false,
    },
  });
  const first = await services.sync.syncNow({ subscriptionId: subscription.id });
  assert.equal(first.created.length, 1);
  assert.equal(first.truncated, true);

  const second = await services.sync.syncNow({ subscriptionId: subscription.id });
  assert.equal(second.created.length, 1);
  assert.equal(services.store.listDrafts().length, 2);
});

test('订阅：专栏模式按发布时间过滤并抓取正文', async () => {
  const services = makeServices();
  const { subscription } = services.store.addSubscription({ mid: '42', mode: 'article', subscribedAt: now - 60000 });
  services.sync.biliFactory = () => fakeBili({
    'article:1': [
      { id: 101, title: '新专栏', publish_time: Math.floor((now - 5000) / 1000), author: { mid: 42, name: 'UP主' } },
      { id: 102, title: '旧专栏', publish_time: Math.floor((now - 600000) / 1000), author: { mid: 42, name: 'UP主' } },
    ],
  });
  const result = await services.sync.syncNow({ subscriptionId: subscription.id });
  assert.equal(result.created.length, 1);
  const draft = services.store.getDraft(result.created[0].draftId);
  assert.match(draft.title, /文章 101/);
  assert.match(draft.markdown, /正文 101/);
});

test('订阅：旧版 sourceMid 配置迁移为「从现在开始」的订阅', () => {
  const services = makeServices({ settings: { sourceMid: '777', sourceName: '旧配置' } });
  assert.equal(services.store.listSubscriptions().length, 0);
  const sub = migrateLegacySubscription({ store: services.store, settings: services.settings, log: services.log });
  assert.ok(sub);
  assert.equal(sub.mid, '777');
  assert.equal(sub.name, '旧配置');
  assert.ok(sub.subscribed_at <= Date.now());
  assert.equal(services.settings.get('sourceMid'), '');
  assert.equal(migrateLegacySubscription({ store: services.store, settings: services.settings, log: services.log }), null);
});

test('订阅：转发原动态为 opus 时，补全全文但保留转发语', async () => {
  const services = makeServices();
  const { subscription } = services.store.addSubscription({ mid: '42', mode: 'dynamic', subscribedAt: now - 60000, includeForwards: true });
  const opusOriginal = {
    id_str: `${now}99`,
    type: 'DYNAMIC_TYPE_OPUS',
    basic: { jump_url: '//www.bilibili.com/opus/999999' },
    modules: {
      module_author: { name: '原作者', mid: 99, pub_ts: Math.floor((now - 3000) / 1000) },
      module_dynamic: {
        desc: { text: '' },
        major: {
          type: 'MAJOR_TYPE_OPUS',
          opus: {
            title: '原文标题',
            summary: { text: '原文摘要' },
            pics: [],
            jump_url: '//www.bilibili.com/opus/999999',
          },
        },
      },
    },
  };
  const forward = {
    id_str: '888',
    type: 'DYNAMIC_TYPE_FORWARD',
    basic: { jump_url: '//www.bilibili.com/opus/888' },
    modules: {
      module_author: { name: '转发者', mid: 42, pub_ts: Math.floor((now - 1000) / 1000) },
      module_dynamic: { desc: { text: '转发语' }, major: null },
    },
    orig: opusOriginal,
  };
  const bili = fakeBili({ '': { items: [forward], offset: '', hasMore: false } });
  bili.opusPage = async () => ({
    title: '原文标题',
    author: '原作者',
    authorMid: '99',
    url: 'https://www.bilibili.com/opus/999999',
    publishedAt: now - 3000,
    paragraphs: [{ text: { nodes: [{ type: 'TEXT_NODE_TYPE_WORD', word: { words: '原文全文内容' } }] } }],
  });
  services.sync.biliFactory = () => bili;

  const result = await services.sync.syncNow({ subscriptionId: subscription.id });
  assert.equal(result.created.length, 1);
  const draft = services.store.getDraft(result.created[0].draftId);
  assert.match(draft.markdown, /转发语/);
  assert.match(draft.markdown, /原文全文内容/);
  assert.match(draft.markdown, /转发自 @原作者/);
});
