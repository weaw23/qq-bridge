/**
 * src/initiative.js — 主动开口（initiative）决策引擎
 *
 * 背景：同类开源项目 ProactiveAgent 的主动开口假警报率高达 64.73%
 * （该说话时不说、不该说话时乱说）。本项目主人的要求是【先保守，宁可少开口】，
 * 目标假警报率 < 40%。所以这里是「多重闸门 + 指数退避 + 每周期最多 1 件」，
 * 并且每一次决策都会给出可读的原因，方便事后复盘「她为什么突然说话 / 为什么装死」。
 *
 * 闸门顺序（稳定，不可调换）：
 *   ① 周期额度  ② 闭嘴期  ③ 凌晨静默  ④ 精力  ⑤ 心情  ⑥ 最小安静时长  ⑦ 概率
 * 任何一项否决 → speak:false 且 prob:0；blocked 里列出【全部】命中项，不是只列第一个。
 *
 * 纯函数约定（务必遵守）：
 *  - 不读文件、不联网、不看当前时间。时间一律由 signals.nowMs / options.nowMs 传入，
 *    缺省值 0（= 未知），未知时按保守方向处理。
 *  - 绝不修改传入对象（全部只读 + 浅拷贝）。
 *  - 随机数只从参数 rand 注入；模块内部仅在【缺省值】位置允许出现 Math.random。
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 现阶段只允许这两个动作：私聊搭话 / 发一张表情。群聊挑话题、发图、改配置一律不开。 */
export const ACTION_WHITELIST = Object.freeze(['private', 'sticker']);

export const INITIATIVE_DEFAULTS = Object.freeze({
  baseProb: 0.15, // 基础开口概率（attentionScore = 0.5 时的中点）
  minProb: 0.01,
  maxProb: 0.45, // 硬上限：不允许“一定开口”
  cycleMs: 30 * MIN, // 判定周期 30 分钟
  maxActionsPerCycle: 1, // 一个周期最多执行 1 件
  minSilenceMs: 20 * MIN, // 安静不满 20 分钟就别开口
  backoffFactor: 0.4, // 被无视一次，概率乘 0.4
  backoffMaxHits: 4, // 连续被无视 4 次后进入“闭嘴期”
  backoffQuietMs: 6 * HOUR, // 闭嘴期长度
  quietHours: Object.freeze([2, 3, 4, 5, 6]), // 本机时间的这些小时不主动开口（凌晨）
  minEnergy: 20, // 精力低于这个值不主动开口
  minMood: 25 // 心情低于这个值不主动开口
});

/** 注意力曲线各分项的饱和点：先到先封顶，避免单项独占总分 */
const SAT = Object.freeze({
  unread: 10,
  silenceMs: 60 * MIN,
  sinceLastSpokeMs: 3 * HOUR,
  groupBusyFree: 6, // 群里 6 条以内算“正常”，不扣分
  groupBusyRange: 12 // 超过 18 条 → 扣满
});
/** 各分项权重（最大值合计 1.15，最后 clamp 到 1，保证任何单项都吃不掉全局） */
const W = Object.freeze({
  base: 0.15,
  unread: 0.25,
  silence: 0.25,
  lastSpoke: 0.2,
  owner: 0.1,
  groupBusy: 0.1,
  mood: 0.1,
  energy: 0.1,
  relation: 0.08,
  ignored: 0.1
});
/** rankThoughts 缺省参数 */
const RANK_DEFAULTS = Object.freeze({
  cooldownMs: 30 * MIN, // 用过之后 30 分钟内降权
  defaultTtlMs: 12 * HOUR, // 没写 ttlMs 时的保鲜期
  costWeight: 0.5 // value = ... / (1 + cost * costWeight)
});

