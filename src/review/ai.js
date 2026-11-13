import { truncate } from '../util.js';

export const DEFAULT_PROMPT = `你是 GameKee 碧蓝档案 wiki 社区的内容审核员。
请审核下面这篇准备从 B 站转载到 GameKee 的文章，判断它是否适合发布。

审核标准：
1. 与《碧蓝档案》或二次元游戏社区相关、信息真实、可读性正常 → approve
2. 含广告、引流诈骗、违法、色情露骨、恶意引战、无意义灌水、明显侵权搬运（未注明来源）→ reject
3. 拿不准（信息可疑、争议内容、与分区关系弱）→ review

只输出一个 JSON 对象，不要输出其他文字：
{"decision":"approve|reject|review","confidence":0.0-1.0,"reason":"不超过80字的中文理由","risk":["可选的风险标签"]}

标题：{{title}}
作者：{{author}}
来源：{{sourceUrl}}
正文：
{{content}}`;

export function renderPrompt(template, variables = {}) {
  return String(template ?? DEFAULT_PROMPT).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => {
    const value = variables[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

export class AiReviewError extends Error {
  constructor(message, { code = 'AI_ERROR', details = null } = {}) {
    super(message);
    this.name = 'AiReviewError';
    this.code = code;
    this.details = details;
  }
}

function extractJson(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
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

const DECISIONS = new Set(['approve', 'reject', 'review']);

/**
 * 调用 OpenAI 兼容的 /chat/completions 做审核。
 * 返回 {decision, confidence, reason, risk, model, rawText}。
 */
export async function reviewWithAi({
  title,
  author,
  sourceUrl,
  content,
  prompt,
  baseUrl,
  apiKey,
  model,
  timeoutMs = 60000,
  minConfidence = 0.6,
  fetchImpl = globalThis.fetch,
}) {
  if (!baseUrl) throw new AiReviewError('AI_BASE_URL 未配置', { code: 'AI_NOT_CONFIGURED' });
  const systemPrompt = '你只输出严格 JSON，不要 Markdown 代码块，不要解释。';
  const userPrompt = renderPrompt(prompt || DEFAULT_PROMPT, {
    title: title ?? '',
    author: author ?? '',
    sourceUrl: sourceUrl ?? '',
    content: truncate(content ?? '', 12000),
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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new AiReviewError('AI 审核请求失败（网络/超时）', { code: 'AI_NETWORK' });
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new AiReviewError(`AI 审核接口返回 HTTP ${response.status}`, {
      code: 'AI_HTTP_ERROR',
      details: truncate(text, 300),
    });
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AiReviewError('AI 响应不是 JSON', { code: 'AI_BAD_RESPONSE' });
  }
  const rawText = payload?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(rawText);
  if (!parsed || !DECISIONS.has(parsed.decision)) {
    throw new AiReviewError('AI 未返回可解析的审核结论', { code: 'AI_UNPARSABLE', details: truncate(rawText, 300) });
  }
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  let decision = parsed.decision;
  if (decision === 'approve' && confidence < minConfidence) decision = 'review';
  return {
    decision,
    confidence,
    reason: truncate(parsed.reason ?? '', 200),
    risk: Array.isArray(parsed.risk) ? parsed.risk.slice(0, 10).map(String) : [],
    model: payload?.model || model || null,
    rawText: truncate(rawText, 2000),
  };
}
