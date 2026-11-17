import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArticlePayload, GamekeeClient } from '../src/gamekee/client.js';
import { buildObjectKey, editorCdnUrl, parseImageSize, publicUrl, signObsV2 } from '../src/gamekee/obs.js';
import { CookieJar, InlineCookieJar, domainMatches, parseCookieText, parseJsonCookies, parseNetscape } from '../src/cookies.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('文章 payload：富文本模式走 content_json，HTML 模式走 content', () => {
  const rich = buildArticlePayload({ title: 'T', summary: 'S', thumb: '//cdn/a.jpg', imageList: ['//cdn/a.jpg'], contentJson: '[]', editorType: 1, gameId: '829' });
  assert.equal(rich.editor_type, 1);
  assert.equal(rich.content, '');
  assert.equal(rich.content_json, '[]');
  assert.deepEqual(rich.game, { game_id: 829 });
  assert.equal(rich.type, 4);
  assert.equal(rich.tag, '2');

  const html = buildArticlePayload({ title: 'T', content: '<p>x</p>', editorType: 0 });
  assert.equal(html.content, '<p>x</p>');
  assert.equal(html.content_json, '');
});

test('图片尺寸：PNG/JPEG 文件头', () => {
  const png = Buffer.alloc(30);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(parseImageSize(png), { width: 1200, height: 800, format: 'png' });

  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  assert.deepEqual(parseImageSize(jpeg), { width: 800, height: 600, format: 'jpeg' });
});

test('OBS key / CDN / 签名格式', () => {
  const key = buildObjectKey({ basePath: 'wiki2.0/pro/829/images', uid: '399789', ext: 'jpg', width: 800, height: 600, now: new Date('2026-11-12T00:00:00Z') });
  assert.match(key, /^wiki2\.0\/pro\/829\/images\/w_800\/h_600\/399789\/2026\/11\/12\/[a-z0-9]{10}\.jpg$/);
  assert.equal(publicUrl(key), `https://cdnimg02.gamekee.com/${key}`);
  assert.equal(editorCdnUrl(`https://cdnimg02.gamekee.com/${key}`), `//cdnimg02.gamekee.com/${key}`);
  const { authorization } = signObsV2({
    method: 'PUT',
    bucket: 'wiki-obs',
    key,
    headers: { 'content-type': 'image/jpeg', 'x-obs-date': new Date('2026-11-12T00:00:00Z').toUTCString(), 'x-obs-security-token': 't' },
    credentials: { access_key_id: 'AK', secret_access_key: 'SK' },
  });
  assert.match(authorization, /^OBS AK:/);
});

test('Cookie：Netscape 解析、子域匹配、OBS 凭证解码', () => {
  const netscape = [
    '# Netscape HTTP Cookie File',
    '.gamekee.com\tTRUE\t/\tTRUE\t0\tuserToken\tabc.def.ghi',
    'www.gamekee.com\tFALSE\t/\tTRUE\t0\tuserUid\t399789',
    `www.gamekee.com\tFALSE\t/\tTRUE\t0\tobs_client_params\t${encodeURIComponent(JSON.stringify({ bucket_name: 'wiki-obs', access_key_id: 'AK', path: { image: 'wiki2.0/pro/829/images' } }))}`,
  ].join('\n');
  const parsed = parseNetscape(netscape);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].domain, 'gamekee.com');
  assert.equal(domainMatches('gamekee.com', 'www.gamekee.com', true), true);
  assert.equal(domainMatches('gamekee.com', 'evil-gamekee.com', true), false);

  const dir = mkdtempSync(join(tmpdir(), 'gkc-'));
  const file = join(dir, 'cookies.txt');
  writeFileSync(file, netscape);
  const jar = new CookieJar(file).reload();
  assert.equal(jar.get('www.gamekee.com', 'userUid'), '399789');
  assert.equal(jar.obsCredentials().bucket_name, 'wiki-obs');
  assert.ok(jar.headerFor('www.gamekee.com').includes('userToken='));
  assert.equal(jar.headerFor('example.com'), '');
});

test('Cookie：JSON 导出兜底', () => {
  const cookies = parseJsonCookies(JSON.stringify([{ name: 'SESSDATA', value: 'x', domain: '.bilibili.com' }]));
  assert.equal(cookies[0].name, 'SESSDATA');
  assert.equal(parseJsonCookies(JSON.stringify({ a: '1' }), { fallbackDomain: '.bilibili.com' })[0].domain, '.bilibili.com');
});


test('Cookie：设置页粘贴文本（Cookie 头 / JSON / Netscape）', () => {
  const header = parseCookieText('Cookie: userToken=tok; userUid=399789; obs_client_params=%7B%22bucket_name%22%3A%22wiki-obs%22%7D', { fallbackDomain: 'www.gamekee.com' });
  assert.equal(header.length, 3);
  assert.equal(header[1].name, 'userUid');
  assert.equal(header[1].value, '399789');

  const json = parseCookieText(JSON.stringify({ userToken: 'a.b.c', userUid: '1', obs_client_params: 'x' }), { fallbackDomain: 'www.gamekee.com' });
  assert.equal(json.length, 3);

  const netscape = parseCookieText('.gamekee.com	TRUE	/	TRUE	0	userToken	tok', { fallbackDomain: 'www.gamekee.com' });
  assert.equal(netscape[0].includeSubdomains, true);
});

test('Cookie：InlineCookieJar 提供 header/OBS/状态', () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const token = `h.${payload}.s`;
  const obs = encodeURIComponent(JSON.stringify({ bucket_name: 'wiki-obs', path: { image: 'wiki2.0/pro/829/images' } }));
  const jar = new InlineCookieJar(`userToken=${token}; userUid=399789; obs_client_params=${obs}`, { fallbackDomain: 'www.gamekee.com' });
  assert.ok(jar.headerFor('www.gamekee.com').includes('userToken='));
  assert.equal(jar.get('www.gamekee.com', 'userUid'), '399789');
  assert.equal(jar.obsCredentials().bucket_name, 'wiki-obs');
  const status = jar.sessionInfo('www.gamekee.com');
  assert.equal(status.source, 'inline');
  assert.equal(status.valid, true);
  assert.equal(status.hasObsParams, true);
});

test('GamekeeClient：使用设置页粘贴的 cookie 发请求', async () => {
  let captured = null;
  const client = new GamekeeClient({
    cookieText: 'userToken=access-token-value; userUid=399789; obs_client_params=%7B%22bucket_name%22%3A%22wiki-obs%22%7D',
    fetchImpl: async (url, init) => {
      captured = { url: String(url), headers: init.headers };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { username: 'tester' } }) };
    },
  });
  const info = await client.myInfo();
  assert.equal(info.username, 'tester');
  assert.equal(captured.headers['Access-Token'], 'access-token-value');
  assert.ok(captured.headers.Cookie.includes('userUid=399789'));
  assert.ok(captured.url.endsWith('/v1/protected/user/myInfo'));
});
