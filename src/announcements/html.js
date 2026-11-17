/**
 * 官方公告 HTML → 统一 blocks。
 * 不引入 DOM 解析器：公告页结构简单，按块级标签/图片切分即可，
 * 重点是保留图片顺序、去掉内联样式与脚本。
 */

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', bull: '•', times: '×',
  copy: '©', reg: '®', trade: '™', yen: '¥', deg: '°',
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return '';
        }
      }
      return '';
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attr(tag, name) {
  const match = String(tag).match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function normalizeImageUrl(src) {
  const value = String(src || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return value; // 相对路径交给调用方补全
  return value;
}

function cleanLine(text) {
  return decodeEntities(text)
    .replace(/[\u200b\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * @returns {{blocks: object[], truncated: boolean, imageCount: number, textLength: number}}
 */
export function htmlToBlocks(html, { maxImages = 30, maxChars = 30000 } = {}) {
  let source = String(html ?? '');
  source = source
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match, attributes, content) => {
      const href = decodeEntities(attr(`a ${attributes}`, 'href'));
      return /^https?:\/\//i.test(href) && !/<img\b/i.test(content) ? `[${content}](${href})` : content;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // 图片先打标记，避免被 strip 阶段丢掉。
  source = source.replace(/<img\b[^>]*>/gi, tag => {
    const fields = [
      normalizeImageUrl(attr(tag, 'src') || attr(tag, 'data-src')),
      attr(tag, 'width'),
      attr(tag, 'height'),
      attr(tag, 'alt'),
    ].map(value => String(value).replace(/\u0001/g, ' '));
    return `\n@@IMG@@${fields.join('\u0001')}@@\n`;
  });

  source = source
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n---\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<td\b[^>]*>/gi, ' | ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  const blocks = [];
  let textLength = 0;
  let imageCount = 0;
  let truncated = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = cleanLine(rawLine);
    if (!line) continue;

    const imageMatch = line.match(/^@@IMG@@([\s\S]*?)@@$/);
    if (imageMatch) {
      if (imageCount >= maxImages) {
        truncated = true;
        continue;
      }
      const [src, width, height, alt] = imageMatch[1].split('\u0001');
      if (!src) continue;
      blocks.push({
        type: 'image',
        url: src,
        width: Number.parseInt(width, 10) || null,
        height: Number.parseInt(height, 10) || null,
        alt: alt || '',
      });
      imageCount += 1;
      continue;
    }

    if (line === '---') {
      blocks.push({ type: 'divider' });
      continue;
    }

    let text = line.replace(/^##\s+/, '').replace(/^-\s+/, '');
    const prefix = line.startsWith('## ') ? 'heading' : line.startsWith('- ') ? 'list' : 'text';
    if (textLength + text.length > maxChars) {
      truncated = true;
      text = text.slice(0, Math.max(0, maxChars - textLength));
      if (!text) continue;
    }
    textLength += text.length;
    if (prefix === 'heading') blocks.push({ type: 'heading', level: 2, text });
    else if (prefix === 'list') blocks.push({ type: 'list', ordered: false, items: [text] });
    else blocks.push({ type: 'text', text });
  }

  // 相邻的同级列表合并成真正的多行列表。
  const merged = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (block.type === 'list' && previous?.type === 'list' && previous.ordered === block.ordered) {
      previous.items.push(...block.items);
    } else {
      merged.push(block);
    }
  }

  if (truncated) {
    merged.push({ type: 'text', text: '（内容过长，已截断，完整内容请查看原文。）' });
  }
  return { blocks: merged, truncated, imageCount, textLength };
}
