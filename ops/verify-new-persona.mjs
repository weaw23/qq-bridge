// 验证：新建的私聊会话系统提示里是否是新人格
import fs from 'node:fs';
import zlib from 'node:zlib';
const st = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/sessions.json', 'utf8'));
console.log('当前会话映射:', JSON.stringify(st.sessions, null, 1));
const sid = st.sessions['private:1918594889'];
if (!sid) { console.log('⚠️ 私聊还没有会话（可能唤醒被频率限制跳过）'); process.exit(0); }
const root = 'C:/Users/HCK/.dsh/sessions/--D-qqbot-qq-whale--';
const dir = fs.readdirSync(root).find((d) => d.includes(sid.replace('session-', '')));
console.log('会话目录:', dir);
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
  '新人格·小女仆': text.includes('小女仆'),
  '新人格·深度求索': text.includes('来自深度求索'),
  '新人格·软萌可爱': text.includes('软萌、可爱、惹人喜欢'),
  '新人格·不许毒舌禁令': text.includes('不许说脏话、不许阴阳怪气'),
  '旧人格·机灵狡黠(应为否)': !text.includes('机灵狡黠、毒舌'),
  '旧人格·反向撒娇(应为否)': !text.includes('【反向撒娇 —— 你的招牌】'),
};
for (const [k, v] of Object.entries(checks)) console.log('  ' + (v ? '✅' : '❌') + ' ' + k);
console.log('\n会话文件大小:', Math.round(buf.length / 1024), 'KB');
