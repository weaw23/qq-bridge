#!/usr/bin/env node
// 人味基线取样器 —— 阶段 0 的验收工具
//
// 用途：把「她最近真正发出去的话」抽成一份可复核的样本，供人工按
// 人味 / 服务感 / 情绪 / 主动性 四项打分；每个阶段改完再抽一次，跟基线比。
//
// 数据来源：state/tool-calls.jsonl（桥接记录的工具调用流水，1000 行滚动）。
//   - type=call 的行带 args（发送工具的 messages 正文就在这里）；
//   - 紧跟其后的 type=result 行带 ok，用来剔除没发成功的调用；
//   - 令牌在落盘时已被打码成 ***，本脚本不接触任何凭据。
//
// 用法：
//   node ops/persona-sample.mjs                      # 全部会话，最近 20 条
//   node ops/persona-sample.mjs --key group:471975044 # 只看某个会话
//   node ops/persona-sample.mjs --limit 30 --json     # 只输出 JSON（给打分表用）
//   node ops/persona-sample.mjs --out                # 额外写 outbox/persona-sample-<日期>.json
//   node ops/persona-sample.mjs --out --label post   # 写 outbox/persona-sample-<日期>-post.json（对比时别覆盖基线）
//   node ops/persona-sample.mjs --out D:\path\任意.json  # 指定完整路径
import fs from 'node:fs';
import path from 'node:path';

const SEND_TOOLS = new Set([
  'mcp__snowluma__qq_send_message',
  'mcp__snowluma__qq_send_burst',
  'mcp__snowluma__qq_reply',
  'mcp__snowluma__qq_send_group_message',
  'mcp__snowluma__qq_send_private_message'
]);

function parseArgs(argv) {
  const out = { limit: 20, key: '', json: false, write: false, outPath: '', label: '', source: 'state/tool-calls.jsonl' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]) || 20;
    else if (a === '--key') out.key = String(argv[++i] ?? '');
    else if (a === '--json') out.json = true;
    else if (a === '--out') {
      out.write = true;
      // 可选跟一个路径；不跟就落到 outbox 的日期文件名（--label 可加后缀）。
      const next = argv[i + 1];
      if (next && !String(next).startsWith('--')) out.outPath = String(argv[++i]);
    } else if (a === '--label') out.label = String(argv[++i] ?? '').replace(/[^\w-]/g, '');
    else if (a === '--source') out.source = String(argv[++i] ?? out.source);
  }
  return out;
}

// 从发送工具的参数里取出「她到底说了什么」——不同工具的字段名不一样
function textOfArgs(tool, args) {
  const texts = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) texts.push(v.trim()); };
  if (Array.isArray(args.messages)) args.messages.forEach(push);
  else if (typeof args.messages === 'string') {
    // send_burst 允许传 JSON 数组字符串
    try { const p = JSON.parse(args.messages); Array.isArray(p) ? p.forEach(push) : push(args.messages); }
    catch { push(args.messages); }
  }
  push(args.message);
  push(args.text);
  return texts;
}

export function collectSamples({ source, key = '', limit = 20 }) {
  const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean);
  const samples = [];
  // 发送调用与它的结果行是相邻的；按出现顺序配对，用「工具+会话」做键。
  const pending = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!SEND_TOOLS.has(row.tool)) continue;
    if (row.type === 'call') {
      let args = {};
      try { args = JSON.parse(row.args || '{}'); } catch { args = {}; }
      pending.push({ row, texts: textOfArgs(row.tool, args) });
      continue;
    }
    if (row.type === 'result') {
      // 找到最近一条同会话同工具的待配对调用
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const p = pending[i];
        if (p.row.tool === row.tool && p.row.key === row.key) {
          if (row.ok === true && p.texts.length) {
            samples.push({
              time: p.row.time,
              key: p.row.key,
              sessionId: p.row.sessionId,
              tool: p.row.tool.replace('mcp__snowluma__', ''),
              parts: p.texts,
              chars: p.texts.reduce((n, t) => n + t.length, 0)
            });
          }
          pending.splice(i, 1);
          break;
        }
      }
    }
  }
  const filtered = samples.filter((s) => !key || s.key === key);
  return filtered.slice(-limit);
}

function statsOf(samples) {
  if (!samples.length) return { n: 0 };
  const partCounts = samples.map((s) => s.parts.length);
  const chars = samples.map((s) => s.chars);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const all = samples.flatMap((s) => s.parts);
  return {
    n: samples.length,
    平均条数: Number(avg(partCounts).toFixed(2)),
    平均字数: Number(avg(chars).toFixed(1)),
    单条最长: Math.max(...all.map((t) => t.length)),
    单条最短: Math.min(...all.map((t) => t.length)),
    含Markdown条数: all.filter((t) => /\*\*|^#{1,6}\s|```/.test(t)).length,
    含空格分句条数: all.filter((t) => /[\u4e00-\u9fa5]\s+[\u4e00-\u9fa5]/.test(t)).length,
    含波浪线条数: all.filter((t) => /[～~]/.test(t)).length,
    含语气词条数: all.filter((t) => /呀|啦|嘛|哦|诶|呜|嘿嘿|唔/.test(t)).length
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\//, ''));
if (isMain || process.argv[1]?.endsWith('persona-sample.mjs')) {
  const opt = parseArgs(process.argv.slice(2));
  const samples = collectSamples(opt);
  const stats = statsOf(samples);
  if (opt.write) {
    const dir = path.join(process.cwd(), '..', 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const file = opt.outPath
      ? path.resolve(opt.outPath)
      : path.join(dir, `persona-sample-${stamp}${opt.label ? '-' + opt.label : ''}.json`);
    fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), filter: opt.key || '(全部会话)', stats, samples }, null, 2), 'utf8');
    console.error(`已写出 ${file}`);
  }
  if (opt.json) {
    console.log(JSON.stringify({ stats, samples }, null, 2));
  } else {
    console.log(`样本 ${samples.length} 条${opt.key ? `（会话 ${opt.key}）` : '（全部会话）'} · 来源 ${opt.source}`);
    console.log('统计：' + JSON.stringify(stats));
    console.log('');
    samples.forEach((s, i) => {
      const t = s.time.replace('T', ' ').slice(0, 19);
      console.log(`#${String(i + 1).padStart(2)} ${t}Z ${s.key} ${s.tool} ${s.parts.length}条/${s.chars}字`);
      s.parts.forEach((p, j) => console.log(`     [${j + 1}] ${p}`));
    });
  }
}
