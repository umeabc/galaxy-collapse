import { AppError, truncate } from '../util.js';
import { imagesFromMarkdown } from '../convert/markdown.js';

export function limitAnnouncementMarkdown(markdown, { maxChars = 30000, maxImages = 30 } = {}) {
  const images = imagesFromMarkdown(markdown).slice(0, maxImages);
  let text = String(markdown).replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '');
  const truncated = text.length > maxChars || imagesFromMarkdown(markdown).length > maxImages;
  if (!truncated) return { markdown: String(markdown), truncated: false };
  text = text.slice(0, maxChars);
  return { markdown: `${text.trim()}\n\n${images.map(url => `![](${url})`).join('\n')}\n\n（内容过长，已截断，完整内容请查看原文。）`, truncated: true };
}

export const DEFAULT_TRANSLATE_PROMPT = `你是《蔚蓝档案》官方公告的本地化译者。请把下面的公告翻译成简体中文。

要求：
1. 保持 Markdown 结构，图片 ![](...) 的 URL、数字、日期、版本号、专有名词保持不变。
2. 使用简中社区常用译名（老师、学生、青辉石、招募、维护、活动、总力战等）。
3. 不要添加解释、不要省略内容；无法翻译的专有名词保留原文。
4. 只输出一个 JSON 对象，不要输出 Markdown 代码块：
{"title":"简体中文标题","markdown":"简体中文正文（Markdown）"}

来源：{{source}}
原文标题：{{title}}
原文正文：
{{markdown}}`;

export function renderTranslatePrompt(template, variables) {
  return String(template || DEFAULT_TRANSLATE_PROMPT).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => {
    const value = variables[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

function extractJson(text) {
  const source = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch.charCodeAt(0) === 92) escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 翻译公告（标题 + Markdown 正文）。要求模型返回 JSON，失败时抛错由调用方决定是否重试。
 */
export async function translateAnnouncement({
  title,
  markdown,
  sourceLabel,
  prompt,
  baseUrl,
  apiKey,
  model,
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch,
  maxChars = 30000,
}) {
  if (!baseUrl) throw new AppError('需要配置 AI Base URL 才能翻译公告', { code: 'AI_NOT_CONFIGURED', status: 400 });
  const limited = limitAnnouncementMarkdown(markdown || '', { maxChars });
  const input = limited.markdown;
  const userPrompt = renderTranslatePrompt(prompt, {
    source: sourceLabel || '',
    title: title || '',
    markdown: input,
  });

  let response;
  try {
    response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: '你只输出严格 JSON，不要 Markdown 代码块。' },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AppError('AI 翻译请求失败（网络/超时）', { code: 'AI_NETWORK', status: 502 });
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new AppError(`AI 翻译接口 HTTP ${response.status}：${truncate(text, 200)}`, { code: 'AI_HTTP_ERROR', status: 502 });
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AppError('AI 翻译响应不是 JSON', { code: 'AI_BAD_RESPONSE', status: 502 });
  }
  const content = payload?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(content);
  if (!parsed || typeof parsed.title !== 'string' || typeof parsed.markdown !== 'string' || !parsed.title.trim() || !parsed.markdown.trim()) {
    throw new AppError('AI 翻译未返回可解析的 title/markdown', { code: 'AI_UNPARSABLE', status: 502 });
  }
  // 模型偶尔会丢图片；把原文里有、译文里没有的图片补回末尾，避免公告配图缺失。
  let translatedMarkdown = parsed.markdown.trim();
  const originalImages = imagesFromMarkdown(input).slice(0, 30);
  const translatedImages = new Set(imagesFromMarkdown(translatedMarkdown));
  const missing = originalImages.filter(url => !translatedImages.has(url));
  if (missing.length) translatedMarkdown += `\n\n${missing.map(url => `![](${url})`).join('\n')}`;
  return {
    title: parsed.title.trim(),
    markdown: translatedMarkdown,
    truncated: limited.truncated,
  };
}
