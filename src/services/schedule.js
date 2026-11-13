import { isWithinWindow, zonedParts } from '../util.js';

/**
 * 发布闸门：暂停 / 时间窗 / 日限 / 最小间隔。
 * 所有判断都是只读的，返回给前端可直接展示原因。
 */
export function checkSchedule({ settings, store, now = Date.now() }) {
  const snapshot = settings.getSnapshot();
  const timeZone = snapshot.timeZone || 'Asia/Shanghai';
  const { dateKey, minutes } = zonedParts(new Date(now), timeZone);
  const details = {
    paused: Boolean(snapshot.paused),
    windowStart: snapshot.publishWindowStart,
    windowEnd: snapshot.publishWindowEnd,
    inWindow: isWithinWindow(minutes, snapshot.publishWindowStart, snapshot.publishWindowEnd),
    dailyLimit: snapshot.dailyLimit,
    publishedToday: store.countPublishedOn(dateKey),
    intervalSeconds: snapshot.publishIntervalSeconds,
    lastPublishedAt: store.lastPublishedAt(),
    timeZone,
    dateKey,
    localTime: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
  };
  details.remainingToday = Math.max(0, details.dailyLimit - details.publishedToday);
  if (details.paused) return { allowed: false, code: 'QUEUE_PAUSED', reason: '发布队列已暂停', details };
  if (!details.inWindow) return { allowed: false, code: 'OUTSIDE_WINDOW', reason: `不在发布窗口 ${details.windowStart}-${details.windowEnd}（当前 ${details.localTime}）`, details };
  if (details.remainingToday <= 0) return { allowed: false, code: 'DAILY_LIMIT', reason: `已达到每日上限 ${details.dailyLimit}`, details };
  if (details.lastPublishedAt && now - details.lastPublishedAt < details.intervalSeconds * 1000) {
    const seconds = Math.ceil((details.intervalSeconds * 1000 - (now - details.lastPublishedAt)) / 1000);
    return { allowed: false, code: 'INTERVAL', reason: `距离上次发布不足 ${details.intervalSeconds} 秒（还需 ${seconds} 秒）`, details };
  }
  return { allowed: true, code: 'OK', reason: '', details };
}
