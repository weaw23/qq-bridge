// 探测 SnowLuma 状态类动作支持情况
import fs from 'node:fs';
const token = fs.readFileSync('D:/qqbot/qq-bridge/.snowluma-token', 'utf8').trim();
const call = async (action, params) => {
  const res = await fetch(`http://127.0.0.1:3000/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const j = await res.json().catch(() => ({}));
  return j;
};
console.log('=== 状态类动作探测 ===');
let r = await call('get_friend_list', {});
console.log('get_friend_list:', r.retcode === 0 ? `ok, ${r.data?.length ?? 0} 个好友` : `retcode=${r.retcode} ${r.wording ?? ''}`);
if (r.retcode === 0) console.log('  好友样例:', JSON.stringify((r.data ?? []).slice(0, 3).map((f) => ({ uid: f.user_id, nick: f.nickname, remark: f.remark }))));

r = await call('get_version_info', {});
console.log('get_version_info:', r.retcode === 0 ? JSON.stringify(r.data).slice(0, 120) : `retcode=${r.retcode}`);

r = await call('get_stranger_info', { user_id: 1918594889 });
console.log('get_stranger_info:', r.retcode === 0 ? JSON.stringify(r.data).slice(0, 120) : `retcode=${r.retcode} ${r.wording ?? ''}`);

r = await call('get_group_honor_info', { group_id: 1107691307, type: 'all' });
console.log('get_group_honor_info:', r.retcode === 0 ? 'ok' : `retcode=${r.retcode} ${r.wording ?? ''}`);

r = await call('get_group_member_info', { group_id: 963871667, user_id: 3692140164 });
const mi = r.data ?? {};
console.log('get_group_member_info(自己在963871667):', r.retcode === 0 ? `role=${mi.role} card='${mi.card}' shut_up_timestamp=${mi.shut_up_timestamp} level=${mi.level}` : `retcode=${r.retcode}`);

r = await call('get_group_info', { group_id: 963871667 });
console.log('get_group_info:', r.retcode === 0 ? `${r.data?.group_name} ${r.data?.member_count}人` : `retcode=${r.retcode}`);

r = await call('get_group_at_all_remain', { group_id: 1107691307 });
console.log('get_group_at_all_remain:', r.retcode === 0 ? JSON.stringify(r.data) : `retcode=${r.retcode} ${r.wording ?? ''}`);
process.exit(0);
