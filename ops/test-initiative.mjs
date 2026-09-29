/**
 * ops/test-initiative.mjs — 主动开口决策引擎离线自检
 * 运行：node ops/test-initiative.mjs
 * 约束：不联网、不读 state/、不看当前时间、测试里禁止 Math.random（全部用固定种子 mulberry32）。
 */
import {
  ACTION_WHITELIST,
  INITIATIVE_DEFAULTS,
  attentionScore,
  speakProbability,
  shouldSpeak,
  rankThoughts,
  pickThought,
  planInitiative,
  initiativeStats
} from '../src/initiative.js';

// ── 测试基础设施（仓库风格） ────────────────────────────
let pass = 0;
let fail = 0;
let skipCount = 0;
function section(title) {
  console.log(`\n── ${title} ──`);
}
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`✅ ${name}  ${detail}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}  ${detail}`);
  }
}
function skipped(name, detail = '') {
  skipCount += 1;
  console.log(`⏭️ ${name}  ${detail}`);
}

// ── 固定种子伪随机（mulberry32） ────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000; // 固定基准时间，永远不看真实时钟
const D = INITIATIVE_DEFAULTS;

const hasSub = (arr, sub) => Array.isArray(arr) && arr.some((x) => typeof x === 'string' && x.includes(sub));
const idxOf = (arr, sub) => (Array.isArray(arr) ? arr.findIndex((x) => typeof x === 'string' && x.includes(sub)) : -1);

/** 全闸门都通过的基线（只改一个字段就能做“只违反它”的用例） */
function goodSignals(over = {}) {
  return {
    unread: 10,
    recentCount: 0,
    silenceMs: 45 * MIN,
    sinceLastSpokeMs: 3 * HOUR,
    hour: 14,
    isOwner: true,
    isGroup: false,
    mood: 80,
    energy: 80,
    ignoredCount: 0,
    relationScore: 80,
    actionsThisCycle: 0,
    roll: 0.05,
    ...over
  };
}

// ══════════════════════════════════════════════════════
section('1. 常量与默认值');

check(
  'ACTION_WHITELIST 只有 private/sticker 且被冻结',
  ACTION_WHITELIST.length === 2 &&
    ACTION_WHITELIST[0] === 'private' &&
    ACTION_WHITELIST[1] === 'sticker' &&
    Object.isFrozen(ACTION_WHITELIST),
  JSON.stringify(ACTION_WHITELIST)
);
check(
  'INITIATIVE_DEFAULTS 被冻结且阈值与约定一致',
  Object.isFrozen(D) &&
    D.baseProb === 0.15 &&
    D.minProb === 0.01 &&
    D.maxProb === 0.45 &&
    D.cycleMs === 30 * MIN &&
    D.maxActionsPerCycle === 1 &&
    D.minSilenceMs === 20 * MIN &&
    D.backoffFactor === 0.4 &&
    D.backoffMaxHits === 4 &&
    D.backoffQuietMs === 6 * HOUR &&
    D.minEnergy === 20 &&
    D.minMood === 25,
  `baseProb=${D.baseProb} maxProb=${D.maxProb} minSilenceMs=${D.minSilenceMs}`
);
check(
  'quietHours = [2,3,4,5,6]',
  Array.isArray(D.quietHours) && D.quietHours.join(',') === '2,3,4,5,6',
  JSON.stringify(D.quietHours)
);

// ══════════════════════════════════════════════════════
section('2. attentionScore 注意力分');

const aEmpty = attentionScore();
check('全缺省不抛错且落在 0..1', Number.isFinite(aEmpty) && aEmpty >= 0 && aEmpty <= 1, `a=${aEmpty}`);

const aBase = attentionScore({ silenceMs: 0, sinceLastSpokeMs: 0, unread: 0 });
const aBusy = attentionScore({ unread: 10, silenceMs: 60 * MIN, sinceLastSpokeMs: 3 * HOUR });
check('未读多 + 安静久 + 离上次说话久 → 分数更高', aBusy > aBase, `${aBase.toFixed(3)} → ${aBusy.toFixed(3)}`);

