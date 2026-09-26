// L2 回归测试：群聊「每条都看」的唤醒节流（按会话频率帽 + 发言后冷却）
//
// 证据强度分层（重要，别把三段当一回事）：
//   U 段  纯函数穷举（src/wake-throttle.js）—— **真正的行为验证**。
//         边界值、组合、时钟回拨、脏数据、子类型原因全部离线覆盖，喂固定时间戳，
//         不依赖运行中的桥接，也不需要真有人在群里说话。
//   S 段  源码级接线检查 —— 只证明「那段代码还在、还是那个写法」，**不是行为验证**。
//         它能拦住「以后改代码时把节流又删掉了」，拦不住「逻辑写反了」。
//   A 段  活体配置面 —— 打真路由，验证五件真实发生的事：
//         ① 每会话的节流字段能否被 /api/socialV2/wake-config 接受并回显
//            （改之前会被路由整个丢掉：它显式重建 next 对象，多余字段不落盘）
//         ② 是否真的持久化（用 /api/socialV2/states 回读，不是看响应自说自话）
//         ③ 不会顺手把既有的触发条件（keywords / atMention / infinite …）冲掉
//         ④ ★节流的**拦截动作本身**（A9/A10/A11）—— 见下。
//         ⑤ ★L0 上线本身（A14）：把 anyMessage 打开，且与节流参数**一次写成**。
//            A14 不是「检查」，它就是本次改造的生产变更本身；重复跑是幂等的。
//            它挂在安全闸门上（A2/A3 为真才执行），理由写在 A14 上方。
//
// 关于 ④ 为什么以前做不到、现在能做到（这段别删，是个容易踩的坑）：
//   节流的调用点不在 scheduleWakeV2（bridge.js:9741，它只负责批量/优先级），
//   而在 **sendWakePromptV2(key, reason)**（bridge.js:9543）—— 所有唤醒原因最终的
//   唯一收口，HTTP /api/socialV2/wake 也直接调它。所以那个入口**并不绕过节流**。
//   于是只要把节流参数临时调成「必然命中」，再 POST /wake，就能让真实的一整条
//   路径跑完判定，并且 **她根本不会被唤醒**（被拦下就直接 return 了）：
//     A9  发言后冷却：该会话最后一次发言在 1 小时窗口内 → 闲聊类被拦（stage=speak-cooldown）
//     A10 频率帽：该会话过去 1 小时内已有唤醒 → 闲聊类被拦（stage=rate）+ 丢弃不暂存
//     A11 同一次频率帽拦截，但原因换成非闲聊类（poke）→ 必须**暂存**而不是丢弃
//   判定结果不靠响应自说自话，而是读 state/bridge.log 里那行「唤醒节流命中」。
//   三个用例都不产生唤醒；A11 会把原因塞进 pendingWakeReasons，所以结尾用
//   /api/socialV2/mark-read 把它清掉（否则她下一回合结束时会补发一次）。
//
// 跑：node ops/test-wake-throttle.mjs
//     默认会把 group:471975044 的三关节流参数写成上线目标值（2 次/分钟、30 次/小时、发言后 120s 冷却），
//     并在最后把该群的 anyMessage 打开（L0：每条消息都看），两件事在同一次 POST 里原子完成；
//     改前的原值备份到 outbox/pc-jobs/wake-config-backup-group-471975044.json。
//     A9-A11 临时改的是 group:471975044 与 group:1132819177（后者被静音到 2026-10-23，代价可控）。

import fs from 'node:fs';
import path from 'node:path';
import {
  AMBIENT_WAKE_REASONS,
  WAKE_SPEAK_COOLDOWN_MS,
  wakeReasonBase,
  isAmbientWakeReason,
  countWithin,
  lastSpeakAtFrom,
  wakeRateVerdict,
  speakCooldownVerdict,
  wakeThrottleVerdict,
  preservedOwnerOverrides,
  THROTTLE_OVERRIDE_FIELDS
} from '../src/wake-throttle.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';
const TARGET_KEY = 'group:471975044';          // 真靶子：134 人群、白名单内。只改它的唤醒配置，不产生任何消息
const FINAL = { maxWakePerMinute: 2, maxWakePerHour: 30, speakCooldownMs: 120000 };
const PROBE = { maxWakePerMinute: 7, maxWakePerHour: 31, speakCooldownMs: 90000 };

const outFile = path.join(ROOT, '..', 'outbox', 'pc-jobs', 'test-wake-throttle.log');
const backupFile = path.join(ROOT, '..', 'outbox', 'pc-jobs', 'wake-config-backup-group-471975044.json');
// A11 会往 pendingWakeReasons 里塞一条待补发的原因，所以那个用例必须放在
// **她发不出消息**的会话上：group:1132819177 被静音到 2026-10-23，
// 万一真的唤醒了她，失败的消息也进不了群（P0-3 会把它收进发件箱重试）。
const MUTED_KEY = 'group:1132819177';
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
function skipped(name) { skip++; say(`⏭️  ${name}（跳过）`); }
function section(t) { say(`\n── ${t} ──`); }

const T0 = 1758800000000;   // 固定基准时间戳，避免测试结果随运行时刻漂移

// ══════════════════════════════════════════════════════════════════
section('U 段：纯函数穷举（src/wake-throttle.js）');
// ══════════════════════════════════════════════════════════════════

say('U1 唤醒原因解析与「闲聊类」分类');
check('U1.1 带子类型的原因取冒号前基名', wakeReasonBase('keyword:鲸鲸') === 'keyword' && wakeReasonBase('speaker:爱吃布拉瓦［猫又连结］') === 'speaker');
check('U1.2 空/非字符串原因不炸', wakeReasonBase('') === '' && wakeReasonBase(null) === '' && wakeReasonBase(undefined) === '');
check('U1.3 五种闲聊类原因全部识别为 ambient', AMBIENT_WAKE_REASONS.every((r) => isAmbientWakeReason(r)) && AMBIENT_WAKE_REASONS.length === 5);
check('U1.4 anyMessage 带子类型仍是 ambient', isAmbientWakeReason('anyMessage:xxx') === true);
const DIRECT_CASES = ['private', 'atMention', 'question', 'nameMention', 'keyword:小鲸', 'speaker:某人', 'poke', 'schedule', 'reminder', 'followup', 'care', 'reflect', 'sendBlock', 'groupHealth', 'bootstrap'];
check('U1.5 点名/约定类一律不是 ambient（冷却不许挡住）', DIRECT_CASES.every((r) => !isAmbientWakeReason(r)), `${DIRECT_CASES.length} 种`);
check('U1.6 未知原因 fail-open（直通，不静音）', isAmbientWakeReason('someFutureReason') === false);

