// 面板渲染实测（数组传参避免引号问题）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const CDP = 'C:\\Users\\HCK\\.dsh\\skills\\web-access\\cdp.mjs';
const token = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const run = (...args) => { try { return execFileSync('node', [CDP, ...args], { encoding: 'utf8' }).trim(); } catch (e) { return 'ERR: ' + String(e.message).slice(0, 200); } };

console.log('[tabs]'); console.log(run('tabs'));
console.log('\n[goto]'); console.log(run('goto', `http://127.0.0.1:3100/panel?token=${token}`, '--wait', '6000'));
console.log('\n[text]'); console.log(run('text', '--max', '600'));
console.log('\n[eval 结构]');
const expr = 'JSON.stringify({title:document.title,h1:document.querySelector("h1")?document.querySelector("h1").innerText:null,pills:document.querySelectorAll(".pill").length,toggles:document.querySelectorAll(".switch").length,rows:document.querySelectorAll(".row").length,tables:document.querySelectorAll("table").length})';
console.log(run('eval', expr));
console.log('\n[shot]'); console.log(run('shot', 'panel.png', '--full'));
const f = 'D:\\qqbot\\outbox\\panel.png';
if (fs.existsSync(f)) console.log('文件大小:', Math.round(fs.statSync(f).size / 1024), 'KB');
