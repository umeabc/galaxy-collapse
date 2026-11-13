import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServices } from './helpers.js';
import { materializeDraft } from '../src/services/sync.js';

function pngBuffer(width = 1200, height = 800) {
  const buffer = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fakeGamekee(capture) {
  return {
    cookieStatus: () => ({ hasUserToken: true, hasObsParams: true, valid: true }),
    cookieStore: {
      get: () => '399789',
      getObsCredentials: () => ({
        access_key_id: 'AK',
        secret_access_key: 'SK',
        security_token: 'TOKEN',
        server: 'obs.cn-north-1.myhuaweicloud.com',
        bucket_name: 'wiki-obs',
        path: { image: 'wiki2.0/pro/829/images' },
      }),
    },
    addArticle: async payload => {
      capture.push({ mode: 'add', payload });
      return { contentId: '12345' };
    },
    editArticle: async (id, payload) => {
      capture.push({ mode: 'edit', id, payload });
      return { contentId: id };
    },
    articleUrl: id => `https://www.gamekee.com/ba/${id}.html`,
  };
}

function draftWithImage(services) {
  const snapshot = services.settings.getSnapshot();
  return materializeDraft({
    store: services.store,
    snapshot,
    item: {
      sourceKey: `publish:${Math.random().toString(16).slice(2)}`,
      kind: 'article',
      title: '发布测试文章',
      author: '作者',
      authorMid: '1',
      url: 'https://www.bilibili.com/opus/1',
      publishedAt: Date.now(),
      blocks: [
        { type: 'text', text: '第一段 **加粗** 内容' },
        { type: 'heading', level: 2, text: '小标题' },
        { type: 'image', url: 'https://i0.hdslb.com/bfs/note/test.png' },
      ],
    },
  });
}

function mockFetch(capture) {
  return async (url, init = {}) => {
    if (String(url).includes('myhuaweicloud.com')) {
      capture.push({ mode: 'obs-put', url: String(url), method: init.method });
      return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    }
    capture.push({ mode: 'image-get', url: String(url), referer: init.headers?.Referer });
    const buffer = pngBuffer();
    return {
      ok: true,
      status: 200,
      headers: { get: name => (name === 'content-type' ? 'image/png' : name === 'content-length' ? String(buffer.length) : null) },
      arrayBuffer: async () => buffer,
    };
  };
}

test('发布：图片下载 → OBS → content_json/thumb/image_list → 记录 publication', async () => {
  const services = makeServices({ settings: { publishWindowStart: '00:00', publishWindowEnd: '23:59' } });
  const capture = [];
  services.publish.gamekeeFactory = () => fakeGamekee(capture);
  services.publish.fetchImpl = mockFetch(capture);
  const draft = draftWithImage(services);

  const result = await services.publish.publishDraft(draft.id, { force: true, actor: 'test' });
  assert.equal(result.contentId, '12345');

  const add = capture.find(item => item.mode === 'add');
  assert.ok(add, 'addArticle 被调用');
  const payload = add.payload;
  assert.equal(payload.title, '发布测试文章');
  assert.equal(payload.editor_type, 1);
  assert.equal(payload.content, '');
  assert.ok(payload.summary.includes('第一段'));
  assert.ok(payload.thumb.startsWith('//cdnimg-v2.gamekee.com/'));
  assert.equal(payload.image_list.length, 1);
  assert.ok(payload.image_list[0].startsWith('//cdnimg-v2.gamekee.com/'));

  const nodes = JSON.parse(payload.content_json);
  assert.ok(nodes.some(node => node.type === 'header2'));
  const image = nodes.flatMap(node => node.children ?? []).find(child => child.type === 'image');
  assert.ok(image.src.startsWith('//cdnimg-v2.gamekee.com/'));
  assert.equal(image.style.width, '1200px');
  assert.equal(image.style.height, '800px');

  const obs = capture.find(item => item.mode === 'obs-put');
  assert.equal(obs.method, 'PUT');
  assert.match(obs.url, /w_1200\/h_800\/399789\//);

  const imageGet = capture.find(item => item.mode === 'image-get');
  assert.equal(imageGet.referer, 'https://www.bilibili.com/');

  assert.equal(services.store.getDraft(draft.id).status, 'PUBLISHED');
  const publication = services.store.getPublicationByDraft(draft.id);
  assert.equal(publication.content_id, '12345');
  assert.equal(publication.url, 'https://www.gamekee.com/ba/12345.html');
  assert.ok(services.store.getMedia('https://i0.hdslb.com/bfs/note/test.png'));
});

test('发布：已发布文章可以走 content/edit 覆盖更新', async () => {
  const services = makeServices({ settings: { publishWindowStart: '00:00', publishWindowEnd: '23:59' } });
  const capture = [];
  services.publish.gamekeeFactory = () => fakeGamekee(capture);
  services.publish.fetchImpl = mockFetch(capture);
  const draft = draftWithImage(services);
  await services.publish.publishDraft(draft.id, { force: true });
  await services.publish.publishDraft(draft.id, { mode: 'edit', contentId: '12345', force: true });

  const edit = capture.find(item => item.mode === 'edit');
  assert.ok(edit);
  assert.equal(edit.id, '12345');
  assert.equal(edit.payload.title, '发布测试文章');
});

test('发布：缺少 GameKee cookie 时拒绝并给出 AUTH_REQUIRED', async () => {
  const services = makeServices();
  const draft = draftWithImage(services);
  await assert.rejects(
    services.publish.publishDraft(draft.id, { force: true }),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );
});
