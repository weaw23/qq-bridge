// P0-2 同图不连发：真条路由的零消息端到端验证。
//
// 为什么需要这个脚本（而不是直接在回归里发图）：
//   「同图不连发」依赖 lastStickerId 这个状态，而它只在**发送成功之后**才落库。
//   所以要验证真条路由，常规做法是真发一张 A。但发图成功会顺带调用
//   scheduleReplyCheckV2（约 30s 后把 AI 唤醒去做「回复检查」），而唯一能关掉它的开关是
//   socialV2.paused —— bridge.js:2001 的全局守卫又会把所有带 agent token 的
//   /api/socialV2/* 请求（包括发图本身）拦成 403，路走不通。
//   往正在和主人聊天的私聊里塞测试消息 + 一次多余唤醒，代价比收益大。
//
// 本脚本的做法：**在桥接停机的窗口里把 lastStickerId 预置好**，再打真条路由。
//   拦截发生在真正发送之前（guard 在 sendStickerV2 之前 return），所以整个过程
//   一张图都不会发出去；被拦的请求也不会 push recentMessages、不会 scheduleReplyCheckV2。
//
// 靶子用 group:1132819177（白名单内、且她在该群被禁言到 2026-10-23）：双保险 ——
//   万一守卫顺序被改坏导致真的走到发送，QQ 侧也会因为禁言拒收。
//
// 覆盖不到的那一条要如实说：**「换一张不同的图应该放行」没有活体验证**，
//   因为那必须真发一张才成立。它由 ops/test-proactive-quota.mjs 的 U2 段离线穷举覆盖
//   （完全不同的图 → 放行），这里只补一条「守卫不是无差别全拦」的间接证据（见 A3）。
//
// 跑：node ops/test-sticker-guard-live.mjs
//     约 2 个停机-启动周期（各 ~15s）。全程 try/finally 恢复现场。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE_EXE = process.execPath;
const BRIDGE_JS = path.join(ROOT, 'src', 'bridge.js');
const STATE_FILE = path.join(ROOT, 'state', 'social-v2.json');
const LOCK_FILE = path.join(ROOT, 'state', 'bridge.lock');
const CONSOLE_TOKEN_FILE = path.join(ROOT, 'state', 'console-token');
const TARGET_KEY = 'group:1132819177';   // 白名单内 + 她被禁言：零可见影响
const PANEL = 'http://127.0.0.1:3100';

