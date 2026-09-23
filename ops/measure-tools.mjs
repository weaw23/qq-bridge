// 量化：工具描述/参数描述占多少上下文
import fs from 'node:fs';
const t = fs.readFileSync('D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js', 'utf8');
const tools = [...t.matchAll(/server\.tool\(\s*\n\s*'([a-z0-9_]+)',\s*\n\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => ({ name: m[1], desc: m[2] }));
const paramDescs = [...t.matchAll(/\.describe\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]);
const sum = (arr) => arr.reduce((a, b) => a + b.length, 0);
const toolChars = sum(tools.map((x) => x.desc));
const paramChars = sum(paramDescs);
console.log('工具数:', tools.length);
console.log('工具描述总字符:', toolChars, '（约', Math.round(toolChars / 1.6), 'tokens）');
console.log('参数描述总字符:', paramChars, '（约', Math.round(paramChars / 1.6), 'tokens，共', paramDescs.length, '条）');
console.log('合计约', Math.round((toolChars + paramChars) / 1.6), 'tokens / 每次请求');
console.log('');
console.log('最长的 8 个工具描述:');
tools.map((x) => ({ n: x.name, l: x.desc.length })).sort((a, b) => b.l - a.l).slice(0, 8).forEach((x) => console.log(`  ${x.n}: ${x.l} 字`));
console.log('');
console.log('最长的 5 个参数描述:');
paramDescs.map((d) => ({ d, l: d.length })).sort((a, b) => b.l - a.l).slice(0, 5).forEach((x) => console.log(`  ${x.l} 字: ${x.d.slice(0, 60)}…`));
