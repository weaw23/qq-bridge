// 新号端到端验证：唤醒 → 她是否用新号发消息 → 桥接日志确认
import fs from 'node:fs';
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const T = fs.readFileSync('D:/qqbot/qq-bridge/.snowluma-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', 'x-console-token': ct };
const post = async (p, b) => (await fetch('http://127.0.0.1:3100' + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
const overview = async () => (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: H })).json();

const before = (await overview()).wakeLimits;
await post('/api/panel/toggle', { path: 'socialV2.wake', value: { ...before, maxWakePerMinute: 20, maxWakePerHour: 200 } });
console.log('[1] 唤醒 group:471975044（22 条未读）');
console.log('   ', JSON.stringify(await post('/api/socialV2/wake', { key: 'group:471975044', reason: 'admin' })));

console.log('[2] 等她自己动手（最多 90 秒）…');
const log0 = fs.readFileSync('D:/qqbot/logs/bridge.out.log', 'utf8').length;
for (let i = 0; i < 9; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const tail = fs.readFileSync('D:/qqbot/logs/bridge.out.log', 'utf8').slice(log0);
  const sends = tail.split(/\r?\n/).filter((l) => /工具统一发送|工具富媒体发送/.test(l));
  if (sends.length) { console.log('   ✅ 她发了消息：'); sends.forEach((l) => console.log('     ' + l.trim())); break; }
  if (i === 8) console.log('   （90 秒内还没发——她可能选择只看不说，或还在读）');
}

console.log('\n[3] 桥接对她的动作记录');
const tail = fs.readFileSync('D:/qqbot/logs/bridge.out.log', 'utf8').split(/\r?\n/).slice(-8);
tail.forEach((l) => console.log('   ' + l.slice(0, 130)));

console.log('\n[4] 恢复唤醒限制');
await post('/api/panel/toggle', { path: 'socialV2.wake', value: before });

console.log('\n[5] 新号账号信息');
const info = await (await fetch('http://127.0.0.1:3000/get_login_info', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: '{}' })).json();
console.log('   ', JSON.stringify(info.data));
process.exit(0);
