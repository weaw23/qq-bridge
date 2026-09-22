// 模拟 MCP 客户端握手，列出 safe server 的全部工具名
import { spawn } from 'node:child_process';

const child = spawn('C:/Users/HCK/AppData/Local/Programs/nodejs/node.exe', ['D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.result?.tools) {
        const names = msg.result.tools.map((t) => t.name);
        console.log('工具总数:', names.length);
        console.log('pc_* 工具:', names.filter((n) => n.startsWith('pc_')).join(', ') || '(无!)');
        console.log('P1/P2 工具在位:', ['qq_group_admin', 'qq_db_remember', 'qq_set_reminder'].every((n) => names.includes(n)) ? '是' : '否');
        child.kill();
        process.exit(0);
      }
    } catch {}
  }
});
child.stderr.on('data', () => {});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 300);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), 700);
setTimeout(() => { console.log('超时，未收到 tools/list 响应'); child.kill(); process.exit(1); }, 15000);
