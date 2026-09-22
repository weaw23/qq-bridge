// 验证面板的「重启桥接」一键功能 + 重新截图
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const token = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', 'x-console-token': token };
const oldPid = (await (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: H })).json()).pid;
console.log('重启前 bridge pid:', oldPid);

console.log('[1] 触发面板「重启桥接」');
const r = await fetch('http://127.0.0.1:3100/api/panel/control', { method: 'POST', headers: H, body: JSON.stringify({ action: 'restart-bridge' }) });
console.log('   响应:', r.status, JSON.stringify(await r.json()).slice(0, 120));

console.log('[2] 等待自动拉起（最多 30 秒）…');
let up = false;
for (let i = 0; i < 15; i++) {
  await new Promise((res) => setTimeout(res, 2000));
  try {
    const o = await (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: H, signal: AbortSignal.timeout(3000) })).json();
    if (o.ok) { console.log(`   ✓ 已恢复（新 pid ${o.pid}，用时约 ${(i + 1) * 2} 秒）`); up = true; break; }
  } catch {}
}
if (!up) { console.log('   ✗ 未能自动恢复（需要手动重启桥接）'); process.exit(1); }

console.log('[3] 重新截图面板（验证排版修复）');
const CDP = 'C:\\Users\\HCK\\.dsh\\skills\\web-access\\cdp.mjs';
const run = (...a) => { try { return execFileSync('node', [CDP, ...a], { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR ' + String(e.message).slice(0, 120); } };
console.log(run('goto', `http://127.0.0.1:3100/panel?token=${token}`, '--wait', '6000').split('\n')[0]);
console.log(run('shot', 'panel2.png', '--full').split('\n')[0]);
const f = 'D:\\qqbot\\outbox\\panel2.png';
console.log('截图大小:', fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) + ' KB' : '失败');
process.exit(0);
