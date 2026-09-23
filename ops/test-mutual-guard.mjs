// 双向守护实测：① 杀看门狗 → 桥接应在 ~3 分钟内拉回；② 杀桥接 → 看门狗应在 60 秒内拉回
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const kill = (pat) => { try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${pat}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { timeout: 20000, windowsHide: true }); } catch {} };
const find = (pat) => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${pat}*' } | Measure-Object).Count`], { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim(); } catch { return '?'; } };
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const chainOk = async () => { try { const o = await (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: { 'x-console-token': ct }, signal: AbortSignal.timeout(3000) })).json(); return o.qq.online ? `桥接 pid ${o.pid} | QQ ${o.qq.nickname} 在线` : '桥接在但QQ离线'; } catch { return null; } };

console.log('起始：看门狗进程数 =', find('watchdog.mjs'), '| 链路 =', await chainOk());

console.log('\n[测试1] 杀掉看门狗 → 等桥接的"互相守护"（最长 3.5 分钟）');
kill('watchdog.mjs');
await new Promise((r) => setTimeout(r, 3000));
console.log('  杀掉后看门狗进程数 =', find('watchdog.mjs'));
let back = false;
for (let i = 0; i < 21; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  if (find('watchdog.mjs') !== '0') { console.log(`  ✅ 桥接已把看门狗拉回（约 ${(i + 1) * 10} 秒）`); back = true; break; }
}
if (!back) console.log('  ⚠️ 3.5 分钟内未拉回（可能护栏周期还没到）');

console.log('\n[测试2] 杀掉桥接 → 等看门狗恢复（最长 90 秒）');
kill('bridge.js');
await new Promise((r) => setTimeout(r, 3000));
console.log('  杀掉后 link =', await chainOk());
for (let i = 0; i < 9; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const s = await chainOk();
  if (s) { console.log(`  ✅ 看门狗已恢复链路（约 ${(i + 1) * 10} 秒）：${s}`); break; }
  if (i === 8) console.log('  ⚠️ 90 秒内未恢复');
}
console.log('\n=== 最终状态 ===');
console.log('看门狗进程数 =', find('watchdog.mjs'), '| 链路 =', await chainOk());
process.exit(0);
