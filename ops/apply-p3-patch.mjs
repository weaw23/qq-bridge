// P3 拼接器：safe server 引入 pc-actions + 8 个 pc_* 工具
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';
let t = fs.readFileSync(SAFE, 'utf8');
if (t.includes('pc_run_command')) throw new Error('safe server 已含 P3 补丁，跳过');

// 1) import（插在 SENSITIVE_RE import 之后）
const impAnchor = "import { SENSITIVE_RE } from './sensitive.js';";
const iImp = t.indexOf(impAnchor);
if (iImp === -1) throw new Error('找不到 import 锚点');
const impLine = "import * as pc from './pc-actions.js';";
t = t.slice(0, iImp) + impLine + '\n' + t.slice(iImp);

// 2) 工具段（插在 server.connect 之前）
const connAnchor = 'await server.connect(new StdioServerTransport());';
const iConn = t.indexOf(connAnchor);
if (iConn === -1) throw new Error('找不到 connect 锚点');
const lineStart = t.lastIndexOf('\n', iConn) + 1;
const payload = fs.readFileSync('D:/qqbot/insert-p3-tools.txt', 'utf8');
t = t.slice(0, lineStart) + payload + t.slice(lineStart);
fs.writeFileSync(SAFE, t);

execFileSync('node', ['--check', SAFE], { stdio: 'inherit' });
execFileSync('node', ['--check', 'D:/qqbot/qq-bridge/src/pc-actions.js'], { stdio: 'inherit' });
console.log('P3 补丁完成，syntax OK，safe lines:', t.split('\n').length);
