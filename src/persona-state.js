// 状态层 —— 她的心情 / 精力 / 对眼前这个人的态度
//
// 为什么要它：主人报的短板里有一条是「情绪太平」——翻她最近 20 条发言，全是软萌 +「呀」，
// 没有低端情绪，也没有"今天不想说话"的日子。纯靠提示词写不出这个：模型每一回合都是全新的，
// 除非有**跨回合演化**的状态被注回提示词。
//
// 本模块只管三件事，不写文案：
//   1. 状态怎么演化（事件加减 + 时间衰减回归）；
//   2. 状态怎么序列化进 state/social-v2.json（重启后还在）；
//   3. 状态怎么变成**倾向与建议**（说长还是说短、要不要主动开口、语气蔫不蔫）。
// 真正的句子仍然由她生成 —— 这是方案第 8 节专门划的线：状态机不许写模板句。
//
// 纯函数：不读文件、不联网、不看当前时间（时间一律由调用方传 nowMs 进来）、不改传入对象。
// 改演化规则/阈值必须同步改 ops/test-persona-state.mjs。

/** 三维状态的出厂值与合法区间。 */
export const STATE_BASE = Object.freeze({ mood: 60, energy: 70 });
export const STATE_MIN = 0;
export const STATE_MAX = 100;
export const STATE_VERSION = 1;

/** 心情跟精力向基准线回归的半衰期（毫秒）。心情慢、精力快（睡一觉就回来了）。 */
export const STATE_HALF_LIFE_MS = Object.freeze({ mood: 12 * 3600 * 1000, energy: 4 * 3600 * 1000 });

/** 各类事件对状态的影响。加了新事件必须同步补测试。 */
export const STATE_EVENTS = Object.freeze({
  chat: Object.freeze({ mood: 2, energy: -2, why: '聊起来' }),
  goodTalk: Object.freeze({ mood: 5, energy: 3, why: '聊得开心' }),
  praise: Object.freeze({ mood: 8, energy: 4, why: '被夸' }),
  care: Object.freeze({ mood: 6, energy: 2, why: '被关心' }),
  insult: Object.freeze({ mood: -12, energy: -4, why: '被骂' }),
  scolded: Object.freeze({ mood: -10, energy: -3, why: '被凶' }),
  ignored: Object.freeze({ mood: -5, energy: -3, why: '说了没人理' }),
  longSilence: Object.freeze({ mood: -4, energy: 6, why: '好久没人说话（正好歇着）' }),
  lateNight: Object.freeze({ mood: -2, energy: -10, why: '熬夜' }),
  burst: Object.freeze({ mood: -3, energy: -6, why: '被连着刷屏' }),
  quietHour: Object.freeze({ mood: 1, energy: 6, why: '安静一小时' }),
  error: Object.freeze({ mood: -6, energy: -4, why: '工具报错/被拒绝' })
});

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo = STATE_MIN, hi = STATE_MAX) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/** 把任意脏数据修成合法状态。非法值一律回落到基准线，绝不抛错、绝不产生 NaN。 */
export function clampState(input) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    mood: round1(clamp(num(s.mood, STATE_BASE.mood))),
    energy: round1(clamp(num(s.energy, STATE_BASE.energy))),
    updatedAtMs: num(s.updatedAtMs, 0)
  };
}

/** 新建一个状态（fresh）。 */
export function newState(nowMs = 0) {
  return { mood: STATE_BASE.mood, energy: STATE_BASE.energy, updatedAtMs: num(nowMs, 0) };
}

/** 指数衰减：v 每秒向 base 靠近，半衰期为 halfLifeMs。fromMs==toMs 时原样返回。 */
export function decayValue(value, base, fromMs, toMs, halfLifeMs) {
  const dt = num(toMs, 0) - num(fromMs, 0);
  if (!(dt > 0) || !(halfLifeMs > 0)) return num(value, base);
  const k = Math.pow(0.5, dt / halfLifeMs);
  return base + (num(value, base) - base) * k;
}