say('U2 countWithin 窗口计数边界');
check('U2.1 非数组/空窗口返回 0', countWithin(undefined, T0, 60000) === 0 && countWithin([T0], T0, 0) === 0);
check('U2.2 龄 59999ms 计入、60000ms 不计入（左闭右开）', countWithin([T0 - 59999], T0, 60000) === 1 && countWithin([T0 - 60000], T0, 60000) === 0);
check('U2.3 未来时间戳不计入（时钟被往回校正后不会把她冻住）', countWithin([T0 + 1000, T0 + 999999], T0, 60000) === 0);
check('U2.4 脏数据（NaN/字符串/对象/null）不计数', countWithin([NaN, 'abc', {}, null, T0], T0, 60000) === 1);
check('U2.5 混入旧数据只数窗口内的', countWithin([T0 - 1000, T0 - 61000, T0 - 3599999, T0 - 3600001], T0, 60000) === 1);

say('U3 wakeRateVerdict 频率帽');
check('U3.1 上限为 0 表示不限', wakeRateVerdict({ wakeTimes: [T0, T0, T0], now: T0, maxPerMinute: 0, maxPerHour: 0 }).ok === true);
check('U3.2 恰好达到上限即拦（>=，与旧实现一致）', wakeRateVerdict({ wakeTimes: [T0 - 1000, T0 - 2000], now: T0, maxPerMinute: 2, maxPerHour: 0 }).ok === false);
check('U3.3 差一次不拦', wakeRateVerdict({ wakeTimes: [T0 - 1000], now: T0, maxPerMinute: 2, maxPerHour: 0 }).ok === true);
const v3a = wakeRateVerdict({ wakeTimes: [T0 - 1000, T0 - 2000], now: T0, maxPerMinute: 2, maxPerHour: 100 });
check('U3.4 分钟帽先命中时 blockedBy=minute', v3a.ok === false && v3a.blockedBy === 'minute' && v3a.recentMinute === 2);
const hourTimes = []; for (let i = 0; i < 30; i++) hourTimes.push(T0 - i * 61000);   // 30 条都在 1 小时内、每分钟最多 1 条
const v3b = wakeRateVerdict({ wakeTimes: hourTimes, now: T0, maxPerMinute: 20, maxPerHour: 30 });
check('U3.5 分钟帽够松时由小时帽兜住 blockedBy=hour', v3b.ok === false && v3b.blockedBy === 'hour' && v3b.recentHour === 30);
check('U3.6 超出 1 小时的不计入小时帽', wakeRateVerdict({ wakeTimes: [T0 - 3600001, T0 - 7200000], now: T0, maxPerMinute: 0, maxPerHour: 1 }).ok === true);

say('U4 speakCooldownVerdict 发言后冷却');
check('U4.1 从没发过言 → 放过', speakCooldownVerdict({ sendTimes: [], now: T0, cooldownMs: 120000 }).ok === true);
check('U4.2 cooldownMs=0 → 关闭且 disabled=true', speakCooldownVerdict({ sendTimes: [T0], now: T0, cooldownMs: 0 }).ok === true && speakCooldownVerdict({ sendTimes: [T0], now: T0, cooldownMs: 0 }).disabled === true);
const cd4 = speakCooldownVerdict({ sendTimes: [T0 - 1000], now: T0, cooldownMs: 120000 });
check('U4.3 刚说完话 → 拦住且剩余时间正确', cd4.ok === false && cd4.elapsedMs === 1000 && cd4.remainingMs === 119000);
check('U4.4 龄恰好等于冷却 → 放行（边界右开）', speakCooldownVerdict({ sendTimes: [T0 - 120000], now: T0, cooldownMs: 120000 }).ok === true);
check('U4.5 龄差 1ms → 仍拦住', speakCooldownVerdict({ sendTimes: [T0 - 119999], now: T0, cooldownMs: 120000 }).ok === false);
check('U4.6 lastSpeakAtFrom 取最大有效值、忽略脏数据', lastSpeakAtFrom([T0 - 5000, NaN, 'abc', T0 - 1000]) === T0 - 1000);
check('U4.7 sendTimes 不是数组不炸', speakCooldownVerdict({ sendTimes: null, now: T0, cooldownMs: 120000 }).ok === true);

say('U5 wakeThrottleVerdict 组合判定');
const hotRate = { wakeTimes: [T0 - 1000, T0 - 2000], now: T0, maxPerMinute: 2, maxPerHour: 0 };
const freshRate = { wakeTimes: [], now: T0, maxPerMinute: 2, maxPerHour: 30 };
const justSpoke = [T0 - 1000];
const v5a = wakeThrottleVerdict({ reason: 'anyMessage', sendTimes: justSpoke, speakCooldownMs: 120000, ...freshRate });
check('U5.1 闲聊类 + 冷却中 → 拦，stage=speak-cooldown，不暂存', v5a.ok === false && v5a.stage === 'speak-cooldown' && v5a.park === false);
check('U5.2 闲聊类 + 冷却已过 → 放过', wakeThrottleVerdict({ reason: 'anyMessage', sendTimes: [T0 - 200000], speakCooldownMs: 120000, ...freshRate }).ok === true);
const v5c = wakeThrottleVerdict({ reason: 'atMention', sendTimes: justSpoke, speakCooldownMs: 120000, ...freshRate });
check('U5.3 ★被 @ 时冷却中照样放过（这是本模块最重要的约束）', v5c.ok === true && v5c.stage === 'ok' && v5c.cooldown === null);
check('U5.4 ★被拍/被提问/被叫名字同样直通', ['poke', 'question', 'nameMention', 'keyword:鲸鲸', 'speaker:主人'].every((r) => wakeThrottleVerdict({ reason: r, sendTimes: justSpoke, speakCooldownMs: 120000, ...freshRate }).ok === true));
check('U5.5 ★她自己约好的事（提醒/待跟进/定时）同样直通', ['schedule', 'reminder', 'followup', 'care', 'reflect'].every((r) => wakeThrottleVerdict({ reason: r, sendTimes: justSpoke, speakCooldownMs: 120000, ...freshRate }).ok === true));
const v5f = wakeThrottleVerdict({ reason: 'anyMessage', sendTimes: [], speakCooldownMs: 120000, ...hotRate });
check('U5.6 闲聊类被频率帽拦住 → park=false（就该丢掉）', v5f.ok === false && v5f.stage === 'rate' && v5f.park === false);
const v5g = wakeThrottleVerdict({ reason: 'atMention', sendTimes: [], speakCooldownMs: 120000, ...hotRate });
check('U5.7 ★点名类被频率帽拦住 → park=true（暂存，回合结束补发，不能丢）', v5g.ok === false && v5g.stage === 'rate' && v5g.park === true);
const v5h = wakeThrottleVerdict({ reason: 'anyMessage', sendTimes: justSpoke, speakCooldownMs: 120000, ...hotRate });
check('U5.8 两条约束同时命中时先报频率帽', v5h.stage === 'rate');
check('U5.9 放过时带回诊断信息（rate/cooldown/ambient）', wakeThrottleVerdict({ reason: 'anyMessage', sendTimes: [], speakCooldownMs: 120000, ...freshRate }).rate.maxPerHour === 30);

