// 鲸鲸 2.0 自主心核（B1 生活状态机 + B4 聊天流三态心流 + C 大胆档时机信号）。
// 纯函数模块：所有判定可离线穷举（与 initiative.js / wake-throttle.js 同一套纪律）。
// 桥接侧只做接线与 LLM 兴趣评估调度；状态迁移决策全部走这里。
//
// 借鉴源：MaiBot HeartFlow（MaiState 全局状态 + 每聊天流三态 + 兴趣驱动）、
// Generative Agents（作息/计划）。此处为 Node 轻量版，无独立协程树，挂桥接调度器。

// ── B1 生活状态机 ───────────────────────────────────────────────────────────
// 四态：sleeping(睡眠) / slacking(摸鱼) / normal(正常) / focused(专注时段)
// 由作息表（小时窗口）+ 可选配置推导；影响主动频率倍率与回复深度提示。

export const LIFE_STATES = ['sleeping', 'slacking', 'normal', 'focused'];

export const LIFE_EFFECTS = Object.freeze({
  sleeping: { proactiveMult: 0, label: '睡眠', depthHint: '你有点困（被吵醒/深夜）：能短则短，语气更松散慵懒，别长篇大论。' },
  slacking: { proactiveMult: 0.7, label: '摸鱼', depthHint: '你正在摸鱼放空：话可以少一点、更随意，不用事事接满。' },
  normal: { proactiveMult: 1, label: '正常', depthHint: '' },
  focused: { proactiveMult: 1.3, label: '专注时段', depthHint: '这是你的专注时段：可以聊得更投入、话题展开更主动。' }
});

// 窗口 [start, end) 支持跨零点（如 [23, 2]）。schedule 缺省值与 loadConfig 保持一致。
export function lifeStateFor(hour, schedule = {}) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const sleepStart = Number.isFinite(Number(schedule.sleepStart)) ? Number(schedule.sleepStart) : 1;
  const sleepEnd = Number.isFinite(Number(schedule.sleepEnd)) ? Number(schedule.sleepEnd) : 8;
  const inWindow = (w) => {
    const s = Number(w?.[0]), e = Number(w?.[1]);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    return s <= e ? (h >= s && h < e) : (h >= s || h < e);
  };
  if (sleepStart !== sleepEnd) {
    const asleep = sleepStart <= sleepEnd ? (h >= sleepStart && h < sleepEnd) : (h >= sleepStart || h < sleepEnd);
    if (asleep) return { state: 'sleeping', label: LIFE_EFFECTS.sleeping.label };
  }
  if (Array.isArray(schedule.focusedWindows) && schedule.focusedWindows.some(inWindow)) {
    return { state: 'focused', label: LIFE_EFFECTS.focused.label };
  }
  if (Array.isArray(schedule.slackingWindows) && schedule.slackingWindows.some(inWindow)) {
    return { state: 'slacking', label: LIFE_EFFECTS.slacking.label };
  }
  return { state: 'normal', label: LIFE_EFFECTS.normal.label };
}

// ── B4 聊天流三态心流 ───────────────────────────────────────────────────────
// absent(没在看) → watering(随便看看) → focused(聊得很投入)
// 升级由兴趣评估（LLM）驱动；降级由连续静默/超时驱动；focused 全局名额上限。

export const HEARTFLOW_STATES = ['absent', 'watering', 'focused'];

export const HEARTFLOW_EFFECTS = Object.freeze({
  absent: { proactiveMult: 0, label: '没在看这个聊天' },
  watering: { proactiveMult: 0.6, label: '随便看看' },
  focused: { proactiveMult: 1.5, label: '聊得很投入' }
});

export const HEARTFLOW_DEFAULTS = Object.freeze({
  focusedCap: 2,          // 全局同时专注的聊天流上限
  silentToAbsent: 5,      // watering 下连续静默 N 次 → absent
  focusedExitSilent: 3,   // focused 下连续静默 N 次 → watering
  focusedIdleMs: 30 * 60 * 1000, // focused 下无新消息超时 → watering
  reentryScore: 0.5,      // absent 重新进入 watering 的兴趣门槛
  focusedScore: 0.75,     // 进入 focused 的兴趣门槛
  evalThrottleMs: 5 * 60 * 1000  // 每流兴趣评估最小间隔（防止每条消息都跑模型）
});

export function normalizeHeartflowConfig(raw = {}) {
  const d = HEARTFLOW_DEFAULTS;
  const num = (v, dv, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dv;
  };
  return {
    focusedCap: Math.floor(num(raw.focusedCap, d.focusedCap, 0, 10)),
    silentToAbsent: Math.floor(num(raw.silentToAbsent, d.silentToAbsent, 1, 50)),
    focusedExitSilent: Math.floor(num(raw.focusedExitSilent, d.focusedExitSilent, 1, 50)),
    focusedIdleMs: num(raw.focusedIdleMs, d.focusedIdleMs, 60 * 1000, 24 * 60 * 60 * 1000),
    reentryScore: num(raw.reentryScore, d.reentryScore, 0, 1),
    focusedScore: num(raw.focusedScore, d.focusedScore, 0, 1),
    evalThrottleMs: num(raw.evalThrottleMs, d.evalThrottleMs, 60 * 1000, 60 * 60 * 1000)
  };
}

