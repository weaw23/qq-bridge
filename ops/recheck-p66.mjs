import fs from 'node:fs';
import zlib from 'node:zlib';
const sid = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/sessions.json', 'utf8')).sessions['private:1918594889'];
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
console.log('日志大小:', Math.round(buf.length / 1024), 'KB /', text.length, '字符（解压后）');
const probes = {
  '工具名 mcp__snowluma__qq_status': 'mcp__snowluma__qq_status',
  '工具名 qq_help': 'qq_help',
  '工具长描述残留': '查询 QQ 机器人登录状态与账号信息',
  '工具短描述': '查机器人登录状态',
  '画像注入标记 好感度': '好感度',
  '画像称呼字段': '称呼"',
  '表达库块': '群里的说话方式',
  '人格 qq_help 提示': '工具说明是精简版',
  '待跟进块': '待跟进',
  '好感度块': '关系记忆 · 好感度',
};
for (const [k, needle] of Object.entries(probes)) {
  const i = text.indexOf(needle);
  console.log((i >= 0 ? '✅' : '❌') + ' ' + k + (i >= 0 ? `（位置 ${i}，上下文：${text.slice(Math.max(0, i - 40), i + 60).replace(/\s+/g, ' ')}）` : ''));
}