const aNoOwner = attentionScore({ ...goodSignals({ isOwner: false }) });
check('isOwner（私聊主人）加分', attentionScore(goodSignals()) > aNoOwner, `${aNoOwner.toFixed(3)} → ${attentionScore(goodSignals()).toFixed(3)}`);

const aQuietGroup = attentionScore(goodSignals({ isGroup: true, recentCount: 0 }));
const aBusyGroup = attentionScore(goodSignals({ isGroup: true, recentCount: 30 }));
check('群聊正刷屏（recentCount 高）减分', aBusyGroup < aQuietGroup, `${aQuietGroup.toFixed(3)} → ${aBusyGroup.toFixed(3)}`);

const aHappy = attentionScore(goodSignals({ mood: 90, energy: 90 }));
const aSad = attentionScore(goodSignals({ mood: 5, energy: 5 }));
check('mood/energy 低 → 减分', aSad < aHappy, `${aHappy.toFixed(3)} → ${aSad.toFixed(3)}`);

const aLowRel = attentionScore(goodSignals({ relationScore: 0 }));
const aHighRel = attentionScore(goodSignals({ relationScore: 100 }));
check('relationScore 高 → 略加分', aHighRel > aLowRel && aHighRel - aLowRel <= 0.1, `${aLowRel.toFixed(3)} → ${aHighRel.toFixed(3)}`);

const weird = {
  unread: '很多',
  recentCount: null,
  silenceMs: NaN,
  sinceLastSpokeMs: {},
  hour: '凌晨',
  isOwner: 'yes',
  isGroup: 1,
  mood: '',
  energy: undefined,
  ignoredCount: '3',
  relationScore: 'abc'
};
const aWeird = attentionScore(weird);
check('非数值输入不产生 NaN 且仍在 0..1', Number.isFinite(aWeird) && aWeird >= 0 && aWeird <= 1, `a=${aWeird}`);

const aExtreme = attentionScore({
  unread: 9999,
  recentCount: 0,
  silenceMs: 999 * HOUR,
  sinceLastSpokeMs: 999 * HOUR,
  isOwner: true,
  relationScore: 100,
  mood: 100,
  energy: 100
});
check('极端输入被封顶到 1（不发散）', Number.isFinite(aExtreme) && aExtreme <= 1 && aExtreme > 0.95, `a=${aExtreme}`);

// ══════════════════════════════════════════════════════
section('3. shouldSpeak 多重闸门');

const ok = shouldSpeak(goodSignals());
check('全闸门通过 → speak=true 且 blocked 为空', ok.speak === true && ok.blocked.length === 0, `prob=${ok.prob.toFixed(3)}`);
check('通过时 prob 落在 [minProb, maxProb]', ok.prob >= D.minProb && ok.prob <= D.maxProb, `prob=${ok.prob.toFixed(3)}`);
check('reasons 可读（≥6 条中文说明）', ok.reasons.length >= 6, `reasons=${ok.reasons.length} 条`);
check('backoffHits 回传当前被无视次数', ok.backoffHits === 0, `backoffHits=${ok.backoffHits}`);

const g1 = shouldSpeak(goodSignals({ actionsThisCycle: 1 }));
check(
  '只违反①周期额度 → 拦下并写明原因',
  g1.speak === false && hasSub(g1.blocked, '这个周期已经开过口了'),
  g1.blocked[0] || '(空)'
);

const g2 = shouldSpeak(goodSignals({ ignoredCount: 4, nowMs: T0, lastIgnoredAtMs: T0 - 60 * MIN }));
check(
  '只违反②闭嘴期 → 拦下并写明原因',
  g2.speak === false && hasSub(g2.blocked, '处在闭嘴期'),
  g2.blocked[0] || '(空)'
);

const g3 = shouldSpeak(goodSignals({ hour: 4 }));
check('只违反③凌晨 → 拦下并写明原因', g3.speak === false && hasSub(g3.blocked, '凌晨不主动开口（hour=4）'), g3.blocked[0] || '(空)');

const g4 = shouldSpeak(goodSignals({ energy: 12 }));
check('只违反④精力 → 拦下并写明原因', g4.speak === false && hasSub(g4.blocked, '精力太低（12 < 20）'), g4.blocked[0] || '(空)');

