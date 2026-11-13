import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliClient } from '../src/bili/client.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function response(payload, { url = '', setCookies = [] } = {}) {
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      getSetCookie: () => setCookies,
      get: () => null,
    },
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

const WBI = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
};

test('BiliClient：匿名 nav(-101) 仍取 WBI，buvid3/buvid4 同时进入 Cookie', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    if (String(url).includes('/x/frontend/finger/spi')) {
      return response({ code: 0, data: { b_3: 'B3', b_4: 'B4' } });
    }
    if (String(url).includes('/x/web-interface/nav')) {
      return response({ code: -101, data: { wbi_img: WBI } });
    }
    if (String(url).includes('/feed/space')) {
      return response({ code: 0, data: { items: [{ id_str: '1', type: 'DYNAMIC_TYPE_WORD' }], offset: 'next' } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const client = new BiliClient({ fetchImpl });
  const feed = await client.dynamicFeed({ mid: '2' });
  assert.equal(feed.items.length, 1);
  assert.equal(feed.offset, 'next');

  const feedCall = calls.find(call => call.url.includes('/feed/space'));
  assert.ok(feedCall.url.includes('w_rid='));
  assert.ok(feedCall.url.includes('host_mid=2'));
  assert.ok(feedCall.headers.Cookie.includes('buvid3=B3'));
  assert.ok(feedCall.headers.Cookie.includes('buvid4=B4'));
});

test('BiliClient：动态流偶发空列表会重新签名重试', async () => {
  let feedCalls = 0;
  const fetchImpl = async url => {
    if (String(url).includes('/spi')) return response({ code: 0, data: { b_3: 'B3', b_4: 'B4' } });
    if (String(url).includes('/nav')) return response({ code: -101, data: { wbi_img: WBI } });
    feedCalls += 1;
    if (feedCalls === 1) return response({ code: 0, data: { items: [], offset: '' } });
    return response({ code: 0, data: { items: [{ id_str: '9' }], offset: 'x' } });
  };
  const client = new BiliClient({ fetchImpl });
  const feed = await client.dynamicFeed({ mid: '2' });
  assert.equal(feedCalls, 2);
  assert.equal(feed.items.length, 1);
});

test('BiliClient：按域匹配 cookie 文件（不把 B 站 cookie 发给其他域）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bilic-'));
  const file = join(dir, 'cookies.txt');
  writeFileSync(file, '.bilibili.com	TRUE	/	TRUE	0	SESSDATA	secret');
  const client = new BiliClient({ cookieFile: file });
  assert.ok(client._cookieHeader('api.bilibili.com').includes('SESSDATA=secret'));
  assert.equal(client._cookieHeader('www.gamekee.com'), '');
});
