import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fetchJpAnnouncements, fetchCnAnnouncements, fetchGlobalAnnouncements } from '../src/announcements/sources.js';
import { htmlToBlocks } from '../src/announcements/html.js';
import { translateAnnouncement, limitAnnouncementMarkdown } from '../src/announcements/translate.js';
import { CosUploader, signCosV5, publicUrl, editorCdnUrl } from '../src/gamekee/obs.js';
import { GamekeeClient } from '../src/gamekee/client.js';
import { createApp } from '../src/app.js';
import { dateKeyOf } from '../src/util.js';
import { makeServices, testConfig } from './helpers.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const today = Date.parse('2026-11-17T00:00:00+08:00');
const options = { todayKey: '2026-11-17', timeZone: 'Asia/Shanghai' };

test('公告长度：超长正文保留上限与 30 张图片并注明截断', () => {
  const result = limitAnnouncementMarkdown('文'.repeat(40000) + Array.from({ length: 35 }, (_, n) => `\n![](https://img.example/${n}.png)`).join(''));
  assert.equal(result.truncated, true);
  assert.equal((result.markdown.match(/!\[\]/g) || []).length, 30);
  assert.ok(result.markdown.length < 33000);
  assert.match(result.markdown, /已截断/);
});

test('公告发布：真实 CookieSource 无 OBS 参数 → COS → type=2 与发布链接', async t => {
  const s = makeServices({ settings: { gamekeeCookieText: 'userToken=token; userUid=42', announcementProxy: 'http://127.0.0.1:7890' } });
  t.after(() => s.db.close());
  s.announcements.fetchImpl = async () => json({ data: { rows: [{ id: 1, title: '活动', content: '<p>正文</p><img src="/a.png">', publishTime: Date.now() }] } });
  const sync = await s.announcements.syncNow({ source: 'cn' });
  let uploaded = false;
  let downloaded = false;
  const fetchImpl = async (url, init) => {
    if (url.includes('getObsCredential')) return json({ code: 0, data: { ...credentials, access: 'AK', secret: 'SK' } });
    if (url.includes('myqcloud.com')) { uploaded = true; assert.match(init.headers.Authorization, /q-sign-algorithm=sha1/); return new Response(''); }
    if (url.includes('/content/add')) {
      const body = JSON.parse(init.body);
      assert.equal(body.type, 2);
      assert.equal(body.tag, '3');
      assert.match(body.thumb, /^\/\/cdnimg-v2.gamekee.com/);
      return json({ code: 0, data: { id: 123 } });
    }
    assert.ok(init.dispatcher);
    downloaded = true;
    const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  s.publish.fetchImpl = fetchImpl;
  s.publish.gamekeeFactory = snapshot => new GamekeeClient({ cookieText: snapshot.gamekeeCookieText, fetchImpl });
  const result = await s.publish.publishDraft(sync.created[0].draftId, { force: true });
  assert.equal(result.url, 'https://www.gamekee.com/ba/123.html');
  assert.ok(uploaded && downloaded);
});

test('公告源：日服今天边界、未来日期和分类，正文直接取列表', async () => {
  const result = await fetchJpAnnouncements({ ...options, fetchImpl: async url => {
    assert.match(url, /typeId=0&pageNum=50&pageIndex=1/);
    return json({ data: { rows: [0, 1, 2, 3].map((n) => ({ id: n, title: `标题${n}`, content: '<p>正文</p>', typeId: n, publishTime: today + (n - 1) * 1000 })) } });
  } });
  assert.deepEqual(result.map(x => x.tag), [3, 4, 2]);
  assert.equal(result[0].publishedAt, today);
  assert.equal(result[0].html, '<p>正文</p>');
});

test('公告源：国服仅新闻 type=1，关键词优先级和昨天过滤', async () => {
  const result = await fetchCnAnnouncements({ ...options, fetchImpl: async url => {
    assert.match(url, /type=1$/);
    return json({ data: { rows: ['维护活动', '招募', '情报', '昨天'].map((title, id) => ({ id, title, content: '正文', publishTime: today + (id === 3 ? -1 : 0) })) } });
  } });
  assert.deepEqual(result.map(x => x.tag), [2, 3, 4]);
  assert.equal(result[0].url, 'https://bluearchive-cn.com/news/0');
});

test('公告源：国际服强制代理、秒转毫秒、UA/Referer 和详情', async () => {
  await assert.rejects(fetchGlobalAnnouncements(options), { code: 'ANNOUNCEMENT_PROXY_REQUIRED' });
  const calls = [];
  const items = await fetchGlobalAnnouncements({ ...options, proxy: 'http://127.0.0.1:7890', fetchImpl: async (url, init) => {
    calls.push(url);
    assert.ok(init.dispatcher);
    assert.match(init.headers['User-Agent'], /Mozilla/);
    assert.match(init.headers.Referer, /board=3352/);
    return json(url.includes('/threads?') ? { threads: [{ threadId: 1, createDate: today / 1000 }, { threadId: 2, createDate: today / 1000 - 1 }] } : { title: '国际公告', content: '<p>详情</p>' });
  } });
  assert.equal(calls.length, 2);
  assert.equal(items[0].publishedAt, today);
  assert.equal(items[0].tag, 2);
  assert.match(items[0].url, /threadId=1$/);
});

test('公告源：置顶旧公告不会中断后续分页，三源请求走代理', async () => {
  let calls = 0;
  const items = await fetchJpAnnouncements({ ...options, proxy: 'http://127.0.0.1:7890', fetchImpl: async (url, init) => {
    assert.ok(init.dispatcher);
    calls++;
    return json({ data: { rows: calls === 1 ? Array.from({ length: 50 }, (_, id) => ({ id, publishTime: today - 1 })) : [{ id: 99, publishTime: today, content: '新公告' }] } });
  } });
  assert.equal(calls, 2);
  assert.equal(items[0].externalId, '99');
});

test('HTML→blocks：实体、图片、标题、列表、脚本清理与长段落截断', () => {
  const parsed = htmlToBlocks('<script>恶意</script><h2>标题&amp;测试</h2><ul><li>甲</li><li>乙</li></ul><img src="/a.png?a=1&amp;b=2"><p>123456789</p>', { maxChars: 9 });
  assert.equal(parsed.blocks[0].type, 'heading');
  assert.equal(parsed.blocks[0].text, '标题&测试');
  assert.deepEqual(parsed.blocks[1].items, ['甲', '乙']);
  assert.equal(parsed.blocks[2].url, '/a.png?a=1&b=2');
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.textLength, 9);
  assert.ok(!JSON.stringify(parsed).includes('恶意'));
  assert.equal(htmlToBlocks('<img src="a"><img src="b">', { maxImages: 1 }).imageCount, 1);
});