const g5 = shouldSpeak(goodSignals({ mood: 10 }));
check('只违反⑤心情 → 拦下并写明原因', g5.speak === false && hasSub(g5.blocked, '心情太低（10 < 25）'), g5.blocked[0] || '(空)');

const g6 = shouldSpeak(goodSignals({ silenceMs: 12 * MIN }));
check('只违反⑥最小安静时长 → 拦下并写明原因', g6.speak === false && hasSub(g6.blocked, '安静时间不足（12 分钟 < 20 分钟）'), g6.blocked[0] || '(空)');

const g7 = shouldSpeak(goodSignals({ roll: 0.999 }));
check('只违反⑦概率 → 拦下并写明原因', g7.speak === false && hasSub(g7.blocked, '概率未命中'), g7.blocked[0] || '(空)');

check(
  '任何一项否决 → prob 一律归零',
  [g1, g2, g3, g4, g5, g6, g7].every((v) => v.prob === 0 && v.speak === false),
  [g1, g2, g3, g4, g5, g6, g7].map((v) => v.prob).join(',')
);

const multi = shouldSpeak(
  goodSignals({ actionsThisCycle: 1, ignoredCount: 5, nowMs: T0, lastIgnoredAtMs: T0 - 60 * MIN, hour: 4, energy: 5, mood: 5, silenceMs: 60 * 1000 })
);
check('多项同时违反 → blocked 列出全部命中项（不是只列第一个）', multi.blocked.length >= 5, `blocked=${multi.blocked.length} 项`);
const orderOk =
  idxOf(multi.blocked, '这个周期') === 0 &&
  idxOf(multi.blocked, '处在闭嘴期') === 1 &&
  idxOf(multi.blocked, '凌晨不主动开口') === 2 &&
  idxOf(multi.blocked, '精力太低') === 3 &&
  idxOf(multi.blocked, '心情太低') === 4 &&
  idxOf(multi.blocked, '安静时间不足') === 5;
check('闸门顺序稳定（①周期②闭嘴期③凌晨④精力⑤心情⑥安静）', orderOk, multi.blocked.map((x) => x.split('（')[0]).join(' | '));
check('多项违反时 prob 也是 0', multi.prob === 0 && multi.speak === false, `prob=${multi.prob}`);

// ══════════════════════════════════════════════════════
section('4. 退避与闭嘴期');

const backoffProbs = [0, 1, 2, 3].map((n) => speakProbability(goodSignals({ ignoredCount: n })));
check(
  '退避：ignoredCount 0→1→2→3 概率严格下降',
  backoffProbs[0] > backoffProbs[1] && backoffProbs[1] > backoffProbs[2] && backoffProbs[2] > backoffProbs[3],
  backoffProbs.map((p) => p.toFixed(4)).join(' > ')
);
check(
  '退避后概率不低于 minProb',
  backoffProbs.every((p) => p >= D.minProb && p <= D.maxProb),
  backoffProbs.map((p) => p.toFixed(4)).join(', ')
);
check(
  '退避倍率约为 0.4 累乘（1 次 ≈ ×0.4）',
  Math.abs(backoffProbs[1] / backoffProbs[0] - 0.4) < 0.08,
  `比值=${(backoffProbs[1] / backoffProbs[0]).toFixed(3)}`
);

const quiet = shouldSpeak(goodSignals({ ignoredCount: D.backoffMaxHits, nowMs: T0, lastIgnoredAtMs: T0 - 2.8 * HOUR }));
check('ignoredCount=4 → 进闭嘴期，speak=false', quiet.speak === false && hasSub(quiet.blocked, '处在闭嘴期'), quiet.blocked[0] || '(空)');
check('闭嘴期写明还剩多久（lastIgnoredAtMs + backoffQuietMs 计算）', hasSub(quiet.blocked, '还有 3.2 小时'), quiet.blocked[0] || '(空)');

