#!/usr/bin/env node
/**
 * 命令行诊断工具（只读，不发任何写请求）。
 *
 *   node tools/probe.mjs article https://www.bilibili.com/read/cv53711426
 *   node tools/probe.mjs opus    https://www.bilibili.com/opus/1265772221318561798
 *   node tools/probe.mjs dynamic 2 [limit]
 *   node tools/probe.mjs feed    2
 *
 * 读取 .env 中的 BILI_COOKIE_FILE（可选）。输出不会包含 cookie/token。
 */
import config from '../src/config.js';
import { BiliClient } from '../src/bili/client.js';
import { extractArticleItem, extractDynamicItem } from '../src/bili/extract.js';
import { blocksToMarkdown, imagesFromMarkdown, summaryFromMarkdown } from '../src/convert/markdown.js';
import { buildSlate } from '../src/convert/slate.js';
import { paragraphsToBlocks } from '../src/bili/page.js';

const [command, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`用法:
  node tools/probe.mjs article <url|id>     抓取专栏/read 页面并打印转换结果
  node tools/probe.mjs opus    <url|id>     抓取 opus 页面
  node tools/probe.mjs dynamic <mid> [n]    列出空间动态前 n 条
  node tools/probe.mjs feed    <mid>        只检查动态流是否可访问

读取 .env 的 BILI_COOKIE_FILE（可选）。`);
}

function makeClient() {
  return new BiliClient({ cookieFile: config.bili.cookieFile, timeoutMs: 25000 });
}

function printBlocks(blocks) {
  const markdown = blocksToMarkdown(blocks);
  const images = imagesFromMarkdown(markdown);
  const slate = buildSlate(markdown, { imageMap: new Map(images.map(url => [url, { cdnUrl: url, width: 800, height: 600 }])) });
  console.log(`\n块数量: ${blocks.length}  图片: ${images.length}`);
  console.log(`Slate 节点: ${slate.nodes.length}（缺图 ${slate.missingImages.length}）`);
  console.log(`摘要: ${summaryFromMarkdown(markdown)}`);
  console.log('\n--- Markdown ---\n');
  console.log(markdown.slice(0, 4000));
  if (markdown.length > 4000) console.log('\n…（截断）');
}

async function runArticle(input, useOpus) {
  if (!input) return usage();
  const client = makeClient();
  const isUrl = /^https?:/.test(input);
  let detail;
  if (useOpus || isUrl && input.includes('/opus/')) {
    const url = isUrl ? input : `https://www.bilibili.com/opus/${input}`;
    detail = await client.opusPage(url);
  } else {
    const id = isUrl ? (input.match(/cv(\d+)/)?.[1] ?? input) : input;
    detail = await client.articlePage(id);
  }
  console.log(`标题: ${detail.title}`);
  console.log(`作者: ${detail.author} (mid=${detail.authorMid})`);
  console.log(`来源: ${detail.url}`);
  console.log(`段落: ${detail.paragraphs.length}`);
  printBlocks(paragraphsToBlocks(detail.paragraphs));
}

async function runDynamic(mid, limit = 5) {
  if (!mid) return usage();
  const client = makeClient();
  const feed = await client.dynamicFeed({ mid });
  console.log(`动态流条目: ${feed.items.length}  offset=${feed.offset || '—'}`);
  const rows = feed.items.slice(0, Number(limit) || 5).map(item => extractDynamicItem(item, { includeForwards: true })).filter(Boolean);
  for (const row of rows) {
    console.log(`\n[${row.sourceKey}] ${row.dynamicType ?? row.kind} · ${row.title}`);
    console.log(`  作者: ${row.author} | 时间: ${row.publishedAt ? new Date(row.publishedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}`);
    const markdown = blocksToMarkdown(row.blocks);
    console.log(`  blocks=${row.blocks.length} images=${imagesFromMarkdown(markdown).length}${row.hydrateUrl ? ` hydrate=${row.hydrateUrl}` : ''}`);
    if (markdown) console.log(`  摘要: ${summaryFromMarkdown(markdown, 100)}`);
  }
}

try {
  if (command === 'article') await runArticle(rest[0], false);
  else if (command === 'opus') await runArticle(rest[0], true);
  else if (command === 'dynamic') await runDynamic(rest[0], rest[1]);
  else if (command === 'feed') {
    const client = makeClient();
    const feed = await client.dynamicFeed({ mid: rest[0] });
    console.log(`OK：${feed.items.length} 条动态，offset=${feed.offset || '—'}`);
    console.log(`Cookie: ${client.cookieStatus().configured ? '已配置' : '匿名'}`);
  } else usage();
} catch (error) {
  console.error(`失败 [${error?.code ?? 'ERROR'}]：${error?.message ?? error}`);
  if (error?.hint) console.error(`提示：${error.hint}`);
  process.exitCode = 1;
}
