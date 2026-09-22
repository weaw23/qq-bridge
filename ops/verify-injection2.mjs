// 验证：新人格段落 + 好感度/自我笔记注入（用 12:20 后创建的新会话）
import fs from 'node:fs';
import zlib from 'node:zlib';
const st = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/sessions.json', 'utf8'));
const root = 'C:/Users/HCK/.dsh/sessions/--D-qqbot-qq-whale--';
const entries = Object.entries(st.sessions ?? {});
console.log('当前会话映射:', JSON.stringify(entries));
let checked = 0;
for (const [key, sid] of entries) {
  const dir = fs.readdirSync(root).find((d) => d.includes(String(sid).replace('session-', '')));
  if (!dir) { console.log(key, '→ 日志目录缺失'); continue; }
  const buf = fs.readFileSync(`${root}/${dir}/session.jsonl.zstd`);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const idx = [];
  let pos = 0;
  while ((pos = buf.indexOf(MAGIC, pos)) !== -1) { idx.push(pos); pos += 4; }
  let text = '';
  for (let i = 0; i < idx.length; i++) {
    const frame = buf.slice(idx[i], i + 1 < idx.length ? idx[i + 1] : buf.length);
    try { text += zlib.zstdDecompressSync(frame).toString('utf8') + '\n'; } catch {}
  }
  console.log(`\n=== ${key} (${String(sid).slice(0, 12)}) ===`);
  console.log('  新人格·关系感段:', text.includes('关系感') && text.includes('好感度系统') ? '✅' : '❌');
  console.log('  新人格·自我演化段:', text.includes('你会慢慢变成') ? '✅' : '❌');
  console.log('  好感度注入块:', text.includes('关系记忆 · 好感度') ? '✅' : '❌');
  console.log('  自我笔记注入块:', text.includes('自我演化笔记') ? '✅' : '❌');
  if (text.includes('关系记忆 · 好感度')) {
    const m = text.match(/关系记忆 · 好感度（[^）]*）】(\\n|\\\\n)([^\"]{0,200})/);
    if (m) console.log('  注入样例:', m[2].replace(/\\\\n/g, ' | ').slice(0, 180));
  }
  if (text.includes('自我演化笔记')) {
    const n = text.match(/自我演化笔记（最近）】(\\n|\\\\n)([^\"]{0,150})/);
    if (n) console.log('  笔记样例:', n[2].replace(/\\\\n/g, ' | ').slice(0, 150));
  }
  checked++;
}
process.exit(0);
