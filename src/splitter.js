// src/splitter.js
// 把 AI 想发的一段话按"人说话的样子"拆成多条短消息，并算出每条之间的发送间隔。
// 纯函数模块：不联网、不读写文件、不看时间、不直接调用 Math.random（只允许出现在默认参数里）。

export const SPLIT_DEFAULTS = Object.freeze({
  maxLen: 25,     // 单条超过这个字数就找地方切
  minLen: 3,      // 短于这个字数的碎片并回上一条
  tailMaxLen: 10, // 尾条（最后一条）尽量不超过这个字数，短尾更像真人
  maxParts: 4,    // 最多几条
  gapMin: 800,    // 相邻两条之间的最小间隔（毫秒）
  gapMax: 1500,   // 最大间隔
  gapCv: 0.35     // 间隔的变异系数（方差要有，不能像机器一样匀速）
});

// 句末标点：优先在这些字符之后切
const SENT_END = new Set(['。', '！', '？', '!', '?', '…', '～', '~']);
// 次级标点：没有句末标点时的退让点
const SECONDARY = new Set(['，', '、', '；', '：', ',', ';', ':']);
// 收尾符号：跟在标点后面时应当粘在前一句上（避免「好。」被切成「好。」+「」」）
const TRAILING = new Set(['）', ')', '」', '』', '】', '》', '〉', '”', '’', '"', "'", '］', ']']);

