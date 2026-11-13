import { escapeHtml, randomKey } from '../util.js';
import { markdownToBlocks, imagesFromMarkdown } from './markdown.js';

/**
 * GameKee wiki-editor（editor_type=1）的 Slate-like JSON 构造。
 * 节点类型来自站点 bundle 实测：paragraph / header1..5 / bulleted-list / numbered-list /
 * list-item / image / link / divider。文本 run 带 color/bold/bgColor/text/fontSize。
 */

const FONT_SIZE = '18px';

function run(text, { bold = false, italic = false } = {}) {
  const value = { color: '', bold: Boolean(bold), bgColor: '', text: String(text), fontSize: FONT_SIZE };
  if (italic) value.italic = true;
  return value;
}

/** Markdown 行内语法 → Slate runs（**粗体**、*斜体*、`代码`、[文字](链接)）。 */
export function parseInlineRuns(text) {
  const source = String(text ?? '');
  const runs = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let cursor = 0;
  let match;
  const pushPlain = value => {
    if (value) runs.push(run(value));
  };
  while ((match = pattern.exec(source))) {
    pushPlain(source.slice(cursor, match.index));
    if (match[1] !== undefined) runs.push(run(match[1], { bold: true }));
    else if (match[2] !== undefined) runs.push(run(match[2], { italic: true }));
    else if (match[3] !== undefined) runs.push(run(match[3]));
    else if (match[4] !== undefined) {
      runs.push({ type: 'link', url: match[5], children: [run(match[4])] });
    }
    cursor = pattern.lastIndex;
  }
  pushPlain(source.slice(cursor));
  return runs.length ? runs : [run('')];
}

function paragraph(children, extra = {}) {
  return {
    type: 'paragraph',
    customClass: null,
    lineHeight: '',
    textAlign: 'start',
    indent: '0px',
    ...extra,
    children: children.length ? children : [run('')],
  };
}

function imageNode({ src, width, height, alt = '' }) {
  return {
    type: 'image',
    key: randomKey(16),
    src,
    alt,
    isAdaptive: true,
    style: { width: `${Number(width) || 800}px`, height: `${Number(height) || 600}px` },
    children: [{ text: '' }],
  };
}

function headingNode(level, children) {
  const tag = `header${Math.min(5, Math.max(1, Number(level) || 2))}`;
  return {
    type: tag,
    customClass: null,
    lineHeight: '',
    textAlign: 'start',
    indent: '0px',
    children,
  };
}

function listNode(items, ordered) {
  return {
    type: ordered ? 'numbered-list' : 'bulleted-list',
    customClass: null,
    lineHeight: '',
    textAlign: 'start',
    indent: '0px',
    children: items.map(item => ({ type: 'list-item', children: [paragraph(parseInlineRuns(item))] })),
  };
}

function resolveImage(imageMap, url) {
  const entry = imageMap instanceof Map ? imageMap.get(url) : imageMap?.[url];
  if (!entry) return null;
  if (typeof entry === 'string') return { src: entry, width: 800, height: 600 };
  return { src: entry.cdnUrl || entry.src || url, width: entry.width, height: entry.height };
}

/**
 * @param {string} markdown 草稿正文
 * @param {{imageMap?: Map|object, attribution?: string}} options
 * @returns {{nodes: object[], missingImages: string[], images: string[], text: string}}
 */
export function buildSlate(markdown, { imageMap = new Map(), attribution = '' } = {}) {
  const blocks = markdownToBlocks(markdown);
  const nodes = [];
  const missingImages = [];
  const usedImages = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        nodes.push(headingNode(block.level, parseInlineRuns(block.text)));
        break;
      case 'image': {
        const resolved = resolveImage(imageMap, block.url);
        if (!resolved) {
          missingImages.push(block.url);
          break;
        }
        usedImages.push(block.url);
        nodes.push(paragraph([run(''), imageNode(resolved), run('')]));
        break;
      }
      case 'list':
        nodes.push(listNode(block.items, block.ordered));
        break;
      case 'quote':
        nodes.push(paragraph(parseInlineRuns(block.text).map(item => (item.text !== undefined ? { ...item, italic: true } : item))));
        break;
      case 'code':
        for (const line of String(block.text).split('\n')) nodes.push(paragraph([run(line)]));
        break;
      case 'divider':
        nodes.push({ type: 'divider', children: [{ text: '' }] });
        break;
      case 'link':
        nodes.push(paragraph([block.title ? { type: 'link', url: block.url, children: [run(block.title)] } : run(block.url)]));
        break;
      case 'text':
      default:
        nodes.push(paragraph(parseInlineRuns(block.text)));
        break;
    }
  }

  if (attribution) nodes.push(paragraph(parseInlineRuns(attribution)));

  return { nodes, missingImages, images: usedImages, text: markdown };
}

/** editor_type=0 的 HTML 版本（保留链接/图片，文本全部转义）。 */
export function buildHtml(markdown, { imageMap = new Map(), attribution = '' } = {}) {
  const blocks = markdownToBlocks(markdown);
  const html = [];
  const missingImages = [];
  const usedImages = [];

  const inline = text => String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        html.push(`<h${Math.min(5, Math.max(2, block.level))}>${inline(block.text)}</h${Math.min(5, Math.max(2, block.level))}>`);
        break;
      case 'image': {
        const resolved = resolveImage(imageMap, block.url);
        if (!resolved) {
          missingImages.push(block.url);
          break;
        }
        usedImages.push(block.url);
        html.push(`<p><img src="${escapeHtml(resolved.src)}" alt="" width="${Number(resolved.width) || 800}" height="${Number(resolved.height) || 600}"></p>`);
        break;
      }
      case 'list':
        html.push(`<${block.ordered ? 'ol' : 'ul'}>${block.items.map(item => `<li>${inline(item)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`);
        break;
      case 'quote':
        html.push(`<blockquote>${inline(block.text).replace(/\n/g, '<br>')}</blockquote>`);
        break;
      case 'code':
        html.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`);
        break;
      case 'divider':
        html.push('<hr>');
        break;
      case 'link':
        html.push(`<p><a href="${escapeHtml(block.url)}" target="_blank" rel="noopener">${escapeHtml(block.title || block.url)}</a></p>`);
        break;
      case 'text':
      default:
        html.push(`<p>${inline(block.text)}</p>`);
        break;
    }
  }
  if (attribution) html.push(`<p>${inline(attribution)}</p>`);
  return { html: html.join('\n'), missingImages, images: usedImages };
}

/** 递归提取 Slate 树里的图片 src（发布后校验用）。 */
export function collectSlateImages(nodes) {
  const urls = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image' && node.src) urls.push(node.src);
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of nodes ?? []) walk(node);
  return urls;
}

/** Slate 树纯文本（长度校验/摘要核对用）。 */
export function slateText(nodes) {
  const parts = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of nodes ?? []) walk(node);
  return parts.join('');
}

export function imageUrlsFromMarkdown(markdown) {
  return imagesFromMarkdown(markdown);
}
