// 精确接线：withSlangContext 返回处追加表达库注入（CRLF）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let t = fs.readFileSync(BRIDGE, 'utf8');
const from = "    return parts.join('\\n\\n') + '\\n\\n' + promptText;\r\n  }\r\n\r\n  if (!cfg.allow.private.length";
const to = "    const joined = parts.join('\\n\\n') + '\\n\\n' + promptText;\r\n    return withExpressionContext(joined);\r\n  }\r\n\r\n  if (!cfg.allow.private.length";
if (!t.includes(from)) {
  console.log('❌ 仍未匹配，当前片段:');
  const i = t.indexOf('function withSlangContext');
  console.log(JSON.stringify(t.slice(i, i + 560)));
  process.exit(1);
}
t = t.replace(from, to);
fs.writeFileSync(BRIDGE, t);
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ 表达库注入已接上，syntax OK');
