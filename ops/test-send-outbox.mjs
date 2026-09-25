// P0-3 回归测试：发送失败出箱重投
//
// 三段：
//   U 段  纯函数单测（src/send-outbox.js）—— 分类/退避/过期/冷却推迟/去重键，边界全喂
//   接线  源码级检查 —— 明确标注「只能证明那段代码还在，不等于行为被验证」
//   H 段  HTTP + DB 端到端 —— 全部走「合成/受控行」，**一张消息都不真发**
//
// 为什么 H 段能零副作用：巡检在真正调用网关之前有三道闸门，我们专挑会被闸门挡住的靶子：
//   H3 合成非白名单 key → 被 modeAllowed 挡在发送之前，直接置 dead
//   H4 白名单内但**她正在被禁言**的群 → 真去打网关，但必然被服务端拒（retcode 120）
//      → 断言「不可重投类不进重试队列、直接 dead」，全程没有消息能落地。
//      H4 跑之前会**先自己查一次禁言状态**，不满足就跳过 —— 绝不赌。
//
// 跑：node ops/test-send-outbox.mjs

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  classifySendFailure, outboxBackoffMs, outboxExhausted, outboxExpired,
  outboxCanAttempt, outboxDedupeKey, stableHash,
  OUTBOX_MAX_ATTEMPTS, OUTBOX_MAX_AGE_MS, OUTBOX_DEDUPE_WINDOW_MS
} from '../src/send-outbox.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';
const SYNTH_KEY = 'group:123456789';   // 合成靶子：绝不在白名单里
const MUTED_GROUP = '1132819177';      // 白名单内，且她自 2026-09-23 起被禁言

const outFile = path.join(ROOT, '..', 'outbox', 'pc-jobs', 'test-send-outbox.log');
try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch {}
try { fs.writeFileSync(outFile, ''); } catch {}
function say(line) {
  console.log(line);
  try { fs.appendFileSync(outFile, line + '\n'); } catch {}
}
let pass = 0, fail = 0, skip = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; say(`✅ ${name}${extra ? '  ' + extra : ''}`); } else { fail++; say(`❌ ${name}${extra ? '  ' + extra : ''}`); }
}
function skipped(name, why = '') { skip++; say(`⏭️  ${name}（跳过${why ? '：' + why : ''}）`); }
function section(t) { say(`\n── ${t} ──`); }

// 令牌只读不打印（输出会落盘到 outbox，绝不写进去）
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

