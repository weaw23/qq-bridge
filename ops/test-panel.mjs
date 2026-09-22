// 面板端到端实测：API + 浏览器截图
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', 'x-console-token': consoleToken };
const j = async (p, opt) => { const r = await fetch('http://127.0.0.1:3100' + p, { ...opt, headers: { ...H, ...(opt?.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

console.log('[1] 面板外壳免令牌可访问');
const shell = await fetch('http://127.0.0.1:3100/panel');
console.log('   HTTP', shell.status, '长度', (await shell.text()).length, '字节');

console.log('[2] /api/panel/overview');
const o = await j('/api/panel/overview');
const b = o.body;
console.log('   QQ:', b.qq?.online ? b.qq.nickname + ' 在线' : '离线', '| SnowLuma:', b.gateway, '| DSH:', b.dshReady, '| 模式:', b.mode);
console.log('   模型:', b.model.provider + '/' + b.model.model, '(' + b.model.reasoningEffort + ')', '| 工具数:', b.toolCount);
console.log('   计数:', JSON.stringify(b.counts), '| 会话:', b.sessions.length);

console.log('[3] 开关读写');
let r = await j('/api/panel/toggle', { method: 'POST', body: JSON.stringify({ path: 'pcControl.enabled', value: true }) });
console.log('   写 pcControl.enabled=true →', r.status, JSON.stringify(r.body).slice(0, 80));
r = await j('/api/panel/toggle', { method: 'POST', body: JSON.stringify({ path: 'hack.evil', value: 1 }) });
console.log('   非法路径应被拒 →', r.status, JSON.stringify(r.body).slice(0, 90));

console.log('[4] 数据面板');
for (const kind of ['affinity', 'facts', 'reminders', 'activity', 'tool-log', 'slang', 'feedback']) {
  const d = await j('/api/panel/data?kind=' + kind);
  console.log(`   ${kind}: HTTP ${d.status}${d.body.html ? ' 有数据 (' + d.body.html.length + ' 字节)' : ' ' + JSON.stringify(d.body).slice(0, 60)}`);
}

console.log('[5] 唤醒限制写入');
r = await j('/api/panel/toggle', { method: 'POST', body: JSON.stringify({ path: 'socialV2.wake', value: { maxWakePerMinute: 3, maxWakePerHour: 30, defaultMs: 30000, maxMs: 600000, preSleepWaitMs: 300000 } }) });
console.log('   →', r.status, JSON.stringify(r.body).slice(0, 100));

console.log('[6] 浏览器渲染截图');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
try { execFileSync(edge, ['--remote-debugging-port=9222', '--user-data-dir=D:\\qqbot\\edge-debug-profile', '--no-first-run', '--headless=new', 'about:blank'], { detached: true, stdio: 'ignore', timeout: 3000 }); } catch {}
await new Promise((r2) => setTimeout(r2, 6000));
const CDP = 'C:\\Users\\HCK\\.dsh\\skills\\web-access\\cdp.mjs';
console.log(execFileSync('node', [CDP, 'goto', 'http://127.0.0.1:3100/panel?token=' + consoleToken, '--wait', '4000'], { encoding: 'utf8' }).trim());
console.log(execFileSync('node', [CDP, 'eval', 'document.querySelector("h1").innerText + " | pills=" + document.querySelectorAll(".pill").length + " | rows=" + document.querySelectorAll(".row").length', '--tab', '0'], { encoding: 'utf8' }).trim());
console.log(execFileSync('node', [CDP, 'shot', 'panel.png', '--full'], { encoding: 'utf8' }).trim());
console.log('[7] 清理调试实例');
try { execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-debug-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { timeout: 15000 }); } catch {}
process.exit(0);
