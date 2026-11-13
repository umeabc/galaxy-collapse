import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDynamicItem, extractArticleItem, deriveTitle } from '../src/bili/extract.js';
import { extractInitialState, paragraphsToBlocks, parseOpusDetail } from '../src/bili/page.js';

test('动态：图文动态提取文本 + 图片 + 标题', () => {
  const item = {
    id_str: '123456',
    type: 'DYNAMIC_TYPE_DRAW',
    basic: { jump_url: '//www.bilibili.com/opus/999888' },
    modules: {
      module_author: { name: '画师A', mid: 42, pub_ts: 1700000000 },
      module_dynamic: {
        desc: { text: '今天画了新的立绘，喜欢的话点个赞。' },
        major: {
          type: 'MAJOR_TYPE_DRAW',
          draw: { items: [{ src: 'https://i0.hdslb.com/x.jpg', width: 800, height: 600 }] },
        },
      },
    },
  };
  const result = extractDynamicItem(item);
  assert.equal(result.kind, 'dynamic');
  assert.equal(result.sourceKey, 'opus:999888');
  assert.equal(result.author, '画师A');
  assert.equal(result.authorMid, '42');
  assert.equal(result.publishedAt, 1700000000000);
  assert.equal(result.blocks[0].type, 'text');
  assert.equal(result.blocks[1].type, 'image');
  assert.equal(result.blocks[1].width, 800);
});

test('动态：转发默认跳过，开启后保留转发语', () => {
  const item = {
    id_str: '1',
    type: 'DYNAMIC_TYPE_FORWARD',
    modules: {
      module_author: { name: 'B', mid: 1, pub_ts: 1700000001 },
      module_dynamic: { desc: { text: '转发语' } },
    },
  };
  assert.equal(extractDynamicItem(item), null);
  assert.equal(extractDynamicItem(item, { includeForwards: true }).blocks[0].text, '转发语');
});

test('动态：opus 动态带全文跳转地址', () => {
  const item = {
    id_str: '2',
    type: 'DYNAMIC_TYPE_ARTICLE',
    basic: { jump_url: '//www.bilibili.com/opus/555' },
    modules: {
      module_author: { name: 'C', mid: 2, pub_ts: 1700000002 },
      module_dynamic: {
        desc: '',
        major: { type: 'MAJOR_TYPE_OPUS', opus: { title: '长文标题', summary: { text: '摘要正文' }, pics: [], jump_url: '//www.bilibili.com/opus/555' } },
      },
    },
  };
  const result = extractDynamicItem(item);
  assert.equal(result.title, '长文标题');
  assert.equal(result.hydrateUrl, 'https://www.bilibili.com/opus/555');
  assert.equal(result.blocks[0].text, '摘要正文');
});

test('专栏列表项提取', () => {
  const item = extractArticleItem({
    id: 53711426,
    title: '专栏标题',
    publish_time: 1700000003,
    summary: '摘要',
    author: { mid: 2, name: '碧诗' },
  });
  assert.equal(item.sourceKey, 'article:53711426');
  assert.equal(item.url, 'https://www.bilibili.com/read/cv53711426');
  assert.equal(item.authorMid, '2');
});

test('段落 → blocks：文本/图片/标题/列表/引用', () => {
  const paragraphs = [
    { para_type: 1, text: { nodes: [{ type: 'TEXT_NODE_TYPE_WORD', word: { words: '第一段' } }] } },
    { para_type: 2, pic: { pics: [{ url: 'https://i0.hdslb.com/p.png', width: 100, height: 200 }] } },
    { heading: { level: 2 }, text: { nodes: [{ type: 'TEXT_NODE_TYPE_WORD', word: { words: '标题' } }] } },
    { list: { style: 2, items: ['甲', { text: '乙' }] } },
    { blockquote: { text: '引用' } },
  ];
  const blocks = paragraphsToBlocks(paragraphs);
  assert.deepEqual(blocks.map(block => block.type), ['text', 'image', 'heading', 'list', 'quote']);
  assert.equal(blocks[1].width, 100);
  assert.deepEqual(blocks[3].items, ['甲', '乙']);
  assert.equal(blocks[3].ordered, true);
});

test('SSR __INITIAL_STATE__ 解析：标题/作者/段落', () => {
  const html = `<!doctype html><script>window.__INITIAL_STATE__ = ${JSON.stringify({
    detail: {
      id_str: '777',
      type: 1,
      modules: {
        1: { module_type: 'MODULE_TYPE_TITLE', module_title: { text: 'SSR 标题' } },
        2: { module_type: 'MODULE_TYPE_AUTHOR', module_author: { name: '作者', mid: 9, pub_ts: 1700000000 } },
        3: {
          module_type: 'MODULE_TYPE_CONTENT',
          module_content: { paragraphs: [{ para_type: 1, text: { nodes: [{ type: 'TEXT_NODE_TYPE_WORD', word: { words: '正文' } }] } }] },
        },
      },
    },
  })};(function(){})();</script>`;
  const state = extractInitialState(html);
  assert.ok(state);
  const detail = parseOpusDetail(state);
  assert.equal(detail.title, 'SSR 标题');
  assert.equal(detail.author, '作者');
  assert.equal(detail.authorMid, '9');
  assert.equal(paragraphsToBlocks(detail.paragraphs)[0].text, '正文');
});

test('deriveTitle 截断长首行', () => {
  assert.equal(deriveTitle('短标题'), '短标题');
  assert.ok(deriveTitle('很'.repeat(50)).endsWith('…'));
});
