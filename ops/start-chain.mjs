// 一键启动整条链路（冷启动/关机重启后可用）：DSH Desktop → SnowLuma → 桥接 → 打开面板
// 用法：node ops/start-chain.mjs    （或直接双击 D:\qqbot\鲸鲸一键启动.cmd）
//
// 设计原则：
//   1. 每一步「先探测再动作」——已经在跑就不动它，所以可以反复点、随时点，幂等安全。
//   2. 账号不对就拒绝启动桥接。SnowLuma hook 的是「当前登录的 QQ」，若鲸鲸号没登录，
//      它可能 hook 到主人的号；此时继续启动会让 AI 用别人的号说话，所以必须硬停。
//   3. 能识别「假死桥接」：进程活着并持有锁、但 /panel 不响应。这是 2026-09-24 10:35
//      看门狗连续 11 次拉起失败的真正原因——看门狗只判断进程在不在，判断不了健不健康。
//      本脚本会结束该进程、清锁、重启。
//   4. 不做任何自启动/常驻守护。主人明确要求自己点一下就好，所以这里不留后台循环、
//      不注册计划任务、不碰 state/watchdog-pause。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const NODE = process.execPath;
const ROOT = 'D:\\qqbot\\qq-bridge';
const LOGS = 'D:\\qqbot\\logs';
const SNOW_DIR = 'D:\\qqbot\\SnowLuma';
const DSH_EXE = 'D:\\DSH Desktop 2.0.5\\DSH Desktop.exe';
const EXPECT_UIN = '3835811547';            // 哦鲸鲸二号机
const SNOW_TOKEN_FILE = path.join(ROOT, '.snowluma-token');
const CONSOLE_TOKEN_FILE = path.join(ROOT, 'state', 'console-token');
const LOCK_FILE = path.join(ROOT, 'state', 'bridge.lock');
const GATEWAY = 'http://127.0.0.1:3000';
const CONSOLE = 'http://127.0.0.1:3100';
const DSH_URL = 'http://127.0.0.1:43120';
const TOTAL = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const step = (n, msg) => console.log(`\n[${n}/${TOTAL}] ${msg}`);
const ok = (msg) => console.log(`    ✅ ${msg}`);
const info = (msg) => console.log(`    ·  ${msg}`);
const warn = (msg) => console.log(`    ⚠️  ${msg}`);
const bad = (msg) => console.log(`    ❌ ${msg}`);
const die = (code) => { console.log(''); process.exit(code); };

async function probe(url, timeoutMs = 4000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status < 500;
  } catch { return false; }
}

