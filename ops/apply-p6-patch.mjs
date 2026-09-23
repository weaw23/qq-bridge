// P6 拼接器：记忆引擎 + 自主性（桥接 4 处插入 + 6 处替换）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';
let t = fs.readFileSync(BRIDGE, 'utf8');
if (t.includes('ensureMemorySession')) throw new Error('已打过 P6 补丁');

const replaceFlex = (file, from, to, label) => {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of [[from, to], [from.replace(/\n/g, '\r\n'), to.replace(/\n/g, '\r\n')]]) {
    if (s.includes(a)) { fs.writeFileSync(file, s.replace(a, b)); console.log('  ✅ 替换 ' + label); return; }
  }
  throw new Error('未匹配: ' + label);
};
const spliceBefore = (file, anchor, payloadPath, label) => {
  let s = fs.readFileSync(file, 'utf8');
  const payload = fs.readFileSync(payloadPath, 'utf8');
  const i = s.indexOf(anchor);
  if (i === -1) throw new Error('找不到锚点: ' + label);
  const lineStart = s.lastIndexOf('\n', i) + 1;
  fs.writeFileSync(file, s.slice(0, lineStart) + payload + s.slice(lineStart));
  console.log('  ✅ 插入 ' + label);
};

// 1) 引入 memory-engine
replaceFlex(BRIDGE,
  "import {\n  loadStickerStore,",
  "import { buildSummaryPrompt, parseSummaryJson, toBigrams, queryToMatch, formatProfileLine } from './memory-engine.js';\nimport {\n  loadStickerStore,",
  'memory-engine import');

// 2) schema：画像列 + 待跟进表 + FTS5 索引
replaceFlex(BRIDGE,
  "    db.exec(\"CREATE TABLE IF NOT EXISTS persona_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'style', content TEXT NOT NULL, created_at INTEGER NOT NULL)\");",
  "    db.exec(\"CREATE TABLE IF NOT EXISTS persona_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'style', content TEXT NOT NULL, created_at INTEGER NOT NULL)\");\n" +
  "    // P6：结构化人物画像列（JSON）+ 待跟进事项 + 中文二元 FTS5 索引\n" +
  "    try { const cols = db.prepare('PRAGMA table_info(affinity)').all().map((c) => c.name); if (!cols.includes('profile')) db.exec(\"ALTER TABLE affinity ADD COLUMN profile TEXT NOT NULL DEFAULT ''\"); } catch {}\n" +
  "    db.exec(\"CREATE TABLE IF NOT EXISTS followups (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_key TEXT NOT NULL, member_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL, due_at INTEGER, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)\");\n" +
  "    db.exec(\"CREATE INDEX IF NOT EXISTS idx_followups_due ON followups (status, due_at)\");\n" +
  "    try { db.exec(\"CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, bigrams, tokenize='ascii')\"); } catch {}",
  'schema P6');

// 3) 记忆引擎核心
spliceBefore(BRIDGE, 'function recordSentMessagesV2(key, messages) {', 'D:/qqbot/insert-memory-core.txt', 'memory core');

// 4) 端点
spliceBefore(BRIDGE, '// ── 富媒体发送端点', 'D:/qqbot/insert-memory-endpoints.txt', 'memory endpoints');

// 5) 召回改走 FTS5（失败回退 LIKE）
replaceFlex(BRIDGE,
  "            if (query) rows = db.prepare('SELECT id, content, category, importance, created_at FROM facts WHERE content LIKE ? ORDER BY importance DESC, updated_at DESC LIMIT ?').all('%' + query + '%', limit);",
  "            if (query) {\n" +
  "              // P6：优先走 FTS5 中文二元召回，失败回退关键词 LIKE\n" +
  "              try {\n" +
  "                const match = queryToMatch(query);\n" +
  "                if (match) rows = db.prepare('SELECT f.id, f.content, f.category, f.importance, f.created_at FROM facts f JOIN facts_fts ON facts_fts.rowid = f.id WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts), f.importance DESC LIMIT ?').all(match, limit);\n" +
  "              } catch { rows = undefined; }\n" +
  "              if (!rows || !rows.length) rows = db.prepare('SELECT id, content, category, importance, created_at FROM facts WHERE content LIKE ? ORDER BY importance DESC, updated_at DESC LIMIT ?').all('%' + query + '%', limit);\n" +
  "            }",
  'FTS recall');