/** 纯时间流逝：心情慢慢回到 60，精力更快回到 70。 */
export function decayState(state, { fromMs, toMs } = {}) {
  const s = clampState(state);
  const from = num(fromMs, s.updatedAtMs);
  const to = num(toMs, from);
  return {
    mood: round1(clamp(decayValue(s.mood, STATE_BASE.mood, from, to, STATE_HALF_LIFE_MS.mood))),
    energy: round1(clamp(decayValue(s.energy, STATE_BASE.energy, from, to, STATE_HALF_LIFE_MS.energy))),
    updatedAtMs: num(to, from)
  };
}

/**
 * 把一串事件叠到状态上。事件会先按时间衰减（用事件自己的 at，或整段的 nowMs）。
 * @param {object} state
 * @param {Array<{type:string, at?:number, weight?:number}>} events
 * @param {{nowMs?:number}} options
 */
export function applyEvents(state, events = [], { nowMs } = {}) {
  let cur = clampState(state);
  const list = Array.isArray(events) ? events : [];
  let cursor = cur.updatedAtMs;
  for (const ev of list) {
    const at = num(ev && ev.at, num(nowMs, cursor));
    cur = decayState(cur, { fromMs: cursor, toMs: at });
    cursor = Math.max(cursor, at);
    const def = STATE_EVENTS[ev && ev.type];
    if (!def) continue; // 未知事件直接忽略（不抛错，方便以后加事件）
    const w = num(ev.weight, 1);
    cur = clampState({ mood: cur.mood + def.mood * w, energy: cur.energy + def.energy * w, updatedAtMs: at });
  }
  if (num(nowMs, 0) > cursor) cur = decayState(cur, { fromMs: cursor, toMs: nowMs });
  return cur;
}

/** 状态 → 倾向与建议。只给方向和一句话的建议，不给成句的文案。 */
export function stateTendency(state, { hour = null } = {}) {
  const s = clampState(state);
  const night = typeof hour === 'number' && (hour >= 23 || hour < 6);

  let lengthHint = 'mid';
  if (s.energy < 20) lengthHint = 'minimal';
  else if (s.energy < 40 || s.mood < 40) lengthHint = 'short';
  else if (s.energy >= 60 && s.mood >= 65) lengthHint = 'long';

  let initiativeHint = 'normal';
  if (s.energy < 20) initiativeHint = 'off';
  else if (s.energy < 35 || s.mood < 30) initiativeHint = 'low';
  else if (s.energy >= 65 && s.mood >= 70) initiativeHint = 'high';

  // 凌晨一律收敛：这个点主人睡了，她就算精力是满的也不该长篇大论、更不该主动找话头。
  // （跟 src/initiative.js 的 quietHours 是一套思路：那边是硬闸门，这边是给她的倾向。）
  if (night) {
    lengthHint = s.energy < 20 ? 'minimal' : 'short';
    initiativeHint = s.energy < 20 ? 'off' : 'low';
  }

  let toneHint = 'normal';
  if (s.mood < 25) toneHint = 'sulky';
  else if (s.mood < 45) toneHint = 'low';
  else if (s.mood >= 78) toneHint = 'bright';

  const sleepy = night || s.energy < 35;
  const sleepyHard = night || s.energy < 18;

  return {
    mood: s.mood,
    energy: s.energy,
    lengthHint,
    initiativeHint,
    toneHint,
    sleepy,
    sleepyHard,
    canBeGrumpy: s.mood < 40,
    advice: ADVICE[lengthHint],
    initiativeAdvice: INITIATIVE_ADVICE[initiativeHint]
  };
}

const ADVICE = Object.freeze({
  long: '多说两句也没关系，甚至可以主动扯一句',
  mid: '正常长度就好',
  short: '说短一点，别解释太多',
  minimal: '尽量一句话，甚至只回个语气词'
});
const INITIATIVE_ADVICE = Object.freeze({
  high: '可以自己找话头',
  normal: '有人搭话就聊，没人说话就安静待着',
  low: '只回应直接点你的话，别主动开口',
  off: '除非被 @ 或主人私聊，否则别说话'
});

