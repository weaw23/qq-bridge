// P6-6 冒烟测试：stdio 握手 → 列工具 → qq_help 取全文 → 实调一个工具
import { spawn } from 'node:child_process';
const child = spawn('C:/Users/HCK/AppData/Local/Programs/nodejs/node.exe', ['D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', () => {});
let id = 0;
const call = (method, params) => new Promise((res) => { const myId = ++id; pending.set(myId, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n'); setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ error: { message: 'timeout' } }); } }, 30000); });

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await new Promise((r) => setTimeout(r, 400));

const list = await call('tools/list', {});
const tools = list.result?.tools ?? [];
const descChars = tools.reduce((a, t) => a + (t.description?.length ?? 0), 0);
console.log('工具数:', tools.length, '| 描述总字符:', descChars);
console.log('样例（前 3 个）:');
tools.slice(0, 3).forEach((t) => console.log(`  ${t.name}: ${t.description}`));
const help = tools.find((t) => t.name === 'qq_help');
console.log('qq_help 存在:', !!help, '|', help?.description);

const r1 = await call('tools/call', { name: 'qq_help', arguments: { name: 'qq_wait_for_messages' } });
const txt1 = r1.result?.content?.[0]?.text ?? JSON.stringify(r1).slice(0, 200);
console.log('\nqq_help(qq_wait_for_messages) 返回长度:', txt1.length, '| 前 120 字:', txt1.slice(0, 120).replace(/\n/g, ' '));

const r2 = await call('tools/call', { name: 'qq_help', arguments: {} });
const txt2 = r2.result?.content?.[0]?.text ?? '';
console.log('qq_help() 工具清单长度:', txt2.length, '|', txt2.slice(0, 100).replace(/\n/g, ' '));

const r3 = await call('tools/call', { name: 'qq_status', arguments: {} });
const txt3 = r3.result?.content?.[0]?.text ?? JSON.stringify(r3).slice(0, 200);
console.log('\nqq_status 实调 →', txt3.slice(0, 160).replace(/\n/g, ' '));

child.kill();
process.exit(0);