// 6) remember 端点写 FTS 索引
replaceFlex(BRIDGE,
  "            const dup = db.prepare('SELECT id FROM facts WHERE content = ?').get(content);\n            if (dup) { db.prepare('UPDATE facts SET importance = ?, updated_at = ? WHERE id = ?').run(importance, now, dup.id); sendJson({ ok: true, id: dup.id, deduped: true }); return; }\n            const rIns = db.prepare('INSERT INTO facts (content, category, source_key, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(content, category, key, importance, now, now);\n            sendJson({ ok: true, id: Number(rIns.lastInsertRowid) });",
  "            const ins = insertFactRow(db, { content, category, sourceKey: key, importance });\n            sendJson({ ok: true, id: ins.id, deduped: ins.deduped });",
  'remember→insertFactRow');

// 7) 画像注入唤醒提示
replaceFlex(BRIDGE,
  "            const r = db.prepare('SELECT score, notes FROM affinity WHERE member_id = ?').get(uid);\n            rows.push({ uid, name, score: r?.score ?? 0, notes: r?.notes ?? '' });",
  "            const r = db.prepare('SELECT score, notes, profile FROM affinity WHERE member_id = ?').get(uid);\n            let prof = '';\n            try { const pj = JSON.parse(r?.profile || '{}') || {}; prof = formatProfileLine(pj); } catch {}\n            rows.push({ uid, name, score: r?.score ?? 0, notes: r?.notes ?? '', prof });",
  'affinity profile select');
replaceFlex(BRIDGE,
  "            const lines = top.map((r) => `- ${r.name}(${r.uid})：好感度 ${r.score}${r.notes ? '，' + String(r.notes).slice(0, 60) : ''}`);",
  "            const lines = top.map((r) => `- ${r.name}(${r.uid})：好感度 ${r.score}${r.notes ? '，' + String(r.notes).slice(0, 60) : ''}${r.prof ? '｜' + r.prof : ''}`);",
  'affinity profile inject');

// 8) 待跟进注入
replaceFlex(BRIDGE,
  "      const notes = db.prepare('SELECT kind, content FROM persona_notes ORDER BY id DESC LIMIT 3').all();",
  "      try {\n        const fu = db.prepare(\"SELECT name, topic FROM followups WHERE conv_key = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 3\").all(key);\n        if (fu.length) parts.push('【待跟进的事】\\n' + fu.map((f) => '- ' + (f.name ? f.name + '：' : '') + String(f.topic).slice(0, 60)).join('\\n') + '\\n（合适的时候自然地问一句，别像查岗）');\n      } catch {}\n      const notes = db.prepare('SELECT kind, content FROM persona_notes ORDER BY id DESC LIMIT 3').all();",
  'followup inject');

// 9) 三种新唤醒理由的指令块
replaceFlex(BRIDGE,
  "    if (reason === 'bootstrap') {",
  "    if (reason === 'reflect') {\n      return `${base}【每日复盘】现在是今天的自我整理时间，不需要给任何人发消息（除非你确实想对主人说一句）。\\n请按顺序做三件事：\\n1) 回顾今天：用 qq_db_recall 看看近期记忆，用 qq_affinity(action=list) 看关系变化；\\n2) 沉淀：值得长期记住的写进 qq_db_remember；对某人的观感变了就 qq_affinity(action=bump/set) 更新；对自己的新发现写 qq_self_note；\\n3) 计划明天：想主动聊的话题/想问的事，可以用 qq_set_reminder 设个提醒，或写进 qq_memory_append(pendingThought)。\\n做完用 qq_mark_read 或 qq_set_wake_config 正常收尾即可。`;\n    }\n    if (reason === 'care') {\n      return `${base}【主动关心】提示里提到的朋友已经有一阵子没出现了。\\n可以主动发一句自然的问候或分享（别一本正经地“你最近怎么不来了”），参考你们之前的相处方式和好感度；如果觉得现在开口不合适，也可以只更新一下记忆、安静收尾。`;\n    }\n    if (reason === 'followup') {\n      return `${base}【待跟进提醒】之前记下的事到点了（见提示里的【待跟进的事】）。\\n合适就自然地问一句（“你上次说要考试，考完了吗～”），不合适就别硬提，可以顺延或标 done（qq_followup action=done）。`;\n    }\n    if (reason === 'bootstrap') {",
  'wake reasons');

execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ bridge syntax OK');
