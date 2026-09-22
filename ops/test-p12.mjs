// 诊断 963871667 + 验证 P1/P2 端点
import fs from 'node:fs';
const token = fs.readFileSync('D:/qqbot/qq-bridge/.snowluma-token', 'utf8').trim();
const ob = async (action, params) => {
  const res = await fetch(`http://127.0.0.1:3000/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  return res.json();
};
console.log('=== [诊断] 群 963871667 成员状态 ===');
const gi = await ob('get_group_info', { group_id: 963871667 });
console.log('group_info:', JSON.stringify(gi?.data ?? gi).slice(0, 200));
const mi = await ob('get_group_member_info', { group_id: 963871667, user_id: 3692140164 });
console.log('bot member_info:', JSON.stringify(mi?.data ?? mi).slice(0, 260));

console.log('=== [P2] 记忆库 roundtrip ===');
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const privToken = j.conversations?.['private:1918594889']?.agentToken ?? '';
const grpToken = j.conversations?.['group:1107691307']?.agentToken ?? '';
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const AUTH = { 'Content-Type': 'application/json', 'x-console-token': consoleToken };
const api = async (p, body, useToken = privToken) => {
  const res = await fetch(`http://127.0.0.1:3100${p}`, { method: 'POST', headers: { ...AUTH, 'x-agent-token': useToken }, body: JSON.stringify({ token: useToken, ...body }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
console.log('DB exists:', fs.existsSync('D:/qqbot/qq-bridge/state/memory.db'));
let r = await api('/api/socialV2/memory/remember', { key: 'private:1918594889', content: '测试事实：主人喜欢在晚上测鲸鲸', category: 'test', importance: 3 });
console.log('remember:', r.status, JSON.stringify(r.body));
const rid = r.body.id;
r = await api('/api/socialV2/memory/recall', { key: 'private:1918594889', query: '主人' });
console.log('recall:', r.status, 'count=' + r.body.count);
r = await api('/api/socialV2/memory/forget', { key: 'private:1918594889', id: rid });
console.log('forget:', r.status, JSON.stringify(r.body));

console.log('=== [P2] 提醒 30 秒触发测试 ===');
r = await api('/api/socialV2/reminder/set', { key: 'private:1918594889', text: 'P2 提醒链路实测：到点请说一句"提醒到货"', delayMinutes: 0.5 });
console.log('set:', r.status, JSON.stringify(r.body));
const remId = r.body.id;

console.log('=== [P1] 管理端点防线 ===');
r = await api('/api/socialV2/admin', { key: 'private:1918594889', token: grpToken, action: 'wholeBan', groupId: '1107691307' }, grpToken);
console.log('群令牌冒充（应 403）:', r.status, JSON.stringify(r.body).slice(0, 90));
r = await api('/api/socialV2/admin', { key: 'private:1918594889', action: 'wholeBan', groupId: '999999999' });
console.log('白名单外群（应 403）:', r.status, JSON.stringify(r.body).slice(0, 90));
r = await api('/api/socialV2/admin', { key: 'private:1918594889', action: 'ban', groupId: '1107691307', targetUserId: '10000', duration: 60 });
console.log('主人令牌+不存在目标（应 500 OneBot 错误=管线通）:', r.status, JSON.stringify(r.body).slice(0, 110));

console.log('--- 等 45s 验证提醒触发 ---');
await new Promise((res2) => setTimeout(res2, 45000));
const j2 = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const st2 = j2.conversations['private:1918594889'];
const lastUnread = (st2.unread ?? []).slice(-2).map((u) => `${u.kind}: ${u.text.slice(0, 50)}`);
console.log('最新未读:', JSON.stringify(lastUnread));
console.log('提醒状态:', JSON.stringify(r.body), '-> fired?');
r = await api('/api/socialV2/reminder/list', { key: 'private:1918594889', status: 'fired' });
console.log('fired 列表:', JSON.stringify(r.body.reminders ?? []).slice(0, 160));
if (remId) await api('/api/socialV2/reminder/cancel', { key: 'private:1918594889', id: remId + 1 }).catch(() => {});
process.exit(0);