/**
 * 状态 → 注入提示词的一行。硬上限 90 字（≈ 方案里说的 ≤80 token 预算）。
 * 只说"我现在什么感觉、该怎么说话"，不许写成她的台词。
 */
export function renderStateLine(state, options = {}) {
  const t = stateTendency(state, options);
  const moodWord = t.toneHint === 'sulky' ? '有点蔫、不太想理人' : t.toneHint === 'low' ? '情绪一般' : t.toneHint === 'bright' ? '心情很好' : '还算平静';
  const energyWord = t.sleepyHard ? '很困、脑子转不动' : t.sleepy ? '有点累' : t.energy >= 65 ? '精神不错' : '还行';
  // 标签必须与 src/bridge.js 的 statusLine（未读/最近一条来自/上次发言）区分开：
  // 那边已经占了【此刻状态】，这里再用同名标签会让提示词里出现两个同名段、语义混淆。
  const line = `【心情与精力】心情 ${t.mood}/100（${moodWord}），精力 ${t.energy}/100（${energyWord}）。`
    + `建议：${t.advice}；${t.initiativeAdvice}。`;
  return line.length > 90 ? `${line.slice(0, 88)}…` : line;
}

/** 落盘用。带版本号，以后改结构可以迁移。 */
export function serializeState(state, nowMs = 0) {
  const s = clampState(state);
  // nowMs 是"外部指定时间戳"；默认 0 表示"沿用状态自己的 updatedAtMs"。
  // 早先直接写 num(nowMs, s.updatedAtMs)：num(0, x) 会返回 0（0 是有效数字），
  // 于是每次落盘都把 updatedAtMs 写成 0 —— 重启读回后 decayState 的 dt = now - 0 ≈ 1.79e12ms，
  // 半衰期幂趋近 0，一步就把心情/精力打回基准线 60/70，等于每次重启清空她的情绪。
  const stamp = num(nowMs, 0) > 0 ? num(nowMs, 0) : num(s.updatedAtMs, 0);
  return { v: STATE_VERSION, mood: s.mood, energy: s.energy, updatedAtMs: stamp };
}

/** 从 social-v2.json 读回来。任何脏数据都回落到基准线，绝不抛错。 */
export function deserializeState(raw, nowMs = 0) {
  if (!raw || typeof raw !== 'object' || raw.v !== STATE_VERSION) {
    return newState(num(raw && raw.updatedAtMs, nowMs));
  }
  // 同上：0 / 负数当成"没有时间戳"，补成 nowMs，别让历史脏数据把衰减算成"过了 57 年"。
  const persisted = num(raw.updatedAtMs, 0);
  return clampState({ ...raw, updatedAtMs: persisted > 0 ? persisted : num(nowMs, 0) });
}

/** 一批状态样本的极差/方差 —— 验收用（"日内方差应出现明显低频日"）。 */
export function stateStats(samples) {
  const list = (Array.isArray(samples) ? samples : []).map(clampState);
  if (!list.length) return { n: 0, moodMin: 0, moodMax: 0, moodAvg: 0, energyMin: 0, energyMax: 0, energyAvg: 0, moodRange: 0, energyRange: 0 };
  const col = (k) => list.map((s) => s[k]);
  const avg = (a) => round1(a.reduce((x, y) => x + y, 0) / a.length);
  const mood = col('mood'); const energy = col('energy');
  return {
    n: list.length,
    moodMin: Math.min(...mood), moodMax: Math.max(...mood), moodAvg: avg(mood),
    energyMin: Math.min(...energy), energyMax: Math.max(...energy), energyAvg: avg(energy),
    moodRange: round1(Math.max(...mood) - Math.min(...mood)),
    energyRange: round1(Math.max(...energy) - Math.min(...energy))
  };
}
