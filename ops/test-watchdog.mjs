// 看门狗自愈实测：杀掉桥接 → 等计划任务自动拉回
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const alive = async () => { try { const r = await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: { 'x-console-token': ct }, signal: AbortSignal.timeout(3000) }); const j = await r.json(); return j.pid; } catch { return null; } };

console.log('杀前 pid:', await alive());
console.log('→ 杀掉所有桥接进程');
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { timeout: 20000 });
} catch {}
await new Promise((r) => setTimeout(r, 3000));
console.log('确认已死:', (await alive()) === null ? '✅ 已停止' : '❌ 还在');

console.log('→ 等看门狗（计划任务每分钟一次）…');
const t0 = Date.now();
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const pid = await alive();
  if (pid) { console.log(`✅ 看门狗已自动拉回！新 pid ${pid}，耗时约 ${Math.round((Date.now() - t0) / 1000)} 秒`); break; }
  console.log(`   ${(i + 1) * 10}s 仍未恢复…`);
}
console.log('--- 看门狗日志 ---');
console.log(fs.readFileSync('D:/qqbot/logs/watchdog.log', 'utf8').split(/\r?\n/).slice(-5).join('\n'));
process.exit(0);
