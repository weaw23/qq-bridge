// 安全探测 SnowLuma 管理动作支持情况（全部用不存在的群号，只看错误类型）
import fs from 'node:fs';
const token = fs.readFileSync('D:/qqbot/qq-bridge/.snowluma-token', 'utf8').trim();
const call = async (action, params) => {
  const res = await fetch(`http://127.0.0.1:3000/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const j = await res.json().catch(() => ({}));
  return `${res.status} retcode=${j.retcode} status=${j.status} wording=${j.wording ?? ''} msg=${(j.message ?? '').slice(0, 60)}`;
};
const G = 999999999; // 不存在的群
const U = 10000;     // 不存在的用户
const probes = [
  ['set_group_ban', { group_id: G, user_id: U, duration: 1 }],
  ['set_group_whole_ban', { group_id: G, enable: true }],
  ['set_group_kick', { group_id: G, user_id: U, reject_add_request: false }],
  ['set_group_card', { group_id: G, user_id: U, card: 'x' }],
  ['set_group_admin', { group_id: G, user_id: U, enable: true }],
  ['set_group_special_title', { group_id: G, user_id: U, special_title: 'x' }],
  ['set_essence_msg', { message_id: -1 }],
  ['send_group_notice', { group_id: G, content: 'probe' }],
  ['get_group_notice', { group_id: G }],
  ['set_group_leave', { group_id: G, is_dismiss: false }],
];
for (const [a, p] of probes) {
  console.log(a.padEnd(24), await call(a, p));
}
process.exit(0);
