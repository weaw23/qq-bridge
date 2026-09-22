// 鲸鲸看门狗：每 60 秒检查链路，缺什么补什么
//   - 桥接（127.0.0.1:3100）不在 → 拉起
//   - SnowLuma 网关（127.0.0.1:3000）不在 → 拉起
//   - 尊重"人工停止"：state/watchdog-pause 存在时什么都不做
// 用法：node watchdog.mjs（常驻）  或由计划任务每分钟调用一次 --once
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'D:\\qqbot\\qq-bridge';
const LOGS = 'D:\\qqbot\\logs';
const PAUSE_FILE = path.join(ROOT, 'state', 'watchdog-pause');
const WD_LOG = path.join(LOGS, 'watchdog.log');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const LAUNCHER = 'D:\\qqbot\\SnowLuma\\launcher.bat';
const once = process.argv.includes('--once');

fs.mkdirSync(LOGS, { recursive: true });
const log = (msg) => {
  const line = `${new Date().toLocaleString('zh-CN')} [watchdog] ${msg}`;
  try { fs.appendFileSync(WD_LOG, line + '\n'); } catch {}
  console.log(line);
};
const bump = (file) => { try { fs.appendFileSync(file, `\n[watchdog] ${new Date().toLocaleString('zh-CN')} 重新拉起\n`); } catch {} };

const httpOk = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return r.status < 500; } catch { return false; }
};
const gatewayOk = async () => {
  // 能响应 HTTP 200 就说明网关进程在跑（带不带 token 都算活着：
  // 不带 token 会返回 1401 unauthorized，那也是"服务已就绪"的证据，
  // 不能当成离线去重复拉起——否则会每分钟spawn一个新实例）。
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000)
    });
    // 401/403（未带或带错 token）也说明服务在跑；只有连不上或 5xx 才算不可用
    return r.status < 500;
  } catch { return false; }
};

function startBridge() {
  const out = fs.openSync(path.join(LOGS, 'bridge.out.log'), 'a');
  const err = fs.openSync(path.join(LOGS, 'bridge.err.log'), 'a');
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME || 'C:\\Users\\HCK\\.dsh', DSH_WEB_URL: process.env.DSH_WEB_URL || 'http://127.0.0.1:43120' }
  });
  child.unref();
  return child.pid;
}
function startSnowluma() {
  const snowDir = 'D:\\qqbot\\SnowLuma';
  const snowNode = fs.existsSync(path.join(snowDir, 'node.exe')) ? path.join(snowDir, 'node.exe') : process.execPath;
  if (!fs.existsSync(path.join(snowDir, 'index.mjs'))) { log('找不到 SnowLuma index.mjs，跳过'); return null; }
  // 无人值守：用官方支持的环境变量声明同意（否则会卡在 EULA 同意页，网关不启动）
  const child = spawn(snowNode, ['index.mjs'], {
    cwd: snowDir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, SNOWLUMA_ACCEPT_EULA: '1', SNOWLUMA_ACCEPT_PRIVACY: '1' }
  });
  child.unref();
  return child.pid;
}

let lastBridgeStart = 0;
let lastGatewayStart = 0;

async function tick() {
  if (fs.existsSync(PAUSE_FILE)) { if (once) log('检测到人工停止标记，跳过本轮'); return; }

  if (!(await httpOk('http://127.0.0.1:3100/panel'))) {
    if (Date.now() - lastBridgeStart > 90000) {
      const pid = startBridge();
      lastBridgeStart = Date.now();
      log(`桥接不在，已拉起（pid ${pid}）`);
    } else log('桥接未就绪，但 90 秒内已尝试过启动，等待中');
  }

  if (!(await gatewayOk())) {
    if (Date.now() - lastGatewayStart > 180000) {
      const pid = startSnowluma();
      lastGatewayStart = Date.now();
      log(`SnowLuma 网关不在，已拉起（pid ${pid ?? '?'}，需 30-40 秒就绪）`);
    } else log('SnowLuma 网关未就绪，180 秒内已尝试过，等待中');
  }
}

if (once) {
  await tick();
  process.exit(0);
} else {
  log('看门狗启动（每 60 秒巡检一次）');
  await tick();
  setInterval(() => { tick().catch((e) => log('巡检异常: ' + (e?.message ?? e))); }, 60000);
}