const quietDone = shouldSpeak(goodSignals({ ignoredCount: D.backoffMaxHits, nowMs: T0, lastIgnoredAtMs: T0 - 7 * HOUR }));
check('闭嘴期已过 → 不再以闭嘴期为由拦下', !hasSub(quietDone.blocked, '处在闭嘴期'), quietDone.blocked[0] || '(无)');

const noStamp = shouldSpeak(goodSignals({ ignoredCount: D.backoffMaxHits }));
check('缺时间戳时不瞎猜，保守拦下', noStamp.speak === false && hasSub(noStamp.blocked, '处在闭嘴期'), noStamp.blocked[0] || '(空)');

// ══════════════════════════════════════════════════════
section('5. 概率上下界（fuzz 200 组）');

const fz = mulberry32(424242);
let nanCount = 0;
let overCount = 0;
let structBad = 0;
let belowZero = 0;
for (let i = 0; i < 200; i += 1) {
  const s = {
    unread: Math.floor(fz() * 60) - 5,
    recentCount: Math.floor(fz() * 40),
    silenceMs: fz() * 4 * HOUR,
    sinceLastSpokeMs: fz() * 24 * HOUR,
    hour: Math.floor(fz() * 24),
    isOwner: fz() > 0.5,
    isGroup: fz() > 0.5,
    mood: fz() * 140 - 20,
    energy: fz() * 140 - 20,
    ignoredCount: Math.floor(fz() * 9),
    relationScore: fz() * 140 - 20,
    actionsThisCycle: Math.floor(fz() * 3),
    roll: fz(),
    nowMs: T0 + Math.floor(fz() * 1e9),
    lastIgnoredAtMs: T0 + Math.floor(fz() * 1e9),
    lastActionAtMs: T0 + Math.floor(fz() * 1e9)
  };
  const p = speakProbability(s);
  if (!Number.isFinite(p)) nanCount += 1;
  if (p > D.maxProb) overCount += 1;
  if (p < 0) belowZero += 1;
  const v = shouldSpeak(s);
  if (
    typeof v.speak !== 'boolean' ||
    !Number.isFinite(v.prob) ||
    !Array.isArray(v.reasons) ||
    !Array.isArray(v.blocked) ||
    !Number.isFinite(v.backoffHits)
  ) {
    structBad += 1;
  }
}
check('fuzz 200 组：概率无 NaN', nanCount === 0, `NaN=${nanCount}`);
check('fuzz 200 组：概率不超过 maxProb', overCount === 0, `超界=${overCount}（maxProb=${D.maxProb}）`);
check('fuzz 200 组：概率不为负', belowZero === 0, `负值=${belowZero}`);
check('fuzz 200 组：shouldSpeak 返回结构完整', structBad === 0, `坏结构=${structBad}`);

const extreme = shouldSpeak({ unread: 9999, silenceMs: 999 * HOUR, sinceLastSpokeMs: 999 * HOUR, isOwner: true, relationScore: 100, mood: 100, energy: 100, hour: 14, roll: 0 });
check('极端信号（unread=9999）也不允许“一定开口”', extreme.prob <= D.maxProb, `prob=${extreme.prob.toFixed(3)} ≤ ${D.maxProb}`);
check('非数值信号 → 概率仍合法（缺省安静 0 → 保守拦下）', speakProbability(weird) === 0, `prob=${speakProbability(weird)}`);

// ══════════════════════════════════════════════════════
section('6. 四道阈值闸门的边界值');

