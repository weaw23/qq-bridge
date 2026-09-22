// 控制台面板补丁：child_process 导入 + /panel 免令牌 + 面板 API
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let t = fs.readFileSync(BRIDGE, 'utf8');
if (t.includes('/api/panel/overview')) throw new Error('已打过面板补丁');

// 1) child_process 导入
const impAnchor = "import http from 'node:http';";
if (t.includes("from 'node:child_process'")) console.log('child_process 已导入，跳过');
else {
  const i = t.indexOf(impAnchor);
  if (i === -1) throw new Error('找不到 http import 锚点');
  t = t.slice(0, i + impAnchor.length) + "\nimport { spawn, execFileSync } from 'node:child_process';" + t.slice(i + impAnchor.length);
}

// 2) /panel 免令牌（只放行面板外壳；数据 API 仍需令牌）
const authAnchor = `        if (req.method === 'GET' && url.pathname === '/') {`;
const authNew = `        if (req.method === 'GET' && url.pathname === '/panel') {
          // 面板外壳免令牌（数据接口仍校验）；页面内会让用户填令牌
          try {
            const html = fs.readFileSync(path.join(ROOT, 'console-panel.html'), 'utf8');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
            res.end(html);
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
            res.end('面板文件缺失：' + (error?.message ?? error));
          }
        } else if (req.method === 'GET' && url.pathname === '/') {`;
if (!t.includes(authAnchor)) throw new Error('找不到鉴权分支锚点');
t = t.replace(authAnchor, authNew);

// 3) 面板 API（插在富媒体端点之前）
const payload = fs.readFileSync('D:/qqbot/insert-panel-api.txt', 'utf8')
  // 去掉原有的 /panel 处理（上面已在鉴权处放行）
  .replace(/\s*\/\/ ── 控制台面板 API（集中开关 \+ 一键控制） ────────────────────────\n\s*if \(req\.method === 'GET' && url\.pathname === '\/panel'\) \{[\s\S]*?\n\s*\}\n\n/, '\n        // ── 控制台面板 API（集中开关 + 一键控制） ────────────────────────\n');
const anchor = '        // ── 富媒体发送端点';
const ai = t.indexOf(anchor);
if (ai === -1) throw new Error('找不到插入锚点');
const lineStart = t.lastIndexOf('\n', ai) + 1;
t = t.slice(0, lineStart) + payload + t.slice(lineStart);

fs.writeFileSync(BRIDGE, t);
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ 面板补丁完成，syntax OK，bridge 行数:', t.split('\n').length);
