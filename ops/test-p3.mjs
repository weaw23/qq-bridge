// P3 实测：sys_info + screenshot → outbox → rich 发给主人
import fs from 'node:fs';
const pc = await import('file:///D:/qqbot/qq-bridge/src/pc-actions.js');

console.log('[1] pc_sys_info');
const si = await pc.sysInfo();
console.log(si.ok ? si.output : 'FAIL: ' + si.error);

console.log('[2] pc_screenshot');
const ss = await pc.screenshot();
console.log(JSON.stringify(ss).slice(0, 220));
if (!ss.ok) process.exit(1);

console.log('[3] 截图发给主人私聊（rich 端点，即 qq_send_image 同管线）');
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const token = j.conversations['private:1918594889'].agentToken;
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const res = await fetch('http://127.0.0.1:3100/api/send/rich', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken },
  body: JSON.stringify({
    key: 'private:1918594889',
    token,
    parts: [
      { type: 'image', file: 'file:///' + ss.file.replace(/\\/g, '/') },
      { type: 'text', text: 'P3 实测：你电脑当前的屏幕画面' },
    ],
  }),
});
console.log('send:', res.status, JSON.stringify(await res.json()).slice(0, 120));
process.exit(0);
