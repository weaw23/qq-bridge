// 端到端复核：三种打开方式 + 服务健康
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const CDP = 'C:\\Users\\HCK\\.dsh\\skills\\web-access\\cdp.mjs';
const token = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const run = (...a) => { try { return execFileSync('node', [CDP, ...a], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim(); } catch (e) { return 'ERR ' + String(e.message).slice(0, 200); } };
const ev = (js) => run('eval', js, '--await');
const snap = () => ev(`JSON.stringify({pill:document.querySelector('.pill')?document.querySelector('.pill').innerText:'-',down:!!document.getElementById('downBanner'),auth:!!document.getElementById('authBanner'),toggles:document.querySelectorAll('.switch input').length})`);

// 起 headless 调试浏览器
const e = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-debug-profile*' } | Measure-Object).Count"], { encoding: 'utf8' }).trim();
if (e === '0') {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "Start-Process -FilePath 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=D:\\qqbot\\edge-debug-profile','--no-first-run','--headless=new','about:blank' -WindowStyle Hidden"], { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 8000));
}

console.log('[1] 正常网址打开');
console.log(run('goto', 'http://127.0.0.1:3100/panel', '--wait', '6000').split('\n')[0]);
console.log('   ', snap());

console.log('[2] 模拟本地文件打开（file:// 场景）');
const fileUrl = 'file:///D:/qqbot/qq-bridge/console-panel.html';
console.log(run('goto', fileUrl, '--wait', '6000').split('\n')[0]);
console.log('   ', snap());
console.log('   提示文字:', ev("/document.getElementById('downBanner')?document.getElementById('downBanner').innerText.slice(0,90):'(无提示)'"));

console.log('[3] 回到正常网址确认仍可用');
console.log(run('goto', 'http://127.0.0.1:3100/panel', '--wait', '5000').split('\n')[0]);
console.log('   ', snap());
console.log('   截图:', run('shot', 'panel5.png', '--full').split('\n')[0]);
process.exit(0);