/** 归一化：非字符串/全空白 → ''；去掉多余空行与行首行尾空白 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, ''))
    .filter((line) => line.length > 0)
    .join('');
}

function resolveOptions(options) {
  const src = options && typeof options === 'object' ? options : {};
  const pick = (key) => (Number.isFinite(src[key]) ? src[key] : SPLIT_DEFAULTS[key]);
  const maxLen = Math.max(1, Math.floor(pick('maxLen')));
  const minLen = Math.max(1, Math.floor(pick('minLen')));
  const tailMaxLen = Math.max(1, Math.floor(pick('tailMaxLen')));
  const maxParts = Math.max(1, Math.floor(pick('maxParts')));
  const gapMin = Math.max(0, Math.round(pick('gapMin')));
  const gapMax = Math.max(gapMin, Math.round(pick('gapMax')));
  const gapCv = Math.max(0, pick('gapCv'));
  return { maxLen, minLen, tailMaxLen, maxParts, gapMin, gapMax, gapCv };
}

/** 先按句末标点切成"句子"，标点（含紧跟的收尾符号）跟着前一句 */
function splitSentences(text) {
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (SENT_END.has(ch)) {
      let j = i + 1;
      while (j < text.length && TRAILING.has(text[j])) {
        buf += text[j];
        j += 1;
      }
      i = j - 1;
      out.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/** 单个过长单元：优先在次级标点后切（切点尽量靠近 maxLen），都没才硬切 */
function splitLongUnit(unit, maxLen, minLen) {
  const out = [];
  let rest = unit;
  while (rest.length > maxLen) {
    let cut = -1;
    for (let i = maxLen - 1; i >= 0; i--) {
      if (SECONDARY.has(rest[i])) {
        cut = i + 1;
        break;
      }
    }
    // 标点太靠前（切出来会比 minLen 还碎）就改成硬切，宁可断在 maxLen 上
    if (cut < minLen) cut = maxLen;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** 贪心装箱：能把下一个单元塞进当前条就塞 */
function packAtoms(atoms, maxLen) {
  const parts = [];
  for (const atom of atoms) {
    if (parts.length === 0) {
      parts.push(atom);
      continue;
    }
    const last = parts[parts.length - 1];
    if (last.length + atom.length <= maxLen) parts[parts.length - 1] = last + atom;
    else parts.push(atom);
  }
  return parts;
}

/** 短于 minLen 的碎片并回上一条（首条则并入下一条）；并回后允许超过 maxLen */
function mergeShortParts(parts, minLen) {
  const out = parts.slice();
  let i = 0;
  while (i < out.length) {
    if (out.length > 1 && out[i].length < minLen) {
      if (i > 0) {
        out[i - 1] = out[i - 1] + out[i];
        out.splice(i, 1);
        i = i - 1;
      } else {
        out[1] = out[0] + out[1];
        out.splice(0, 1);
      }
      continue;
    }
    i += 1;
  }
  return out;
}

/** 超过 maxParts 的部分全部并进最后一条（不丢字） */
function capParts(parts, maxParts) {
  if (parts.length <= maxParts) return parts.slice();
  const head = parts.slice(0, maxParts - 1);
  const tail = parts.slice(maxParts - 1).join('');
  return head.concat([tail]);
}

/** 在尾条内部找一个靠后的标点再切一次，让尾条变短；切不动就算了 */
function shortenTail(parts, opt) {
  const { minLen, tailMaxLen, maxParts } = opt;
  if (parts.length <= 1 || parts.length >= maxParts) return parts.slice();
  const out = parts.slice();
  const last = out[out.length - 1];
  if (last.length <= tailMaxLen) return out;

  const candidates = [];
  for (let p = last.length - 1; p >= 0; p--) {
    const ch = last[p];
    if (!SENT_END.has(ch) && !SECONDARY.has(ch)) continue;
    let cut = p + 1;
    while (cut < last.length && TRAILING.has(last[cut])) cut += 1;
    const rightLen = last.length - cut;
    const leftLen = cut;
    if (rightLen >= minLen && leftLen >= minLen) candidates.push({ cut, rightLen });
  }
  if (candidates.length === 0) return out;

  // 首选"切完尾条就不超过 tailMaxLen"的最后一个切点，否则退而求其次取最后的切点
  const picked = candidates.find((c) => c.rightLen <= tailMaxLen) || candidates[0];
  out[out.length - 1] = last.slice(0, picked.cut);
  out.push(last.slice(picked.cut));
  return out;
}

/**
 * 把一段话拆成 1~maxParts 条短消息。
 * @param {string} text
 * @param {object} [options]
 * @returns {string[]}
 */
export function splitMessage(text, options = {}) {
  const opt = resolveOptions(options);
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];
  // 本来就够短：原样返回 1 条
  if (normalized.length <= opt.maxLen) return [normalized];

  const atoms = [];
  for (const seg of splitSentences(normalized)) {
    if (seg.length <= opt.maxLen) {
      atoms.push(seg);
      continue;
    }
    for (const piece of splitLongUnit(seg, opt.maxLen, opt.minLen)) atoms.push(piece);
  }

  let parts = packAtoms(atoms, opt.maxLen);
  parts = mergeShortParts(parts, opt.minLen);
  parts = capParts(parts, opt.maxParts);
  parts = shortenTail(parts, opt);
  return parts;
}

/**
 * 算相邻两条之间的间隔：先取 gapMin~gapMax 的均值，再叠加 ±(均值*gapCv) 的抖动，最后 clamp 取整。
 * @param {string[]} parts
 * @param {object} [options]
 * @param {() => number} [rand]
 * @returns {number[]} 长度 = parts.length - 1
 */
export function planGaps(parts, options = {}, rand = Math.random) {
  const rnd = typeof rand === 'function' ? rand : Math.random;
  if (!Array.isArray(parts) || parts.length < 2) return [];
  const opt = resolveOptions(options);
  const span = opt.gapMax - opt.gapMin;
  const gaps = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const mean = opt.gapMin + rnd() * span;
    const jitter = mean * opt.gapCv * (rnd() * 2 - 1);
    let gap = Math.round(mean + jitter);
    if (gap < opt.gapMin) gap = opt.gapMin;
    if (gap > opt.gapMax) gap = opt.gapMax;
    gaps.push(gap);
  }
  return gaps;
}

/**
 * 一步到位：拆句 + 安排间隔。
 * @param {string} text
 * @param {object} [options]
 * @param {() => number} [rand]
 * @returns {{parts: string[], gaps: number[], chars: number, tailLen: number}}
 */
export function planSend(text, options = {}, rand = Math.random) {
  const parts = splitMessage(text, options);
  const gaps = planGaps(parts, options, rand);
  let chars = 0;
  for (const p of parts) chars += p.length;
  const tailLen = parts.length > 0 ? parts[parts.length - 1].length : 0;
  return { parts, gaps, chars, tailLen };
}

/**
 * 汇总统计：samples 可以是 planSend 的返回值，也可以是 string[]。
 * @param {Array<{parts?: string[], gaps?: number[]}|string[]>} samples
 * @returns {{n:number, 平均条数:number, 单条最长:number, 单条最短:number, 尾条均值:number, 平均间隔:number, 间隔标准差:number}}
 */
export function splitStats(samples) {
  const empty = { n: 0, 平均条数: 0, 单条最长: 0, 单条最短: 0, 尾条均值: 0, 平均间隔: 0, 间隔标准差: 0 };
  if (!Array.isArray(samples) || samples.length === 0) return empty;

  let n = 0;
  let countSum = 0;
  let longest = 0;
  let shortest = Infinity;
  let tailSum = 0;
  let gapSum = 0;
  let gapN = 0;
  const gapValues = [];

  for (const sample of samples) {
    let parts = null;
    let gaps = [];
    if (Array.isArray(sample)) {
      parts = sample;
    } else if (sample && typeof sample === 'object' && Array.isArray(sample.parts)) {
      parts = sample.parts;
      if (Array.isArray(sample.gaps)) gaps = sample.gaps;
    }
    if (!parts || parts.length === 0) continue;

    n += 1;
    countSum += parts.length;
    for (const p of parts) {
      const len = typeof p === 'string' ? p.length : 0;
      if (len > longest) longest = len;
      if (len < shortest) shortest = len;
    }
    const tail = parts[parts.length - 1];
    tailSum += typeof tail === 'string' ? tail.length : 0;
    for (const g of gaps) {
      if (!Number.isFinite(g)) continue;
      gapSum += g;
      gapN += 1;
      gapValues.push(g);
    }
  }

  if (n === 0) return empty;
  const meanGap = gapN > 0 ? gapSum / gapN : 0;
  let variance = 0;
  if (gapValues.length > 0) {
    for (const g of gapValues) variance += (g - meanGap) * (g - meanGap);
    variance /= gapValues.length;
  }

  return {
    n,
    平均条数: countSum / n,
    单条最长: longest,
    单条最短: shortest === Infinity ? 0 : shortest,
    尾条均值: tailSum / n,
    平均间隔: meanGap,
    间隔标准差: Math.sqrt(variance)
  };
}