// 纯状态迁移。interestScore 为 null 表示「这次没评估」（不算门槛命中，只可能降级）。
export function heartflowTransition({ state, silentCount = 0, idleMs = 0, interestScore = null, focusedCount = 0, ...cfgRaw }) {
  const c = normalizeHeartflowConfig(cfgRaw);
  const cur = HEARTFLOW_STATES.includes(state) ? state : 'watering';
  const silent = Number(silentCount) || 0;
  const want = (interestScore == null || !Number.isFinite(Number(interestScore))) ? null : Math.max(0, Math.min(1, Number(interestScore)));
  if (cur === 'focused') {
    if (silent >= c.focusedExitSilent) return { state: 'watering', changed: true, reason: `连续静默 ${silent} 次` };
    if (Number(idleMs) >= c.focusedIdleMs) return { state: 'watering', changed: true, reason: `超时没动静 ${Math.round(Number(idleMs) / 60000)} 分钟` };
    return { state: cur, changed: false, reason: '' };
  }
  if (cur === 'watering') {
    if (want != null && want >= c.focusedScore && focusedCount < c.focusedCap) {
      return { state: 'focused', changed: true, reason: `兴趣 ${want.toFixed(2)}，且专注名额未满` };
    }
    if (silent >= c.silentToAbsent) return { state: 'absent', changed: true, reason: `连续静默 ${silent} 次` };
    return { state: cur, changed: false, reason: '' };
  }
  // absent：只有兴趣评估够高才重新进入（消息来了但她不想看就继续 absent）
  if (want != null && want >= c.focusedScore && focusedCount < c.focusedCap) {
    return { state: 'focused', changed: true, reason: `兴趣 ${want.toFixed(2)}，直接投入` };
  }
  if (want != null && want >= c.reentryScore) {
    return { state: 'watering', changed: true, reason: `兴趣 ${want.toFixed(2)}，回来看看` };
  }
  return { state: 'absent', changed: false, reason: '' };
}

// ── C 大胆档时机信号（纯计算，喂给概率乘数） ────────────────────────────────

// 群活跃度：最近 windowMs 内非自发消息数 / cap，夹 0~1。
export function groupActivityScore(recent = [], nowMs = Date.now(), windowMs = 10 * 60 * 1000, cap = 20) {
  if (!Array.isArray(recent) || !recent.length) return 0;
  const n = recent.filter((m) => m && !m.isSelf && Number(m.time) && nowMs - Number(m.time) <= windowMs).length;
  return Math.max(0, Math.min(1, n / Math.max(1, cap)));
}

// 话题匹配：今日计划话题出现在最近聊天文本里的比例（简单子串+bigram 容错），夹 0~1。
export function topicMatchScore(recentText = '', topics = []) {
  if (!Array.isArray(topics) || !topics.length) return 0;
  const hay = String(recentText || '');
  if (!hay) return 0;
  const hits = topics.filter((t) => {
    const s = String(t || '').trim();
    if (!s) return false;
    if (hay.includes(s)) return true;
    // 容错：话题里任一 ≥2 字的词片段命中也算（中文无分词的粗匹配）
    const frags = s.split(/[，。,.\s、/|]+/).filter((f) => f.length >= 2);
    return frags.some((f) => hay.includes(f));
  }).length;
  return Math.max(0, Math.min(1, hits / Math.max(1, Math.min(3, topics.length))));
}

// ── B4 兴趣评估 LLM 的 prompt 与解析 ────────────────────────────────────────

export function buildInterestPrompt({ streamLabel = '这个聊天', lifeLabel = '', recentLines = [], planTopics = [] }) {
  const lines = (Array.isArray(recentLines) ? recentLines : []).slice(-20)
    .map((l) => String(l || '').slice(0, 120)).join('\n') || '（最近没有新消息）';
  const topicLine = (Array.isArray(planTopics) && planTopics.length)
    ? `她今天的计划里有这些话题：${planTopics.slice(0, 5).map((t) => String(t).slice(0, 20)).join('；')}\n`
    : '';
  return `你是她的「心流判断器」：只判断她现在想不想参与下面这个聊天，不写台词。\n\n【她的设定】活泼、爱接梗的女仆型 AI 伙伴（哦鲸鲸），有自己的兴趣和情绪，不是客服。\n${lifeLabel ? `【她的生活状态】${lifeLabel}\n` : ''}${topicLine}【聊天：${streamLabel} 的最近内容】\n${lines}\n\n【判断】结合聊天内容与她的性格，给她此刻「想参与这个聊天」的程度打分。\n只输出一行 JSON（不要围栏、不要解释）：{"want": 0到1的小数, "reason": "不超过12字的原因"}\nwant≥0.75 表示很投入；0.5~0.75 随便看看；<0.5 暂时不想参与。`;
}

export function parseInterestResult(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // 容错：剥围栏、取第一个 { 到最后一个 }
  let s = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  else s = s.replace(/^[^{]*([\s\S]*?)[^}]*$/, '$1');
  try {
    const o = JSON.parse(s);
    const want = Number(o?.want);
    if (!Number.isFinite(want)) return null;
    return {
      want: Math.max(0, Math.min(1, want)),
      reason: String(o?.reason ?? '').slice(0, 30)
    };
  } catch { return null; }
}

// 唤醒 prompt 里的心核状态行（B1+B4 对她可见的一行）
export function heartLineFor({ lifeLabel = '', lifeDepthHint = '', heartflowLabel = '', streamLabel = '' }) {
  const bits = [];
  if (lifeLabel) bits.push(`生活状态：${lifeLabel}`);
  if (heartflowLabel) bits.push(`你此刻对这个${streamLabel || '聊天'}：${heartflowLabel}`);
  if (!bits.length) return '';
  let line = `【她的心核状态】${bits.join('；')}\n`;
  if (lifeDepthHint) line += `${lifeDepthHint}\n`;
  return line;
}
