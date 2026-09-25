// 好感度双维度模型（P1-4）——纯函数，无副作用。
//
// 为什么单独成模块：
//   双维度的边界值（熟识度封顶、让步判定误伤、周末跨天）如果埋在 main() 闭包里，
//   就只能靠「跟真人聊一周」来验证；抽出来可以离线穷举，也不会波及正在跑的会话。
//
// 模型来源：zaofan v1.5.1（见 docs/upgrade-plan-2026-09.md §P1-4）
//   · 熟识度 = 她把你记得多牢 —— **慢变量，客观自动算**（来过几天/说过多少/被点名），只增不减。
//   · 好感度 = 她对你什么态度 —— 随互动可升可降，由 AI 自己用 qq_affinity 更新。
//   · 判定读「思考（内心）」与「正文（说出口）」的落差：**心里不肯但话仍照顾 = 让步**。
//
// 🚫 红线（照搬 zaofan，代码与提示词里都要写死）：
//   **低好感只允许降低「她愿不愿意自己开口」的频率，绝不允许改变语气。**
//   也就是说 score 唯一的消费点是 affinityBoostFromScores（主动概率乘数），
//   不许出现在任何影响措辞、回复长度、称呼、是否回复的分支里。
//   禁止冷落、阴阳、攻击 —— 负好感也只有「少主动」这一个后果。

// ── 熟识度 ────────────────────────────────────────────────────────────────────
// 三档满分合计 100，各自独立封顶：任何单一维度刷满也到不了「自己人」，
// 必须真的处得久（天数）且聊得多（条数）且被记得（点名）。
export const FAM_DAYS_FULL = 20;          // 20 个活跃日 → 40 分
export const FAM_INTERACTIONS_FULL = 80;  // 80 条消息   → 40 分
export const FAM_MENTIONS_FULL = 10;      // 被点名 10 次 → 20 分
export const FAM_MAX = 100;

const clampNum = (n, lo, hi, dflt = 0) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
};

/**
 * 由客观统计量算熟识度。
 * 单调不减（输入只增，输出不减），因此熟识度天然「只增不减」——吵架不会让她忘了你。
 * @returns {{familiarity:number, parts:{days:number,interactions:number,mentions:number}}}
 */
export function familiarityFromStats({ activeDays = 0, interactions = 0, mentions = 0 } = {}) {
  const d = clampNum(activeDays, 0, 1e9);
  const i = clampNum(interactions, 0, 1e9);
  const m = clampNum(mentions, 0, 1e9);
  const parts = {
    days: Math.round((Math.min(d, FAM_DAYS_FULL) / FAM_DAYS_FULL) * 40),
    interactions: Math.round((Math.min(i, FAM_INTERACTIONS_FULL) / FAM_INTERACTIONS_FULL) * 40),
    mentions: Math.round((Math.min(m, FAM_MENTIONS_FULL) / FAM_MENTIONS_FULL) * 20),
  };
  const familiarity = Math.max(0, Math.min(FAM_MAX, parts.days + parts.interactions + parts.mentions));
  return { familiarity, parts };
}

const FAM_TIERS = [
  { min: 80, key: 'inner', label: '自己人' },
  { min: 60, key: 'old', label: '老友' },
  { min: 40, key: 'acquainted', label: '熟人' },
  { min: 20, key: 'familiar', label: '眼熟' },
  { min: 0, key: 'stranger', label: '陌生' },
];

export function familiarityTier(familiarity) {
  const f = clampNum(familiarity, 0, FAM_MAX);
  return FAM_TIERS.find((t) => f >= t.min) ?? FAM_TIERS[FAM_TIERS.length - 1];
}

const AFF_TIERS = [
  { min: 40, key: 'intimate', label: '亲密' },
  { min: 10, key: 'close', label: '亲近' },
  { min: -9, key: 'neutral', label: '中性' },
  { min: -39, key: 'cold', label: '冷淡' },
  { min: -100, key: 'distant', label: '疏离' },
];

export function affinityTier(score) {
  const s = clampNum(score, -100, 100);
  return AFF_TIERS.find((t) => s >= t.min) ?? AFF_TIERS[AFF_TIERS.length - 1];
}

/** 本地日是否变了（用于「来过几天」的累计；必须传本地日键，不能用 toISOString） */
export function isNewActiveDay(lastDay, today) {
  const a = String(lastDay ?? '').trim();
  const b = String(today ?? '').trim();
  return !!b && a !== b;
}

// ── 主动概率乘数（好感度**唯一**的消费点）─────────────────────────────────────
export const BOOST_MAX = 0.4;   // 满分好感最多 +40%
export const BOOST_MIN = -0.3;  // 负好感最多 -30%，只影响「她愿不愿意自己开口」

/**
 * 由一组好感分算主动概率乘数。
 * 与旧版差别：旧版**只统计正分**、全是负分时返回 1（等于负好感毫无后果）；
 * 现在负分也算，但下限锁在 0.7 —— 红线要求「负好感也只是少主动」。
 */