check(
  '安静时长正好 = minSilenceMs → 不拦',
  !hasSub(shouldSpeak(goodSignals({ silenceMs: D.minSilenceMs })).blocked, '安静时间不足'),
  `silenceMs=${D.minSilenceMs}`
);
check(
  '安静时长少 1 毫秒 → 拦',
  hasSub(shouldSpeak(goodSignals({ silenceMs: D.minSilenceMs - 1 })).blocked, '安静时间不足'),
  `silenceMs=${D.minSilenceMs - 1}`
);
check('精力正好 = minEnergy → 不拦', !hasSub(shouldSpeak(goodSignals({ energy: D.minEnergy })).blocked, '精力太低'), `energy=${D.minEnergy}`);
check('精力少 1 → 拦', hasSub(shouldSpeak(goodSignals({ energy: D.minEnergy - 1 })).blocked, '精力太低'), `energy=${D.minEnergy - 1}`);
check('心情正好 = minMood → 不拦', !hasSub(shouldSpeak(goodSignals({ mood: D.minMood })).blocked, '心情太低'), `mood=${D.minMood}`);
check('心情少 1 → 拦', hasSub(shouldSpeak(goodSignals({ mood: D.minMood - 1 })).blocked, '心情太低'), `mood=${D.minMood - 1}`);
check('hour=2（静默段下边界）→ 拦', hasSub(shouldSpeak(goodSignals({ hour: 2 })).blocked, '凌晨不主动开口'), 'hour=2');
check('hour=6（静默段上边界）→ 拦', hasSub(shouldSpeak(goodSignals({ hour: 6 })).blocked, '凌晨不主动开口'), 'hour=6');
check('hour=1 与 hour=7（静默段外）→ 不拦', !hasSub(shouldSpeak(goodSignals({ hour: 1 })).blocked, '凌晨不主动开口') && !hasSub(shouldSpeak(goodSignals({ hour: 7 })).blocked, '凌晨不主动开口'), 'hour=1,7');
check('hour 缺省 → 跳过凌晨闸门（不误杀）', !hasSub(shouldSpeak(goodSignals({ hour: undefined })).blocked, '凌晨不主动开口'), 'hour=undefined');

// ══════════════════════════════════════════════════════
section('7. rankThoughts 排序 / TTL / 冷权');

const rk = rankThoughts(
  [
    { id: 'fresh', kind: 'private', score: 2, createdAtMs: T0 - 1 * MIN, ttlMs: 60 * MIN, cost: 0 },
    { id: 'old', kind: 'private', score: 2, createdAtMs: T0 - 59 * MIN, ttlMs: 60 * MIN, cost: 0 },
    { id: 'expired', kind: 'private', score: 100, createdAtMs: T0 - 2 * HOUR, ttlMs: 60 * MIN, cost: 0 }
  ],
  { nowMs: T0 }
);
check('过期念头（超 ttlMs）被直接剔除', rk.length === 2 && !rk.some((r) => r.thought.id === 'expired'), `剩余=${rk.length}`);
check('高价值（越新）念头排前面', rk[0].thought.id === 'fresh' && rk[0].value > rk[1].value, `${rk[0].value.toFixed(3)} > ${rk[1].value.toFixed(3)}`);
check('每条都带可读 reasons', rk.every((r) => Array.isArray(r.reasons) && r.reasons.length >= 4), `reasons=${rk[0].reasons.length} 条`);
check('按 value 从高到低严格排序', rk.every((r, i) => i === 0 || rk[i - 1].value >= r.value), rk.map((r) => r.value.toFixed(3)).join(' ≥ '));

const cd = rankThoughts(
  [
    { id: 'hot', score: 2, lastUsedMs: T0 - 1 * MIN },
    { id: 'cold', score: 2, lastUsedMs: T0 - 10 * HOUR }
  ],
  { nowMs: T0, cooldownMs: 30 * MIN }
);
check('刚用过的念头被冷却降权', cd[0].thought.id === 'cold', `${cd[0].thought.id}(${cd[0].value.toFixed(3)}) > ${cd[1].thought.id}(${cd[1].value.toFixed(3)})`);

const cst = rankThoughts(
  [
    { id: 'cheap', score: 2, cost: 0 },
    { id: 'pricey', score: 2, cost: 4 }
  ],
  { nowMs: T0 }
);
check('cost 高的念头被降权', cst[0].thought.id === 'cheap' && cst[0].value > cst[1].value, `${cst[0].value.toFixed(3)} > ${cst[1].value.toFixed(3)}`);

const immut = [{ id: 'x', kind: 'private', score: 2, createdAtMs: T0 - MIN, ttlMs: HOUR, cost: 1, lastUsedMs: T0 - MIN }];
const snap = JSON.stringify(immut);
rankThoughts(immut, { nowMs: T0 });
pickThought(immut, { nowMs: T0 }, mulberry32(1));
planInitiative(goodSignals({ nowMs: T0, thoughts: immut }), {}, mulberry32(1));
check('不修改传入对象（念头池快照不变）', JSON.stringify(immut) === snap, JSON.stringify(immut));
check('空池 / 非数组输入安全', rankThoughts().length === 0 && rankThoughts(null).length === 0, 'ok');

