import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blocksToMarkdown,
  imagesFromMarkdown,
  markdownToBlocks,
  plainTextFromMarkdown,
  summaryFromMarkdown,
} from '../src/convert/markdown.js';

test('blocks → markdown → blocks 保留文本/图片/标题/列表', () => {
  const blocks = [
    { type: 'text', text: '第一段' },
    { type: 'heading', level: 2, text: '小标题' },
    { type: 'image', url: 'https://i0.hdslb.com/a.png', alt: '' },
    { type: 'list', ordered: false, items: ['要点一', '要点二'] },
    { type: 'quote', text: '引用内容' },
  ];
  const markdown = blocksToMarkdown(blocks);
  assert.match(markdown, /第一段/);
  assert.match(markdown, /## 小标题/);
  assert.match(markdown, /!\[\]\(https:\/\/i0\.hdslb\.com\/a\.png\)/);
  assert.match(markdown, /- 要点一\n- 要点二/);
  assert.match(markdown, /^> 引用内容$/m);

  const round = markdownToBlocks(markdown);
  assert.equal(round[0].type, 'text');
  assert.equal(round[0].text, '第一段');
  assert.equal(round[1].type, 'heading');
  assert.equal(round[1].level, 2);
  assert.equal(round[2].type, 'image');
  assert.deepEqual(imagesFromMarkdown(markdown), ['https://i0.hdslb.com/a.png']);
});

test('markdown 行内链接/粗体不会破坏纯文本与摘要', () => {
  const markdown = '本文转载自 B 站 @碧诗，[原文链接](https://www.bilibili.com/read/cv1)。\n\n**重点**内容';
  assert.equal(plainTextFromMarkdown(markdown), '本文转载自 B 站 @碧诗，原文链接。 重点内容');
  assert.ok(summaryFromMarkdown(markdown, 10).endsWith('…'));
  assert.equal(summaryFromMarkdown('短文本', 10), '短文本');
});

test('代码块与分隔线可往返', () => {
  const markdown = '```\nconst a = 1;\n```\n\n---';
  const blocks = markdownToBlocks(markdown);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].text, 'const a = 1;');
  assert.equal(blocks[1].type, 'divider');
});