export function affinityBoostFromScores(scores = []) {
  const nums = (Array.isArray(scores) ? scores : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return 1;
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return 1 + Math.max(BOOST_MIN, Math.min(BOOST_MAX, avg / 250));
}

// ── 让步判定（轻量一致性检查，规则优先、保守）────────────────────────────────
// reserved2 下她的文本本来就不自动转发，所以「内心」通道天然存在：
// 每轮结束时 bridge 拿得到内部输出全文（日志里的「AI 内部输出（不自动转发）」），
// 再比对这一轮真正发出去的消息 —— zaofan 要专门接小模型读的东西我们白捡。
//
// 保守原则：**两边都命中才算一次让步**，且只扣 1 分、每天最多 2 次。
// 误判会伤关系，所以宁可漏判。
export const CONCESSION_DELTA = -1;
export const CONCESSION_DAILY_CAP = 2;

const NEG_PATTERNS = [
  /不想(理|聊|说|回)/, /懒得(理|说|回|搭理)/, /烦(死|人|欸|哎)/, /无语/, /哼[，。！!~～]?$/,
  /才不(要|想|理)/, /关我(什么|啥)事/, /随便吧/, /敷衍/, /没(兴趣|心情)/, /别烦我/, /不想搭腔/,
];

const FRIENDLY_PATTERNS = [
  /[呀啦噢哦嘛诶~～]/, /哈哈/, /嘿嘿/, /抱抱|摸摸|贴贴|蹭蹭|亲亲/i, /乖/, /想你/, /晚安|早安|午安/,
  /谢谢|辛苦|厉害|好看|可爱/, /[😊🥰😘😍🤗❤️💕🙈🌸✨]/u,
];

/** 内部输出里是否出现明显的负面/抗拒信号 */
export function hasNegativeSignal(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return NEG_PATTERNS.some((re) => re.test(s));
}

/** 发出去的正文里是否有友好信号 */
export function hasFriendlySignal(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return FRIENDLY_PATTERNS.some((re) => re.test(s));
}

/**
 * 判定一次让步：**心里不肯、话仍照顾**。
 * @param {string} internalText 本轮 AI 内部输出全文
 * @param {string[]} publicTexts 本轮真正发出去的消息（可能为空 = 她没说话）
 */
export function detectConcession(internalText, publicTexts = []) {
  const list = Array.isArray(publicTexts) ? publicTexts : (publicTexts == null || publicTexts === '' ? [] : [publicTexts]);
  const texts = list.map((t) => String(t ?? '')).filter(Boolean);
  const neg = hasNegativeSignal(internalText);
  const friendly = texts.some((t) => hasFriendlySignal(t));
  const concession = neg && friendly;
  return { concession, neg, friendly, delta: concession ? CONCESSION_DELTA : 0 };
}

/** 让步判定的开关（默认开；socialV2.affinity.concessionDetect === false 可关断） */
export function concessionDetectEnabled(raw) {
  return raw !== false;
}

/** 跨天滚动：不是同一天就把当日计数归零。必须传本地日键。 */
export function concessionRollover(lastDay, today, usedToday) {
  const same = String(lastDay ?? '').trim() === String(today ?? '').trim();
  return { day: String(today ?? '').trim(), used: same ? clampNum(usedToday, 0, 1e9) : 0 };
}

export function concessionAllowed(usedToday, cap = CONCESSION_DAILY_CAP) {
  const c = clampNum(cap, 0, 1e9, CONCESSION_DAILY_CAP);
  return clampNum(usedToday, 0, 1e9) < c;
}

// ── 提示词注入 ───────────────────────────────────────────────────────────────
/** 给某个人生成一行关系描述（熟识度写进去，让她演得有据） */
export function relationLine({ name = '', uid = '', score = 0, familiarity = 0, activeDays = 0, interactions = 0, notes = '', profile = '' } = {}) {
  const at = affinityTier(score);
  const ft = familiarityTier(familiarity);
  const stats = familiarity > 0 || activeDays > 0
    ? `熟识度 ${familiarity}（${ft.label}，认识 ${Number(activeDays) || 0} 天、说过 ${Number(interactions) || 0} 句）`
    : '熟识度 0（新面孔）';
  const who = `${String(name || uid)}${uid ? `(${uid})` : ''}`;
  const tail = [String(notes ?? '').slice(0, 60), String(profile ?? '')].filter(Boolean).join('｜');
  return `- ${who}：好感度 ${Math.round(Number(score) || 0)}（${at.label}），${stats}${tail ? '，' + tail : ''}`;
}

/** 注入块尾部的红线说明：低好感**只**降主动频率 */
export const AFFINITY_REDLINE_NOTE = '（对高分的人毒舌/撒娇可以更放肆，对 0 分或负分的人礼貌但有距离；互动后有变化就用 qq_affinity 更新。⚠️ 低好感只影响你「愿不愿意自己主动开口」，**绝不改变语气**：不冷落、不阴阳、不攻击，照常礼貌对待）';
