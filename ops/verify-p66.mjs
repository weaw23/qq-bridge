// 验证：新会话是否拿到 精简工具描述 + 表达库注入
import fs from 'node:fs';
import zlib from 'node:zlib';
const ct = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const H = { 'Content-Type': 'application/json', 'x-console-token': ct };
const post = async (p, b) => (await fetch('http://127.0.0.1:3100' + p, { method: 'POST', headers: H, body: JSON.stringify(b) })).json();

const before = (await (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: H })).json()).wakeLimits;
await post('/api/panel/toggle', { path: 'socialV2.wake', value: { ...before, maxWakePerMinute: 20, maxWakePerHour: 200 } });
console.log('[1] 唤醒私聊:', JSON.stringify(await post('/api/socialV2/wake', { key: 'private:1918594889', reason: 'admin' })));
await new Promise((r) => setTimeout(r, 35000));

const st = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/sessions.json', 'utf8'));
const sid = st.sessions['private:1918594889'];
console.log('[2] 新会话:', sid ?? '(未创建)');
if (sid) {
  const root = 'C:/Users/HCK/.dsh/sessions/--D-qqbot-qq-whale--';
  const dir = fs.readdirSync(root).find((d) => d.includes(sid.replace('session-', '')));
  const buf = fs.readFileSync(`${root}/${dir}/session.jsonl.zstd`);
  const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const idx = [];
  let p = 0;
  while ((p = buf.indexOf(M, p)) !== -1) { idx.push(p); p += 4; }
  let text = '';
  for (let i = 0; i < idx.length; i++) {
    try { text += zlib.zstdDecompressSync(buf.slice(idx[i], i + 1 < idx.length ? idx[i + 1] : buf.length)).toString('utf8'); } catch {}
  }
  const checks = {
    '精简工具描述生效（qq_status 短版）': text.includes('查机器人登录状态（只读）'),
    '旧版长描述已消失': !text.includes('查询 QQ 机器人登录状态与账号信息（只读）'),
    'qq_help 工具在位': text.includes('查工具的完整说明'),
    '表达库注入（群里的说话方式）': text.includes('群里的说话方式'),
    '表达库有内容（万一是X呢）': text.includes('万一是X呢') || text.includes('不太行'),
    '人格含 qq_help 提示': text.includes('工具说明是精简版'),
    '人物画像注入（柚子主人画像）': text.includes('callName') || text.includes('深夜聊天'),
  };
  for (const [k, v] of Object.entries(checks)) console.log('   ' + (v ? '✅' : '❌') + ' ' + k);
  console.log('   会话日志:', Math.round(buf.length / 1024), 'KB');
}
console.log('[3] 恢复唤醒限制');
await post('/api/panel/toggle', { path: 'socialV2.wake', value: before });
process.exit(0);