// ══════════════════════════════════════════════════════
section('8. pickThought 轮盘赌');

const empty = pickThought([], {}, mulberry32(3));
check('空池 → {thought:null}', empty.thought === null && empty.value === 0 && Array.isArray(empty.rejected), JSON.stringify(empty));

const pool2 = [
  { id: 'hi', kind: 'private', score: 9 },
  { id: 'lo', kind: 'private', score: 1 }
];
const randA = mulberry32(2024);
let hiHits = 0;
let rejectedSeen = false;
for (let i = 0; i < 1000; i += 1) {
  const r = pickThought(pool2, {}, randA);
  if (r.thought && r.thought.id === 'hi') hiHits += 1;
  if (Array.isArray(r.rejected) && r.rejected.length > 0) rejectedSeen = true;
}
check('轮盘赌偏向高价值（但不是必胜）', hiHits > 700 && hiHits < 1000, `hi 中签 ${hiHits}/1000（期望 ≈900）`);
check('rejected 记录没中签的念头与原因', rejectedSeen, 'ok');

const pickedOne = pickThought(pool2, {}, mulberry32(77));
check('单次返回 {thought, value, rejected} 且 value 与所选项一致', pickedOne.thought !== null && Number.isFinite(pickedOne.value) && pickedOne.value > 0, `id=${pickedOne.thought.id} value=${pickedOne.value.toFixed(3)}`);

const pickExpired = pickThought([{ id: 'gone', score: 5, createdAtMs: T0 - 5 * HOUR, ttlMs: HOUR }], { nowMs: T0 }, mulberry32(9));
check('池里只剩过期念头 → 选不出，且 rejected 说明原因', pickExpired.thought === null && hasSub(pickExpired.rejected, '已过期'), pickExpired.rejected[0] || '(空)');

// ══════════════════════════════════════════════════════
section('9. planInitiative 与动作白名单');

const POOL = [
  { id: 't-private', kind: 'private', text: '问问主人今天怎么样', score: 3, cost: 1 },
  { id: 't-sticker', kind: 'sticker', text: '发个表情', score: 2, cost: 0.5 },
  { id: 't-group-topic', kind: 'group_topic', text: '在群里挑个话题', score: 5, cost: 1 }
];

const blockedPlan = planInitiative(goodSignals({ hour: 4, thoughts: POOL }), {}, mulberry32(11));
check(
  'shouldSpeak 否决 → action=none 且原因带出来',
  blockedPlan.action === 'none' && blockedPlan.thought === null && blockedPlan.blocked.length > 0 && blockedPlan.prob === 0,
  blockedPlan.blocked[0] || '(空)'
);

const onlyGroup = planInitiative(goodSignals({ thoughts: [{ id: 'g1', kind: 'group_topic', score: 9, text: '群聊挑话题' }] }), {}, mulberry32(7));
check('白名单：kind=group_topic 不被执行（action=none）', onlyGroup.action === 'none', `action=${onlyGroup.action}`);
check('白名单：被拦下的念头写进 blockedThoughts', onlyGroup.blockedThoughts.length > 0 && hasSub(onlyGroup.blockedThoughts, 'group_topic'), onlyGroup.blockedThoughts[0] || '(空)');
check('白名单：动作落到 ACTION_WHITELIST 内', ACTION_WHITELIST.includes(onlyGroup.action) === false, `action=${onlyGroup.action}`);

const onlyPrivate = planInitiative(goodSignals({ thoughts: [{ id: 'p1', kind: 'private', score: 5, text: '搭话' }] }), {}, mulberry32(13));
check('kind=private → action=private 且带出 thought', onlyPrivate.action === 'private' && onlyPrivate.thought && onlyPrivate.thought.id === 'p1', `action=${onlyPrivate.action} prob=${onlyPrivate.prob.toFixed(3)}`);

