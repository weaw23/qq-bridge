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
// Bug #19（m13685）：主人嫌「meme 弹窗程序」烦（m12957）。留一个豁免标记，
// 让看门狗在暂停解除后也不把它拉起来——否则一恢复巡检弹窗就回来。
const MEME_NOSPAWN_FILE = path.join(ROOT, 'state', 'meme-nospawn');
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
// Bug #24（第四轮自检 2026-10-04）：常驻 python 服务会弹出真窗口。
// 机理：venv 的 python.exe 是 console 子系统程序（PE subsystem=3）。给它 detached:true
// 就是让 libuv 传 DETACHED_PROCESS —— 「没有控制台」的 console 程序一启动，系统就再分配
// 一个全新控制台。此时 windowsHide:true 已经不管用了（它只在 CreateProcess 阶段
// 设 STARTF_USESHOWWINDOW/SW_HIDE，管不了系统事后新建的控制台），而 Windows 11 的默认
// 终端会把新控制台交给 Windows Terminal 显示 —— 于是主人看到「后台一直弹窗」。
// 实测（D:\qqbot\outbox\_spawnprobe.ps1 A/B 对照，同样参数只换解释器）：
//   A python.exe  → 新增 OpenConsole 1 个，且新增 conhost 的父进程就是 python（=真分了新控制台）
//   B pythonw.exe → 新增 OpenConsole 0 个，python 名下新增 conhost 0 个（=根本没分控制台）
// pythonw.exe 是 GUI 子系统（PE subsystem=2），从不分配控制台，因此永远不可能弹窗；
// stdout/stderr 仍被重定向到日志文件，所以 print() 照常可用（不是 pythonw 那种 stdout=None 的坑）。
function pythonExe(venvDir) {
  // 两种环境布局都要认：venv 把可执行文件放在 Scripts/ 下，conda 环境放在环境根目录
  // （如 D:\ai-tools\miniconda3\envs\sovits\pythonw.exe）。
  // 只认 Scripts/ 会让 conda 环境静默退回 console 版 python.exe —— 弹窗会悄悄回来，所以两种都探。
  const cands = [
    path.join(venvDir, 'Scripts', 'pythonw.exe'),
    path.join(venvDir, 'pythonw.exe'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return path.join(venvDir, 'Scripts', 'python.exe');   // 退回 console 版只为兼容，理论上不该走到
}
function startWhisper() {
  // 鲸鲸 3.0 语音识别常驻服务（127.0.0.1:9881，faster-whisper small cuda int8）
  // 模型缓存走 hf-mirror（huggingface.co 直连不通），并禁用 xet 协议（hf-mirror 不代理它）
  const py = pythonExe('D:\\ai-tools\\whisper-venv');
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
  const py = pythonExe('D:\\ai-tools\\meme-venv');
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
let pausedSince = null;      // Bug #19：进入暂停的时刻（null=未暂停）
let lastPauseLogAt = 0;      // Bug #19：上次复述暂停状态的时间，避免每分钟刷屏
let memeNoSpawnLogged = false;

async function tick() {
  // Bug #19（m13685）：原来 PAUSE 存在时静默 return（只在 --once 模式记一行），
  // 于是「看门狗被冻住」和「看门狗正常但无事可做」在 watchdog.log 里长得一模一样。
  // 实测 2026-10-04 19:15:10 点了「停止全链」之后，看门狗静默近 3 小时，期间
  // whisper-server(:9881) 和 meme-server(:9882) 双双死亡也没人拉——故障完全隐形，
  // 直到手工查端口才发现语音识别已经挂了。
  // 现在：进入暂停时立刻记一行，此后每 10 分钟复述一次，恢复时再记一行。
  if (fs.existsSync(PAUSE_FILE)) {
    const nowMs = Date.now();
    if (pausedSince === null) {
      pausedSince = nowMs;
      lastPauseLogAt = 0;
      log('⚠️ 检测到人工停止标记（state/watchdog-pause），看门狗已暂停：不再巡检桥接/网关/语音/表情服务。删除该文件或点「一键启动全链」即恢复。');
    }
    if (nowMs - lastPauseLogAt > 600000) {
      lastPauseLogAt = nowMs;
      log(`⏸ 仍处于人工暂停中（已 ${Math.round((nowMs - pausedSince) / 60000)} 分钟）：whisper/meme 等常驻服务在此期间不会被自动拉起。`);
    }
    return;
  }
  if (pausedSince !== null) {
    log(`▶️ 人工停止标记已移除，看门狗恢复巡检（本次共暂停 ${Math.round((Date.now() - pausedSince) / 60000)} 分钟）。`);
    pausedSince = null;
    lastPauseLogAt = 0;
  }

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
  if (fs.existsSync(MEME_NOSPAWN_FILE)) {
    if (!memeNoSpawnLogged) {
      memeNoSpawnLogged = true;
      log('meme-server 已被 state/meme-nospawn 标记禁用（主人要求关掉那个弹窗程序），跳过拉起。删除该文件即恢复。');
    }
  } else if (!(await httpOk('http://127.0.0.1:9882/health'))) {
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
  // Bug #20（m13754）：原来是直接 `process.exit(0)`。但 tick() 刚刚 spawn 过子进程
  // （whisper/meme/bridge）并把日志 fd 交给了它，libuv 里对应的 async handle 还处在
  // closing 状态，被 process.exit() 强行拆掉，Windows 上直接触发：
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
  // 进程以非 0 退出码 abort，计划任务会误报失败（而且这行 assert 只在调用方控制台，
  // 从不落 watchdog.log，所以潜伏很久没人发现）。
  // 改法：先设 exitCode 让主逻辑判成功，把控制权交回事件循环自然排空；再挂一个
  // unref 的兜底定时器，万一还有句柄把循环吊住，5 秒后强退，保证 --once 永不会挂死。
  process.exitCode = 0;
  const guard = setTimeout(() => process.exit(0), 5000);
  guard.unref();
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
