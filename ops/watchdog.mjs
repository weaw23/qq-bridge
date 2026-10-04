// ⚠️ 这是 **线上 `D:\qqbot\watchdog.mjs` 的同步镜像**，不是可独立运行的脚本副本。
// 真正在跑的是仓库外那一份（由桥接的"互相守护" `ensureWatchdog()` 拉起，路径写死在 `D:\qqbot\watchdog.mjs`）。
// 2026-10-04 自检发现：本文件停在 2026-09-22 的 98 行版本，比线上少 84 行 —— 缺 whisper/meme
// 健康检查、缺 SnowLuma 兜底，尤其**不含 Bug #13（spawn 后不关日志句柄）与 Bug #14（无单实例锁）的修复**，
// 等于那两处修复完全没有版本控制，谁读仓库都会读到错的看门狗。
// 规则：改线上那份之后**必须同步回这里**（`Copy-Item D:\qqbot\watchdog.mjs ops\watchdog.mjs -Force`，
// 再把本段注释贴回文件头），否则归档就又开始说谎了。
//
// 鲸鲸看门狗：每 60 秒检查链路，缺什么补什么
//   - 桥接（127.0.0.1:3100）不在 → 拉起
//   - SnowLuma 网关（127.0.0.1:3000）不在 → 拉起
//   - whisper 语音识别服务（127.0.0.1:9881，鲸鲸 3.0）不在 → 拉起
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

// Bug #13：spawn 之后必须把 openSync 拿到的日志句柄关掉。
// 子进程已经通过 stdio 继承了这两个 fd（spawn 内部会 dup），父进程这一份再留着没有任何用处，
// 而看门狗是常驻进程、每次拉起都漏两个句柄 —— 跑几天就是几百个，更要命的是 Windows 上
// 会把日志文件锁住：实测 meme.err.log 被锁到别的进程连 ReadAllBytes 都抛 IOException，
// 排查问题时等于看不到任何日志。
const closeLogFds = (out, err) => {
  try { fs.closeSync(out); } catch {}
  try { fs.closeSync(err); } catch {}
};

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
  closeLogFds(out, err);
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
function startWhisper() {
  // 鲸鲸 3.0 语音识别常驻服务（127.0.0.1:9881，faster-whisper small cuda int8）
  // 模型缓存走 hf-mirror（huggingface.co 直连不通），并禁用 xet 协议（hf-mirror 不代理它）
  const py = 'D:\\ai-tools\\whisper-venv\\Scripts\\python.exe';
  const script = 'D:\\ai-tools\\whisper-server.py';
  if (!fs.existsSync(py) || !fs.existsSync(script)) { log('whisper-server 文件不全，跳过'); return null; }
  const out = fs.openSync(path.join(LOGS, 'whisper.out.log'), 'a');
  const err = fs.openSync(path.join(LOGS, 'whisper.err.log'), 'a');
  const child = spawn(py, [script], {
    cwd: 'D:\\ai-tools', detached: true, windowsHide: true, stdio: ['ignore', out, err],
    env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1' }
  });
  child.unref();
  closeLogFds(out, err);
  return child.pid;
}
function startMeme() {
  // 鲸鲸 3.0 P2：meme-generator 常驻服务（127.0.0.1:9882，Rust pyd，无模型下载）
  const py = 'D:\\ai-tools\\meme-venv\\Scripts\\python.exe';
  const script = 'D:\\ai-tools\\meme-server.py';
  if (!fs.existsSync(py) || !fs.existsSync(script)) { log('meme-server 文件不全，跳过'); return null; }
  const out = fs.openSync(path.join(LOGS, 'meme.out.log'), 'a');
  const err = fs.openSync(path.join(LOGS, 'meme.err.log'), 'a');
  const child = spawn(py, [script], {
    cwd: 'D:\\ai-tools', detached: true, windowsHide: true, stdio: ['ignore', out, err]
  });
  child.unref();
  closeLogFds(out, err);
  return child.pid;
}

let lastBridgeStart = 0;
let lastGatewayStart = 0;
let lastWhisperStart = 0;
let lastMemeStart = 0;

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

  // 鲸鲸 3.0：语音识别服务常驻（冷启动+模型加载约 30-60s；首次启动还要下载模型）
  if (!(await httpOk('http://127.0.0.1:9881/health'))) {
    if (Date.now() - lastWhisperStart > 300000) {
      const pid = startWhisper();
      lastWhisperStart = Date.now();
      log(`whisper-server 不在，已拉起（pid ${pid ?? '?'}）`);
    } else log('whisper-server 未就绪，300 秒内已尝试过，等待中');
  }

  // 鲸鲸 3.0 P2：meme 服务常驻（冷启动预热全表约 3-10s）
  if (!(await httpOk('http://127.0.0.1:9882/health'))) {
    if (Date.now() - lastMemeStart > 300000) {
      const pid = startMeme();
      lastMemeStart = Date.now();
      log(`meme-server 不在，已拉起（pid ${pid ?? '?'}）`);
    } else log('meme-server 未就绪，300 秒内已尝试过，等待中');
  }
}

// Bug #14：单实例锁。
// 原本没有任何互斥，重复启动（手工 + 上次没退干净 + 计划任务）会留下多个常驻实例，
// 而每个实例都有自己的 lastBridgeStart / lastWhisperStart / lastMemeStart 计时器，
// 于是「300 秒内不重复拉起」这条守卫**逐实例失效**：实测 2026-10-04 09:27–09:32
// 三个实例在 70 秒内把 meme-server 拉起 3 次，:9882 整整 5 分钟不可用。
// --once 是给计划任务用的短命进程，不与常驻实例抢锁。
const LOCK_FILE = path.join(LOGS, 'watchdog.lock');
function otherWatchdogPid() {
  try {
    const pid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim());
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
    process.kill(pid, 0); // 只是探活；进程不在会抛错，落到 catch
    return pid;
  } catch { return null; }
}

if (once) {
  await tick();
  process.exit(0);
} else {
  const alive = otherWatchdogPid();
  if (alive !== null) {
    log(`已有看门狗在跑（pid ${alive}），本实例退出以免重复拉起服务`);
    process.exit(0);
  }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
  log('看门狗启动（每 60 秒巡检一次）');
  await tick();
  setInterval(() => { tick().catch((e) => log('巡检异常: ' + (e?.message ?? e))); }, 60000);
}
