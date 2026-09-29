// 「AI 腔」离线检测（纯函数）
//
// 背景：哦鲸鲸是个软萌小女仆，在 QQ 群里跟人聊天。她偶尔会露出 AI 腔：
// 过渡词堆砌（此外 / 值得注意的是）、句子长度齐整得像作文、书面语（深耕 / 赋能 / 闭环）、
// 客服收尾（还有什么可以帮到您）、Markdown 格式（**加粗**、`代码`、- 列表）、总分总排比。
// 群里的人一眼就能看出「这是机器人」——这比偶尔说错话更伤。
//
// 本模块只回答一个问题：**这段待发文本有多像 AI 写的**。
// 它只做检测与打分：不改文本、不发网络请求、不读写任何文件、不看时间。
// 是否让她重说一遍由上层（桥接）决定 —— 这里只给出 score 与人话理由（reasons）。
//
// 抽成纯函数的理由和 src/wake-throttle.js 一样：只有纯函数才能在离线测试里穷举边界，
// 否则唯一的验证方式就是拿真群去撞（见 ops/test-deai.mjs 头部的说明）。
//
// ── 打分规则（改这里就必须同步改 ops/test-deai.mjs）────────────────────
//   1) 词命中加分：transition +8 / buzzword +12 / service +12 / essay +6 / refuse +25
//      同一个词出现几次就算几次（「此外……此外」= 16 分）。
//   2) 句长齐整加成：句子 >= 3 句、且变异系数 lengthJitter < 0.25 → +15
//      （AI 最大的破绽不是用词，是**每句都差不多长**：15~25 字、四平八稳）
//   3) Markdown 痕迹每处 +10（kind 记为 markdown，词表里放在 format 类）。
//   4) 同一 index 上命中多个词只算一次（取权重更高的那一类）——
//      「综上所述」同时躺在 transition 与 essay 两张表里，不能既算 8 又算 6。
//   5) 总分封顶 100，取整数。
//
// 注意：**分数不能当判决用**。它是给上层的「要不要重说一遍」的提示，
// 阈值默认为 40（shouldRephrase），而短消息一律放过 —— 群里「哈哈哈」不需要被重写。

// ── 词表 ────────────────────────────────────────────────────────────────
// 六类。前五类是真正会被逐词扫描的中文词表（每类 >= 6 个词）；
// format 类放的是 Markdown 记号，不按 indexOf 扫词，而是由 markdownHits() 按行/记号规则匹配，
// 命中后 kind 统一记为 'markdown'（见 shouldRephrase 上方的说明与 ops/test-deai.mjs T4.2）。
export const AI_TONE_WORDS = Object.freeze({
  // 过渡词/连词滥用：书面连接词出现在 QQ 口语里，是最典型的机器味
  transition: Object.freeze([
    '此外', '然而', '值得注意的是', '综上所述', '总而言之', '客观来说',
    '值得一提的是', '与此同时', '因此', '综上'
  ]),
  // AI 铁证级空话：这些话单个拎出来都不通顺，连在一起就成了汇报稿
  buzzword: Object.freeze([
    '赋能', '深耕', '聚焦', '助力', '打造', '引领',
    '闭环', '抓手', '底层逻辑', '顶层设计', '全方位', '多维度'
  ]),
  // 客服/助手腔：对着主人说「请问您」「感谢您的」，身份就穿帮了
  service: Object.freeze([
    '亲', '请问您', '希望能帮到你', '还有什么可以帮到您', '如有需要', '感谢您的', '建议您'
  ]),
  // 作文腔/总分总：排比与总分总是最容易被认出来的结构痕迹
  essay: Object.freeze([
    '首先', '其次', '最后', '第一', '第二', '综上所述', '不仅', '而且', '总而言之'
  ]),
  // 官方拒答腔 —— 这一项最要紧：群里最不能出现的就是「作为 AI，我不能讨论」
  refuse: Object.freeze([
    '我不能讨论', '作为 AI', '作为一个 AI', '建议你咨询专业人士', '我无法提供',
    '不适合讨论', '我建议你', '请注意甄别', '理性看待'
  ]),
  // Markdown 记号（不是中文词表，故不足 6 个）：**加粗、`行内代码、- 列表行、# 标题行
  format: Object.freeze(['**', '`', '- ', '#'])
});

