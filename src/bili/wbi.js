import { createHash } from 'node:crypto';

/** B 站 WBI 签名：nav 接口的两个图片 key → mixinKey → 参数 + wts + w_rid(md5)。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export function keyFromUrl(url) {
  return String(url || '').split('/').pop().split('.')[0];
}

export function mixinKey(imgKey, subKey) {
  const raw = `${keyFromUrl(imgKey)}${keyFromUrl(subKey)}`;
  return MIXIN_KEY_ENC_TAB.map(index => raw[index] ?? '').join('').slice(0, 32);
}

export function signParams(params, key, now = Date.now()) {
  const withTs = { ...params, wts: Math.floor(now / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map(name => {
      const value = String(withTs[name] ?? '').replace(/[!'()*]/g, '');
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/** 从 nav 响应里解析签名 key；结构缺失时返回 null。 */
export function wbiKeysFromNav(navData) {
  const img = navData?.wbi_img;
  if (!img?.img_url || !img?.sub_url) return null;
  return mixinKey(img.img_url, img.sub_url);
}
