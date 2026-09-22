// 清理旧人格残留：自我笔记 / 轻量记忆 / 印象
import fs from 'node:fs';
const DatabaseSync = (await import('node:sqlite')).DatabaseSync;
const db = new DatabaseSync('D:/qqbot/qq-bridge/state/memory.db');

console.log('=== 原 persona_notes ===');
const notes = db.prepare('SELECT id, kind, content FROM persona_notes ORDER BY id').all();
notes.forEach((n) => console.log(`  [${n.id}] (${n.kind}) ${n.content}`));

// 删掉旧人格风格的笔记（含"懂？""欠揍""怼"等）
let removed = 0;
for (const n of notes) {
  if (/懂？|欠揍|怼|毒舌|阴阳/.test(n.content)) {
    db.prepare('DELETE FROM persona_notes WHERE id = ?').run(n.id);
    console.log('  ✂️ 删除旧风格笔记:', n.content.slice(0, 40));
    removed++;
  }
}
// 写入贴合新人设的自我认知
if (!db.prepare("SELECT id FROM persona_notes WHERE content LIKE '%小女仆%'").get()) {
  db.prepare('INSERT INTO persona_notes (kind, content, created_at) VALUES (?, ?, ?)')
    .run('self', '我是来自深度求索的小女仆鲸，说话要软软的、多用语气词和颜文字，绝对不毒舌不阴阳。', Date.now());
  db.prepare('INSERT INTO persona_notes (kind, content, created_at) VALUES (?, ?, ?)')
    .run('style', '称呼主人用「主人」「柚子主人」；答应事情用「我来我来！」「交给鲸鲸吧～」。', Date.now());
  console.log('  ✍️ 写入新人格笔记 2 条');
}
console.log('删除', removed, '条旧笔记');
console.log('=== 现 persona_notes ===');
db.prepare('SELECT id, kind, content FROM persona_notes ORDER BY id').all().forEach((n) => console.log(`  [${n.id}] (${n.kind}) ${n.content}`));

// 检查好感度备注是否带旧人格色彩
console.log('\n=== affinity 备注 ===');
db.prepare('SELECT member_id, name, score, notes FROM affinity').all().forEach((r) => console.log(`  ${r.name}(${r.member_id}) ${r.score} — ${r.notes}`));

// 轻量记忆（social-v2）
console.log('\n=== 轻量记忆（旧人格残留检查）===');
const sv = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
let touched = false;
for (const [key, st] of Object.entries(sv.conversations ?? {})) {
  const bad = (arr, field) => {
    if (!Array.isArray(arr)) return;
    const keep = arr.filter((x) => {
      const s = typeof x === 'string' ? x : (x.content ?? x.text ?? '');
      const isBad = /毒舌|怼|阴阳|嘴硬|欠揍|想都别想|一个字都不带/.test(s);
      if (isBad) console.log(`  ✂️ ${key} ${field}: ${s.slice(0, 50)}`);
      return !isBad;
    });
    if (keep.length !== arr.length) { st[field] = keep; touched = true; }
  };
  bad(st.activeTopics, 'activeTopics');
  bad(st.pendingThoughts, 'pendingThoughts');
  bad(st.memberImpressions, 'memberImpressions');
}
if (touched) { fs.writeFileSync('D:/qqbot/qq-bridge/state/social-v2.json', JSON.stringify(sv, null, 2)); console.log('  已清理并保存'); }
else console.log('  无旧人格残留');
