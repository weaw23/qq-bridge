// P0 端点实测：rich 发送（face+本地图+文字） + 私聊历史 + 防线
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const token = j.conversations['private:1918594889'].agentToken;
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const AUTH = { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken };

console.log('[1] /api/send/rich face+image+text');
let res = await fetch('http://127.0.0.1:3100/api/send/rich', {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({
    key: 'private:1918594889',
    token,
    parts: [
      { type: 'face', id: '66' },
      { type: 'image', file: 'file:///D:/qqbot/outbox/test-image.png' },
      { type: 'text', text: 'P0 新链路实测：系统表情+本地图片+文字混排，一条消息' },
    ],
  }),
});
console.log('   ', res.status, JSON.stringify(await res.json()).slice(0, 160));

console.log('[2] /api/socialV2/friend-history 最近 5 条');
res = await fetch('http://127.0.0.1:3100/api/socialV2/friend-history', {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ userId: '1918594889', count: 5, token }),
});
const jj = await res.json();
console.log('   ', res.status, 'ok=' + jj.ok, 'count=' + (jj.messages?.length ?? 0));
for (const m of (jj.messages ?? []).slice(-3)) {
  console.log('    [' + (m.isSelf ? '鲸' : '人') + '] ' + String(m.text).slice(0, 40));
}

console.log('[3] 防线测试：非法图片路径应被拒');
res = await fetch('http://127.0.0.1:3100/api/send/rich', {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ key: 'private:1918594889', token, parts: [{ type: 'image', file: 'file:///C:/Users/HCK/secret.txt' }] }),
});
console.log('   ', res.status, JSON.stringify(await res.json()).slice(0, 160));
process.exit(0);