say('U6 真实节奏量化：今天 group:471975044 那段 40 条消息的节奏');
// 场景：20 分钟内每 30 秒一条消息 = 40 次唤醒尝试（开 anyMessage 后群聊正常节奏的最坏情形）
// 注意这里的入参用的是「配置字段名」（maxWakePerMinute），和持久化/路由/文档一致；
// 函数参数名是 maxPerMinute，2026-09-25 基线跑时就是因为把两者写成同一个名字、
// 传了 undefined 进去（上限 0 = 不设防），导致「新配置压到 30 次」这条断言假失败。
function simulate(attempts, conf) {
  const wakeTimes = [];
  let allowed = 0; const blocked = { rate: 0, 'speak-cooldown': 0 };
  for (const t of attempts) {
    const v = wakeThrottleVerdict({
      reason: 'anyMessage',
      wakeTimes,
      sendTimes: conf.sendTimes ?? [],
      now: t,
      maxPerMinute: conf.maxWakePerMinute,
      maxPerHour: conf.maxWakePerHour,
      speakCooldownMs: conf.speakCooldownMs ?? 0
    });
    if (v.ok) { allowed++; wakeTimes.push(t); } else blocked[v.stage]++;
  }
  return { allowed, blocked };
}
const attempts = []; for (let i = 0; i < 40; i++) attempts.push(T0 + i * 30000);
const simNew = simulate(attempts, { ...FINAL, speakCooldownMs: 0 });
const simOld = simulate(attempts, { maxWakePerMinute: 20, maxWakePerHour: 200, speakCooldownMs: 0 });
say(`   新配置(${FINAL.maxWakePerMinute}/分, ${FINAL.maxWakePerHour}/时)：40 次尝试 → 放过 ${simNew.allowed}，被频率帽拦 ${simNew.blocked.rate}`);
say(`   旧配置(20/分, 200/时)  ：40 次尝试 → 放过 ${simOld.allowed}，被频率帽拦 ${simOld.blocked.rate}`);
check('U6.1 旧配置等于不设防（40 次全放过）', simOld.allowed === 40);
check('U6.2 新配置把它压到 30 次/小时上限', simNew.allowed === FINAL.maxWakePerHour);
check('U6.3 被拦下来的全是频率帽，且无一被暂存（闲聊类就该丢）', simNew.blocked.rate === 10 && simNew.blocked['speak-cooldown'] === 0);
// 场景 B：她刚发完话，群里继续聊 2 分钟
const sheSpoke = [T0];
const ambB = [T0 + 10000, T0 + 40000, T0 + 90000, T0 + 119000].map((t) => wakeThrottleVerdict({ reason: 'anyMessage', wakeTimes: [], sendTimes: sheSpoke, now: t, maxPerMinute: 2, maxPerHour: 30, speakCooldownMs: 120000 }));
const dirB = wakeThrottleVerdict({ reason: 'atMention', wakeTimes: [], sendTimes: sheSpoke, now: T0 + 40000, maxPerMinute: 2, maxPerHour: 30, speakCooldownMs: 120000 });
say(`   她说完话后的 2 分钟：闲聊唤醒 4 次尝试全部被冷却挡住=${ambB.every((v) => !v.ok)}，同期 @ 她=${dirB.ok ? '放过' : '被拦'}`);
check('U6.4 ★冷却期内闲聊全部被挡、@ 她照常通过', ambB.every((v) => !v.ok && v.stage === 'speak-cooldown') && dirB.ok === true);
check('U6.5 冷却=0 时同一批闲聊恢复通过（可一键关闭）', [T0 + 10000, T0 + 40000].every((t) => wakeThrottleVerdict({ reason: 'anyMessage', wakeTimes: [], sendTimes: sheSpoke, now: t, maxPerMinute: 2, maxPerHour: 30, speakCooldownMs: 0 }).ok === true));
check('U6.6 导出常量：默认冷却 120s', WAKE_SPEAK_COOLDOWN_MS === 120000);

// ── U7：永眠兜底重置时「该保留什么」────────────────────────────────────
// 三处兜底重置原本是整个对象换成默认值，于是开了「每条消息都看」的大群只要她连续 3 个回合
// 不说话（常态，不是卡死），主人的 anyMessage 与成本闸门就被抹掉。这个纯函数决定保留什么。
// 注：本组没有「改前基线」—— 函数是本次新加的，而 ESM 的具名 import 在模块链接期就会
// 失败，缺函数会直接让整个测试文件加载失败，不可能只红这一组。行为覆盖靠下面这些边界穷举。
say(`   THROTTLE_OVERRIDE_FIELDS = ${JSON.stringify(THROTTLE_OVERRIDE_FIELDS)}`);
check('U7.1 空/脏配置一律不保留（退回默认，不猜）',
  [[undefined, {}], [null, {}], ['abc', {}], [42, {}]].every(([input]) => {
    const k = preservedOwnerOverrides(input);
    return k.anyMessage === false && Object.keys(k.fields).length === 0;
  }));
check('U7.2 anyMessage 只在严格 true 时保留（字符串 "true" / 1 都不算）',
  preservedOwnerOverrides({ triggers: { anyMessage: true } }).anyMessage === true
    && preservedOwnerOverrides({ triggers: { anyMessage: 'true' } }).anyMessage === false
    && preservedOwnerOverrides({ triggers: { anyMessage: 1 } }).anyMessage === false
    && preservedOwnerOverrides({ triggers: null }).anyMessage === false
    && preservedOwnerOverrides({}).anyMessage === false);
