// 展示 P6 成果：自动摘要产出、待跟进、画像、FTS 召回
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/qqbot/qq-bridge/state/memory.db');
const { toBigrams, queryToMatch } = await import('file:///D:/qqbot/qq-bridge/src/memory-engine.js');

console.log('=== 自动摘要产出的新事实 ===');
db.prepare('SELECT id, content, category, importance FROM facts ORDER BY id DESC LIMIT 8').all().reverse()
  .forEach((f) => console.log(`  [${f.importance}](${f.category}) ${String(f.content).slice(0, 140)}`));

console.log('\n=== 自动提取的待跟进 ===');
db.prepare('SELECT id, name, topic, status, due_at FROM followups ORDER BY id').all()
  .forEach((f) => console.log(`  #${f.id} ${f.name}：${f.topic} | 到点 ${new Date(f.due_at).toLocaleString('zh-CN')} | ${f.status}`));

console.log('\n=== 人物画像 ===');
db.prepare("SELECT name, score, profile FROM affinity WHERE profile != '' ").all()
  .forEach((a) => console.log(`  ${a.name}(${a.score}): ${a.profile}`));

console.log('\n=== FTS5 中文二元召回 ===');
for (const q of ['生图 API', '被移出', '面板', '表情']) {
  const rows = db.prepare('SELECT f.content FROM facts f JOIN facts_fts ON facts_fts.rowid = f.id WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts) LIMIT 2').all(queryToMatch(q));
  console.log(`搜「${q}」→ ${rows.length} 条`);
  rows.forEach((r) => console.log('    ' + String(r.content).slice(0, 95)));
}