// 每类的分值。key 是 kind（format 类命中后记为 markdown，所以这里没有 format）。
const SCORE_WEIGHTS = Object.freeze({
  transition: 8,
  buzzword: 12,
  service: 12,
  essay: 6,
  refuse: 25,
  markdown: 10
});

// kinds 的中文名，用于 reasons（人话说明）。顺序即 reasons 的输出顺序：越像 AI 的排越前。
const KIND_LABELS = Object.freeze({
  refuse: '官方拒答腔',
  service: '客服腔',
  buzzword: 'AI 空话',
  transition: '过渡词',
  essay: '作文腔',
  markdown: 'Markdown 痕迹'
});
const REASON_ORDER = Object.freeze(['refuse', 'service', 'buzzword', 'transition', 'essay', 'markdown']);

const MAX_SCORE = 100;        // 分数上限
const JITTER_FLAT_MAX = 0.25; // 低于这个变异系数就算「句子长度过于齐整」
const JITTER_MIN_SENTENCES = 3; // 少于 3 句谈不上「齐整」
const JITTER_BONUS = 15;
const MARKDOWN_BONUS = 10;

// 句末标点（中文全角 + 英文半角）。分号也算：AI 的长句常常用分号硬连。
const SENTENCE_ENDERS = '。！？!?；;…';
const WHITESPACE_RE = /\s/;
const DIGIT_RE = /[0-9]/;

// i 位置是不是句末。ASCII 句点要特判：'3.14'、'版本 1.2' 这种不能断句（小数/版本号在群里很常见）。
function isSentenceEndAt(chars, i) {
  const ch = chars[i];
  if (SENTENCE_ENDERS.includes(ch)) return true;
  if (ch === '.') {
    const prev = i > 0 ? chars[i - 1] : '';
    const next = i + 1 < chars.length ? chars[i + 1] : '';
    return !(DIGIT_RE.test(prev) && DIGIT_RE.test(next));
  }
  return false;
}

/**
 * 按中英文句末标点切句，返回每句的「有效字数」。
 * - 空白（空格/换行/Tab）不计入字数：「你好    世界。」是 4 个字。
 * - 按**码点**计数，所以 emoji 算 1 个字（🐳🐳好 → 3），不会因为代理对变成 2。
 * - 空句（连续标点、开头就是标点）忽略：「。。。？？」→ []。
 * - 末尾没有句末标点的残句照算一句：「今天天气不错」→ [6]。
 * - 非字符串输入（null / undefined / 数字）按 String() 处理，不抛异常。
 * @param {string} text
 * @returns {number[]}
 */
export function sentenceLengths(text) {
  const chars = Array.from(String(text ?? ''));
  const out = [];
  let buf = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (isSentenceEndAt(chars, i)) {
      if (buf > 0) out.push(buf);
      buf = 0;
      continue;
    }
    if (!WHITESPACE_RE.test(chars[i])) buf += 1;
  }
  if (buf > 0) out.push(buf);
  return out;
}

/**
 * 句长变异系数 = 标准差 / 均值。
 * 齐整句（[20,20,20,20]）→ 0；长短交替（[2,30,2,30]）→ 0.875。
 * 少于 2 个有效长度、或均值为 0（全是空句/全是 0）时返回 0 —— 不返回 NaN，调用方不必再判。
 * 脏数据（NaN / 字符串数字以外的值）先过滤；过滤后不足 2 个同样返回 0。
 * @param {number[]} lengths
 * @returns {number}
 */
export function lengthJitter(lengths) {
  if (!Array.isArray(lengths)) return 0;
  const vals = [];
  for (const v of lengths) {
    const n = Number(v);
    if (Number.isFinite(n)) vals.push(n);
  }
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (!(mean > 0)) return 0;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance) / mean;
}

// 逐词扫描：每个词的**每一次**出现都算一条命中（index 为在原文中的下标）。
// from = index + 1 而不是 index + word.length：允许重叠匹配，
// 中文里「此外此外」这种复读机式排比应该被算两次，这正是要抓的东西。
function wordHits(text) {
  const hits = [];
  for (const kind of Object.keys(AI_TONE_WORDS)) {
    if (kind === 'format') continue; // format 不按词扫，交给 markdownHits
    const words = AI_TONE_WORDS[kind];
    for (const word of words) {
      if (typeof word !== 'string' || word.length === 0) continue;
      let from = 0;
      for (;;) {
        const index = text.indexOf(word, from);
        if (index < 0) break;
        hits.push({ word, kind, index });
        from = index + 1;
      }
    }
  }
  return hits;
}

