// 验证重连后她的工具清单是否已更新（精简描述 + qq_help）
import fs from 'node:fs';
import zlib from 'node:zlib';
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', 'x-console-token': ct };
const post = async (p, b) => (await fetch('http://127.0.0.1:3100' + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();

const before = (await (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: H })).json()).wakeLimits;
await post('/api/panel/toggle', { path: 'socialV2.wake', value: { ...before, maxWakePerMinute: 20, maxWakePerHour: 200 } });
console.log('[1] 唤醒:', JSON.stringify(await post('/api/socialV2/wake', { key: 'private:1918594889', reason: 'admin' })));
await new Promise((r) => setTimeout(r, 40000));

const sid = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/sessions.json', 'utf8')).sessions['private:1918594889'];
if (!sid) { console.log('未创建会话（可能繁忙）'); await post('/api/panel/toggle', { path: 'socialV2.wake', value: before }); process.exit(0); }
console.log('[2] 会话:', sid);
const root = 'C:/Users/HCK/.dsh/sessions/--D-qqbot-qq-whale--';
const dir = fs.readdirSync(root).find((d) => d.includes(sid.replace('session-', '')));
const buf = fs.readFileSync(`${root}/${dir}/session.jsonl.zstd`);
const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const idx = [];
let p = 0;
while ((p = buf.indexOf(M, p)) !== -1) { idx.push(p); p += 4; }
let text = '';
for (let i = 0; i < idx.length; i++) {
  try { text += zlib.zstdDecompressSync(buf.slice(idx[i], i + 1 < idx.length ? idx[i + 1] : buf.length)).toString('utf8'); } catch {}
}
const which = (needle) => (text.includes(needle) ? '✅' : '❌');
console.log('[3] 工具清单检查');
console.log('   ' + which('查机器人登录状态（只读）') + ' 精简描述（qq_status）');
console.log('   ' + which('查询 QQ 机器人登录状态与账号信息') + ' 旧长描述仍存在（应为❌）');
console.log('   ' + which('"qq_help"') + ' qq_help 工具已下发');
console.log('   ' + which('qq_person_profile') + ' qq_person_profile 工具已下发');
console.log('   ' + which('qq_followup') + ' qq_followup 工具已下发');
// 统计工具 schema 里的描述字符总量
const m = text.match(/"name":"mcp__snowluma__[^"]+","description":"((?:[^"\\]|\\.)*)"/g) || [];
const total = m.reduce((a, s) => a + (s.match(/"description":"((?:[^"\\]|\\.)*)"/)?.[1]?.length ?? 0), 0);
console.log(`[4] 会话里 mcp__snowluma__ 工具数 ${m.length}，描述合计 ${total} 字符（压缩前约 8300）`);
console.log('[5] 恢复唤醒限制');
await post('/api/panel/toggle', { path: 'socialV2.wake', value: before });
process.exit(0);
