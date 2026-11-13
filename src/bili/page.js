/**
 * B 站 opus/read 页面解析。
 *
 * 2026-11 实测：`/read/cv<id>` 会 302 到 `/opus/<opusId>`，页面 SSR 内嵌
 * `window.__INITIAL_STATE__ = {...};`，其中 detail.modules 按 MODULE_TYPE_* 给出
 * 标题、作者、正文段落。正文段落是结构化 JSON（不是 HTML），适合直接映射到编辑器。
 */

/** 从 HTML 中截取 `__INITIAL_STATE__` 的 JSON 对象（括号配对，跳过字符串内的括号）。 */
export function extractInitialState(html) {
  const marker = String(html).indexOf('window.__INITIAL_STATE__');
  if (marker < 0) return null;
  const start = String(html).indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch {
          // SSR 里偶尔出现 undefined 字面量；只替换 JSON 结构位置上的 undefined。
          try {
            return JSON.parse(raw.replace(/:\s*undefined\b/g, ':null').replace(/,\s*undefined\b/g, ',null'));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

export function moduleOf(detail, type) {
  const modules = detail?.modules;
  if (!modules) return null;
  const list = Array.isArray(modules) ? modules : Object.values(modules);
  return list.find(module => module?.module_type === type) ?? null;
}

/** SSR detail → 统一结构（只保留后续需要的字段）。 */
export function parseOpusDetail(state, { url = '' } = {}) {
  const detail = state?.detail ?? state?.readInfo?.detail ?? state?.readInfo ?? null;
  if (!detail || !detail.modules) return null;

  const titleModule = moduleOf(detail, 'MODULE_TYPE_TITLE');
  const authorModule = moduleOf(detail, 'MODULE_TYPE_AUTHOR');
  const contentModule = moduleOf(detail, 'MODULE_TYPE_CONTENT');
  const copyrightModule = moduleOf(detail, 'MODULE_TYPE_COPYRIGHT');

  const title = titleModule?.module_title?.text ?? '';
  const author = authorModule?.module_author ?? {};
  const paragraphs = contentModule?.module_content?.paragraphs ?? [];
  const opusId = detail.id_str ?? null;

  return {
    opusId,
    title: String(title).trim(),
    author: author.name ?? '',
    authorMid: author.mid ? String(author.mid) : '',
    publishedAt: Number(author.pub_ts) ? Number(author.pub_ts) * 1000 : null,
    paragraphs: Array.isArray(paragraphs) ? paragraphs : [],
    url: url || (opusId ? `https://www.bilibili.com/opus/${opusId}` : ''),
    copyright: copyrightModule?.module_copyright ?? null,
    type: detail.type ?? null,
  };
}

const TEXT_NODE_TEXT = node => {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'TEXT_NODE_TYPE_WORD':
      return node.word?.words ?? '';
    case 'TEXT_NODE_TYPE_RICH':
      return node.rich?.text ?? node.rich?.content ?? '';
    case 'TEXT_NODE_TYPE_FORMULA':
      return node.formula?.latex ? `$${node.formula.latex}$` : '';
    case 'TEXT_NODE_TYPE_AT':
      return node.user?.name ? `@${node.user.name}` : '';
    case 'TEXT_NODE_TYPE_EMOJI':
      return node.emoji?.text ?? '';
    default:
      return node.word?.words ?? node.text ?? '';
  }
};

export function paragraphText(paragraph) {
  const nodes = paragraph?.text?.nodes;
  if (Array.isArray(nodes)) return nodes.map(TEXT_NODE_TEXT).join('');
  return paragraph?.text?.text ?? '';
}

/** 结构化段落 → 与站点无关的 blocks（text/heading/image/list/quote/code/link/divider）。 */
export function paragraphsToBlocks(paragraphs) {
  const blocks = [];
  for (const paragraph of paragraphs ?? []) {
    if (!paragraph) continue;
    const alt = paragraph.alt ?? '';
    if (paragraph.heading) {
      blocks.push({
        type: 'heading',
        level: Math.min(5, Math.max(2, Number(paragraph.heading.level) || 2)),
        text: paragraphText(paragraph) || paragraph.heading.text || '',
      });
      continue;
    }
    if (paragraph.code) {
      blocks.push({ type: 'code', text: paragraphText(paragraph) || paragraph.code.content || '' });
      continue;
    }
    if (paragraph.list) {
      const items = Array.isArray(paragraph.list.items)
        ? paragraph.list.items.map(item => {
          if (typeof item === 'string') return item;
          if (Array.isArray(item?.nodes)) return item.nodes.map(TEXT_NODE_TEXT).join('');
          return item?.text ?? '';
        })
        : [];
      if (items.length) blocks.push({ type: 'list', ordered: Number(paragraph.list.style) === 2, items });
      continue;
    }
    if (paragraph.link_card) {
      const card = paragraph.link_card;
      blocks.push({ type: 'link', url: card.url ?? card.jump_url ?? '', title: card.title ?? card.text ?? '' });
      continue;
    }
    if (paragraph.blockquote) {
      blocks.push({ type: 'quote', text: paragraphText(paragraph) || paragraph.blockquote.text || '' });
      continue;
    }
    if (paragraph.line) {
      blocks.push({ type: 'divider' });
      continue;
    }
    const pics = paragraph.pic?.pics;
    if (Array.isArray(pics) && pics.length) {
      for (const pic of pics) {
        if (!pic?.url) continue;
        blocks.push({
          type: 'image',
          url: pic.url,
          width: Number(pic.width) || null,
          height: Number(pic.height) || null,
          alt,
        });
      }
      continue;
    }
    const text = paragraphText(paragraph).trim();
    if (text) blocks.push({ type: 'text', text });
  }
  return blocks;
}

/** 动态 item 的 opus/文章页 URL（用于取全文）。 */
export function hydrationUrl(item) {
  const md = item?.modules?.module_dynamic;
  const major = md?.major;
  if (!major) return null;
  if (major.type === 'MAJOR_TYPE_OPUS' && major.opus?.jump_url) return normalizeBiliUrl(major.opus.jump_url);
  if (major.type === 'MAJOR_TYPE_ARTICLE' && major.article?.jump_url) return normalizeBiliUrl(major.article.jump_url);
  return null;
}

export function normalizeBiliUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `https://www.bilibili.com${url}`;
  return url;
}
