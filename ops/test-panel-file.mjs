// 本地文件场景复测（file:// 打开面板应给出明确指引）
import { execFileSync } from 'node:child_process';
const CDP = 'C:\\Users\\HCK\\.dsh\\skills\\web-access\\cdp.mjs';
const run = (...a) => { try { return execFileSync('node', [CDP, ...a], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim(); } catch (e) { return 'ERR ' + String(e.message).slice(0, 200); } };
const ev = (js) => run('eval', js, '--await');

console.log('[file:// 打开面板]');
console.log(run('goto', 'file:///D:/qqbot/qq-bridge/console-panel.html', '--wait', '6000').split('\n')[0]);
console.log('页面状态:', ev("JSON.stringify({url:location.href.slice(0,20), pill:document.querySelector('.pill')?document.querySelector('.pill').innerText:'-', downBanner:!!document.getElementById('downBanner')})"));
console.log('提示内容:', ev("(document.getElementById('downBanner')||{innerText:'(无)'}).innerText.slice(0,120)"));
console.log('\n[回到正常网址]');
console.log(run('goto', 'http://127.0.0.1:3100/panel', '--wait', '5000').split('\n')[0]);
console.log('页面状态:', ev("JSON.stringify({pill:document.querySelector('.pill').innerText, toggles:document.querySelectorAll('.switch input').length, banner:!!document.getElementById('downBanner')})"));
process.exit(0);