function onebotToken() {
  try { return fs.readFileSync(SNOW_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

async function onebot(action, body = {}) {
  const token = onebotToken();
  try {
    const r = await fetch(`${GATEWAY}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000)
    });
    return await r.json();
  } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 脱离式启动：detached + unref，脚本退出后子进程继续活着
function detached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, windowsHide: true, stdio: 'ignore', ...opts });
  child.unref();
  return child.pid;
}

async function waitUntil(label, fn, timeoutMs, hint = '') {
  const start = Date.now();
  let lastNote = '';
  while (Date.now() - start < timeoutMs) {
    const r = await fn();
    if (r === true) { ok(`${label}就绪（用时 ${Math.round((Date.now() - start) / 1000)} 秒）`); return true; }
    if (typeof r === 'string' && r && r !== lastNote) { lastNote = r; info(r); }
    await sleep(3000);
  }
  bad(`${label}在 ${Math.round(timeoutMs / 1000)} 秒内未就绪${hint ? `（${hint}）` : ''}`);
  return false;
}

console.log('══════════════════════════════════════════════');
console.log('   🐳 哦鲸鲸 · 一键启动（冷启动可用）');
console.log('══════════════════════════════════════════════');

// ── 1. DSH Desktop ────────────────────────────────────────────────────────────
step(1, 'DSH Desktop（模型服务，端口 43120）');
if (await probe(`${DSH_URL}/`, 3000)) {
  ok('已在运行');
} else if (!fs.existsSync(DSH_EXE)) {
  bad(`找不到 ${DSH_EXE}`);
  warn('桥接仍会启动，但她连不上模型、不会说话。请手动启动 DSH Desktop。');
} else {
  info('未运行，正在启动（首次启动较慢）…');
  detached(DSH_EXE, [], { cwd: path.dirname(DSH_EXE) });
  const up = await waitUntil('DSH Desktop', async () => probe(`${DSH_URL}/`, 3000), 150000, '可稍后重跑本脚本');
  if (!up) warn('桥接仍会继续启动，但她在 DSH 就绪前不会说话');
}

// ── 2. SnowLuma 网关 ──────────────────────────────────────────────────────────
step(2, 'SnowLuma 网关（OneBot，端口 3000）');
let li = await onebot('get_login_info');
if (li?.retcode === 0) {
  ok('已在运行');
} else if (!fs.existsSync(path.join(SNOW_DIR, 'index.mjs'))) {
  bad(`找不到 ${path.join(SNOW_DIR, 'index.mjs')}`);
  die(1);
} else {
  info('未运行，正在启动…');
  const snowNode = fs.existsSync(path.join(SNOW_DIR, 'node.exe')) ? path.join(SNOW_DIR, 'node.exe') : NODE;
  // EULA 环境变量：无人值守时必须声明同意，否则会卡在同意页、网关不启动
  detached(snowNode, ['index.mjs'], {
    cwd: SNOW_DIR,
    env: { ...process.env, SNOWLUMA_ACCEPT_EULA: '1', SNOWLUMA_ACCEPT_PRIVACY: '1' }
  });
  const up = await waitUntil('SnowLuma 网关', async () => {
    const r = await onebot('get_login_info');
    if (r?.retcode === 0) return true;
    if (r) return `网关已响应但账号未登录（retcode=${r.retcode} ${r.wording ?? ''}）`;
    return '';
  }, 120000, 'QQ 客户端可能没登录');
  if (!up) {
    bad('网关起不来，链路无法继续');
    info(`详细日志：${path.join(SNOW_DIR, 'logs')}`);
    die(1);
  }
}

// ── 3. 账号校验（不通过就硬停）────────────────────────────────────────────────
step(3, `校验 hook 到的账号是否为鲸鲸号 ${EXPECT_UIN}`);
li = await onebot('get_login_info');
if (li?.retcode !== 0) {
  bad(`网关未返回登录信息（retcode=${li?.retcode ?? '无响应'}）`);
  console.log('\n    多半是 QQ 客户端没登录。请先在 QQ 里登录 3835811547（哦鲸鲸二号机），再重跑本脚本。');
  die(1);
}
const uin = String(li.data?.user_id ?? '');
if (uin !== EXPECT_UIN) {
  bad(`SnowLuma hook 到的是 ${uin}（${li.data?.nickname ?? '?'}），不是鲸鲸号 ${EXPECT_UIN}`);
  console.log('\n    SnowLuma hook 的是「当前登录的 QQ」。这时候继续启动桥接，');
  console.log('    她会用别人的号说话，所以这里必须停下。');
  console.log(`\n    请在 QQ 客户端登录 ${EXPECT_UIN}，然后重新运行本脚本。`);
  die(1);
}
ok(`已确认：${uin} / ${li.data?.nickname ?? '?'}`);

// ── 4. 桥接（含假死处理）──────────────────────────────────────────────────────
step(4, '桥接（端口 3100）');
const bridgeHealthy = async () => probe(`${CONSOLE}/api/panel/overview`, 3000);
if (await bridgeHealthy()) {
  ok('已在运行且健康');
} else {
  let lockPid = 0;
  try { lockPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) || 0; } catch {}
  if (lockPid && pidAlive(lockPid)) {
    warn(`检测到「假死桥接」：PID ${lockPid} 活着并持有锁，但 /panel 不响应`);
    info('这正是 9/24 10:35 看门狗连续 11 次拉起失败的原因——它只判断进程在不在。');
    info(`结束 PID ${lockPid} 并清锁…`);
    try { execFileSync('taskkill', ['/PID', String(lockPid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(2500);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  } else if (lockPid) {
    info(`清理残留锁文件（PID ${lockPid} 已不存在）…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, 'bridge.out.log'), 'a');
  const err = fs.openSync(path.join(LOGS, 'bridge.err.log'), 'a');
  const pid = detached(NODE, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      DSH_HOME: process.env.DSH_HOME || 'C:\\Users\\HCK\\.dsh',
      DSH_WEB_URL: process.env.DSH_WEB_URL || DSH_URL
    }
  });
  info(`已启动桥接（PID ${pid}）`);
  const up = await waitUntil('桥接', bridgeHealthy, 90000, `看 ${path.join(LOGS, 'bridge.err.log')}`);
  if (!up) die(1);
}

// ── 5. 打开面板 + 汇总 ────────────────────────────────────────────────────────
step(5, '控制面板');
let ctok = '';
try { ctok = fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim(); } catch {}
const panelUrl = ctok ? `${CONSOLE}/panel?token=${encodeURIComponent(ctok)}` : `${CONSOLE}/panel`;
try { detached('cmd.exe', ['/c', 'start', '', panelUrl]); ok(`已在浏览器打开（${ctok ? '带令牌，直接可用' : '无令牌，可能需要手输'}）`); }
catch { warn('浏览器打开失败，请手动访问 ' + CONSOLE + '/panel'); }

let summary = '';
try {
  const r = await fetch(`${CONSOLE}/api/panel/overview`, {
    headers: ctok ? { 'x-console-token': ctok } : {},
    signal: AbortSignal.timeout(8000)
  });
  const o = await r.json();
  summary = [
    `  QQ      ：${o.qq?.online ? '在线' : '离线'} ${o.qq?.userId ?? ''} ${o.qq?.nickname ?? ''}`,
    `  网关    ：${o.gateway ? '在线' : '离线'}    DSH：${o.dshReady ? '已连' : '连接中'}    模式：${o.mode}`,
    `  模型    ：${o.model?.provider}/${o.model?.model}（思考 ${o.model?.reasoningEffort}）`,
    `  会话    ：${o.sessions?.length ?? 0} 个    记忆 ${o.counts?.facts ?? '?'} 条    好感度 ${o.counts?.affinity ?? '?'} 人    工具 ${o.toolCount ?? '?'} 个`,
    `  群白名单：${(o.allowGroups ?? []).join(', ') || '(空)'}    已停用：${(o.groupsDisabled ?? []).join(', ') || '(无)'}`
  ].join('\n');
} catch (e) { summary = `  状态读取失败：${e.message}`; }

console.log('\n──────────────────────────────────────────────');
console.log(summary);
console.log(`  面板    ：${CONSOLE}/panel`);
console.log(`  用时    ：${Math.round((Date.now() - T0) / 1000)} 秒`);
console.log('──────────────────────────────────────────────');
console.log('\n完成。本脚本不留任何后台常驻进程，关机后重开电脑再点一次即可。');
console.log('提示：若距上次每日复盘已超过一天，启动后约 10 分钟内会自动补跑一次（她会做自我整理）。');
