// P6 完整实测（修正版）：画像 + 待跟进 + FTS 召回 + 真实摘要（选消息最多的会话）
import fs from 'node:fs';
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const sv = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const KEY = 'private:1918594889';
const token = sv.conversations[KEY].agentToken;
const post = async (p, body, key = KEY) => {
  const r = await fetch('http://127.0.0.1:3100' + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-console-token': ct, 'x-agent-token': token },
    body: JSON.stringify({ key, token, ...body })
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log('[1] 人物画像写入（主人）');
console.log('   ', JSON.stringify((await post('/api/socialV2/person-profile', { action: 'set', memberId: '1918594889', callName: '主人 / 柚子主人', likes: '深夜聊天、折腾机器人、被叫主人、发搞笑图', dislikes: '被无视、被当工具人', style: '话短直接，心情好会连发好几条', status: '在给鲸鲸升级能力（换号/面板/记忆引擎）' })).body).slice(0, 200));

console.log('\n[2] 画像读取 + 落库校验');
const got = await post('/api/socialV2/person-profile', { action: 'get', memberId: '1918594889' });
console.log('   ', JSON.stringify(got.body).slice(0, 300));

console.log('\n[3] 各会话消息量（决定摘要测试目标）');
for (const [k, st] of Object.entries(sv.conversations)) {
  console.log(`   ${k}: recentMessages ${(st.recentMessages || []).length} | 已摘要至 seq ${st.lastSummarizedSeq ?? 0} | 未读 ${(st.unread || []).length}`);
}

console.log('\n[4] 强制对消息最多的会话做一次真实摘要');
let best = null;
for (const [k, st] of Object.entries(sv.conversations)) {
  const n = (st.recentMessages || []).length;
  if (!best || n > best.n) best = { k, n };
}
console.log('   目标:', best.k, '（', best.n, '条）');
const tk = sv.conversations[best.k]?.agentToken;
const sum = await post('/api/socialV2/memory/summarize-now', {}, best.k);
console.log('   结果:', JSON.stringify(sum.body));
if (!sum.body.summarized && best.n < 15) {
  console.log('   （消息数不足 15，属正常阈值行为；降低阈值再试）');
  const cfg = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/config.json', 'utf8'));
  cfg.memory.minNewMessages = 3;
  fs.writeFileSync('D:/qqbot/qq-bridge/config.json', JSON.stringify(cfg, null, 2) + '\n');
  console.log('   已临时把 minNewMessages 降到 3 —— 需要重启桥接生效');
}

console.log('\n[5] 当前记忆库状态');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync('D:/qqbot/qq-bridge/state/memory.db');
const q = (sql) => { try { return db.prepare(sql).get()?.c ?? 0; } catch { return '?'; } };
console.log('   facts:', q('SELECT COUNT(*) c FROM facts'), '| FTS:', q('SELECT COUNT(*) c FROM facts_fts'), '| followups:', q('SELECT COUNT(*) c FROM followups'), '| 画像非空:', q("SELECT COUNT(*) c FROM affinity WHERE profile != ''"));
process.exit(0);
