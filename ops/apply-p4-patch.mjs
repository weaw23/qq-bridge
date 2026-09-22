// P4 拼接器：好感度/自我演化（桥接+工具） + 长轮询修复
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';

function spliceBefore(file, anchor, payloadPath, marker) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.includes(marker)) throw new Error(`${file} 已含 ${marker}，跳过`);
  const payload = fs.readFileSync(payloadPath, 'utf8');
  const i = t.indexOf(anchor);
  if (i === -1) throw new Error(`${file} 找不到锚点：${anchor.slice(0, 40)}`);
  const lineStart = t.lastIndexOf('\n', i) + 1;
  fs.writeFileSync(file, t.slice(0, lineStart) + payload + t.slice(lineStart));
}

function replaceOnce(file, from, to, marker) {
  let t = fs.readFileSync(file, 'utf8');
  if (marker && t.includes(marker)) { console.log('已在位，跳过替换：' + marker); return; }
  if (!t.includes(from)) throw new Error(`${file} 找不到待替换片段：${from.slice(0, 60)}`);
  fs.writeFileSync(file, t.replace(from, to));
}

// ── 桥接 ──
// 1) 建表
replaceOnce(
  BRIDGE,
  "    db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, fire_at)');",
  "    db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, fire_at)');\n" +
    "    db.exec(\"CREATE TABLE IF NOT EXISTS affinity (member_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', score INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)\");\n" +
    "    db.exec(\"CREATE TABLE IF NOT EXISTS persona_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'style', content TEXT NOT NULL, created_at INTEGER NOT NULL)\");",
  'CREATE TABLE IF NOT EXISTS affinity'
);
// 2) 注入函数
spliceBefore(BRIDGE, 'function withSlangContext(promptText) {', 'D:/qqbot/insert-affinity-core.txt', 'function withAffinityContext');
// 3) 唤醒提示链
replaceOnce(
  BRIDGE,
  'let content = [{ type: \'text\', text: withSlangContext(promptText) }];',
  'let content = [{ type: \'text\', text: withAffinityContext(key, withSlangContext(promptText)) }];',
  'withAffinityContext(key, withSlangContext'
);
// 4) 端点
spliceBefore(BRIDGE, '// ── 富媒体发送端点', 'D:/qqbot/insert-affinity-endpoints.txt', '/api/socialV2/affinity');
// 5) 工具
spliceBefore(SAFE, 'await server.connect(new StdioServerTransport());', 'D:/qqbot/insert-affinity-tools.txt', 'qq_affinity');
// 6) 长轮询：导入 http + 函数 + wait 工具切换
replaceOnce(SAFE, "import fs from 'node:fs';", "import fs from 'node:fs';\nimport http from 'node:http';", "import http from 'node:http';");
spliceBefore(SAFE, 'async function authorizeRead(key, token) {', 'D:/qqbot/insert-longpoll.txt', 'function agentApiLong');
replaceOnce(SAFE, "await agentApi('/api/socialV2/wait', {", "await agentApiLong('/api/socialV2/wait', {", "agentApiLong('/api/socialV2/wait'");

for (const f of [BRIDGE, SAFE]) {
  execFileSync('node', ['--check', f], { stdio: 'inherit' });
  console.log('syntax OK:', f);
}
