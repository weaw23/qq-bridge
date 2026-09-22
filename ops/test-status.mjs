// P3.5 实测：my-status / friend-list / 发送失败自动诊断
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const privToken = j.conversations['private:1918594889']?.agentToken ?? '';
const grpToken963 = j.conversations['group:963871667']?.agentToken ?? j.conversations['group:471975044']?.agentToken ?? '';
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const AUTH = (tk) => ({ 'Content-Type': 'application/json', 'x-agent-token': tk, 'x-console-token': consoleToken });
const api = (p, body, tk) => fetch('http://127.0.0.1:3100' + p, { method: 'POST', headers: AUTH(tk), body: JSON.stringify({ token: tk, ...body }) }).then((r) => r.json());

console.log('[1] my-status 963871667（主人私聊令牌指定群）');
const st = await api('/api/socialV2/my-status', { key: 'private:1918594889', groupId: '963871667' }, privToken);
console.log('   ', JSON.stringify(st).slice(0, 420));

console.log('[2] friend-list');
const fl = await api('/api/socialV2/friend-list', { key: 'private:1918594889' }, privToken);
console.log('   ', JSON.stringify((fl.friends ?? []).map((f) => `${f.nickname}${f.isSelf ? '(自己)' : ''}`)));

console.log('[3] 往禁言群发消息 → 错误应自动附诊断');
const res = await fetch('http://127.0.0.1:3100/api/send/rich', {
  method: 'POST',
  headers: AUTH(grpToken963 || privToken),
  body: JSON.stringify({ key: 'group:963871667', token: grpToken963 || privToken, parts: [{ type: 'text', text: '测试' }] }),
});
console.log('   ', res.status, JSON.stringify(await res.json()).slice(0, 300));
process.exit(0);
