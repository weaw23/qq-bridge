// 现场诊断：桥接健康 + 面板可用性 + 令牌一致性
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const fileTok = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
console.log('[1] 桥接进程');
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' } | ForEach-Object { $_.ProcessId }) -join ','"], { encoding: 'utf8' }).trim();
  console.log('   pid:', out || '(没有桥接进程！)');
} catch (e) { console.log('   查询失败'); }

console.log('[2] 控制台端口 3100 是否在听');
try {
  const r = await fetch('http://127.0.0.1:3100/panel', { signal: AbortSignal.timeout(4000) });
  const html = await r.text();
  const m = html.match(/const INJECTED = '([^']+)'/);
  const injected = m ? m[1] : null;
  console.log('   GET /panel →', r.status, '| 页面大小', html.length, '| 注入令牌前 8 位:', injected ? injected.slice(0, 8) : '(未注入)');
  console.log('   注入令牌 === 文件令牌 ?', injected === fileTok ? '✅ 一致' : '❌ 不一致（文件 ' + fileTok.slice(0, 8) + '）');
} catch (e) { console.log('   ❌ 连不上：' + e.message); process.exit(0); }

console.log('[3] 面板同款 API 调用（用文件令牌）');
for (const p of ['/api/panel/overview', '/api/panel/data?kind=affinity']) {
  try {
    const r = await fetch('http://127.0.0.1:3100' + p, { headers: { 'x-console-token': fileTok }, signal: AbortSignal.timeout(5000) });
    console.log('   ' + p + ' →', r.status, (await r.text()).slice(0, 60).replace(/\n/g, ' '));
  } catch (e) { console.log('   ' + p + ' → 错误 ' + e.message); }
}

console.log('[4] 一键启动脚本里读令牌的方式（cmd for /f）');
try {
  const out = execFileSync('cmd.exe', ['/c', 'for /f "delims=" %t in (\'type "D:\\qqbot\\qq-bridge\\state\\console-token"\') do @echo %t'], { encoding: 'utf8' }).trim();
  console.log('   cmd 读到的令牌前 8 位:', out.slice(0, 8), '| 与文件一致:', out === fileTok ? '✅' : '❌ (长度 ' + out.length + ' vs ' + fileTok.length + ')');
} catch (e) { console.log('   读取失败:', e.message.slice(0, 80)); }

console.log('[5] 桥接日志尾部（看是否有面板相关报错）');
const log = fs.readFileSync('D:/qqbot/logs/bridge.out.log', 'utf8').split(/\r?\n/).slice(-6);
log.forEach((l) => console.log('   ' + l.slice(0, 120)));
const err = fs.readFileSync('D:/qqbot/logs/bridge.err.log', 'utf8').split(/\r?\n/).slice(-4);
console.log('   --- err ---');
err.forEach((l) => console.log('   ' + l.slice(0, 120)));
