import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKeywords, matchKeyword, parseKeywordList } from '../src/review/keywords.js';
import { reviewWithAi, renderPrompt, DEFAULT_PROMPT } from '../src/review/ai.js';

test('关键字解析与优先级：拦截 > 标记 > 通过', () => {
  assert.deepEqual(parseKeywordList('a, b\nc，d；e'), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(matchKeyword('碧蓝档案攻略', ['攻略']), '攻略');
  const reject = evaluateKeywords('这里有广告', { allow: ['广告投放'], block: ['广告'] });
  assert.equal(reject.decision, 'reject');
  const flag = evaluateKeywords('可能有争议', { allow: ['争议'], flag: ['争议'] });
  assert.equal(flag.decision, 'flag');
  const approve = evaluateKeywords('碧蓝档案', { allow: ['碧蓝档案'] });
  assert.equal(approve.decision, 'approve');
  assert.equal(evaluateKeywords('普通内容', {}).decision, null);
});

test('提示词变量替换', () => {
  const text = renderPrompt('标题：{{title}}；作者：{{author}}；{{missing}}', { title: 'T', author: 'A' });
  assert.equal(text, '标题：T；作者：A；');
  assert.ok(DEFAULT_PROMPT.includes('{{content}}'));
});

const mockFetch = payload => async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ model: 'mock', choices: [{ message: { content: payload } }] }),
});

test('AI 审核：解析代码块中的 JSON 并返回结论', async () => {
  const result = await reviewWithAi({
    title: '标题',
    author: '作者',
    sourceUrl: 'https://example.com',
    content: '正文',
    baseUrl: 'http://mock/v1',
    apiKey: 'k',
    model: 'mock',
    minConfidence: 0.6,
    fetchImpl: mockFetch('```json\n{"decision":"approve","confidence":0.9,"reason":"正常内容"}\n```'),
  });
  assert.equal(result.decision, 'approve');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.reason, '正常内容');
});

test('AI 审核：低置信度 approve 降级为 review', async () => {
  const result = await reviewWithAi({
    title: 't',
    content: 'c',
    baseUrl: 'http://mock/v1',
    minConfidence: 0.8,
    fetchImpl: mockFetch('{"decision":"approve","confidence":0.3,"reason":"模糊"}'),
  });
  assert.equal(result.decision, 'review');
});

test('AI 审核：接口错误与非 JSON 结论都抛错', async () => {
  await assert.rejects(
    reviewWithAi({ title: 't', content: 'c', baseUrl: 'http://mock/v1', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) }),
    /HTTP 500/,
  );
  await assert.rejects(
    reviewWithAi({ title: 't', content: 'c', baseUrl: 'http://mock/v1', fetchImpl: mockFetch('我觉得可以') }),
    /审核结论/,
  );
});
