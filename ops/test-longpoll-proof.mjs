// 决定性对比：fetch（旧路径，undici 300s 掐断） vs node:http（新路径）
import fs from 'node:fs';
import http from 'node:http';
const KEY = 'group:1107691307';
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const token = j.conversations[KEY]?.agentToken ?? '';
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
console.log('目标会话:', KEY, 'token 前 6 位:', token.slice(0, 6));

const call = (timeoutMs, useFetch) => new Promise((resolve) => {
  const t0 = Date.now();
  if (useFetch) {
    fetch('http://127.0.0.1:3100/api/socialV2/wait', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken },
      body: JSON.stringify({ key: KEY, token, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 30000),
    }).then((r) => r.json()).then((b) => resolve({ ok: true, secs: Math.round((Date.now() - t0) / 1000), body: b }))
      .catch((e) => resolve({ ok: false, secs: Math.round((Date.now() - t0) / 1000), err: String(e?.message ?? e) }));
    return;
  }
  const req = http.request({
    hostname: '127.0.0.1', port: 3100, path: '/api/socialV2/wait', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken },
  }, (res) => {
    let d = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve({ ok: true, secs: Math.round((Date.now() - t0) / 1000), body: (() => { try { return JSON.parse(d); } catch { return d.slice(0, 100); } })() }));
  });
  req.setTimeout(timeoutMs + 40000, () => req.destroy(new Error('本地超时')));
  req.on('error', (e) => resolve({ ok: false, secs: Math.round((Date.now() - t0) / 1000), err: String(e?.message ?? e) }));
  req.write(JSON.stringify({ key: KEY, token, timeoutMs }));
  req.end();
});

console.log('[A] 旧路径 fetch 305 秒（预期：约 300 秒处被 undici 掐断 = fetch failed）');
const a = await call(305000, true);
console.log('   →', a.ok ? `成功 ${a.secs}s` : `失败 ${a.secs}s: ${a.err}`, a.ok ? JSON.stringify(a.body).slice(0, 100) : '');

await new Promise((r) => setTimeout(r, 3000));
console.log('[B] 新路径 node:http 310 秒（预期：完整等到 310 秒后正常返回 timeout=true）');
const b = await call(310000, false);
console.log('   →', b.ok ? `成功 ${b.secs}s: ${JSON.stringify(b.body).slice(0, 140)}` : `失败 ${b.secs}s: ${b.err}`);
console.log('===== 对比结束 =====');
process.exit(0);
