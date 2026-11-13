/** 关键字审核：允许/拦截/标记三组关键词，命中最严格的一条。 */

export function parseKeywordList(value) {
  if (Array.isArray(value)) return [...new Set(value.map(item => String(item).trim()).filter(Boolean))];
  return [...new Set(
    String(value ?? '')
      .split(/[\n,，;；]+/)
      .map(item => item.trim())
      .filter(Boolean),
  )];
}

export function matchKeyword(text, keywords) {
  const haystack = String(text ?? '').toLowerCase();
  for (const keyword of keywords) {
    const needle = String(keyword).toLowerCase();
    if (needle && haystack.includes(needle)) return keyword;
  }
  return null;
}

/**
 * @returns {{decision: 'approve'|'reject'|'flag'|null, keyword: string|null, rule: string|null}}
 */
export function evaluateKeywords(text, { allow = [], block = [], flag = [] } = {}) {
  const blocked = matchKeyword(text, block);
  if (blocked) return { decision: 'reject', keyword: blocked, rule: 'block' };
  const flagged = matchKeyword(text, flag);
  if (flagged) return { decision: 'flag', keyword: flagged, rule: 'flag' };
  const allowed = matchKeyword(text, allow);
  if (allowed) return { decision: 'approve', keyword: allowed, rule: 'allow' };
  return { decision: null, keyword: null, rule: null };
}