const keptF = preservedOwnerOverrides({ maxWakePerMinute: 2, maxWakePerHour: 30, speakCooldownMs: 120000.4 });
say(`   三字段保留结果 = ${JSON.stringify(keptF.fields)}`);
check('U7.3 三关节流值保留且取整（0 = 不限，也必须保留，那是主人的明确选择）',
  keptF.fields.maxWakePerMinute === 2 && keptF.fields.maxWakePerHour === 30 && keptF.fields.speakCooldownMs === 120000
    && preservedOwnerOverrides({ maxWakePerMinute: 0 }).fields.maxWakePerMinute === 0
    && Object.keys(preservedOwnerOverrides({ maxWakePerMinute: 0 }).fields).length === 1);
check('U7.4 脏值一律丢弃（负数/NaN/Infinity/字符串/null/undefined）',
  ['-5', 'abc', '2'].every((v) => preservedOwnerOverrides({ maxWakePerMinute: v }).fields.maxWakePerMinute === undefined)
    && [NaN, Infinity, -Infinity, -1, null, undefined, {}].every((v) => preservedOwnerOverrides({ maxWakePerMinute: v }).fields.maxWakePerMinute === undefined));
check('U7.5 只认识这三样，其它字段不带出来（默认值结构归 defaultWakeConfigV2）',
  Object.keys(preservedOwnerOverrides({ mode: 'active', infinite: true, sleepUntil: '2026-01-01', batchWindowMs: 3000, noActionCount: 5, triggers: { anyMessage: true, atMention: true, keywords: ['x'] } }).fields).length === 0
    && preservedOwnerOverrides({ triggers: { anyMessage: true, atMention: true, keywords: ['x'] } }).anyMessage === true);