test('翻译：解析 fenced JSON，提示词变量、模型配置和图片补回', async () => {
  const result = await translateAnnouncement({ title: '原题', markdown: '正文\n\n![](https://example.com/a.png)', sourceLabel: '日服', prompt: '{{source}} {{title}} {{markdown}}', baseUrl: 'https://ai.example/v1/', model: 'mock', apiKey: 'secret', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://ai.example/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'mock');
    assert.match(body.messages[1].content, /日服 原题 正文/);
    return json({ choices: [{ message: { content: '```json\n{"title":"译题","markdown":"## 译文 2026"}\n```' } }] });
  } });
  assert.equal(result.title, '译题');
  assert.match(result.markdown, /!\[\]\(https:\/\/example.com\/a.png\)/);
});

test('翻译：HTTP、非 JSON、空正文和网络失败均拒绝', async () => {
  for (const fetchImpl of [async () => new Response('bad', { status: 500 }), async () => json({ choices: [{ message: { content: 'bad' } }] }), async () => json({ choices: [{ message: { content: '{"title":"题","markdown":""}' } }] }), async () => { throw new Error('secret'); }]) {
    await assert.rejects(translateAnnouncement({ title: '题', markdown: '文', baseUrl: 'https://ai.example', fetchImpl }));
  }
});

test('公告服务：升序选择上限、去重、国服跳过 AI、type/tag/前缀/通过/入队', async t => {
  const s = makeServices({ settings: { announcementMaxItemsPerRun: 1, autoPublish: true } });
  t.after(() => s.db.close());
  s.announcements.translateImpl = () => { throw new Error('国服不能翻译'); };
  const now = Date.now();
  s.announcements.fetchImpl = async () => json({ data: { rows: [{ id: 2, title: '活动', content: '<p>正文</p>', publishTime: now + 1000 }, { id: 1, title: '更新', content: '<p>正文</p><img src="/a.png">', publishTime: now }] } });
  const first = await s.announcements.syncNow({ source: 'cn' });
  assert.equal(first.created.length, 1);
  const draft = s.store.getDraft(first.created[0].draftId);
  assert.equal(draft.title, '【国服】更新');
  assert.equal(draft.type, 2);
  assert.equal(draft.tag, '2');
  assert.equal(draft.status, 'QUEUED');
  assert.match(draft.markdown, /https:\/\/bluearchive-cn.com\/a.png/);
  assert.match(draft.markdown, /来源/);
  assert.equal((await s.announcements.syncNow({ source: 'cn' })).created.length, 1);
  assert.equal((await s.announcements.syncNow({ source: 'cn' })).created.length, 0);
});

