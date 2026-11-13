import { normalizeWhitespace } from '../util.js';

/** 与站点无关的 blocks ⇄ Markdown（草稿编辑与预览都用 Markdown 作为可读载体）。 */

export function blocksToMarkdown(blocks = []) {
  const parts = [];
  let listBuffer = null;

  const flushList = () => {
    if (!listBuffer) return;
    parts.push(listBuffer.items.map((item, index) => `${listBuffer.ordered ? `${index + 1}.` : '-'} ${item}`).join('\n'));
    listBuffer = null;
  };

  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'list') {
      flushList();
      listBuffer = { ordered: Boolean(block.ordered), items: [...(block.items ?? [])] };
      continue;
    }
    flushList();
    switch (block.type) {
      case 'heading':
        parts.push(`${'#'.repeat(Math.min(5, Math.max(2, block.level || 2)))} ${block.text ?? ''}`.trim());
        break;
      case 'image':
        parts.push(`![${block.alt ?? ''}](${block.url ?? ''})`);
        break;
      case 'quote':
        parts.push(String(block.text ?? '').split('\n').map(line => `> ${line}`).join('\n'));
        break;
      case 'code':
        parts.push(['```', String(block.text ?? ''), '```'].join('\n'));
        break;
      case 'link':
        parts.push(block.title ? `[${block.title}](${block.url})` : String(block.url ?? ''));
        break;
      case 'divider':
        parts.push('---');
        break;
      case 'text':
      default:
        if (String(block.text ?? '').trim()) parts.push(String(block.text).trimEnd());
        break;
    }
  }
  flushList();
  return normalizeWhitespace(parts.join('\n\n'));
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const DIVIDER = /^-{3,}$/;

export function markdownToBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith('```')) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = trimmed.match(HEADING);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (DIVIDER.test(trimmed)) {
      blocks.push({ type: 'divider' });
      index += 1;
      continue;
    }
    const image = trimmed.match(IMAGE);
    if (image) {
      blocks.push({ type: 'image', alt: image[1], url: image[2], width: null, height: null });
      index += 1;
      continue;
    }
    if (BULLET.test(trimmed) || ORDERED.test(trimmed)) {
      const ordered = ORDERED.test(trimmed);
      const items = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = ordered ? current.match(ORDERED) : current.match(BULLET);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (QUOTE.test(trimmed)) {
      const quoted = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = current.match(QUOTE);
        if (!match) break;
        quoted.push(match[1]);
        index += 1;
      }
      blocks.push({ type: 'quote', text: quoted.join('\n') });
      continue;
    }
    // 普通段落：逐行成段，避免把中文软换行粘成一行。
    blocks.push({ type: 'text', text: trimmed });
    index += 1;
  }
  return blocks;
}

export function plainTextFromMarkdown(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+[.)]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summaryFromMarkdown(markdown, max = 120) {
  const text = plainTextFromMarkdown(markdown);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function imagesFromMarkdown(markdown) {
  const urls = [];
  const regex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let match;
  while ((match = regex.exec(String(markdown ?? '')))) {
    if (!urls.includes(match[1])) urls.push(match[1]);
  }
  return urls;
}
