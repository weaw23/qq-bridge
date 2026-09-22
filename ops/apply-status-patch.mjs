// P3.5 拼接器：状态端点 + 2 个状态工具
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';

function spliceBefore(file, anchor, payloadPath, marker) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.includes(marker)) throw new Error(`${file} 已包含 ${marker}，跳过`);
  const payload = fs.readFileSync(payloadPath, 'utf8');
  const i = t.indexOf(anchor);
  if (i === -1) throw new Error(`${file} 找不到锚点`);
  const lineStart = t.lastIndexOf('\n', i) + 1;
  fs.writeFileSync(file, t.slice(0, lineStart) + payload + t.slice(lineStart));
}

spliceBefore(BRIDGE, '// ── 富媒体发送端点', 'D:/qqbot/insert-status-endpoints.txt', '/api/socialV2/my-status');
spliceBefore(SAFE, 'await server.connect(new StdioServerTransport());', 'D:/qqbot/insert-status-tools.txt', 'qq_my_group_status');

for (const f of [BRIDGE, SAFE]) {
  execFileSync('node', ['--check', f], { stdio: 'inherit' });
  console.log('syntax OK:', f);
}