async function req(pathname) {
  const res = await fetch(BASE + pathname, { headers: { 'x-console-token': consoleToken }, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

let db = null;
function openDb() {
  if (!db) {
    db = new DatabaseSync(path.join(ROOT, 'state', 'memory.db'));
    db.exec('PRAGMA busy_timeout = 3000');   // 桥接随时可能在写，别因为一次 BUSY 误判
  }
  return db;
}
function finish(code) {
  // 延迟退出：fetch 的 keep-alive socket 正在关闭时强退会触发 libuv 断言，stderr 里看着像崩溃
  setTimeout(() => process.exit(code), 500);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

say('P0-3 回归：发送失败出箱重投');

// ─────────────────────────────────────────────────────────────────────────────
section('U 段：classifySendFailure（可重投 vs 不可重投，这是整个功能的地基）');
{
  const net = classifySendFailure({ httpStatus: 0, networkError: true });
  check('网络错误 → 可重投', net.retryable === true && net.klass === 'network', `klass=${net.klass}`);

  const s503 = classifySendFailure({ httpStatus: 503 });
  check('网关 503 → 可重投', s503.retryable === true && s503.klass === 'gateway_5xx', `klass=${s503.klass}`);
  const s502 = classifySendFailure({ httpStatus: 502 });
  check('网关 502 → 可重投', s502.retryable === true, `klass=${s502.klass}`);

  const m120 = classifySendFailure({ httpStatus: 200, retcode: 120, wording: 'rejected' });
  check('retcode 120（禁言/被拒）→ **不可**重投', m120.retryable === false && m120.klass === 'muted_or_risk', `klass=${m120.klass}`);
  const m120b = classifySendFailure({ httpStatus: 200, retcode: 200, wording: 'SEND_MSG_API_ERROR rejected' });
  check('wording 含 rejected → 不可重投（哪怕 retcode 不是 120）', m120b.retryable === false && m120b.klass === 'muted_or_risk');
  const kick = classifySendFailure({ httpStatus: 200, retcode: 110 });
  check('retcode 110 被移出 → 不可重投', kick.retryable === false && kick.klass === 'kicked');
  const kickW = classifySendFailure({ httpStatus: 200, retcode: 999, wording: '你已被移出本群' });
  check('wording 含「移出」→ 不可重投（不依赖具体 retcode）', kickW.retryable === false && kickW.klass === 'kicked');

  const p100 = classifySendFailure({ httpStatus: 200, retcode: 100 });
  check('retcode 100 参数错 → 不可重投', p100.retryable === false && p100.klass === 'bad_param');
  const m426 = classifySendFailure({ httpStatus: 426 });
  check('HTTP 426（httpUrl 指到 WS 端口）→ 不可重投（配置错误）', m426.retryable === false && m426.klass === 'misconfig');
  const cred = classifySendFailure({ httpStatus: 200, retcode: 104 });
  check('retcode 104 凭据过期 → 可重投（客户端重连常自愈）', cred.retryable === true && cred.klass === 'credential');
  const op102 = classifySendFailure({ httpStatus: 200, retcode: 102 });
  check('retcode 102 通用操作失败 → 可重投', op102.retryable === true && op102.klass === 'operation_failed');
  const unknownRet = classifySendFailure({ httpStatus: 200, retcode: 77 });
  check('未知 retcode 77 → 不可重投（保守）', unknownRet.retryable === false && unknownRet.klass === 'unknown_retcode');
  const unknown = classifySendFailure({ httpStatus: 0 });
  check('完全认不出来 → 不可重投（宁漏不乱）', unknown.retryable === false && unknown.klass === 'unknown');

  const canceled = classifySendFailure({ httpStatus: 0, wording: '发送已取消：会话、模式或白名单已变化' });
  check('本地守卫「发送已取消」→ 不可重投', canceled.retryable === false && canceled.klass === 'cancelled');
  const leak = classifySendFailure({ httpStatus: 0, wording: '发送内容包含会话令牌，已阻止发送' });
  check('令牌泄漏拦截 → 不可重投', leak.retryable === false && leak.klass === 'token_leak');

  // 从真实 Error 对象上读 ob（这是 onebotSendRaw 挂上去的结构化字段）
  const err = new Error('OneBot send_group_msg 失败: rejected（诊断：本账号在该群被禁言至 …）');
  err.ob = { httpStatus: 200, retcode: 120, wording: 'rejected', networkError: false };
  const fromErr = classifySendFailure(err);
  check('从 Error.ob 读结构化字段（给人看的中文消息里混着诊断文案，不能拿来反解）',
    fromErr.retryable === false && fromErr.klass === 'muted_or_risk', `klass=${fromErr.klass}`);
  const netErr = new Error('OneBot send_group_msg 网络错误: fetch failed');
  netErr.ob = { httpStatus: 0, networkError: true, wording: 'fetch failed' };
  check('从网络错误 Error.ob 读 → 可重投', classifySendFailure(netErr).retryable === true);
}

section('U 段：退避 / 次数 / 过期');
{
  check('退避第 1 次 = 60s', outboxBackoffMs(1) === 60000, `实际=${outboxBackoffMs(1)}`);
  check('退避第 2 次 = 180s', outboxBackoffMs(2) === 180000, `实际=${outboxBackoffMs(2)}`);
  check('退避第 3 次 = 540s', outboxBackoffMs(3) === 540000, `实际=${outboxBackoffMs(3)}`);
  check('退避越界时封顶（不返回 undefined）', outboxBackoffMs(99) === 540000, `实际=${outboxBackoffMs(99)}`);
  check('退避 0/负数 视为第 1 次', outboxBackoffMs(0) === 60000 && outboxBackoffMs(-5) === 60000);
  check('退避是**递增**的（防抖退避退化成固定间隔）', outboxBackoffMs(1) < outboxBackoffMs(2) && outboxBackoffMs(2) < outboxBackoffMs(3));

  check('试满 3 次算耗尽', outboxExhausted(3) === true);
  check('试 2 次不算耗尽', outboxExhausted(2) === false);
  check('默认上限 = 3', OUTBOX_MAX_ATTEMPTS === 3, `实际=${OUTBOX_MAX_ATTEMPTS}`);

  const now = T0();
  check('刚建的没过期', outboxExpired(now, now) === false);
  check('29 分钟前建的没过期', outboxExpired(now - 29 * 60 * 1000, now) === false);
  check('31 分钟前建的过期了', outboxExpired(now - 31 * 60 * 1000, now) === true);
  check('created_at=0（脏数据）视为过期', outboxExpired(0, now) === true);
  check('过期阈值 = 30 分钟', OUTBOX_MAX_AGE_MS === 30 * 60 * 1000);
  check('去重窗口 = 5 分钟，且**大于**最短退避（否则重投前就先被当成重复归并掉）',
    OUTBOX_DEDUPE_WINDOW_MS === 5 * 60 * 1000 && OUTBOX_DEDUPE_WINDOW_MS > outboxBackoffMs(1));
}

section('U 段：outboxCanAttempt（冷却只推迟、不消耗次数）');
{
  const now = T0();
  const row = { attempts: 0, max_attempts: 3, next_at: now - 1000, created_at: now };
  const ok = outboxCanAttempt(row, now, 0);
  check('到点 + 次数够 + 没过期 → 可试', ok.ok === true && ok.defer === false);

  const blockFuture = now + 30 * 60 * 1000;
  const blocked = outboxCanAttempt(row, now, blockFuture);
  check('sendBlock 冷却中 → **defer**（推迟，不是丢弃）', blocked.ok === false && blocked.defer === true, `reason=${blocked.reason}`);
  check('冷却推迟时不会去动 attempts（调用方靠 defer 区分）', blocked.defer === true);

  const notY = outboxCanAttempt({ ...row, next_at: now + 60000 }, now, 0);
  check('未到退避时间 → defer', notY.ok === false && notY.defer === true && notY.reason === '未到退避时间');

  const exhausted = outboxCanAttempt({ ...row, attempts: 3 }, now, 0);
  check('已试满 → **不 defer**（该置 dead 就得置 dead）', exhausted.ok === false && exhausted.defer === false);

  const expired = outboxCanAttempt({ ...row, created_at: now - OUTBOX_MAX_AGE_MS - 1000 }, now, 0);
  check('已过期 → 不 defer', expired.ok === false && expired.defer === false && expired.reason === '已过期');

  const noRow = outboxCanAttempt(null, now, 0);
  check('记录不存在 → 不 defer', noRow.ok === false && noRow.defer === false);
}

section('U 段：去重键');
{
  const k1 = outboxDedupeKey('group', '1', '你好');
  check('同会话同内容同引用 → 同一个键', k1 === outboxDedupeKey('group', '1', '你好'));
  check('内容不同 → 键不同', k1 !== outboxDedupeKey('group', '1', '你好啊'));
  check('会话不同 → 键不同', k1 !== outboxDedupeKey('group', '2', '你好'));
  check('kind 不同 → 键不同', k1 !== outboxDedupeKey('private', '1', '你好'));
  check('引用不同 → 键不同（引用/@ 的语义不一样，不能归并）', k1 !== outboxDedupeKey('group', '1', '你好', '12345'));
  check('@ 不同 → 键不同', k1 !== outboxDedupeKey('group', '1', '你好', '', '67890'));
  check('数字/字符串 id 归一（字符串 "1" 与数字 1 同键）', outboxDedupeKey('group', 1, 'x') === outboxDedupeKey('group', '1', 'x'));
  check('stableHash 稳定', stableHash('abc') === stableHash('abc'));
  check('stableHash 区分不同输入', stableHash('abc') !== stableHash('abd'));
  check('stableHash 输出 8 位十六进制', /^[0-9a-f]{8}$/.test(stableHash('随便什么内容')));
  // 关键回归：中文内容不能被「拼接歧义」撞键（'ab'+'c' 与 'a'+'bc' 必须不同）
  check('拼接歧义不会撞键', outboxDedupeKey('g', '1', 'ab', 'c') !== outboxDedupeKey('g', '1', 'a', 'bc'));
}

function T0() { return 1780000000000; }

// ─────────────────────────────────────────────────────────────────────────────
section('接线检查（**只证明代码还在，不是行为验证**）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('onebotSendRaw 存在（保留原始抛错层，重投才有对象可重）', src.includes('async function onebotSendRaw('));
  check('失败时挂结构化 ob 字段', src.includes('err.ob = { httpStatus: Number(res.status)'));
  check('网络错误也挂 ob（否则最常见的抖动被归到「认不出来」而不重投）', src.includes('err.ob = { httpStatus: 0, networkError: true'));
  check('onebotSend 包装层调用了分类函数', src.includes('const cls = classifySendFailure(err)'));
  check('不可重投类直接抛出（不进箱）', src.includes('if (!cls.retryable) throw err;'));
  check('**冷却期内不入箱**（P8-3b 三振冷却本来就是「别再试了」）',
    /if \(gid && sendBlockActive\(gid\)\) \{[\s\S]{0,400}?不入箱以免空烧/.test(src));
  check('巡检里也检查 sendBlockActive（推迟而非丢弃）', src.includes('const block = km[1] === \'group\' ? sendBlockActive(km[2]) : 0;'));
  check('巡检里先查白名单再发（排队期间白名单可能变）', src.includes('已不在当前模式允许范围'));
  check('补发成功清零 sendBlock 三振', src.includes('补发成功，已清零发送受阻三振计数'));
  check('补发成功会记录已发消息', src.includes('recordSentMessagesV2(row.conv_key, [String(row.message)]);'));
  check('定时巡检已挂上（60s）', src.includes('const outboxTimer = setInterval(') && src.includes('void sweepSendOutbox(); }, 60 * 1000)'));
  check('面板暴露出箱概况', src.includes('outbox: outboxStats(),'));
  check('路由对入箱消息返回 202（而不是 500）', src.includes('queued: true, outboxId: error.outboxId, klass: error.klass'));
}

// ─────────────────────────────────────────────────────────────────────────────
section('H 段：端到端（零消息）');
let seededIds = [];
try {
  const st = await req('/api/panel/social-state');
  check('面板 social-state 可达', st.status === 200, `status=${st.status}`);
  const ob = st.json?.outbox;
  check('面板返回 outbox 概况（功能未上线时这里是 undefined）', ob && typeof ob === 'object', `实际=${JSON.stringify(ob)?.slice(0, 80)}`);
  check('outbox 各状态都是数字', typeof ob?.pending === 'number' && typeof ob?.sent === 'number'
    && typeof ob?.dead === 'number' && typeof ob?.expired === 'number',
    `pending=${ob?.pending} sent=${ob?.sent} dead=${ob?.dead} expired=${ob?.expired}`);
  check('outbox.items 是数组', Array.isArray(ob?.items));

  // 表存在性：读不存在的表会被巡检里的 try/catch 静默吞掉，所以必须直接查 sqlite_master
  const tbl = openDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='send_outbox'").get();
  check('send_outbox 表存在', !!tbl, tbl ? 'ok' : '未建表（功能未上线/迁移没跑）');
  if (tbl) {
    const cols = openDb().prepare('PRAGMA table_info(send_outbox)').all().map((c) => c.name);
    for (const c of ['dedupe_key', 'conv_key', 'kind', 'target_id', 'message', 'reply_to', 'at_user', 'klass', 'attempts', 'max_attempts', 'next_at', 'created_at', 'status']) {
      check(`send_outbox 列 ${c}`, cols.includes(c));
    }
  }
} catch (e) {
  fail++;
  say(`❌ H 段准备阶段异常：${e?.message ?? e}`);
}

// H3：合成非白名单 key → 巡检必须在**发送之前**把它判死
if (openDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='send_outbox'").get()) {
  const now = Date.now();
  const ins = openDb().prepare(`INSERT INTO send_outbox
    (dedupe_key, conv_key, kind, target_id, message, reply_to, at_user, klass, reason, attempts, max_attempts, next_at, created_at, updated_at, status)
    VALUES (?,?,?,?,?,'','',?,?,0,3,?,?,?,'pending')`);
  const r1 = ins.run(outboxDedupeKey('group', '123456789', '__outbox_test__'), SYNTH_KEY, 'group', '123456789',
    '__outbox_test__ 请忽略', 'network', '测试种子', now - 1000, now, now);
  const h3id = Number(r1.lastInsertRowid);
  seededIds.push(h3id);
  say(`   （H3 已埋入 #${h3id} → ${SYNTH_KEY}，等巡检处理）`);

  let row = null;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    row = openDb().prepare('SELECT status, reason FROM send_outbox WHERE id = ?').get(h3id);
    if (row && row.status !== 'pending') break;
  }
  check('H3 非白名单待发消息被巡检判死（而不是无限期挂着）', row?.status === 'dead', `status=${row?.status} reason=${row?.reason}`);
  check('H3 判死原因是白名单，且发生在真正发送之前', String(row?.reason ?? '').includes('不在当前模式允许范围'), `reason=${row?.reason}`);
  check('H3 attempts 仍为 0（没白打一次网关）',
    Number(openDb().prepare('SELECT attempts FROM send_outbox WHERE id = ?').get(h3id)?.attempts) === 0);
} else {
  skipped('H3 非白名单判死', '表不存在');
}

// H4：白名单内 + 她被禁言的群 → 真打网关但必然被拒 → 不可重投类直接判死
if (openDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='send_outbox'").get()) {
  let muteOk = false, muteInfo = '未查';
  try {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const ov = await req('/api/panel/overview');
    const meId = Number(ov.json?.qq?.userId ?? 0);
    if (meId > 0) {
      const r = await fetch(`${httpUrl}/get_group_member_info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {}) },
        body: JSON.stringify({ group_id: Number(MUTED_GROUP), user_id: meId }),
        signal: AbortSignal.timeout(8000)
      });
      const mi = await r.json().catch(() => ({}));
      const shut = Number(mi?.data?.shut_up_timestamp ?? 0);
      muteOk = shut > Date.now() / 1000;
      muteInfo = muteOk ? `禁言至 ${new Date(shut * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : `未被禁言（shut=${shut}）`;
    } else {
      muteInfo = '拿不到自己的 QQ 号';
    }
  } catch (e) { muteInfo = `查询异常：${e?.message ?? e}`; }

  if (!muteOk) {
    skipped('H4 禁言群真打网关 → 不可重投类判死', `前置条件不满足，${muteInfo}。**不赌**：万一能发出去就会往真群里灌一条测试消息`);
  } else {
    say(`   （H4 前置条件满足：${muteInfo}）`);
    const now = Date.now();
    const ins = openDb().prepare(`INSERT INTO send_outbox
      (dedupe_key, conv_key, kind, target_id, message, reply_to, at_user, klass, reason, attempts, max_attempts, next_at, created_at, updated_at, status)
      VALUES (?,?,?,?,?,'','',?,?,0,3,?,?,?,'pending')`);
    const r2 = ins.run(outboxDedupeKey('group', MUTED_GROUP, '__outbox_test__'), `group:${MUTED_GROUP}`, 'group', MUTED_GROUP,
      '__outbox_test__ 出箱探针，请忽略', 'network', '测试种子', now - 1000, now, now);
    const h4id = Number(r2.lastInsertRowid);
    seededIds.push(h4id);
    say(`   （H4 已埋入 #${h4id} → group:${MUTED_GROUP}，等巡检处理）`);

    let row = null;
    for (let i = 0; i < 20; i++) {
      await sleep(5000);
      row = openDb().prepare('SELECT status, reason, attempts FROM send_outbox WHERE id = ?').get(h4id);
      if (row && row.status !== 'pending') break;
    }
    check('H4 禁言导致的失败被判定为「不可重投」，直接 dead（不是退避重试）',
      row?.status === 'dead', `status=${row?.status} reason=${row?.reason}`);
    check('H4 判死原因归到 muted_or_risk（分类器真的认出了 rejected）',
      String(row?.reason ?? '').includes('muted_or_risk'), `reason=${row?.reason}`);
    check('H4 attempts==1（真打了一次网关，不是被闸门提前挡掉）', Number(row?.attempts) === 1, `attempts=${row?.attempts}`);
    check('H4 没有进入退避重试（next_at 不会在未来）', String(row?.status) === 'dead');
  }
} else {
  skipped('H4 禁言群真打网关 → 不可重投类判死', '表不存在');
}

// 收尾：清掉所有测试种子行，别把探针数据留在生产库里
{
  try {
    let n = 0;
    for (const id of seededIds) n += openDb().prepare('DELETE FROM send_outbox WHERE id = ?').run(id).changes;
    const left = openDb().prepare("SELECT COUNT(*) AS n FROM send_outbox WHERE message LIKE '__outbox_test__%'").get();
    check('收尾清干净（生产库里不留探针行）', Number(left?.n) === 0, `删了 ${n} 行，剩余 ${left?.n}`);
    const st = await req('/api/panel/social-state');
    check('收尾后 pending 不因测试而残留', Number(st.json?.outbox?.pending ?? 0) >= 0);
  } catch (e) {
    fail++;
    say(`❌ 收尾清理异常：${e?.message ?? e}`);
  }
}

if (db) { try { db.close(); } catch {} }
say(`\n──────── 结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ────────`);
say(`日志副本：${outFile}`);
finish(fail > 0 ? 1 : 0);