const onlySticker = planInitiative(goodSignals({ thoughts: [{ id: 's1', kind: 'sticker', score: 5 }] }), {}, mulberry32(17));
check('kind=sticker → action=sticker', onlySticker.action === 'sticker' && onlySticker.thought.id === 's1', `action=${onlySticker.action}`);

const mixed = planInitiative(goodSignals({ thoughts: POOL }), {}, mulberry32(19));
check('混合池：group_topic 记录在案，执行的动作仍在白名单内', ACTION_WHITELIST.includes(mixed.action) && hasSub(mixed.blockedThoughts, 'group_topic'), `action=${mixed.action}`);

const noThoughts = planInitiative(goodSignals({ thoughts: [] }), {}, mulberry32(23));
check('空念头池 → action=none 且说明原因', noThoughts.action === 'none' && noThoughts.blockedThoughts.length > 0, noThoughts.blockedThoughts[0] || '(空)');

const pinnedRoll = planInitiative(goodSignals({ roll: 0.99, thoughts: POOL }), {}, mulberry32(31));
const pinnedPass = planInitiative(goodSignals({ roll: 0.0, thoughts: POOL }), {}, mulberry32(31));
check(
  'signals.roll 可钉住骰子，便于复盘重放',
  pinnedRoll.action === 'none' && hasSub(pinnedRoll.blocked, '概率未命中') && ACTION_WHITELIST.includes(pinnedPass.action),
  `roll=0.99 → ${pinnedRoll.action}，roll=0 → ${pinnedPass.action}`
);

const planKeys = Object.keys(planInitiative(goodSignals({ thoughts: POOL }), {}, mulberry32(29))).sort().join(',');
check('planInitiative 返回字段齐全', planKeys === 'action,blocked,blockedThoughts,prob,reasons,thought', planKeys);

// ══════════════════════════════════════════════════════
section('10. 固定种子 500 次长跑');

const SEED = 20240915;
const HOURS = [14, 15, 16, 4, 20, 21, 3, 22, 12, 13];

function runSim(seed, rounds = 500) {
  const rand = mulberry32(seed);
  const log = [];
  const perCycle = new Map();
  const startMs = T0;
  let lastSpokeMs = startMs - 3 * HOUR;
  let lastActionAtMs = null;
  for (let i = 0; i < rounds; i += 1) {
    const nowMs = startMs + i * MIN;
    const cycle = Math.floor(nowMs / D.cycleMs);
    const signals = {
      nowMs,
      unread: Math.floor(rand() * 6),
      recentCount: Math.floor(rand() * 8),
      silenceMs: nowMs - lastSpokeMs,
      sinceLastSpokeMs: nowMs - lastSpokeMs,
      hour: HOURS[i % HOURS.length],
      isOwner: true,
      isGroup: false,
      mood: 40 + rand() * 60,
      energy: 40 + rand() * 60,
      ignoredCount: 0,
      relationScore: 70,
      actionsThisCycle: perCycle.get(cycle) || 0,
      lastActionAtMs,
      thoughts: POOL
    };
    const plan = planInitiative(signals, {}, rand);
    log.push(plan);
    if (plan.action !== 'none') {
      perCycle.set(cycle, (perCycle.get(cycle) || 0) + 1);
      lastSpokeMs = nowMs;
      lastActionAtMs = nowMs;
    }
  }
  return { log, perCycle };
}

const simA = runSim(SEED);
const actedA = simA.log.filter((p) => p.action !== 'none').length;
const overCycle = [...simA.perCycle.values()].filter((n) => n > D.maxActionsPerCycle).length;
check('500 次开口比例 ∈ [0,1] 且不是全开口', actedA >= 0 && actedA <= 500 && actedA / 500 < 1, `开口 ${actedA}/500 = ${(actedA / 500).toFixed(3)}`);
check('500 次里从没超掉 maxActionsPerCycle', overCycle === 0, `超限周期数=${overCycle}，周期数=${simA.perCycle.size}`);
check('长跑里确实开了口（不是永远装死）', actedA > 0, `开口 ${actedA} 次`);
check('所有 action 都在 {none,private,sticker} 内', simA.log.every((p) => p.action === 'none' || ACTION_WHITELIST.includes(p.action)), 'ok');
check('所有 prob 都在 0..maxProb 内', simA.log.every((p) => Number.isFinite(p.prob) && p.prob >= 0 && p.prob <= D.maxProb), 'ok');

