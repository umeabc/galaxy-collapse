import { fetchWithProxy } from '../net/proxy.js';
import { AppError, dateKeyOf, truncate } from '../util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const ANNOUNCEMENT_SOURCES = {
  jp: { key: 'jp', label: '日服', home: 'https://bluearchive.jp/news/newsJump', tag: 4, tagName: '情报' },
  global: { key: 'global', label: '国际服', home: 'https://forum.nexon.com/bluearchiveTW/board_list?board=3352', tag: 2, tagName: '更新' },
  cn: { key: 'cn', label: '国服', home: 'https://bluearchive-cn.com', tag: 4, tagName: '情报' },
};

export const TAG_LABELS = { 2: '更新', 3: '活动', 4: '情报' };

async function getJson(url, { proxy = '', fetchImpl, headers = {} } = {}) {
  let response;
  try {
  response = await fetchWithProxy(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,zh-TW;q=0.7',
      ...headers,
    },
    signal: AbortSignal.timeout(30000),
  }, proxy, fetchImpl);
  } catch {
    throw new AppError('公告源请求失败，请检查网络或公告代理', { code: 'SOURCE_NETWORK', status: 502 });
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    if (response.status === 403) {
      throw new AppError(
        proxy
          ? '请求被源站拒绝（403）；请确认代理可用或更换出口'
          : '源站拒绝匿名访问（403）：国际服请先在设置里配置公告代理',
        { code: 'SOURCE_FORBIDDEN', status: 502, details: { httpStatus: response.status } },
      );
    }
    throw new AppError(`源站返回非 JSON（HTTP ${response.status}）`, { code: 'SOURCE_BAD_RESPONSE', status: 502, details: { httpStatus: response.status } });
  }
  if (!response.ok) throw new AppError(`源站 HTTP ${response.status}`, { code: 'SOURCE_HTTP_ERROR', status: 502, details: { httpStatus: response.status } });
  return payload;
}

function jpTag(typeId) {
  if (Number(typeId) === 3) return 2; // 维护
  if (Number(typeId) === 1) return 3; // 活动
  return 4; // お知らせ
}

function cnTag(title) {
  if (/维护|更新|版本|修复/.test(title)) return 2;
  if (/活动|招募|卡池|签到|登录|联动|复刻/.test(title)) return 3;
  return 4;
}

function inToday(timestamp, todayKey, timeZone) {
  if (!timestamp) return false;
  return dateKeyOf(timestamp, timeZone) >= todayKey;
}

export async function fetchJpAnnouncements({ proxy = '', fetchImpl, timeZone = 'Asia/Shanghai', todayKey = dateKeyOf(Date.now(), timeZone), maxPages = 3 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await getJson(`https://api-web.bluearchive.jp/api/news/list?typeId=0&pageNum=50&pageIndex=${page}`, { proxy, fetchImpl });
    const rows = payload?.data?.rows ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      if (!inToday(row.publishTime, todayKey, timeZone)) continue;
      items.push({
        source: 'jp',
        externalId: String(row.id),
        title: String(row.summary || row.title || '公告').trim(),
        html: String(row.content || ''),
        publishedAt: Number(row.publishTime) || Date.now(),
        url: `${ANNOUNCEMENT_SOURCES.jp.home}/${row.id}`,
        tag: jpTag(row.typeId),
      });
    }
    if (rows.length < 50) break;
  }
  return items;
}

export async function fetchCnAnnouncements({ proxy = '', fetchImpl, timeZone = 'Asia/Shanghai', todayKey = dateKeyOf(Date.now(), timeZone), maxPages = 3 } = {}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await getJson(`https://bluearchive-cn.com/api/news/list?pageIndex=${page}&pageNum=50&type=1`, { proxy, fetchImpl });
    const rows = payload?.data?.rows ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      if (!inToday(row.publishTime, todayKey, timeZone)) continue;
      const title = String(row.title || '公告').trim();
      items.push({
        source: 'cn',
        externalId: String(row.id),
        title,
        html: String(row.content || ''),
        publishedAt: Number(row.publishTime) || Date.now(),
        url: `https://bluearchive-cn.com/news/${row.id}`,
        tag: cnTag(title),
      });
    }
    if (rows.length < 50) break;
  }
  return items;
}

export async function fetchGlobalAnnouncements({ proxy = '', fetchImpl, timeZone = 'Asia/Shanghai', todayKey = dateKeyOf(Date.now(), timeZone), maxPages = 4 } = {}) {
  if (!proxy) throw new AppError('国际服必须在设置中配置公告代理', { code: 'ANNOUNCEMENT_PROXY_REQUIRED', status: 400 });
  const items = [];
  const listHeaders = { Referer: 'https://forum.nexon.com/bluearchiveTW/board_list?board=3352' };
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await getJson(
      `https://forum.nexon.com/api/v1/board/3352/threads?alias=bluearchivetw&pageNo=${page}&paginationType=PAGING&pageSize=15&blockSize=5&hideType=WEB`,
      { proxy, fetchImpl, headers: listHeaders },
    );
    const threads = payload?.threads ?? [];
    if (!threads.length) break;
    for (const thread of threads) {
      const publishedAt = Number(thread.createDate) * 1000;
      if (!inToday(publishedAt, todayKey, timeZone)) continue;
      const detail = await getJson(
        `https://forum.nexon.com/api/v1/thread/${thread.threadId}?alias=bluearchivetw`,
        { proxy, fetchImpl, headers: listHeaders },
      );
      items.push({
        source: 'global',
        externalId: String(thread.threadId),
        title: String(detail.title || thread.title || '公告').trim(),
        html: String(detail.content || ''),
        publishedAt,
        url: `https://forum.nexon.com/bluearchiveTW/board_view?board=3352&threadId=${thread.threadId}`,
        tag: 2,
      });
    }
    const lastThread = threads[threads.length - 1];
    const lastTimestamp = Number(lastThread?.createDate) * 1000;
    if (threads.length < 15 || !inToday(lastTimestamp, todayKey, timeZone)) break;
  }
  return items;
}

export async function fetchAnnouncementSource(sourceKey, options = {}) {
  if (sourceKey === 'jp') return fetchJpAnnouncements(options);
  if (sourceKey === 'cn') return fetchCnAnnouncements(options);
  if (sourceKey === 'global') return fetchGlobalAnnouncements(options);
  throw new AppError(`未知公告源：${truncate(sourceKey, 20)}`, { code: 'SOURCE_UNKNOWN', status: 400 });
}