test('公告服务：翻译失败不落 post/draft，下一轮重试；相对图片与声明', async t => {
  const s = makeServices();
  t.after(() => s.db.close());
  s.announcements.fetchImpl = async () => json({ data: { rows: [{ id: 1, title: '原题', content: '<p>正文</p><img src="https://bluearchive.jp/image.png">', typeId: 1, publishTime: Date.now() }] } });
  s.announcements.translateImpl = async () => { throw new Error('AI failure'); };
  assert.equal((await s.announcements.syncNow({ source: 'jp' })).errors.length, 1);
  assert.equal(s.store.findPostByKey('announcement:jp:1'), null);
  assert.equal(s.store.listAnnouncementDrafts().length, 0);
  s.announcements.translateImpl = async input => ({ title: '译题', markdown: input.markdown });
  const result = await s.announcements.syncNow({ source: 'jp' });
  const draft = s.store.getDraft(result.created[0].draftId);
  assert.equal(draft.title, '【日服】译题');
  assert.equal(draft.status, 'APPROVED');
  assert.equal(draft.tag, '3');
  assert.match(draft.markdown, /https:\/\/bluearchive.jp\/image.png/);
  assert.match(draft.markdown, /本文由 AI 翻译整理/);
});

test('公告服务：关闭自动通过保持 DRAFT；调度只同步到期启用源', async t => {
  const s = makeServices({ settings: { announcementAutoApprove: false } });
  t.after(() => s.db.close());
  s.store.updateAnnouncementSource('jp', { enabled: false });
  s.store.updateAnnouncementSource('global', { lastSyncAt: Date.now() });
  s.announcements.fetchImpl = async url => { assert.match(url, /bluearchive-cn/); return json({ data: { rows: [{ id: 1, title: '新闻', content: '正文', publishTime: Date.now() }] } }); };
  const result = await s.announcements.syncNow({ dueOnly: true });
  assert.equal(result.sources.length, 1);
  assert.equal(s.store.getDraft(result.created[0].draftId).status, 'DRAFT');
  assert.equal((await s.announcements.syncNow({ dueOnly: true })).skipped, true);
});

const credentials = { provider: 'cos', access_key_id: 'AK', secret_access_key: 'SK', security_token: 'TOKEN', bucket_name: 'bucket-123', region: 'ap-shanghai', path: { image: 'wiki2.0/pro/829/images' } };

test('COS：V5 签名结构、上传 key、临时 token 与 CDN 选择', async () => {
  const now = new Date('2026-11-17T00:00:00Z');
  const signed = signCosV5({ key: 'a.png', headers: { host: 'bucket.test', 'x-cos-security-token': 'TOKEN' }, credentials, now });
  assert.match(signed, /^q-sign-algorithm=sha1&q-ak=AK&/);
  assert.match(signed, /q-header-list=host;x-cos-security-token/);
  assert.match(signed, /q-signature=[0-9a-f]{40}$/);
  const uploader = new CosUploader({ credentials, fetchImpl: async (url, init) => {
    assert.match(url, /^https:\/\/bucket-123.cos.ap-shanghai.myqcloud.com\/wiki2.0\/pro\/829\/images\/w_1\/h_1\/42\/2026\/11\/17\/[a-z0-9]{10}.png$/);
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers['x-cos-security-token'], 'TOKEN');
    assert.match(init.headers.Authorization, /q-signature=/);
    return new Response('', { status: 200 });
  } });
  const result = await uploader.upload(Buffer.from('image'), { uid: '42', ext: 'png', width: 1, height: 1, now });
  assert.equal(result.url, `https://cdnimg-v2.gamekee.com/${result.key}`);
  assert.equal(publicUrl('key'), 'https://cdnimg02.gamekee.com/key');
  assert.equal(editorCdnUrl(result.url), `//cdnimg-v2.gamekee.com/${result.key}`);
});

test('GameKee：无 OBS Cookie 动态请求 COS 凭证并复用缓存', async () => {
  let count = 0;
  const client = new GamekeeClient({ cookieText: 'userToken=token; userUid=42', fetchImpl: async (url) => {
    assert.match(url, /\/v1\/public\/getObsCredential$/);
    count++;
    return json({ code: 0, data: { ...credentials, access: 'AK', secret: 'SK' } });
  } });
  assert.equal((await client.getUploadCredentials()).provider, 'cos');
  await client.getUploadCredentials();
  assert.equal(count, 1);
});

