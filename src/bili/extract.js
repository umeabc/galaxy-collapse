import { normalizeBiliUrl } from './page.js';

/** 从动态/专栏列表项提取与站点无关的元信息（正文由 client 再取全文补充）。 */

export function deriveTitle(text, fallback = 'B 站动态') {
  const firstLine = String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  const cleaned = firstLine.replace(/^#+\s*/, '').replace(/[【】[\]「」]/g, '').trim();
  const source = cleaned || firstLine;
  return source.length > 40 ? `${source.slice(0, 39)}…` : source;
}

function authorOf(item) {
  const author = item?.modules?.module_author ?? {};
  return {
    author: author.name ?? '',
    authorMid: author.mid ? String(author.mid) : '',
    publishedAt: Number(author.pub_ts) ? Number(author.pub_ts) * 1000 : null,
  };
}

function opusIdOf(item) {
  const jumpUrl = normalizeBiliUrl(item?.basic?.jump_url || item?.modules?.module_dynamic?.major?.opus?.jump_url || '');
  const match = jumpUrl.match(/\/opus\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * 动态 item → 统一草稿素材。
 * @returns {null|{sourceKey,kind,title,author,authorMid,publishedAt,url,blocks,hydrateUrl}}
 */
export function extractDynamicItem(item, { includeForwards = false } = {}) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'DYNAMIC_TYPE_FORWARD' && !includeForwards) return null;

  const meta = authorOf(item);
  const md = item.modules?.module_dynamic ?? {};
  const major = md.major ?? null;
  const text = String(md.desc?.text ?? '').trim();
  const blocks = [];

  // 转发：保留转发语 + 原动态内容（原动态存在 item.orig）。
  if (item.type === 'DYNAMIC_TYPE_FORWARD') {
    const prefix = [];
    if (text) prefix.push({ type: 'text', text });
    const original = item.orig ? extractDynamicItem(item.orig, { includeForwards: false }) : null;
    if (original?.blocks?.length) {
      prefix.push({ type: 'text', text: `// 转发自 @${original.author || 'B 站用户'}` });
      blocks.push(...original.blocks);
    }
    return {
      sourceKey: `dynamic:${item.id_str ?? ''}`,
      kind: 'dynamic',
      dynamicType: item.type,
      title: deriveTitle(text || original?.title || '', `${meta.author || 'B 站'}的转发`),
      ...meta,
      url: normalizeBiliUrl(item.basic?.jump_url || ''),
      blocks: [...prefix, ...blocks],
      // 原动态是 opus/文章时，用 full 页面补全正文，但保留转发语。
      hydrateUrl: original?.hydrateUrl ?? null,
      forwardPrefix: original?.hydrateUrl ? prefix : null,
    };
  }

  if (text) blocks.push({ type: 'text', text });

  let title = '';
  let hydrateUrl = null;
  let url = normalizeBiliUrl(item.basic?.jump_url || '');

  if (major?.type === 'MAJOR_TYPE_OPUS') {
    const opus = major.opus ?? {};
    title = String(opus.title ?? '').trim();
    if (!text && opus.summary?.text) blocks.push({ type: 'text', text: String(opus.summary.text) });
    for (const pic of opus.pics ?? []) {
      if (!pic?.url) continue;
      blocks.push({ type: 'image', url: pic.url, width: Number(pic.width) || null, height: Number(pic.height) || null, alt: '' });
    }
    hydrateUrl = opus.jump_url ? normalizeBiliUrl(opus.jump_url) : null;
  } else if (major?.type === 'MAJOR_TYPE_ARTICLE') {
    const article = major.article ?? {};
    title = String(article.title ?? '').trim();
    if (article.desc && !text) blocks.push({ type: 'text', text: String(article.desc) });
    for (const cover of article.covers ?? []) {
      if (typeof cover === 'string') blocks.push({ type: 'image', url: cover, width: null, height: null, alt: '' });
    }
    hydrateUrl = article.jump_url ? normalizeBiliUrl(article.jump_url) : null;
  } else if (major?.type === 'MAJOR_TYPE_DRAW') {
    for (const pic of major.draw?.items ?? []) {
      if (!pic?.src) continue;
      blocks.push({ type: 'image', url: pic.src, width: Number(pic.width) || null, height: Number(pic.height) || null, alt: '' });
    }
  } else if (major?.type === 'MAJOR_TYPE_ARCHIVE') {
    const archive = major.archive ?? {};
    title = String(archive.title ?? '').trim();
    if (archive.desc && !text) blocks.push({ type: 'text', text: String(archive.desc) });
    if (archive.cover) blocks.push({ type: 'image', url: archive.cover, width: null, height: null, alt: '' });
    if (archive.jump_url) blocks.push({ type: 'link', url: normalizeBiliUrl(archive.jump_url), title: archive.title ?? '视频' });
  }

  const opusId = opusIdOf(item);
  const sourceKey = opusId ? `opus:${opusId}` : `dynamic:${item.id_str ?? ''}`;
  if (!title) title = deriveTitle(text, `${meta.author || 'B 站'}的动态`);
  if (!url) url = hydrateUrl || `https://www.bilibili.com/opus/${opusId ?? ''}`;

  return {
    sourceKey,
    kind: 'dynamic',
    dynamicType: item.type ?? '',
    title,
    ...meta,
    url,
    blocks,
    hydrateUrl,
  };
}

/** 专栏列表项 → 统一素材（正文由 read 页重定向后的 opus 页面取）。 */
export function extractArticleItem(article) {
  if (!article || !article.id) return null;
  const author = article.author ?? {};
  return {
    sourceKey: `article:${article.id}`,
    kind: 'article',
    title: String(article.title ?? '').trim(),
    author: author.name ?? '',
    authorMid: author.mid ? String(author.mid) : '',
    publishedAt: Number(article.publish_time) ? Number(article.publish_time) * 1000 : null,
    url: `https://www.bilibili.com/read/cv${article.id}`,
    blocks: [],
    hydrateUrl: null,
    articleId: String(article.id),
    summary: String(article.summary ?? ''),
  };
}