let pass = 0, fail = 0, skip = 0;
const say = (s = '') => console.log(s);
const section = (t) => say(`\n── ${t} ──`);
function check(name, ok, extra = '') {
  if (ok) { pass++; say(`✅ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; say(`❌ ${name}${extra ? `  ${extra}` : ''}`); }
}
const skipped = (n, why = '') => { skip++; say(`⏭️  ${n}${why ? `（${why}）` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const consoleToken = fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim();
const panelHeaders = { 'x-console-token': consoleToken };

async function req(url, { method = 'GET', token = '', body = null, headers = {} } = {}) {
  // x-console-token 是全局闸门，漏了会直接 401「未授权：请提供控制台访问令牌」——
  // 而 401 的响应体里当然没有业务字段，断言就会以 undefined 的形式静默通过（空断言）。
  const h = { 'x-console-token': consoleToken, ...headers };
  if (token) h['x-agent-token'] = token;
  let payload;
  if (body !== null) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(PANEL + url, { method, headers: h, body: payload, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const panelOf = async (key) => (await req(`/api/panel/social-state?key=${encodeURIComponent(key)}`)).json;

function lockPid() {
  try { return Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }   // EPERM = 活着但不是我的子进程；只有 ESRCH 才是真死
}
async function waitQuiet(sec = 100) {
  const logFile = path.join(ROOT, 'state', 'bridge.log');
  for (let i = 0; i < 240; i++) {
    const age = (Date.now() - fs.statSync(logFile).mtimeMs) / 1000;
    if (age >= sec) return Math.round(age);
    await sleep(3000);
  }
  return -1;
}
function stopBridge() {
  const pid = lockPid();
  if (!pid || !alive(pid)) { say(`   （没有活着的桥接进程，lock pid=${pid}）`); return 0; }
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' }); } catch {}
  try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  say(`   已停止桥接 PID ${pid}`);
  return pid;
}
// 用 WMI 拉起：Start-Process 在调用方（工具/终端）中断时会跟着死，WMI Create 不会。
// 另外两个坑（都踩过）：
//   ① 本机 PowerShell 的执行策略禁止加载 .ps1（Running scripts is disabled），必须显式
//      加 -ExecutionPolicy Bypass，否则 powershell -File 直接拒绝执行；
//   ② 5.1 不支持三元运算符 ? :（那是 PS7 的），脚本里只能用 if/else。
const PS_LAUNCH = path.join(os.tmpdir(), 'qqbridge-launch.ps1');
function startBridge() {
  fs.writeFileSync(PS_LAUNCH, [
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{`,
    `  CommandLine = '${NODE_EXE} ${BRIDGE_JS}'`,
    `  CurrentDirectory = '${ROOT}'`,
    `}`,
    `Write-Output ("$($r.ReturnValue) $($r.ProcessId)")`
  ].join('\n'), 'utf8');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_LAUNCH], { encoding: 'utf8' }).trim();
  const [rv, pid] = out.split(/\s+/);
  if (String(rv) !== '0') throw new Error(`WMI Create 失败 ReturnValue=${rv}`);
  say(`   已拉起桥接 PID ${pid}`);
  return Number(pid);
}
async function waitHealthy(sec = 45) {
  for (let i = 0; i < sec; i++) {
    await sleep(1000);
    try {
      const r = await fetch(PANEL + '/api/panel/overview', { headers: panelHeaders, signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.mode === 'reserved2' && j?.dshReady === true && j?.paused === false) return j;
    } catch {}
  }
  return null;
}
function patchState(fn) {
  const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  fn(j);
  fs.writeFileSync(STATE_FILE, JSON.stringify(j), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
say('P0-2 同图不连发：真条路由零消息验证（种子化）');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const allowGroups = (cfg.allow?.groups ?? []).map(String);
const targetGroup = TARGET_KEY.split(':')[1];
if (!allowGroups.includes(targetGroup)) {
  say(`❌ 靶子 ${TARGET_KEY} 不在白名单里（allow.groups=${allowGroups.join(',')}）：守卫跑不到，无法验证。`);
  process.exit(2);
}
const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'stickers.json'), 'utf8'));
const entries = (Array.isArray(store) ? store : (store.entries ?? [])).filter((e) => e && e.id && e.md5);
if (entries.length < 1) { say('❌ 表情库为空，无法验证。'); process.exit(2); }
const A = entries[0];
say(`靶子：${TARGET_KEY}（白名单内且她被禁言到 2026-10-23，双保险）`);
say(`种子表情 A：id=${A.id.slice(0, 28)}… md5=${String(A.md5).slice(0, 12)}…（只用于判定，不会真的发出去）`);

// agent token 只读不打印（本机凭据，测试输出会落盘）
const agentToken = String(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))?.conversations?.[TARGET_KEY]?.agentToken ?? '');

let restored = false;
try {
  // ── 第一轮：停机 → 种下 lastStickerId=A → 启动 → 打真条路由 ──────────────
  section('准备：停机并预置 lastStickerId');
  const quiet = await waitQuiet(100);
  say(`   日志静默 ${quiet}s`);
  stopBridge();
  await sleep(2000);
  patchState((j) => {
    const st = j.conversations?.[TARGET_KEY];
    if (!st) throw new Error(`状态文件里没有 ${TARGET_KEY}`);
    st.lastStickerId = A.id;
    st.lastStickerMd5 = String(A.md5).toUpperCase();
  });
  say(`   已把 ${TARGET_KEY} 的 lastStickerId 预置为 A`);
  startBridge();
  const health = await waitHealthy();
  check('桥接重启后健康（reserved2 / dshReady / 未暂停）', !!health, health ? `pid=${health.pid}` : '45s 内没起来');

  const seeded = await panelOf(TARGET_KEY);
  check('种子就位：端点读回 lastStickerId = A', seeded?.lastStickerId === A.id, `实际=${String(seeded?.lastStickerId).slice(0, 28)}…`);
  // agent token：存在 social-v2.json 每个会话的 agentToken 字段里（不是单独的表）
  if (!agentToken) {
    skipped('A1–A4 全部', `social-v2.json 里 ${TARGET_KEY} 没有 agentToken`);
  } else {
    section('A 段：真条路由');
    const send = (stickerId) => req('/api/socialV2/send-sticker', { method: 'POST', token: agentToken, body: { key: TARGET_KEY, stickerId } });

    const r1 = await send(A.id);
    check('A1 发同一张（原样 id）→ 409 被拦，一张图都没发出去', r1.status === 409, `status=${r1.status} err=${String(r1.json?.error ?? '').slice(0, 40)}`);
    check('A1 错误文案点明原因', String(r1.json?.error ?? '').includes('刚才已经发过这张表情了'));

    const r2 = await send(String(A.md5));
    check('A2 换成 md5 写法发同一张 → 仍 409（换个写法绕不过去）', r2.status === 409, `status=${r2.status} err=${String(r2.json?.error ?? '').slice(0, 40)}`);

    // A3：守卫不是「无差别全拦」。传一个库里不存在的 id ——
    // 它和上一张不同，所以必须放行到 sendStickerV2，再由那儿因为找不到表情而失败。
    // 全程不会发消息（解析不到条目就抛错），所以这条是零风险的。
    const bogus = 'no_such_sticker_id_9f3a';
    const r3 = await send(bogus);
    const r3err = String(r3.json?.error ?? '');
    check('A3 库里不存在的 id → 不是 409（守卫放行了它，证明不是无差别全拦）', r3.status !== 409, `status=${r3.status} err=${r3err.slice(0, 40)}`);
    check('A3 它走到了发送阶段并因找不到表情而失败（说明确实过了守卫）', r3err.includes('找不到') || r3err.includes('表情'), `err=${r3err.slice(0, 40)}`);

    const after = await panelOf(TARGET_KEY);
    check('A4 三次尝试之后 lastStickerId 仍是 A（失败/被拦都不会移动指针）', after?.lastStickerId === A.id, `实际=${String(after?.lastStickerId).slice(0, 28)}…`);
    check('A4 指针的 md5 也没变', String(after?.lastStickerMd5).toUpperCase() === String(A.md5).toUpperCase());
  }
} finally {
  // ── 恢复现场：无论上面出什么事，都要把种子清掉并让桥接跑起来 ──────────────
  section('收尾：清除种子并恢复桥接');
  try {
    stopBridge();
    await sleep(2000);
    patchState((j) => {
      const st = j.conversations?.[TARGET_KEY];
      if (st) { st.lastStickerId = ''; st.lastStickerMd5 = ''; }
    });
    // 现场恢复是硬要求：桥接停了没拉起来就是把她下线了，必须重试到成功为止
    let h2 = null;
    for (let attempt = 1; attempt <= 3 && !h2; attempt++) {
      try { startBridge(); } catch (e) { say(`   第 ${attempt} 次拉起失败：${e?.message ?? e}`); await sleep(3000); continue; }
      h2 = await waitHealthy();
      if (!h2) say(`   第 ${attempt} 次拉起后 45s 内没健康，重试`);
    }
    check('收尾：种子已清除且桥接恢复健康', !!h2, h2 ? `pid=${h2.pid}` : '三次都没起来');
    const fin = await panelOf(TARGET_KEY);
    check('收尾：lastStickerId 精确复位为空串', fin?.lastStickerId === '', `实际=${JSON.stringify(fin?.lastStickerId)}`);
    check('收尾：端点是真答了（不是 401 导致的 undefined 假绿）', typeof fin?.proactiveQuota === 'number', `quota=${fin?.proactiveQuota}`);
    restored = !!h2;
  } catch (e) {
    say(`❌ 收尾失败，需要手动处理：${e?.message ?? e}`);
    say('   手动恢复：删掉 state/bridge.lock，然后用 WMI 拉起 bridge.js，并把 social-v2.json 里该会话的 lastStickerId 置空。');
  }
}

say(`\n结果：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}${restored ? '' : '（⚠️ 现场未恢复）'}`);
say('未覆盖：真发一张「不同的」图应当放行 —— 那需要真发消息，由 test-proactive-quota.mjs 的 U2 段离线覆盖。');
setTimeout(() => process.exit(fail ? 1 : 0), 500);
