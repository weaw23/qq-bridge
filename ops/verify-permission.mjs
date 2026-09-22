// 验证权限预设：新建会话 → 读运行时上下文里的 file policy / approval policy
import fs from 'node:fs';
import zlib from 'node:zlib';
import { NodeApiClient, unwrap } from 'file:///D:/qqbot/qq-bridge/src/dsh-client.js';

const api = new NodeApiClient('http://127.0.0.1:43120', undefined, { token: '', header: 'authorization', prefix: 'Bearer' });
const created = unwrap(await api.sessions.create({ cwd: 'D:\\qqbot\\qq-whale' }), 'session.create');
const sessionId = created.sessionId;
console.log('测试会话:', sessionId);
try { unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] }), 'prompt'); console.log('prompt 已投递'); } catch (e) { console.log('prompt 失败:', e.message.slice(0, 100)); }
await new Promise((r) => setTimeout(r, 12000));

const root = 'C:/Users/HCK/.dsh/sessions/--D-qqbot-qq-whale--';
const dir = fs.readdirSync(root).find((d) => d.includes(sessionId.replace('session-', '')));
if (!dir) { console.log('未找到会话目录'); process.exit(0); }
const f = `${root}/${dir}/session.jsonl.zstd`;
const buf = fs.readFileSync(f);
const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const idx = [];
let p = 0;
while ((p = buf.indexOf(M, p)) !== -1) { idx.push(p); p += 4; }
let text = '';
for (let i = 0; i < idx.length; i++) {
  try { text += zlib.zstdDecompressSync(buf.slice(idx[i], i + 1 < idx.length ? idx[i + 1] : buf.length)).toString('utf8'); } catch {}
}
const fp = text.match(/Current DSH file policy: ([a-z-]+)/);
const ap = text.match(/Approval policy: ([a-z-]+)/);
console.log('文件策略:', fp ? fp[1] : '(未找到)');
console.log('审批策略:', ap ? ap[1] : '(未找到)');
console.log('结论:', fp?.[1] === 'danger-full-access' && ap?.[1] === 'never' ? '✅ 完全权限已生效' : '⚠️ 未按预期');
try { unwrap(await api.workspace.archiveSession({ sessionId }), 'archive'); console.log('测试会话已归档'); } catch {}
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
