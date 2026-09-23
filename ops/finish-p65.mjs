// P6-5 收尾：config + 面板"表达库"标签 + 数据分支
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// config
const CFG = 'D:/qqbot/qq-bridge/config.json';
const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
c.expressions = Object.assign({ enabled: true, minMessages: 8, injectMax: 8, timeoutMs: 180000 }, c.expressions ?? {});
fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n');
console.log('✅ config.expressions =', JSON.stringify(c.expressions));

// 面板标签
const PANEL = 'D:/qqbot/qq-bridge/console-panel.html';
let p = fs.readFileSync(PANEL, 'utf8');
if (!p.includes("['expressions', '表达库']")) {
  p = p.replace(
    "['slang', '黑话库']",
    "['slang', '黑话库'], ['expressions', '表达库']"
  );
  fs.writeFileSync(PANEL, p);
  console.log('✅ 面板新增「表达库」标签');
} else console.log('（面板已含表达库标签）');

// 数据分支
const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let b = fs.readFileSync(BRIDGE, 'utf8');
if (!b.includes("kind === 'expressions'")) {
  const anchor = "          } else if (kind === 'slang') {";
  const branch = `          } else if (kind === 'expressions') {
            const arr = (Array.isArray(expressionEntries) ? expressionEntries : []).slice().sort((a, c2) => (c2.score || 0) - (a.score || 0)).slice(0, 120);
            html = '<table><tr><th>句式</th><th>用法</th><th>语气</th><th>例句</th><th>出现</th></tr>' + arr.map((e) =>
              \`<tr><td>\${esc(e.pattern)}</td><td>\${esc(e.usage)}</td><td>\${esc(e.tone)}</td><td>\${esc(String(e.example || '').slice(0, 50))}</td><td>\${e.count || 1}</td></tr>\`).join('') + '</table>';
`;
  const i = b.indexOf(anchor);
  if (i === -1) throw new Error('找不到 slang 分支锚点');
  const lineStart = b.lastIndexOf('\n', i) + 1;
  b = b.slice(0, lineStart) + branch + b.slice(lineStart);
  fs.writeFileSync(BRIDGE, b);
  console.log('✅ 面板 API 新增 expressions 分支');
}
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ bridge syntax OK');