// ══════════════════════════════════════════════════════════════════
section('S 段：源码接线检查（只证明代码还在，不是行为验证）');
// ══════════════════════════════════════════════════════════════════
const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const srcRegion = src.slice(src.indexOf('async function sendWakePromptV2'), src.indexOf('function cancelReplyCheckV2'));
check('S1 bridge.js 从 ./wake-throttle.js 引入', /from '\.\/wake-throttle\.js'/.test(src));
check('S2 sendWakePromptV2 内调用了 wakeThrottleVerdict', /wakeThrottleVerdict\(\{/.test(srcRegion));
check('S3 旧的「自己数 recentMinute/recentHour」写法已移除', !/const recentMinute = \(st\.wakeTimes \|\| \[\]\)/.test(srcRegion));
check('S4 节流命中会打日志（否则线上无从查证）', /唤醒节流/.test(srcRegion));
check('S5 频率帽支持按会话覆盖（st.wakeConfig 优先于全局 cfg）', /st\.wakeConfig\?\.maxWakePerMinute \?\?/.test(srcRegion) && /st\.wakeConfig\?\.maxWakePerHour \?\?/.test(srcRegion));
check('S6 非闲聊类被拦时会暂存而不是丢弃', /park/.test(srcRegion) && /pendingWakeReasons/.test(srcRegion));
check('S7 wake-config 路由接受 maxWakePerMinute', /maxWakePerMinute: numOr\(/.test(src));
check('S8 wake-config 路由接受 maxWakePerHour', /maxWakePerHour: numOr\(/.test(src));
check('S9 wake-config 路由接受 speakCooldownMs', /speakCooldownMs: numOr\(/.test(src));
const prioRegion = src.slice(src.indexOf('const WAKE_PRIORITY'), src.indexOf('function wakePriorityV2'));
check('S10 WAKE_PRIORITY 补上了 poke（否则开了 anyMessage 后拍一拍会被降级成 anyMessage）', /poke:\s*\d+/.test(prioRegion), prioRegion.match(/poke:\s*\d+/)?.[0] ?? '未找到');
check('S11 refreshDefaultWakeConfigV2 会保留三关节流字段', /maxWakePerMinute: old\.maxWakePerMinute/.test(src));
check('S12 冷却默认值可经 cfg.socialV2.wake.speakCooldownMs 覆盖', /cfg\.socialV2\?\.wake\?\.speakCooldownMs/.test(srcRegion));
// 沉睡前观察窗口守卫（wake-config 3245-3252、mark-read 3119-3134 一带）原本是**唯一**两条
// 不带管理员直通的守卫：`if (isSleepingConfigV2(...) && preSleepWaitBlockedV2(st))`。
// 后果：在一个活跃群里（134 人的群几乎不可能安静满 5 分钟），任何唤醒参数写入都被 400 挡住，
// 连运维用控制台都改不了配置；错误文案还在让「你」去调 qq_wait_for_messages（人没有这个工具）。
// 现在两条都加了 `const isAdminMarkRead/isAdminCall = !req.headers['x-agent-token']` 直通。
const guardRegion = src.slice(src.indexOf('const isAdminCall'), src.indexOf('const isAdminCall') + 400);
check('S13 wake-config 的睡前观察守卫放行管理员', /const isAdminCall = !req\.headers\['x-agent-token'\]/.test(src) && /if \(!isAdminCall && isSleepingConfigV2\(next\)/.test(guardRegion));
check('S14 mark-read 的睡前观察守卫放行管理员', /const isAdminMarkRead = !req\.headers\['x-agent-token'\]/.test(src) && /if \(!isAdminMarkRead && isSleepingConfigV2\(st\.wakeConfig\)/.test(src));
// wake-config 里那句「diving 时清除 anyMessage」原本是无条件生效的（比它注释说的
// 「从 active 切回 diving 时」范围大得多），会把主人配好的「每条消息都看」在任意一次
// 无关写入中悄悄关掉。A6/A13 就是这么红的。
check('S15 diving→diving 的写入不会关掉 anyMessage（只在真的模式切换时才清除）',
  /if \(current\.mode !== 'diving' && next\.mode === 'diving' && !\('anyMessage' in inputTriggers\)\)/.test(src)
    && !/if \(next\.mode === 'diving' && !\('anyMessage' in inputTriggers\)\)/.test(src));
// ★ 开了 anyMessage 的群，`evaluateWakeTriggerV2` 的第一句原来是
//   `if (tr.anyMessage) return 'anyMessage';` —— 于是同一个群里「被 @、被提问、叫她的名字、
//   命中关键词、指定群友发言」也全被打成 `anyMessage`（闲聊类）。后果不是少唤醒，而是**标签错**：
//   她刚说完话时，有人 @ 她会被发言后冷却挡掉、被频率帽拦下时会被「丢弃」而不是「暂存」。
//   这正是主人开的那个群的处境 ——「她刚说完话」不等于「别人叫她时可以不理」。
//   修法：anyMessage 退到兜底位（概率那一句之前），具体触发优先拿到自己的标签。
const evalRegion = src.slice(src.indexOf('function evaluateWakeTriggerV2'), src.indexOf('function buildWakePromptV2'));
const at = (re) => { const m = evalRegion.match(re); return m ? evalRegion.indexOf(m[0]) : -1; };
const iAny = at(/if \(tr\.anyMessage\) return 'anyMessage';/);
const iAt = at(/if \(tr\.atMention\) \{/);
const iName = at(/if \(tr\.nameMention && selfNickname\)/);
const iKw = at(/if \(Array\.isArray\(tr\.keywords\) && tr\.keywords\.length\)/);
const iQ = at(/if \(tr\.question && isDirectedAtAi\(plainContent\)\)/);
const iSpk = at(/if \(Array\.isArray\(tr\.speakerIds\) && tr\.speakerIds\.length\)/);
const iProb = at(/if \(Number\(tr\.probability\) > 0/);
check('S16 anyMessage 只当兜底，不抢 @/提问/名字/关键词/指定群友的标签',
  [iAt, iName, iKw, iQ, iSpk, iProb].every((i) => i >= 0)
    && iAny > iAt && iAny > iName && iAny > iKw && iAny > iQ && iAny > iSpk && iAny < iProb,
  `anyMessage@${iAny} at@${iAt} name@${iName} kw@${iKw} question@${iQ} speaker@${iSpk} probability@${iProb}`);
// ★★ 三处「把她从永眠里捞出来」的兜底重置（ensureWakeableV2 / 连续无行动 / 连续未设置唤醒条件）
//    原来都是 `st.wakeConfig = defaultWakeConfigV2()` —— 把整个会话配置换成默认值。
//    而 defaultWakeConfigV2() 里 anyMessage 是 `defaultMode === 'active'`（diving 时 = false），
//    三关节流参数也不在里面。于是：开了「每条消息都看」的群，只要她**连续 3 个回合选择不说话**
//    （在这种群里这是常态，不是卡死），主人的 anyMessage 与成本闸门就被无声抹掉 ——
//    退回「只看被 @ 的」+ 全局默认 20 次/分、200 次/时。
//    重置的目的只是「别再永眠」，而 anyMessage 与频率帽都只会让她更容易被唤醒 / 限制频率，
//    不可能造成永眠，所以它们不该在重置范围内。
const resetRegion = src.slice(src.indexOf('function resetWakeConfigV2'), src.indexOf('function getSocialV2State'));
const bareResets = (src.match(/st\.wakeConfig = defaultWakeConfigV2\(\);/g) ?? []).length;
const helperResets = (src.match(/resetWakeConfigV2\(st, \{ key/g) ?? []).length;
check('S17 三处永眠兜底重置都保留 anyMessage 与按会话节流参数（不再裸重置）',
  /function resetWakeConfigV2/.test(src)
    && bareResets === 0 && helperResets >= 3
    && /preservedOwnerOverrides\(st\.wakeConfig\)/.test(resetRegion)
    && /THROTTLE_OVERRIDE_FIELDS/.test(resetRegion)
    && /next\.triggers = \{ \.\.\.next\.triggers, anyMessage: true \}/.test(resetRegion),
  `裸重置=${bareResets} 次、走 helper=${helperResets} 次、helper 区长度=${resetRegion.length}`);

// ══════════════════════════════════════════════════════════════════
section('A 段：活体配置面（真路由 / 真落盘 / 不冲掉既有配置）');
// ══════════════════════════════════════════════════════════════════
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
async function req(pathname, { method = 'GET', body = null, headers = {} } = {}) {
  const h = { 'x-console-token': consoleToken, ...headers };
  if (body) h['content-type'] = 'application/json';
  const res = await fetch(BASE + pathname, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const states = () => req('/api/socialV2/states');
async function wakeConfigOf(key) {
  const r = await states();
  const conv = (r.json?.conversations ?? []).find((c) => c.key === key);
  return conv?.wakeConfig ?? null;
}
const setWakeConfig = (body) => req('/api/socialV2/wake-config', { method: 'POST', body });

// ── 判定结果的取证工具（不靠 HTTP 响应）─────────────────────────────
// 节流判定结果不靠 HTTP 响应（/api/socialV2/wake 是无脑 200，它 fire-and-forget
// 调 sendWakePromptV2，3341 行立刻回 ok），只能读 state/bridge.log 里的那行日志。
//
// ★ 这里踩过两个坑，都写在注释里，别再退回旧写法：
//   ① 不能按**字节偏移**读（先记 size，之后 slice(size)）。bridge.js:618 在日志超过
//      2000 行时会 `fs.writeFileSync(BRIDGE_LOG, lines.slice(-2000).join('\n'))` 把整个
//      文件重写一遍 —— 那是**行级轮转**：内容整体上移一行，文件长度几乎不变。于是记录的
//      偏移量落点漂到某行中间，slice 出来是半行，正则永远匹配不上。实测症状：
//      `读到字节=90 新鲜行字节=49`，而日志里那行确实在。偏移法在轮转面前没有出路。
//   ② 改成整读之后，要能区分「本次探测写的那行」和「上一轮测试留下的同名历史行」。
//      日志行只带 HH:MM:SS（**UTC**，文件 mtime 与进程时间是本地时间），所以把行的时刻
//      拼到「今天(UTC)」上得到 epoch，只认 >= 探测开始时刻的行。
const LOG_FILE = path.join(ROOT, 'state', 'bridge.log');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineEpoch = (line) => {
  const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!m) return null;
  const now = new Date();
  let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]), Number(m[2]), Number(m[3]));
  if (t - now.getTime() > 3600000) t -= 86400000; // 行时刻比此刻「晚」超过 1 小时 → 其实是昨天（跨零点）
  return t;
};
// 取日志里所有「写于 t0 之后」的行。整读 + 时间窗，既不怕轮转，也不怕历史同名行。
const linesSince = (t0) => {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter((l) => { const t = lineEpoch(l); return t !== null && t >= t0; }).join('\n');
  } catch { return ''; }
};
async function waitFor(pred, timeoutMs = 6000) {
  const t0 = Date.now();
  let v = false;
  while (Date.now() - t0 < timeoutMs) {
    v = pred();
    if (v) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return v;
}
// 一次「必然命中节流」的活体探测：改配置 → POST /wake → 读日志。
// 被拦下时 sendWakePromptV2 直接 return，她**不会被唤醒**，所以这个探测是零副作用的。
async function probeThrottle({ key, reason, config, expectStage, expectPark, attempts = 3 }) {
  const r = await setWakeConfig({ key, config });
  const hitRe = new RegExp(`唤醒节流命中（${expectStage}）${expectPark ? '暂存' : '跳过'} ${esc(key)}（${esc(reason)}）`);
  // ★「会话繁忙」这一支在桥接里排在节流判定**前面**（src/bridge.js:9621 → 9632）：
  // 她这个回合还没结束时，唤醒会被暂存并打 `会话繁忙，暂存唤醒原因` 就返回，
  // **根本走不到节流**。所以这时候"没有节流日志"不代表节流失效，只代表会话正忙 ——
  // 没有区分开的话，A9/A10 会变成随她忙不忙而随机红绿的假失败
  // （线上打开 L0「每条消息都看」之后她更常处于回合中，这个坑就更容易踩到）。
  const busyRe = new RegExp(`会话繁忙，暂存唤醒原因 ${esc(key)}（${esc(reason)}@`);
  // 9638 行那句「[reserved2] 唤醒 <key>（<reason>）」只有真投递了才会出现，与节流命中互斥。
  const deliveredRe = new RegExp(`\\[reserved2\\] 唤醒 ${esc(key)}（${esc(reason)}）`);
  let hit = false;
  let delivered = false;
  let busy = false;
  let postStatus = 0;
  for (let i = 0; i < attempts; i += 1) {
    const t0 = Date.now() - 2000; // 留 2 秒余量：日志行只精确到秒
    const post = await req('/api/socialV2/wake', { method: 'POST', body: { key, reason } });
    postStatus = post.status;
    let text = '';
    await waitFor(() => { text = linesSince(t0); return hitRe.test(text) || busyRe.test(text); });
    hit = hitRe.test(text);
    delivered = deliveredRe.test(text);
    busy = !hit && busyRe.test(text);
    // 走到节流判定就结束；既没节流也没忙（说明别的地方断了）也结束，交给断言去报失败，
    // 不要用重试把真问题盖过去。
    if (hit || !busy) break;
    await new Promise((resolve) => setTimeout(resolve, 15000)); // 她还在回合里，等一会儿再试
  }
  return { hit, delivered, busy, cfgStatus: r.status, postStatus };
}
const timesOf = (key, field) => {
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    const arr = snap?.conversations?.[key]?.[field];
    return Array.isArray(arr) ? arr.filter((t) => Number.isFinite(t)) : [];
  } catch { return []; }
};
const recentCount = (arr, windowMs) => { const n = Date.now(); return arr.filter((t) => n - t >= 0 && n - t < windowMs).length; };

let alive = false;
try { const p = await req('/api/panel/overview'); alive = p.status === 200 && !!p.json?.ok; } catch (e) { alive = false; }
if (!alive) {
  skipped('A 段全部（桥接未运行或面板不可达）');
} else {
  const before = await wakeConfigOf(TARGET_KEY);
  check('A1 靶子会话存在且能读到 wakeConfig', !!before, before ? `mode=${before.mode} infinite=${before.infinite} triggers=${JSON.stringify(before.triggers)}` : '读不到');
  if (!before) {
    skipped('A 段其余用例（读不到 wakeConfig）');
  } else {
  try {
    try { fs.writeFileSync(backupFile, JSON.stringify(before, null, 2)); say(`   （改前原值已备份到 ${path.relative(ROOT, backupFile)}）`); } catch {}
    // A2/A3 先用一组「探测值」验证真能往返 —— 用目标值测不出「路由是不是只是把输入原样回显」
    const r2 = await setWakeConfig({ key: TARGET_KEY, config: PROBE });
    const echoed = r2.json?.wakeConfig ?? {};
    const a2ok = r2.status === 200 && echoed.maxWakePerMinute === PROBE.maxWakePerMinute && echoed.maxWakePerHour === PROBE.maxWakePerHour && echoed.speakCooldownMs === PROBE.speakCooldownMs;
    check('A2 ★路由接受并回显三关节流字段', a2ok,
      `HTTP ${r2.status} 回显=${echoed.maxWakePerMinute}/${echoed.maxWakePerHour}/${echoed.speakCooldownMs}`);
    const persistedProbe = await wakeConfigOf(TARGET_KEY);
    const a3ok = persistedProbe?.maxWakePerMinute === PROBE.maxWakePerMinute && persistedProbe?.maxWakePerHour === PROBE.maxWakePerHour && persistedProbe?.speakCooldownMs === PROBE.speakCooldownMs;
    check('A3 ★三关节流字段真的落盘（回读 /states，不是看响应自说自话）', a3ok,
      `回读=${persistedProbe?.maxWakePerMinute}/${persistedProbe?.maxWakePerHour}/${persistedProbe?.speakCooldownMs}`);
    // ★安全闸门：A9-A11 的活体探测只有在「新版路由确实生效」时才允许跑。
    // 理由：那些用例靠「必然命中的节流参数」把她挡在门外，如果跑的是改动前的桥接
    // （路由会把三参数整个丢掉 → 冷却根本不存在、频率帽还是全局 20/200），
    // 那么 POST /wake 就会**真的在 134 人群里唤醒她**。宁可不测，也不能因为这个测试
    // 在真群里发出一条消息。所以闸门直接挂在 A2/A3 的结论上。
    const throttleLive = a2ok && a3ok;
    const gateOff = throttleLive ? '' : '安全闸门：新版 wake-config 路由未生效，现在探测会真的在群里唤醒她';
    if (!throttleLive) say(`   ⚠ A9-A12 将被跳过 —— ${gateOff}。`);
    // A4/A5 写上线目标值
    const r4 = await setWakeConfig({ key: TARGET_KEY, config: FINAL });
    check('A4 写入上线目标值成功', r4.status === 200 && r4.json?.ok === true, `HTTP ${r4.status}`);
    const after = await wakeConfigOf(TARGET_KEY);
    check('A5 上线目标值已生效（2 次/分、30 次/时、120s 冷却）',
      after?.maxWakePerMinute === FINAL.maxWakePerMinute && after?.maxWakePerHour === FINAL.maxWakePerHour && after?.speakCooldownMs === FINAL.speakCooldownMs,
      `现为 ${after?.maxWakePerMinute}/${after?.maxWakePerHour}/${after?.speakCooldownMs}`);
    const trigSame = JSON.stringify(after?.triggers) === JSON.stringify(before.triggers);
    check('A6 ★既有触发条件与潜水状态没被冲掉', trigSame && after?.mode === before.mode && after?.infinite === before.infinite,
      `triggers 一致=${trigSame} mode=${after?.mode} infinite=${after?.infinite}`);
    const r7 = await setWakeConfig({ key: TARGET_KEY, config: { maxWakePerMinute: -5, maxWakePerHour: 'abc', speakCooldownMs: -1 } });
    const afterBad = await wakeConfigOf(TARGET_KEY);
    check('A7 非法值被拒（不写脏值，保留原值）',
      afterBad?.maxWakePerMinute === FINAL.maxWakePerMinute && afterBad?.maxWakePerHour === FINAL.maxWakePerHour && afterBad?.speakCooldownMs === FINAL.speakCooldownMs,
      `HTTP ${r7.status} 回读=${afterBad?.maxWakePerMinute}/${afterBad?.maxWakePerHour}/${afterBad?.speakCooldownMs}`);
    const r8 = await req('/api/socialV2/wake-config', { method: 'POST', headers: { 'x-agent-token': 'definitely_not_a_valid_token_0000' }, body: { key: TARGET_KEY, config: { maxWakePerMinute: 99 } } });
    check('A8 错令牌被 403 拦下（且没写进去）', r8.status === 403 && (await wakeConfigOf(TARGET_KEY))?.maxWakePerMinute === FINAL.maxWakePerMinute, `HTTP ${r8.status}`);
    say(`   ℹ 该群 anyMessage 当前值 = ${after?.triggers?.anyMessage}（L0 开关是否已打开看这里）`);
    say(`   ℹ 该群 keywords = ${JSON.stringify(after?.triggers?.keywords)}  speakerIds = ${JSON.stringify(after?.triggers?.speakerIds)}`);

    // ── A9-A12：节流的**拦截动作**（零唤醒，原理见文件头 ④）────────────
    // 前提条件只能从落盘文件读（频率帽读 st.wakeTimes、冷却读 st.sendTimes），
    // 所以先确认前提真的成立；不成立就跳过并说明，而不是让它变成一条假失败。
    const tgtSends = timesOf(TARGET_KEY, 'sendTimes');
    const tgtWakes = timesOf(TARGET_KEY, 'wakeTimes');
    const mutedWakes = timesOf(MUTED_KEY, 'wakeTimes');
    say(`   ℹ 前提：${TARGET_KEY} 最近 1 小时 发言 ${recentCount(tgtSends, 3600000)} 次 / 被唤醒 ${recentCount(tgtWakes, 3600000)} 次；${MUTED_KEY} 最近 1 小时被唤醒 ${recentCount(mutedWakes, 3600000)} 次`);

    // A9 发言后冷却拦住闲聊类：把频率帽关掉（0=不限），命中的原因就只可能是冷却。
    if (gateOff || recentCount(tgtSends, 3600000) === 0) {
      skipped(`A9（${gateOff || `${TARGET_KEY} 最近 1 小时没发过言，冷却前提不成立`}）`);
    } else {
      const a9 = await probeThrottle({ key: TARGET_KEY, reason: 'anyMessage', config: { ...FINAL, maxWakePerMinute: 0, maxWakePerHour: 0, speakCooldownMs: 3600000 }, expectStage: 'speak-cooldown', expectPark: false });
      if (a9.busy) {
        skipped(`A9（${TARGET_KEY} 的会话正在回合中，唤醒被「会话繁忙」暂存、没走到节流判定；稍后重跑即可）`);
      } else {
        check('A9 ★发言后冷却真的拦住了闲聊类唤醒（stage=speak-cooldown，她确实没被唤醒）',
          a9.hit && !a9.delivered, `命中=${a9.hit} 被投递=${a9.delivered} HTTP cfg=${a9.cfgStatus} wake=${a9.postStatus}`);
      }
    }
    // A10 频率帽拦住闲聊类，且必须标记「跳过」（park=false）—— 被限流时丢掉闲聊正是节流目的。
    if (gateOff || recentCount(tgtWakes, 3600000) === 0) {
      skipped(`A10（${gateOff || `${TARGET_KEY} 最近 1 小时没被唤醒过，频率帽前提不成立`}）`);
    } else {
      const a10 = await probeThrottle({ key: TARGET_KEY, reason: 'anyMessage', config: { ...FINAL, maxWakePerMinute: 0, maxWakePerHour: 1, speakCooldownMs: 0 }, expectStage: 'rate', expectPark: false });
      if (a10.busy) {
        skipped(`A10（${TARGET_KEY} 的会话正在回合中，唤醒被「会话繁忙」暂存、没走到节流判定；稍后重跑即可）`);
      } else {
        check('A10 ★频率帽真的拦住了闲聊类唤醒，且是「跳过」而不是暂存',
          a10.hit && !a10.delivered, `命中=${a10.hit} 被投递=${a10.delivered}`);
      }
    }
    // A11 同一次频率帽拦截，原因换成非闲聊类 → 必须**暂存**（回合结束补发），不能丢。
    if (gateOff || recentCount(mutedWakes, 3600000) === 0) {
      skipped(`A11（${gateOff || `${MUTED_KEY} 最近 1 小时没被唤醒过，频率帽前提不成立`}）`);
    } else {
      const a11 = await probeThrottle({ key: MUTED_KEY, reason: 'poke', config: { maxWakePerMinute: 0, maxWakePerHour: 1, speakCooldownMs: 3600000 }, expectStage: 'rate', expectPark: true });
      if (a11.busy) {
        skipped(`A11（${MUTED_KEY} 的会话正在回合中，唤醒被「会话繁忙」暂存、没走到节流判定；稍后重跑即可）`);
      } else {
        check('A11 ★非闲聊类（拍一拍）被频率帽拦下时是「暂存」而不是「跳过」',
          a11.hit && !a11.delivered, `命中=${a11.hit} 被投递=${a11.delivered}`);
      }
      // 收尾（尽力而为）：mark-read 清空 unread 后，补发逻辑 10664 行的 stillRelevant
      // 判定必为假，暂存项就不会再补一次唤醒。若 mark-read 被 400 挡下（她刚被唤醒、
      // 还没等够沉睡前观察窗口），残留项也只是躺在内存里没有持久化，等她下次在那个
      // 会话有回合时才会被处理——而那时消息基本已被那回合读过，同样会判定为不相关。
      const mr = await req('/api/socialV2/mark-read', { method: 'POST', body: { key: MUTED_KEY } });
      say(`   ℹ A11 收尾：${MUTED_KEY} mark-read HTTP ${mr.status}，markedCount=${mr.json?.markedCount ?? '-'}${mr.status === 200 ? '' : '（未清空，残留暂存项按上面注释处理）'}`);
      // 配置同样要收尾：A11 为了「必然命中」把该会话的频率帽写成 1 次/小时、冷却写成 1 小时。
      // 不清掉就等于给一个静音群永久钉上这套参数（以后没人说得清这参数哪来的）。
      // 传 null = 清除按会话覆盖、退回全局默认 —— 这正是本次改造前它的状态。
      const rc = await setWakeConfig({ key: MUTED_KEY, config: { maxWakePerMinute: null, maxWakePerHour: null, speakCooldownMs: null } });
      const back = await wakeConfigOf(MUTED_KEY);
      check('A11b 探测后已清除该会话的临时节流覆盖（退回全局默认）',
        rc.status === 200 && back?.maxWakePerMinute === undefined && back?.maxWakePerHour === undefined && back?.speakCooldownMs === undefined,
        `HTTP ${rc.status} 回读=${back?.maxWakePerMinute}/${back?.maxWakePerHour}/${back?.speakCooldownMs}`);
    }
    // A12 null 能把按会话覆盖**清掉**、退回全局默认。
    // 先写一个临时值确认「确实有东西可清」——否则在改动前跑时这条会假通过
    // （两边都是 undefined），那就失去基线意义了。
    if (gateOff) {
      skipped(`A12（${gateOff}）`);
    } else {
      await setWakeConfig({ key: TARGET_KEY, config: { maxWakePerHour: 7 } });
      const set12 = await wakeConfigOf(TARGET_KEY);
      const r12 = await setWakeConfig({ key: TARGET_KEY, config: { maxWakePerMinute: null, maxWakePerHour: null, speakCooldownMs: null } });
      const after12 = await wakeConfigOf(TARGET_KEY);
      check('A12 传 null 可清除按会话覆盖、退回全局默认',
        set12?.maxWakePerHour === 7 && r12.status === 200 && after12?.maxWakePerMinute === undefined && after12?.maxWakePerHour === undefined && after12?.speakCooldownMs === undefined,
        `先写入=${set12?.maxWakePerHour} 清除后 HTTP ${r12.status} 回读=${after12?.maxWakePerMinute}/${after12?.maxWakePerHour}/${after12?.speakCooldownMs}`);
    }
    // A13 探测过程中把靶子群配置改成了临时值，必须恢复上线目标值并确认触发条件仍在。
    await setWakeConfig({ key: TARGET_KEY, config: FINAL });
    const restored = await wakeConfigOf(TARGET_KEY);
    check('A13 探测结束后靶子群已恢复上线目标值、触发条件未被动过',
      restored?.maxWakePerMinute === FINAL.maxWakePerMinute && restored?.maxWakePerHour === FINAL.maxWakePerHour && restored?.speakCooldownMs === FINAL.speakCooldownMs && JSON.stringify(restored?.triggers) === JSON.stringify(before.triggers),
      `现为 ${restored?.maxWakePerMinute}/${restored?.maxWakePerHour}/${restored?.speakCooldownMs} triggers 一致=${JSON.stringify(restored?.triggers) === JSON.stringify(before.triggers)}`);
    // ── A14：L0 上线（每条消息都看）+ 节流参数，**必须一次写成** ──────────
    // 为什么必须一次写完：anyMessage=true 与三关节流参数必须同时生效。
    // 如果分两次写，中间就会存在一个「每条消息都唤醒她、但节流还没上」的窗口，
    // 那个窗口里她会被 134 人群的每一条闲聊按全局默认（20/分、200/时 ≈ 不设防）
    // 叫起来——这正是本次改造要消除的东西。路由把 config 合成一个 next 对象一次
    // 落盘，所以一次 POST 就是原子的。
    // 为什么挂在闸门上：如果新版路由没生效（A2/A3 红），三关节流参数会被整个丢掉，
    // 而 anyMessage=true 却写得进去，那等于亲手制造上面那个窗口。所以闸门关着时
    // 宁可不开 anyMessage —— 少做一步，而不是做一个危险的一步。
    if (!throttleLive) {
      skipped(`A14（L0 上线被闸门拦住：${gateOff}）`);
    } else {
      const l0 = await setWakeConfig({ key: TARGET_KEY, config: { ...FINAL, triggers: { anyMessage: true } } });
      const afterL0 = await wakeConfigOf(TARGET_KEY);
      const trig = { ...(afterL0?.triggers ?? {}) };
      delete trig.anyMessage;
      const beforeTrig = { ...(before.triggers ?? {}) };
      delete beforeTrig.anyMessage;
      check('A14 ★L0+L2 一次写入：anyMessage 已打开、其余触发条件分毫未动、节流三参数同时生效',
        l0.status === 200 && afterL0?.triggers?.anyMessage === true && JSON.stringify(trig) === JSON.stringify(beforeTrig)
          && afterL0?.maxWakePerMinute === FINAL.maxWakePerMinute && afterL0?.maxWakePerHour === FINAL.maxWakePerHour && afterL0?.speakCooldownMs === FINAL.speakCooldownMs
          && afterL0?.mode === before.mode && afterL0?.infinite === before.infinite,
        `HTTP ${l0.status} anyMessage=${afterL0?.triggers?.anyMessage} 其余触发条件一致=${JSON.stringify(trig) === JSON.stringify(beforeTrig)} 节流=${afterL0?.maxWakePerMinute}/${afterL0?.maxWakePerHour}/${afterL0?.speakCooldownMs} mode=${afterL0?.mode}`);
      if (afterL0?.triggers?.anyMessage === true) {
        say('   ℹ L0 已生效：该群任何新消息都会唤醒她一次（评估由模型判断要不要说话），');
        say('     成本由 A5 的频率帽（2/分、30/时）与发言后冷却（120s）兜住，见 U6 的量化模拟。');
      }
    }
  } catch (e) {
    // 整个 A 段包在 try 里：桥接随时可能被面板动作或看门狗重启换掉
    // （实测撞上过一次：`POST /api/panel/control {action:'restart-bridge'}` 让旧进程
    //  在测试中途退出，一个 ECONNRESET 就把整个测试崩掉、连汇总都不打）。
    // 断线应该表现为一条失败，而不是把前面 U/S 段的结论一起丢掉。
    fail++;
    say(`❌ A 段中断（桥接在测试过程中被重启或断线）：${e?.message ?? e}`);
  }
  }
}

// ══════════════════════════════════════════════════════════════════
say(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
await new Promise((r) => setTimeout(r, 500));
process.exit(fail > 0 ? 1 : 0);
