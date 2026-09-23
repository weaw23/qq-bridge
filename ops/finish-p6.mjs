// 收尾：MCP 工具 + config + 面板数据页 + 人格说明
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// 1) safe server 工具
const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';
let s = fs.readFileSync(SAFE, 'utf8');
if (!s.includes('qq_person_profile')) {
  const payload = fs.readFileSync('D:/qqbot/insert-memory-tools.txt', 'utf8');
  const anchor = 'await server.connect(new StdioServerTransport());';
  const i = s.indexOf(anchor);
  if (i === -1) throw new Error('找不到 connect 锚点');
  const lineStart = s.lastIndexOf('\n', i) + 1;
  s = s.slice(0, lineStart) + payload + s.slice(lineStart);
  fs.writeFileSync(SAFE, s);
  console.log('✅ MCP 工具已加入（qq_person_profile / qq_followup）');
}
execFileSync('node', ['--check', SAFE], { stdio: 'inherit' });

// 2) config.json：memory + autonomy 段
const CFG = 'D:/qqbot/qq-bridge/config.json';
const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
c.memory = Object.assign({ enabled: true, intervalMs: 1200000, minNewMessages: 15, timeoutMs: 180000 }, c.memory ?? {});
c.autonomy = Object.assign({ enabled: true, reflectHour: 23, careScore: 60, careAfterDays: 3, careCooldownDays: 3 }, c.autonomy ?? {});
fs.writeFileSync(CFG, JSON.stringify(c, null, 2) + '\n');
console.log('✅ config.json: memory + autonomy 已写入', JSON.stringify({ memory: c.memory, autonomy: c.autonomy }));

// 3) 面板：好感度表加"画像"列 + 新增"待跟进"标签
const PANEL = 'D:/qqbot/qq-bridge/console-panel.html';
let p = fs.readFileSync(PANEL, 'utf8');
p = p.replace(
  "const TABS = [['affinity', '好感度'], ['facts', '长期记忆'], ['reminders', '定时提醒'], ['activity', '最近活动'], ['tool-log', '工具日志'], ['slang', '黑话库'], ['feedback', '她的反馈']];",
  "const TABS = [['affinity', '好感度'], ['facts', '长期记忆'], ['followups', '待跟进'], ['reminders', '定时提醒'], ['activity', '最近活动'], ['tool-log', '工具日志'], ['slang', '黑话库'], ['feedback', '她的反馈']];"
);
fs.writeFileSync(PANEL, p);
console.log('✅ 面板：新增"待跟进"标签');

// 4) 桥接面板 API：followups 数据 + 好感度画像列
const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let b = fs.readFileSync(BRIDGE, 'utf8');
const fromAff = "          if (kind === 'affinity') {\n            const rows = db.prepare('SELECT member_id AS memberId, name, score, notes, updated_at AS updatedAt FROM affinity ORDER BY ABS(score) DESC LIMIT 100').all();\n            html = '<table><tr><th>QQ</th><th>称呼</th><th>好感度</th><th>印象</th><th>操作</th></tr>' + rows.map((r) =>";
const toAff = "          if (kind === 'followups') {\n            const rows = db.prepare('SELECT id, conv_key AS convKey, name, topic, due_at AS dueAt, status FROM followups ORDER BY (status = \\'pending\\') DESC, due_at ASC LIMIT 100').all();\n            html = '<table><tr><th>#</th><th>会话</th><th>谁</th><th>要跟进的事</th><th>提醒时间</th><th>状态</th></tr>' + rows.map((r) =>\n              `<tr><td>${r.id}</td><td>${esc(r.convKey)}</td><td>${esc(r.name)}</td><td>${esc(r.topic)}</td><td>${r.dueAt ? new Date(r.dueAt).toLocaleString('zh-CN') : '-'}</td><td>${esc(r.status)}</td></tr>`).join('') + '</table>';\n          } else if (kind === 'affinity') {\n            const rows = db.prepare('SELECT member_id AS memberId, name, score, notes, profile, updated_at AS updatedAt FROM affinity ORDER BY ABS(score) DESC LIMIT 100').all();\n            html = '<table><tr><th>QQ</th><th>称呼</th><th>好感度</th><th>印象</th><th>画像</th><th>操作</th></tr>' + rows.map((r) =>";
if (b.includes('member_id AS memberId, name, score, notes, profile, updated_at AS updatedAt')) console.log('（面板 affinity 已含 profile，跳过）');
else {
  const tryReplace = (src, dst) => {
    for (const [a, d] of [[src, dst], [src.replace(/\n/g, '\r\n'), dst.replace(/\n/g, '\r\n')]]) {
      if (b.includes(a)) { b = b.replace(a, d); return true; }
    }
    return false;
  };
  if (!tryReplace(fromAff, toAff)) {
    // 退一步：只改 SELECT（加 profile 列），followups 分支单独插
    const ok = tryReplace(
      "            const rows = db.prepare('SELECT member_id AS memberId, name, score, notes, updated_at AS updatedAt FROM affinity ORDER BY ABS(score) DESC LIMIT 100').all();",
      "            const rows = db.prepare('SELECT member_id AS memberId, name, score, notes, profile, updated_at AS updatedAt FROM affinity ORDER BY ABS(score) DESC LIMIT 100').all();"
    );
    console.log(ok ? '✅ affinity SELECT 加 profile' : '⚠️ affinity SELECT 未匹配');
    const fuBranch = "          } else if (kind === 'followups') {\n            const rows = db.prepare('SELECT id, conv_key AS convKey, name, topic, due_at AS dueAt, status FROM followups ORDER BY (status = \\'pending\\') DESC, due_at ASC LIMIT 100').all();\n            html = '<table><tr><th>#</th><th>会话</th><th>谁</th><th>要跟进的事</th><th>提醒时间</th><th>状态</th></tr>' + rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.convKey)}</td><td>${esc(r.name)}</td><td>${esc(r.topic)}</td><td>${r.dueAt ? new Date(r.dueAt).toLocaleString('zh-CN') : '-'}</td><td>${esc(r.status)}</td></tr>`).join('') + '</table>';\n";
    const anchor = "          } else if (kind === 'affinity') {";
    const i = b.indexOf(anchor);
    if (i > 0) { b = b.slice(0, i) + fuBranch + b.slice(i + 2); console.log('✅ 面板 API：followups 数据分支已插入'); }
    else console.log('⚠️ 未找到 affinity 分支锚点');
  } else console.log('✅ 面板 API：affinity 画像列 + followups 分支');
  fs.writeFileSync(BRIDGE, b);
}
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ bridge syntax OK');
