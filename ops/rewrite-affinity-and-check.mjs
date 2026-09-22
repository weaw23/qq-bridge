// 好感度备注改写为新人设语气 + 唤醒观察新口吻
import fs from 'node:fs';
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('D:/qqbot/qq-bridge/state/memory.db');
const rewrites = [
  ['1918594889', 88, '我最喜欢的主人～会陪鲸鲸玩到很晚，也会认真听鲸鲸说话'],
  ['2113929217', 0, '主人用来跑测试的电脑，鲸鲸在它上面干活，要温柔对待'],
  ['1702185580', 15, '主人的游戏搭子，话不多，安安静静的那种'],
  ['1525207110', 15, '打肉鸽的哥哥，会接鲸鲸的话，很温柔'],
];
for (const [id, score, note] of rewrites) {
  const r = db.prepare('UPDATE affinity SET score = ?, notes = ?, updated_at = ? WHERE member_id = ?').run(score, note, Date.now(), id);
  console.log(r.changes ? '✅ 更新' : '⚠️ 未找到', id, '→', score, note.slice(0, 30));
}
console.log('\n=== 现好感度 ===');
db.prepare('SELECT member_id, name, score, notes FROM affinity ORDER BY score DESC').all().forEach((r) => console.log(`  ${r.name}(${r.member_id}) ${r.score} — ${r.notes}`));

// 唤醒一次，看看新口吻（放宽限制 → 唤醒 → 恢复）
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', 'x-console-token': ct };
const post = async (p, b) => (await fetch('http://127.0.0.1:3100' + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
const before = (await (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: H })).json()).wakeLimits;
await post('/api/panel/toggle', { path: 'socialV2.wake', value: { ...before, maxWakePerMinute: 20, maxWakePerHour: 200 } });
console.log('\n[唤醒]', await post('/api/socialV2/wake', { key: 'private:1918594889', reason: 'admin' }));
await new Promise((r) => setTimeout(r, 45000));
await post('/api/panel/toggle', { path: 'socialV2.wake', value: before });
console.log('已恢复唤醒限制');

const T = fs.readFileSync('D:/qqbot/qq-bridge/.snowluma-token', 'utf8').trim();
const j = await (await fetch('http://127.0.0.1:3000/get_friend_msg_history', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
  body: JSON.stringify({ user_id: 1918594889, count: 4 })
})).json();
const arr = Array.isArray(j.data) ? j.data : (j.data?.messages ?? []);
console.log('\n=== 最新消息（看新口吻）===');
for (const m of arr.slice(-4)) {
  const self = m.sender?.user_id === 3692140164;
  const txt = Array.isArray(m.message) ? m.message.map((s) => (s.type === 'text' ? s.data.text : '[' + s.type + ']')).join('') : String(m.raw_message ?? '');
  const ts = m.time ? new Date(m.time * 1000).toLocaleTimeString('zh-CN') : '?';
  console.log(`[${ts}] ${self ? '🐳鲸鲸' : '👤主人'}: ${txt.slice(0, 160)}`);
}
process.exit(0);
