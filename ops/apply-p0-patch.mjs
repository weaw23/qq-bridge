// 拼接器：把两个载荷插入目标文件，然后语法检查
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const splice = (file, anchor, payloadPath, beforeMarker) => {
  let t = fs.readFileSync(file, 'utf8');
  const payload = fs.readFileSync(payloadPath, 'utf8');
  if (t.includes(beforeMarker)) throw new Error(file + ' 已包含补丁标记，跳过');
  const i = t.indexOf(anchor);
  if (i === -1) throw new Error(file + ' 找不到锚点: ' + anchor);
  const lineStart = t.lastIndexOf('\n', i) + 1;
  t = t.slice(0, lineStart) + payload + t.slice(lineStart);
  fs.writeFileSync(file, t);
  return t.split('\n').length;
};

const n1 = splice(
  'D:/qqbot/qq-bridge/src/bridge.js',
  '// ── 统一发送端点（MCP 旧发送工具也走这里）',
  'D:/qqbot/insert-bridge-rich.txt',
  '/api/send/rich'
);
console.log('bridge.js ->', n1, 'lines');

const n2 = splice(
  'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js',
  "await server.connect(new StdioServerTransport());",
  'D:/qqbot/insert-safe-tools.txt',
  'qq_get_friend_msg_history'
);
console.log('mcp-snowluma-safe.js ->', n2, 'lines');

for (const f of ['D:/qqbot/qq-bridge/src/bridge.js', 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js']) {
  execFileSync('node', ['--check', f], { stdio: 'inherit' });
  console.log('syntax OK:', f);
}
