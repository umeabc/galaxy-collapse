import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml, buildSlate, collectSlateImages, parseInlineRuns } from '../src/convert/slate.js';

const imageMap = new Map([
  ['https://i0.hdslb.com/a.png', { cdnUrl: '//cdnimg-v2.gamekee.com/wiki2.0/a.png', width: 1200, height: 800 }],
]);

test('Slate：段落/标题/列表/图片/转载声明', () => {
  const markdown = [
    '第一段 **加粗** 与 [链接](https://example.com)',
    '## 小标题',
    '- 要点一\n- 要点二',
    '![](https://i0.hdslb.com/a.png)',
    '本文转载自 B 站 @作者，[原文链接](https://www.bilibili.com/read/cv1)。',
  ].join('\n\n');

  const result = buildSlate(markdown, { imageMap });
  assert.deepEqual(result.missingImages, []);
  const [p1, h2, list, imageParagraph, attribution] = result.nodes;

  assert.equal(p1.type, 'paragraph');
  assert.equal(p1.children[0].text, '第一段 ');
  assert.equal(p1.children[1].bold, true);
  assert.equal(p1.children[1].text, '加粗');
  assert.equal(p1.children.at(-1).type, 'link');
  assert.equal(p1.children.at(-1).url, 'https://example.com');

  assert.equal(h2.type, 'header2');
  assert.equal(list.type, 'bulleted-list');
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].type, 'list-item');
  assert.equal(list.children[0].children[0].type, 'paragraph');

  assert.equal(imageParagraph.type, 'paragraph');
  const image = imageParagraph.children.find(child => child.type === 'image');
  assert.equal(image.src, '//cdnimg-v2.gamekee.com/wiki2.0/a.png');
  assert.equal(image.style.width, '1200px');

  assert.ok(attribution.children.some(child => child.type === 'link'));
  assert.deepEqual(collectSlateImages(result.nodes), ['//cdnimg-v2.gamekee.com/wiki2.0/a.png']);
});

test('Slate：未上传的图片会进入 missingImages 而不是静默丢失', () => {
  const result = buildSlate('![](https://i0.hdslb.com/missing.png)', { imageMap: new Map() });
  assert.deepEqual(result.missingImages, ['https://i0.hdslb.com/missing.png']);
  assert.equal(result.nodes.length, 0);
});

test('HTML 版本转义文本并保留图片/链接', () => {
  const { html } = buildHtml('<script>alert(1)</script>\n\n![](https://i0.hdslb.com/a.png)', { imageMap });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('cdnimg-v2.gamekee.com'));
});

test('行内解析：粗体/斜体/代码/链接', () => {
  const runs = parseInlineRuns('A**B**C*D*E`F`[G](https://x.y)');
  assert.equal(runs[0].text, 'A');
  assert.equal(runs[1].bold, true);
  assert.equal(runs[3].italic, true);
  assert.equal(runs[5].text, 'F');
  assert.equal(runs[6].type, 'link');
});