// Markdown 痕迹：** 与 ` 出现几次算几处；`- `（连字符+空格）与 `#` 只认**行首**。
// 用 lastIndex 自增防零宽死循环（这几个正则都非零宽，属于防御性写法）。
function markdownHits(text) {
  const hits = [];
  for (const re of [/\*\*/g, /`/g, /^- /gm, /^#/gm]) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      hits.push({ word: m[0], kind: 'markdown', index: m.index });
      if (re.lastIndex === m.index) re.lastIndex += 1;
      m = re.exec(text);
    }
  }
  return hits;
}

// 同一 index 只留一条（取权重更高的那一类；权重相同留先遇到的那条）。
// 这是「同一位置命中多个词不重复计数」的实现，专治 综上所述 / 总而言之 这类双表词。
function dedupeByIndex(hits) {
  const byIndex = new Map();
  for (const h of hits) {
    const prev = byIndex.get(h.index);
    if (prev === undefined || (SCORE_WEIGHTS[h.kind] ?? 0) > (SCORE_WEIGHTS[prev.kind] ?? 0)) {
      byIndex.set(h.index, h);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * 扫描「AI 腔」特征。
 * @param {string} text 待发文本（不会被修改）
 * @returns {{ hits: Array<{word: string, kind: string, index: number}>, score: number, reasons: string[] }}
 *   hits    按 index 升序；kind 为分类名（transition/buzzword/service/essay/refuse/markdown）
 *   score   0~100 的整数，越高越像 AI
 *   reasons 人话说明，例如「出现 3 个过渡词」「句子长度过于齐整（4 句，变异系数 0.08）」
 */
export function scanAiTone(text) {
  const s = String(text ?? '');
  const hits = dedupeByIndex([...wordHits(s), ...markdownHits(s)]);

  const counts = new Map();
  const wordsOf = new Map();
  let score = 0;
  for (const h of hits) {
    counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
    if (!wordsOf.has(h.kind)) wordsOf.set(h.kind, []);
    wordsOf.get(h.kind).push(h.word);
    score += SCORE_WEIGHTS[h.kind] ?? 0;
  }

  const reasons = [];
  for (const kind of REASON_ORDER) {
    const n = counts.get(kind) ?? 0;
    if (n === 0) continue;
    const uniq = [...new Set(wordsOf.get(kind) ?? [])];
    const label = KIND_LABELS[kind];
    if (kind === 'markdown') {
      reasons.push(`带 Markdown 痕迹 ${n} 处：${uniq.join(' ')}`);
    } else if (kind === 'refuse') {
      // 拒答腔单独标出来：它出现一次就足够穿帮，不像过渡词可以靠数量堆
      reasons.push(`出现 ${n} 个「${label}」（最要紧）：${uniq.join('、')}`);
    } else {
      // 用「」括住分类名：不然「AI 空话」这类夹了半角字符的标签会和前面的量词连成一串
      reasons.push(`出现 ${n} 个「${label}」：${uniq.join('、')}`);
    }
  }

  // 句长齐整加成：AI 的破绽是「每句都差不多长」，不是某一句太长
  const lengths = sentenceLengths(s);
  const jitter = lengthJitter(lengths);
  if (lengths.length >= JITTER_MIN_SENTENCES && jitter < JITTER_FLAT_MAX) {
    score += JITTER_BONUS;
    reasons.push(`句子长度过于齐整（${lengths.length} 句，变异系数 ${jitter.toFixed(2)}）`);
  }

  if (reasons.length === 0) reasons.push('未发现明显的 AI 腔特征');
  return { hits, score: Math.min(MAX_SCORE, Math.round(score)), reasons };
}

/**
 * 要不要让她把这句话重说一遍。
 * - 太短不重说：trim 后的字符数 < minLength 直接 false（「哈哈哈哈」「好耶」不需要被重写）。
 * - 只有 score **严格大于** maxScore 才重说（等于阈值算通过，边界行为写死在测试里）。
 * @param {string} text
 * @param {{maxScore?: number, minLength?: number}} [options]
 * @returns {boolean}
 */
export function shouldRephrase(text, { maxScore = 40, minLength = 12 } = {}) {
  const s = String(text ?? '').trim();
  if (s.length < Number(minLength)) return false;
  return scanAiTone(s).score > Number(maxScore);
}
