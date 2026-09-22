// P4 实测（修正版）：好感度 + 自我笔记 + 长轮询（>300s）
import fs from 'node:fs';
import http from 'node:http';
const KEY = 'private:1918594889';
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const token = j.conversations[KEY].agentToken;
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const api = async (p, body) => {
  const res = await fetch('http://127.0.0.1:3100' + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken },
    body: JSON.stringify({ key: KEY, token, ...body }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log('[1] 好感度 bump 主人 +5');
let r = await api('/api/socialV2/affinity', { action: 'bump', memberId: '1918594889', name: '爱吃布拉瓦的柚子', delta: 5, note: '嘴硬心软，测鲸鲸测得很起劲' });
console.log('   ', JSON.stringify(r.body).slice(0, 200));

console.log('[2] 好感度 set 群友 -8');
r = await api('/api/socialV2/affinity', { action: 'set', memberId: '2113929217', name: '我的电脑', score: -8, note: '老被拉去跑测试，烦' });
console.log('   ', JSON.stringify(r.body.affinity ?? r.body).slice(0, 200));

console.log('[3] 好感度 list');
r = await api('/api/socialV2/affinity', { action: 'list' });
console.log('   ', JSON.stringify(r.body.affinity).slice(0, 260));

console.log('[4] 自我笔记 add + list');
r = await api('/api/socialV2/self-note', { action: 'add', kind: 'style', content: '我最近喜欢在句尾加"懂？"，显得欠揍一点' });
console.log('   add:', JSON.stringify(r.body));
r = await api('/api/socialV2/self-note', { action: 'list', limit: 3 });
console.log('   list:', JSON.stringify(r.body.notes).slice(0, 220));

console.log('[5] 长轮询 310 秒（旧 fetch 会在 300s 处炸成 fetch failed）');
const t0 = Date.now();
await new Promise((resolve) => {
  const req = http.request({
    hostname: '127.0.0.1', port: 3100, path: '/api/socialV2/wait', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken },
  }, (res) => {
    let d = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { d += c; });
    res.on('end', () => {
      console.log('   HTTP', res.statusCode, '耗时', Math.round((Date.now() - t0) / 1000), '秒');
      console.log('   响应:', d.slice(0, 160));
      resolve();
    });
  });
  req.setTimeout(400000, () => req.destroy(new Error('本地超时')));
  req.on('error', (e) => { console.log('   失败:', e.message, '@', Math.round((Date.now() - t0) / 1000), '秒'); resolve(); });
  req.write(JSON.stringify({ key: KEY, token, timeoutMs: 310000 }));
  req.end();
});
console.log('===== 全部完成 =====');
process.exit(0);