test('公告图片下载：代理热更新与 GameKee CDN Referer/UA', async t => {
  const s = makeServices();
  t.after(() => s.db.close());
  s.publish.fetchImpl = async (url, init) => {
    assert.ok(init.dispatcher);
    assert.equal(init.headers.Referer, 'https://www.gamekee.com/');
    assert.match(init.headers['User-Agent'], /Mozilla/);
    return new Response(Buffer.alloc(24), { headers: { 'content-type': 'image/png' } });
  };
  await s.publish.downloadImage('https://cdnimg-v2.gamekee.com/a.png', 'http://127.0.0.1:7890');
});

test('公告服务：国际服译文前缀、更新分类与设置时区的今天边界', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-17T12:00:00Z'));
  const s = makeServices({ settings: { announcementProxy: 'http://127.0.0.1:7890', timeZone: 'America/New_York' } });
  t.after(() => s.db.close());
  const key = dateKeyOf(Date.now(), 'America/New_York');
  // New York is UTC-5 in November; derive local midnight from the date key.
  const midnight = Date.parse(`${key}T00:00:00-05:00`);
  s.announcements.fetchImpl = async url => url.includes('/threads?')
    ? json({ threads: [{ threadId: 1, createDate: midnight / 1000 }, { threadId: 2, createDate: midnight / 1000 - 1 }] })
    : json({ title: '原题', content: '<p>正文</p>' });
  s.announcements.translateImpl = async input => ({ title: '译题', markdown: input.markdown });
  const result = await s.announcements.syncNow({ source: 'global' });
  assert.equal(result.created.length, 1);
  const draft = s.store.getDraft(result.created[0].draftId);
  assert.equal(draft.title, '【国际服】译题');
  assert.equal(draft.type, 2);
  assert.equal(draft.tag, '2');
});

test('公告 API：列表、源开关校验、同步、代理测试与凭证不泄漏', async t => {
  const { app, services: s, close } = createApp({ config: testConfig(), startWorker: false });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/announcements')).body.sources.length, 3);
  assert.equal((await request('/announcements/sources/nope', 'PATCH', { enabled: false })).status, 404);
  assert.equal((await request('/announcements/sources/cn', 'PATCH', { enabled: 'false' })).status, 400);
  assert.equal((await request('/announcements/sources/cn', 'PATCH', { enabled: false })).body.source.enabled, false);
  assert.equal((await request('/announcements/sync', 'POST', { source: 'cn' })).status, 409);
  await request('/announcements/sources/cn', 'PATCH', { enabled: true });
  s.announcements.fetchImpl = async () => json({ data: { rows: [] } });
  assert.equal((await request('/announcements/sync', 'POST', { source: 'cn' })).body.created.length, 0);
  assert.equal((await request('/settings/test', 'POST', { target: 'proxy' })).body.ok, false);
  s.settings.update({ announcementProxy: 'http://user:secret@127.0.0.1:7890' });
  s.announcements.fetchImpl = async (url, init) => { assert.ok(init.dispatcher); return json({ threads: [] }); };
  const proxy = (await request('/settings/test', 'POST', { target: 'proxy' })).body;
  assert.equal(proxy.ok, true);
  assert.equal(proxy.status, 200);
  assert.equal(typeof proxy.elapsedMs, 'number');
  assert.ok(!JSON.stringify(proxy).includes('secret'));
  s.announcements.fetchImpl = async () => new Response('Forbidden', { status: 403 });
  assert.equal((await request('/settings/test', 'POST', { target: 'proxy' })).body.status, 403);
  s.publish.fetchImpl = async (url, init) => {
    assert.equal(init.headers.Referer, 'https://www.gamekee.com/');
    assert.match(init.headers['User-Agent'], /Mozilla/);
    return new Response(Buffer.from('image'), { headers: { 'content-type': 'image/png' } });
  };
  const preview = await fetch(`${base}/api/proxy/image?url=${encodeURIComponent('https://cdnimg-v2.gamekee.com/a.png')}`);
  assert.equal(preview.status, 200);
  assert.equal((await request('/settings', 'PATCH', { announcementProxy: 'socks5://localhost' })).status, 400);
});

test('公告调度：间隔、下次抓取与自动抓取开关', t => {
  const s = makeServices({ settings: { announcementSyncIntervalSeconds: 600, announcementAutoSync: false } });
  t.after(() => s.db.close());
  s.store.updateAnnouncementSource('jp', { lastSyncAt: 1_700_000_000_000 });
  const schedule = s.announcements.getSchedule();
  assert.equal(schedule.autoSync, false);
  assert.equal(schedule.intervalSeconds, 600);
  assert.equal(schedule.nextSyncAt, 1_700_000_000_000 + 600_000);
  const jp = s.store.listAnnouncementSources().find(item => item.key === 'jp');
  assert.equal(jp.enabled, true);
});
