// P1+P2 拼接器：4 处插入 + 语法检查
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';

function spliceBefore(file, anchor, payloadPath, marker) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.includes(marker)) throw new Error(`${file} 已包含 ${marker}，跳过`);
  const payload = fs.readFileSync(payloadPath, 'utf8');
  const i = t.indexOf(anchor);
  if (i === -1) throw new Error(`${file} 找不到锚点: ${anchor.slice(0, 40)}`);
  const lineStart = t.lastIndexOf('\n', i) + 1;
  fs.writeFileSync(file, t.slice(0, lineStart) + payload + t.slice(lineStart));
}

// 1) import（插在 sdk import 之后 → 锚点用下一行 dsh-client import）
spliceBefore(BRIDGE, "import { NodeApiClient, unwrap", 'D:/qqbot/insert-import.txt', "from 'node:sqlite'");
// 2) P2 核心（DB/通知/扫描器，插在 recordSentMessagesV2 之前）
spliceBefore(BRIDGE, 'function recordSentMessagesV2(key, messages) {', 'D:/qqbot/insert-p2-core.txt', 'getMemoryDb');
// 3) 端点（插在富媒体端点之前）
spliceBefore(BRIDGE, '// ── 富媒体发送端点', 'D:/qqbot/insert-p12-endpoints.txt', '/api/socialV2/admin');
// 4) MCP 工具（插在 server.connect 之前）
spliceBefore(SAFE, 'await server.connect(new StdioServerTransport());', 'D:/qqbot/insert-p12-tools.txt', 'qq_group_admin');

for (const f of [BRIDGE, SAFE]) {
  execFileSync('node', ['--check', f], { stdio: 'inherit' });
  console.log('syntax OK:', f);
}
console.log('bridge lines:', fs.readFileSync(BRIDGE, 'utf8').split('\n').length);
console.log('safe lines:', fs.readFileSync(SAFE, 'utf8').split('\n').length);
