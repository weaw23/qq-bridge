// P6-6 第二轮：剩余工具描述替换（宽松匹配）+ 超长参数说明压缩
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';
const DOCS = 'D:/qqbot/qq-bridge/src/tool-docs.js';
let t = fs.readFileSync(SAFE, 'utf8');

// 复用第一轮的短描述表（从 tool-docs.js 的全文重新生成同样的规则）
const shortOfMap = {};
{
  const mod = await import('file:///D:/qqbot/qq-bridge/src/tool-docs.js');
  const OVERRIDES = JSON.parse(fs.readFileSync('D:/qqbot/p66-overrides.json', 'utf8'));
  for (const [name, full] of Object.entries(mod.TOOL_DOCS)) {
    if (OVERRIDES[name]) { shortOfMap[name] = OVERRIDES[name]; continue; }
    const first = String(full).split(/[。！]/)[0];
    let s = (first.length >= 12 ? first : String(full).slice(0, 60)).replace(/\s+/g, ' ').trim();
    if (s.length > 56) s = s.slice(0, 54) + '…';
    shortOfMap[name] = s.endsWith('。') ? s : s + '。';
  }
}

// 校验现存描述：只替换"仍为长文"的工具
const current = [...t.matchAll(/server\.tool\(\r?\n\s*'([a-z0-9_]+)',\r?\n\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => ({ name: m[1], desc: m[2] }));
let replaced = 0;
for (const c of current) {
  const short = shortOfMap[c.name];
  if (!short || c.desc.length <= short.length + 6) continue;   // 已经是短版
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const re = new RegExp(`('${c.name}',\\s*\\r?\\n\\s*)'${c.desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
  if (re.test(t)) { t = t.replace(re, `$1'${esc(short)}'`); replaced++; }
  else console.log('  ⚠️ 仍无法替换:', c.name, '(描述', c.desc.length, '字)');
}
console.log('第二轮替换:', replaced, '个');

// 压缩超长参数说明（>60 字且不含枚举 |）
let pFixed = 0;
t = t.replace(/\.describe\('((?:[^'\\]|\\.)*)'\)/g, (m, txt) => {
  if (txt.length <= 60 || txt.includes('|')) return m;
  const clean = txt.replace(/\\'/g, "'");
  const cut = clean.split(/[；;。]/)[0];
  let s = (cut.length >= 15 ? cut : clean.slice(0, 50)).trim();
  if (s.length > 52) s = s.slice(0, 50) + '…';
  pFixed++;
  return `.describe('${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
});
console.log('压缩参数说明:', pFixed, '条');

fs.writeFileSync(SAFE, t);
execFileSync('node', ['--check', SAFE], { stdio: 'inherit' });
console.log('✅ syntax OK');