// ── 基础工具（全部防 NaN） ──────────────────────────────
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function num(v, def = 0) {
  return isNum(v) ? v : def;
}
function asObj(v) {
  return v && typeof v === 'object' ? v : {};
}
function asArr(v) {
  return Array.isArray(v) ? v : [];
}
function clamp(x, lo, hi) {
  const v = num(x, lo);
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(x) {
  return clamp(x, 0, 1);
}
function fmtMin(ms) {
  return `${Math.round(num(ms, 0) / MIN)} 分钟`;
}
function fmtHours(ms) {
  return `${(num(ms, 0) / HOUR).toFixed(1)} 小时`;
}
function nameOf(t, i = 0) {
  if (t && typeof t === 'object') {
    if (typeof t.id === 'string' && t.id) return t.id;
    if (typeof t.text === 'string' && t.text) return t.text.slice(0, 12);
  }
  return `念头#${i}`;
}
function resolveCfg(raw) {
  const o = asObj(raw);
  const d = INITIATIVE_DEFAULTS;
  const hours = Array.isArray(o.quietHours)
    ? o.quietHours.filter(isNum).map((h) => Math.trunc(h))
    : d.quietHours;
  const out = {
    baseProb: num(o.baseProb, d.baseProb),
    minProb: num(o.minProb, d.minProb),
    maxProb: num(o.maxProb, d.maxProb),
    cycleMs: Math.max(1, num(o.cycleMs, d.cycleMs)),
    maxActionsPerCycle: Math.max(0, num(o.maxActionsPerCycle, d.maxActionsPerCycle)),
    minSilenceMs: Math.max(0, num(o.minSilenceMs, d.minSilenceMs)),
    backoffFactor: clamp(num(o.backoffFactor, d.backoffFactor), 0, 1),
    backoffMaxHits: Math.max(1, num(o.backoffMaxHits, d.backoffMaxHits)),
    backoffQuietMs: Math.max(0, num(o.backoffQuietMs, d.backoffQuietMs)),
    quietHours: hours.length ? hours : d.quietHours,
    minEnergy: num(o.minEnergy, d.minEnergy),
    minMood: num(o.minMood, d.minMood)
  };
  out.maxProb = clamp(out.maxProb, 0, 1);
  out.minProb = clamp(out.minProb, 0, out.maxProb);
  out.baseProb = clamp(out.baseProb, out.minProb, out.maxProb);
  return out;
}

// ── 1. 注意力分 ────────────────────────────────────────
/**
 * 把一堆原始信号揉成 0..1 的“此刻该不该关注她”的分数。
 * 未读越多 / 安静越久 / 离上次说话越久 → 越高；私聊主人加分；
 * 群聊正刷屏（recentCount 高）→ 减分（热闹时插话显得吵）；
 * mood/energy 低 → 减分；relationScore（0~100 熟识度）高 → 略加分。
 * 全部字段可缺省；任何非数值输入都被当作缺省值，绝不产生 NaN。
 */
export function attentionScore(signals) {
  const s = asObj(signals);
  const unread = Math.max(0, num(s.unread, 0));
  const recentCount = Math.max(0, num(s.recentCount, 0));
  const silenceMs = Math.max(0, num(s.silenceMs, 0));
  const sinceLastSpokeMs = Math.max(0, num(s.sinceLastSpokeMs, 0));
  const mood = clamp(num(s.mood, 50), 0, 100);
  const energy = clamp(num(s.energy, 50), 0, 100);
  const relation = clamp(num(s.relationScore, 0), 0, 100);
  const ignored = Math.max(0, num(s.ignoredCount, 0));
  const isOwner = s.isOwner === true;
  const isGroup = s.isGroup === true;

  let v = W.base;
  v += clamp01(unread / SAT.unread) * W.unread;
  v += clamp01(silenceMs / SAT.silenceMs) * W.silence;
  v += clamp01(sinceLastSpokeMs / SAT.sinceLastSpokeMs) * W.lastSpoke;
  if (isOwner) v += W.owner;
  if (isGroup) {
    v -= clamp01((recentCount - SAT.groupBusyFree) / SAT.groupBusyRange) * W.groupBusy;
  }
  v -= clamp01((50 - mood) / 50) * W.mood;
  v -= clamp01((50 - energy) / 50) * W.energy;
  v += clamp01(relation / 100) * W.relation;
  v -= clamp01(ignored / INITIATIVE_DEFAULTS.backoffMaxHits) * W.ignored;

  return clamp(isNum(v) ? v : 0, 0, 1);
}

// ── 2. 概率内核 ────────────────────────────────────────
/** 注意力 → 概率：以 baseProb 为 attention=0.5 的中点，两端分别是 minProb / maxProb */
function probFromAttention(a, c) {
  const x = clamp01(num(a, 0));
  const p =
    x >= 0.5
      ? c.baseProb + (c.maxProb - c.baseProb) * ((x - 0.5) / 0.5)
      : c.minProb + (c.baseProb - c.minProb) * (x / 0.5);
  return clamp(isNum(p) ? p : c.minProb, c.minProb, c.maxProb);
}

function probabilityParts(s, c) {
  const att = attentionScore(s);
  const hits = Math.max(0, num(s.ignoredCount, 0));
  const base = probFromAttention(att, c);
  const mult = clamp(Math.pow(c.backoffFactor, hits), 0, 1); // 累乘退避
  let p = base * mult;
  if (!isNum(p)) p = c.minProb;
  p = Math.max(p, c.minProb);
  p = Math.min(p, c.maxProb); // 硬上限：哪怕 attention=1、unread=9999
  p = Math.max(p, 0);
  return { att, base, mult, prob: p, hits };
}

// ── 3. 确定性闸门 ①~⑥ ─────────────────────────────────
function collectGates(s, c) {
  const reasons = [];
  const blocked = [];

  // ① 周期额度
  const nowMs = num(s.nowMs, 0);
  const used = Math.max(0, num(s.actionsThisCycle, 0));
  const lastActionAtMs = isNum(s.lastActionAtMs) ? s.lastActionAtMs : null;
  const sameCycle =
    lastActionAtMs !== null &&
    nowMs > 0 &&
    Math.floor(nowMs / c.cycleMs) === Math.floor(lastActionAtMs / c.cycleMs);
  if (used >= c.maxActionsPerCycle || sameCycle) {
    const shown = Math.max(used, sameCycle ? 1 : 0);
    blocked.push(`这个周期已经开过口了（本周期已开口 ${shown}/${c.maxActionsPerCycle}）`);
  } else {
    reasons.push(`周期额度可用（本周期已开口 ${used}/${c.maxActionsPerCycle}）`);
  }

  // ② 闭嘴期
  const hits = Math.max(0, num(s.ignoredCount, 0));
  if (hits >= c.backoffMaxHits) {
    const lastIgnoredAtMs = isNum(s.lastIgnoredAtMs) ? s.lastIgnoredAtMs : null;
    const remains =
      lastIgnoredAtMs === null || nowMs <= 0
        ? null
        : lastIgnoredAtMs + c.backoffQuietMs - nowMs;
    if (remains === null) {
      blocked.push(`处在闭嘴期（连续被无视 ${hits} 次，缺少时间戳，保守不开口）`);
    } else if (remains > 0) {
      blocked.push(`处在闭嘴期，还有 ${fmtHours(remains)}`);
    } else {
      reasons.push(`闭嘴期已结束（连续被无视 ${hits} 次）`);
    }
  } else {
    reasons.push(`未进闭嘴期（连续被无视 ${hits}/${c.backoffMaxHits} 次）`);
  }

  // ③ 凌晨
  const hour = isNum(s.hour) ? Math.trunc(s.hour) : null;
  if (hour !== null && c.quietHours.includes(hour)) {
    blocked.push(`凌晨不主动开口（hour=${hour}）`);
  } else if (hour === null) {
    reasons.push('未提供本机小时，跳过凌晨闸门');
  } else {
    reasons.push(`不在凌晨静默段（hour=${hour}）`);
  }

  // ④ 精力
  const energy = num(s.energy, 50);
  if (energy < c.minEnergy) {
    blocked.push(`精力太低（${energy} < ${c.minEnergy}）`);
  } else {
    reasons.push(`精力够用（${energy} ≥ ${c.minEnergy}）`);
  }

  // ⑤ 心情
  const mood = num(s.mood, 50);
  if (mood < c.minMood) {
    blocked.push(`心情太低（${mood} < ${c.minMood}）`);
  } else {
    reasons.push(`心情在线（${mood} ≥ ${c.minMood}）`);
  }

  // ⑥ 最小安静时长
  const silenceMs = Math.max(0, num(s.silenceMs, 0));
  if (silenceMs < c.minSilenceMs) {
    blocked.push(`安静时间不足（${fmtMin(silenceMs)} < ${fmtMin(c.minSilenceMs)}）`);
  } else {
    reasons.push(`安静时间已够（${fmtMin(silenceMs)} ≥ ${fmtMin(c.minSilenceMs)}）`);
  }

  return { reasons, blocked, hits };
}

/** ⑦ 骰子：优先用调用方预抽的 roll（保证可重复）；缺省才落回 Math.random */
function rollOf(s) {
  const raw = isNum(s.roll) ? s.roll : isNum(s.random) ? s.random : Math.random();
  return clamp(num(raw, 0.5), 0, 1);
}

// ── 4. shouldSpeak / speakProbability ──────────────────
function speakProbabilityWith(rawSignals, rawCfg) {
  const s = asObj(rawSignals);
  const c = resolveCfg(rawCfg);
  const gates = collectGates(s, c);
  if (gates.blocked.length > 0) return 0; // 已含各项否决
  return probabilityParts(s, c).prob;
}

function shouldSpeakWith(rawSignals, rawCfg) {
  const s = asObj(rawSignals);
  const c = resolveCfg(rawCfg);
  const gates = collectGates(s, c);
  const hits = gates.hits;
  if (gates.blocked.length > 0) {
    return { speak: false, prob: 0, reasons: gates.reasons, blocked: gates.blocked, backoffHits: hits };
  }
  const parts = probabilityParts(s, c);
  const reasons = gates.reasons.slice();
  reasons.push(`注意力 ${parts.att.toFixed(3)} → 基础概率 ${parts.base.toFixed(3)}`);
  reasons.push(`退避 ${parts.hits} 次（×${parts.mult.toFixed(3)}）→ 开口概率 ${parts.prob.toFixed(3)}`);
  const blocked = [];
  const r = rollOf(s);
  if (r >= parts.prob) {
    blocked.push(`概率未命中（骰子 ${r.toFixed(3)} ≥ 开口概率 ${parts.prob.toFixed(3)}）`);
  } else {
    reasons.push(`掷骰 ${r.toFixed(3)} < ${parts.prob.toFixed(3)}，允许开口`);
  }
  const speak = blocked.length === 0;
  return { speak, prob: speak ? parts.prob : 0, reasons, blocked, backoffHits: parts.hits };
}

/** 0..1。已含退避与各项否决：被闸门拦下时返回 0。 */
export function speakProbability(signals) {
  return speakProbabilityWith(signals, {});
}

/** 多重闸门判定；blocked 里是要的中文原因，全部命中项都会列出。 */
export function shouldSpeak(signals) {
  return shouldSpeakWith(signals, {});
}

// ── 5. 念头排序 ────────────────────────────────────────
function rankInternal(thoughts, rawOpts) {
  const opts = asObj(rawOpts);
  const nowMs = num(opts.nowMs, 0);
  const cooldownMs = Math.max(0, num(opts.cooldownMs, RANK_DEFAULTS.cooldownMs));
  const defaultTtlMs = Math.max(0, num(opts.defaultTtlMs, RANK_DEFAULTS.defaultTtlMs));
  const costWeight = Math.max(0, num(opts.costWeight, RANK_DEFAULTS.costWeight));

  const ranked = [];
  const dropped = [];

  asArr(thoughts).forEach((t, i) => {
    const name = nameOf(t, i);
    if (!t || typeof t !== 'object') {
      dropped.push({ name, reason: '不是合法的念头对象' });
      return;
    }
    const score = Math.max(0, num(t.score, 1));
    const ttlMs =
      t.ttlMs === undefined || t.ttlMs === null ? defaultTtlMs : Math.max(0, num(t.ttlMs, defaultTtlMs));
    const createdAtMs = isNum(t.createdAtMs) ? t.createdAtMs : null;

    let ageMs = 0;
    let freshness = 1;
    if (createdAtMs !== null) {
      ageMs = Math.max(0, nowMs - createdAtMs);
      if (ageMs > ttlMs) {
        dropped.push({ name, reason: `已过期（存在 ${fmtMin(ageMs)} > TTL ${fmtMin(ttlMs)}）` });
        return;
      }
      if (ttlMs > 0) freshness = 1 - 0.7 * (ageMs / ttlMs); // 越新越高：刚生成 1.0，临期 0.3
    }

    let cooldown = 1;
    if (isNum(t.lastUsedMs)) {
      const elapsed = Math.max(0, nowMs - t.lastUsedMs);
      if (cooldownMs > 0 && elapsed < cooldownMs) {
        cooldown = 0.2 + 0.8 * clamp01(elapsed / cooldownMs); // 刚用过 → 降到 0.2
      }
    }

    const cost = Math.max(0, num(t.cost, 0));
    const costPenalty = 1 / (1 + cost * costWeight);

    let value = score * freshness * cooldown * costPenalty;
    if (!isNum(value) || value < 0) value = 0;

    ranked.push({
      thought: t,
      value,
      reasons: [
        `基础分 ${score.toFixed(3)}`,
        `时效 ×${freshness.toFixed(3)}（存在 ${fmtMin(ageMs)} / TTL ${fmtMin(ttlMs)}）`,
        `冷却 ×${cooldown.toFixed(3)}`,
        `成本 ×${costPenalty.toFixed(3)}（cost=${cost}）`,
        `合计 ${value.toFixed(3)}`
      ]
    });
  });

  const withIdx = ranked.map((r, i) => ({ r, i }));
  withIdx.sort((a, b) => b.r.value - a.r.value || a.i - b.i);
  return { ranked: withIdx.map((x) => x.r), dropped };
}

/** 返回按 value 从高到低排好的 [{thought, value, reasons}]；过期念头直接剔除（不出现）。 */
export function rankThoughts(thoughts, options = {}) {
  return rankInternal(thoughts, options).ranked;
}

// ── 6. 轮盘赌选念头 ────────────────────────────────────
/** [{thought|null, value, rejected}]；rejected 是「名字: 原因」的可读数组。 */
export function pickThought(thoughts, options = {}, rand = Math.random) {
  const opts = asObj(options);
  const rnd = typeof rand === 'function' ? rand : Math.random;
  const { ranked, dropped } = rankInternal(thoughts, opts);
  const rejected = dropped.map((d) => `${d.name}: ${d.reason}`);
  if (ranked.length === 0) return { thought: null, value: 0, rejected };

  const total = ranked.reduce((acc, r) => acc + (r.value > 0 ? r.value : 0), 0);
  const r = clamp01(num(rnd(), 0.5));
  let picked = null;

  if (total > 0) {
    const target = r * total;
    let acc = 0;
    for (const item of ranked) {
      acc += item.value > 0 ? item.value : 0;
      if (target < acc) {
        picked = item;
        break;
      }
    }
    if (!picked) picked = ranked[ranked.length - 1]; // 浮点兜底
  } else {
    // 全 0 价值：退化成均匀抽（仍然只用注入的 rand）
    picked = ranked[Math.min(ranked.length - 1, Math.floor(r * ranked.length))];
  }

  for (const item of ranked) {
    if (item !== picked) rejected.push(`${nameOf(item.thought)}: 轮盘未中（value ${item.value.toFixed(3)}）`);
  }
  return { thought: picked.thought, value: picked.value, rejected };
}

// ── 7. 总决策 ──────────────────────────────────────────
/**
 * 先 shouldSpeak，再 pickThought，最后过 ACTION_WHITELIST。
 * 非白名单 kind（group_topic / image / config …）一律不执行，记进 blockedThoughts。
 */
export function planInitiative(signals, options = {}, rand = Math.random) {
  const s = asObj(signals);
  const opts = asObj(options);
  const cfg = resolveCfg(opts.cfg || opts.config);
  const rnd = typeof rand === 'function' ? rand : Math.random;

  // 骰子：signals.roll 是调用方显式钉住的（便于复盘重放），否则从 rand 抽一次。
  // 两种情况都只依赖入参，所以同一个 rand 序列两次调用结果完全一致。
  const roll = isNum(s.roll) ? clamp01(s.roll) : clamp01(num(rnd(), 0.5));
  const verdict = shouldSpeakWith({ ...s, roll }, cfg);
  const reasons = verdict.reasons.slice();
  const blocked = verdict.blocked.slice();

  if (!verdict.speak) {
    return { action: 'none', thought: null, prob: 0, reasons, blocked, blockedThoughts: [] };
  }

  const pool = Array.isArray(opts.thoughts) ? opts.thoughts : asArr(s.thoughts);
  const allowed = [];
  const blockedThoughts = [];
  pool.forEach((t, i) => {
    const kind = t && typeof t === 'object' && typeof t.kind === 'string' ? t.kind : undefined;
    if (kind !== undefined && ACTION_WHITELIST.includes(kind)) allowed.push(t);
    else blockedThoughts.push(`${nameOf(t, i)}（kind=${kind === undefined ? '未标注' : kind} 不在动作白名单 [${ACTION_WHITELIST.join(', ')}]）`);
  });
  if (allowed.length === 0) {
    if (blockedThoughts.length === 0) blockedThoughts.push('念头池为空，没有可执行的动作');
    else reasons.push(`念头池里 ${blockedThoughts.length} 个念头全被白名单拦下`);
    return { action: 'none', thought: null, prob: verdict.prob, reasons, blocked, blockedThoughts };
  }

  const nowMs = num(s.nowMs, num(opts.nowMs, 0));
  const picked = pickThought(allowed, { ...opts, nowMs }, rnd);
  if (!picked.thought) {
    blocked.push('念头轮盘没有选出可用念头');
    return {
      action: 'none',
      thought: null,
      prob: verdict.prob,
      reasons,
      blocked,
      blockedThoughts: blockedThoughts.concat(picked.rejected)
    };
  }

  const kind = picked.thought.kind;
  if (!ACTION_WHITELIST.includes(kind)) {
    // 双保险：白名单是硬约束，任何情况下都不许执行
    blockedThoughts.push(`${nameOf(picked.thought)}（kind=${kind} 不在动作白名单）`);
    return { action: 'none', thought: null, prob: verdict.prob, reasons, blocked, blockedThoughts };
  }

  reasons.push(`选中念头「${nameOf(picked.thought)}」（value ${picked.value.toFixed(3)}，kind=${kind}）`);
  return {
    action: kind,
    thought: picked.thought,
    prob: verdict.prob,
    reasons,
    blocked,
    blockedThoughts: blockedThoughts.concat(picked.rejected)
  };
}

// ── 8. 复盘统计 ────────────────────────────────────────
/**
 * 假警报定义（重要，改统计口径先改这里）：
 *   假警报 = 真的开了口（action !== 'none'）但事后被标记 wasIgnored:true（没人理）。
 *   falseAlarmRate = 假警报数 / 开口数（acted），不是除以全部决策数。
 *   开口数为 0 时返回 0（绝不产生 NaN / Infinity）。
 * byBlocked 按原因主干（'（' 之前的部分）聚合，用于查“她最常因为什么装死”。
 */
export function initiativeStats(log) {
  const arr = asArr(log);
  const byAction = { none: 0, private: 0, sticker: 0 };
  const byBlocked = {};
  let acted = 0;
  let ignored = 0;

  for (const raw of arr) {
    const e = asObj(raw);
    const action = typeof e.action === 'string' && e.action ? e.action : 'none';
    byAction[action] = (byAction[action] || 0) + 1;
    if (action !== 'none') {
      acted += 1;
      if (e.wasIgnored === true) ignored += 1;
    }
    for (const b of asArr(e.blocked).concat(asArr(e.blockedThoughts))) {
      if (typeof b !== 'string' || !b) continue;
      const key = (b.split('（')[0].split('(')[0] || b).trim() || b;
      byBlocked[key] = (byBlocked[key] || 0) + 1;
    }
  }

  const n = arr.length;
  return {
    n,
    acted,
    ignored,
    actedRate: n > 0 ? acted / n : 0,
    falseAlarmRate: acted > 0 ? ignored / acted : 0,
    byAction,
    byBlocked
  };
}
