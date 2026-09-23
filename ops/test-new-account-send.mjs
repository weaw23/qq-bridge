// 用新号的会话令牌发一条测试消息（验证发送链路 + 新人格口吻）
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const token = j.conversations['private:1918594889'].agentToken;
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const res = await fetch('http://127.0.0.1:3100/api/send/rich', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-console-token': ct },
  body: JSON.stringify({
    key: 'private:1918594889',
    token,
    parts: [
      { type: 'text', text: '主人～鲸鲸换新家啦！二号机上线，记忆和好感度都带过来了哦（这条是系统自检消息，确认新号能跟你说话 💙）' },
      { type: 'face', id: '66' },
    ],
  }),
});
console.log('发送结果:', res.status, JSON.stringify(await res.json()));

// 确认消息确实来自新号
const T = fs.readFileSync('D:/qqbot/qq-bridge/.snowluma-token', 'utf8').trim();
await new Promise((r) => setTimeout(r, 3000));
const h = await (await fetch('http://127.0.0.1:3000/get_friend_msg_history', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
  body: JSON.stringify({ user_id: 1918594889, count: 3 }),
})).json();
const arr = Array.isArray(h.data) ? h.data : (h.data?.messages ?? []);
console.log('\n最新消息（核对发送方 QQ）:');
for (const m of arr.slice(-3)) {
  const uid = m.sender?.user_id;
  const txt = Array.isArray(m.message) ? m.message.map((s) => (s.type === 'text' ? s.data.text : '[' + s.type + ']')).join('') : String(m.raw_message ?? '');
  console.log(`  [${uid === 3835811547 ? '新号 3835811547' : uid}] ${txt.slice(0, 100)}`);
}
process.exit(0);