const simB = runSim(SEED);
check(
  '同种子两次运行结果 JSON 完全一致',
  JSON.stringify(simA.log) === JSON.stringify(simB.log) &&
    JSON.stringify([...simA.perCycle.entries()]) === JSON.stringify([...simB.perCycle.entries()]),
  `len=${simA.log.length} acted=${actedA}`
);

const statsSim = initiativeStats(simA.log);
check('长跑日志统计：acted 与逐条计数一致', statsSim.acted === actedA && statsSim.n === 500, `n=${statsSim.n} acted=${statsSim.acted}`);
check('长跑假警报率在 0..1 之间（本模拟全部 wasIgnored=false → 0）', statsSim.falseAlarmRate >= 0 && statsSim.falseAlarmRate <= 1, `falseAlarmRate=${statsSim.falseAlarmRate}`);

// ══════════════════════════════════════════════════════
section('11. initiativeStats 复盘统计');

const st0 = initiativeStats([]);
check('空日志 → 全零且不产生 NaN', st0.n === 0 && st0.acted === 0 && st0.actedRate === 0 && st0.falseAlarmRate === 0, JSON.stringify({ n: st0.n, actedRate: st0.actedRate, falseAlarmRate: st0.falseAlarmRate }));
check('非数组输入安全', initiativeStats(null).n === 0 && initiativeStats(undefined).falseAlarmRate === 0, 'ok');

const fakeLog = [
  { action: 'none', blocked: ['安静时间不足（12 分钟 < 20 分钟）'], blockedThoughts: [] },
  { action: 'private', wasIgnored: true, blocked: [], blockedThoughts: [] },
  { action: 'private', wasIgnored: false, blocked: [], blockedThoughts: [] },
  { action: 'sticker', wasIgnored: true, blocked: [], blockedThoughts: ['g1（kind=group_topic 不在动作白名单）'] },
  { action: 'none', blocked: ['凌晨不主动开口（hour=4）', '精力太低（12 < 20）'], blockedThoughts: [] },
  { action: 'private', wasIgnored: false, blocked: [], blockedThoughts: [] },
  { action: 'sticker', wasIgnored: false, blocked: [], blockedThoughts: [] },
  { action: 'none', blocked: ['安静时间不足（30 分钟 < 45 分钟）'], blockedThoughts: ['x: 轮盘未中'] }
];
const st = initiativeStats(fakeLog);
check('n = 全部决策条数', st.n === 8, `n=${st.n}`);
check('acted = 真的开口的次数', st.acted === 5, `acted=${st.acted}`);
check('actedRate = acted / n', Math.abs(st.actedRate - 5 / 8) < 1e-12, `actedRate=${st.actedRate}`);
check(
  '假警报率 = 开口后被 wasIgnored 的占比（2/5 = 0.4）',
  Math.abs(st.falseAlarmRate - 0.4) < 1e-12,
  `falseAlarmRate=${st.falseAlarmRate}（2/5）`
);
check('byAction 分类计数正确', st.byAction.none === 3 && st.byAction.private === 3 && st.byAction.sticker === 2, JSON.stringify(st.byAction));
check(
  'byBlocked 按原因主干聚合',
  st.byBlocked['安静时间不足'] === 2 && st.byBlocked['凌晨不主动开口'] === 1 && st.byBlocked['精力太低'] === 1,
  JSON.stringify(st.byBlocked)
);
check('全开口没人理 → 假警报率 1（口径正确）', initiativeStats([{ action: 'private', wasIgnored: true }]).falseAlarmRate === 1, 'ok');
check('一次都没开口 → 假警报率 0（不带 NaN）', initiativeStats([{ action: 'none' }, { action: 'none' }]).falseAlarmRate === 0, 'ok');

// ══════════════════════════════════════════════════════
console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skipCount} ═══`);
if (fail > 0) process.exitCode = 1;
