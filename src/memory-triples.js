// 记忆三元组引擎（阶段 5）：把长期记忆从「一句话 facts」升级成 (subject, predicate, object) + 时序。
//
// 设计取舍（为什么这么写）：
// 1) **纯函数 + 时间注入**：模块内不调用 Date.now()、不读文件、不随机。所有时间都由调用方传 nowMs。
//    理由：这套东西要能离线穷举测试（ops/test-memory-triples.mjs 全文不需要等真实时间流逝），
//    而且桥接重启/回放历史记忆时能给出与当时一致的分数——分数可复现，调参才有意义。
// 2) **冲突消解走 Mem0 式「同槽覆盖」**：一个人对同一 predicate 通常只有一个当前状态。
//    新事实与旧事实的 object 词面很接近（≥ 阈值）说明是同一件事的修正（「喜欢美式」→「喜欢冰美式」），
//    这时把旧条 validToMs 打上失效戳、新条接上；只有 object 明显是另一件事（相似度低）才两条并存。
//    这样既不丢历史（旧条还在，只标记失效），也不会让「她」同时记住互相矛盾的两句话。
// 3) **失效不是删除**：retrieval 时对 validToMs !== null 的条目乘 0.3，而不是过滤掉。
//    理由：跨会话回放时，用户可能在问「你以前不是喜欢 X 吗」，完全抹掉会让历史不可解释；
//    乘 0.3 让它在正常召回里让位、但在明确问旧事时仍可能被捞出来。
// 4) **相似度用词面重合**：中英混排都必须能用，且不许引依赖，所以只用字符/二元/整词三层 Jaccard。
//    权重与阈值见 TRIPLE_CONSTANTS，全部导出成一个 Object.freeze 对象，方便以后统一调参。

export const TRIPLE_VERSION = 1;

/** 模块所有可调常量集中在这里（冻结，防止调用方误改全局行为）。 */
export const TRIPLE_CONSTANTS = Object.freeze({
  version: TRIPLE_VERSION,

  // ── 相似度（similarity）──
  // 三层加权求和的权重，和为 1。为什么是这三层：
  //   字符层 0.35：中文短词（「拿铁」 vs「拿铁加糖」）只有靠字面才抓得住；
  //   二元层 0.45：中文语序与长词的主要证据层（「一只叫豆豆的橘猫」 vs「一只叫豆豆的猫」靠它拿到 0.65）；
  //   整词层 0.20：英文/数字按整词，避免 "cod" 与 "codfishing" 被字符层误判为同义。
  // 权重取值经离线标定（见 ops/test-memory-triples.mjs T2 的实测边界值注释），不是拍脑袋。
  similarityWeights: Object.freeze({ char: 0.35, bigram: 0.45, word: 0.2 }),
  // 0.6 是标定出来的分界线（见 ops/test-memory-triples.mjs T2/T6 的实测值）：
  //   边界扩展类修正句（无糖冰美式 → 无糖冰美式咖啡）经 edgeBoost 后 0.6875，**过线**（严格大于 0.6）；
  //   真·不同事物（美式咖啡 / 美式冰咖啡 = 0.46，拿铁 / 加糖拿铁 = 0.4062）落在阈值下，不会被合并。
  // 已知边界（刻意不修的取舍，别当成 bug 去调权重）：**更短的**加后缀对「冰美式 → 冰美式咖啡」只有 0.5438，
  // 落在阈值下 → 这种改口不会自动覆盖，会变成两条并存。原因：短句加字时 charJaccard 只有 0.6、bigram 0.5，
  // 加权后 0.435，即便乘 1.25 也只有 0.5438；而「加几个字」和「换一件事」在这么短的字面上本来就不可靠区分。
  // 调低阈值到 0.54 会把「美式咖啡 / 美式冰咖啡」这类不同事物也合并掉，代价比收益大，
  // 所以这类改口由调用方显式指定失效（见 ops/test-memory-triples.mjs T7 的说明）。
  // 调低会把「咖啡 vs 拿铁」这类不同事物合并成一条；调高会让（本来能过的）修正句变成两条并存。
  similarityThreshold: 0.6,
  // 边界扩展加成：短句是长句前缀/后缀时 ×1.25（理由见 similarity() 里的说明）。
  similarityEdgeExtensionBoost: 1.25,

  // ── 检索打分（scoreTriple）──
  // 公式权重：匹配分是主项（检索的本职），新鲜度次之（Generative Agents 的指数衰减），
  // 重要度再次（人工/模型标注的重要事实优先），访问次数只做轻微加成（避免热门条目垄断召回）。
  scoreWeights: Object.freeze({ match: 0.5, freshness: 0.25, importance: 0.15, access: 0.1 }),
  // 访问次数的饱和尺度：log1p(accessCount)/3，accessCount=19 时逼近 1（再点也没什么增量）。
  accessSaturation: 3,
  // Stanford Generative Agents 的经典衰减底数：每小时 ×0.995（半天约 -11%，一周约 -57%）。
  freshnessDecayPerHour: 0.995,
  // 失效条目保留 30% 分数（见文件头第 3 条取舍），不直接归零。
  staleScoreMultiplier: 0.3,
  // 同一说话人提到的事实加成：她说自己/当事人亲口说的记忆，比旁人转述的更可信。
  sameSpeakerMultiplier: 1.2,
  // 匹配分下限（scoreTriple 裸调用时的默认）：查询与条目毫无词面重合时给 0.35 而不是 0。
  // 为什么不是 0：那个 0.5 权重项一旦归零，弱相关的候选会被全局压死，
  // 结果就是「问什么都想不起来」；给个下限保证召回里始终有可解释的候选。
  matchFloor: 0.35,
  // 召回专用下限：recallTriples 内部把匹配分抬得更高。
  // 理由：0.35 的下限会让「完全无关」和「部分相关」只差 0.2 出头，
  // 而重要度+新鲜度两项合计 0.4，足以让一条毫不相干的记忆靠「重要 + 新鲜」挤掉正确答案。
  // 把下限提到 0.6，等于规定「想进召回榜，至少得有明确的词面重合」。
  recallMatchFloor: 0.6,
  // 打分时把 lastAccessMs 视作「至少访问过一次」的保底：访问次数为 0 时用 validFromMs。
  // （访问次数 0 不代表「从没被用过」，只代表「还没通过 upsert 累加过」。）
  minimumAccessCount: 0,

  // ── 打分→排序 ──
  // 同分时的 tie-break：先用 accessCount（更常用的优先），仍同分再用 id 字典序，
  // 保证 **同分不乱序**（排序稳定性靠代码里的原始下标，不依赖 Array.prototype.sort 的实现细节）。
  // 分数比较容差：浮点尾差不算不同分。
  scoreEpsilon: 1e-9,

  // ── 默认值 ──
  defaultImportance: 1,
  maxImportance: 5,
  minImportance: 0,
  defaultRecallLimit: 10,
  maxTextLength: 120,
  maxSourceLength: 200,
  maxIdLength: 80,
});

const C = TRIPLE_CONSTANTS;

// 生成 id 用的模块级单调计数器。注意：它只在**没有**注入 id/random 时递增，
// 不影响任何与时间/随机相关的语义；同一个进程内重复调用也能拿到不同 id。
let idSeq = 0;

/** 中英文混排切词：拉丁字母/数字按连续段整体成词，CJK 整段成词（CJK 内部无空格边界，拆字交给字符/二元层）。 */
const TOKEN_RE = /[A-Za-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const CJK_ONLY_RE = /^[\u3400-\u4dbf\u4e00-\u9fff]+$/;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function safeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** 清洗文本字段：去首尾空白 + 折内部换行 + 限长（防止模型把整段摘要塞进 object）。 */
function cleanText(value, maxLen = C.maxTextLength) {
  const s = safeString(value).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** 小写化的词面归一（只用于比对，不写回数据）。 */
function foldText(value) {
  return cleanText(value).toLowerCase();
}

function finiteOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 夹到 [lo, hi]；非数字一律返回 lo（脏数据不许产生 NaN）。 */
function clampNumber(value, lo, hi, fallback = lo) {
  const n = finiteOr(value, fallback);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function tokensOf(text) {
  return foldText(text).match(TOKEN_RE) ?? [];
}

/** 字符集合：CJK 逐字（英文不进这层，英文的可比性交给整词层）。 */
function charSetOf(text) {
  const set = new Set();
  for (const tk of tokensOf(text)) {
    if (!CJK_RE.test(tk)) continue;
    for (const ch of tk) set.add(ch);
  }
  return set;
}

/** 二元集合：CJK 相邻两字；单字词自成一个 bin（否则「猫」这种单词会被整层忽略）。 */
function bigramSetOf(text) {
  const set = new Set();
  for (const tk of tokensOf(text)) {
    if (!CJK_RE.test(tk)) continue;
    if (tk.length === 1) { set.add(tk); continue; }
    for (let i = 0; i < tk.length - 1; i += 1) set.add(tk.slice(i, i + 2));
  }
  return set;
}

/**
 * 整词集合：拉丁/数字按整词；CJK 段也整体成词。
 * 注意：CJK **不设长度上限**——「无糖冰美式」这类 5 字词一旦被丢掉，
 * 整词层就只剩字符层在干活，实测相似度会整体低 0.03~0.08（真·同义改写会被压到阈值下），
 * 这是标定阶段踩到的坑，别再加长度上限。
 */
function wordSetOf(text) {
  const set = new Set();
  for (const tk of tokensOf(text)) set.add(tk);
  return set;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function idFromRandom(rand, nowMs) {
  const r = typeof rand === 'function' ? Number(rand()) : NaN;
  const base = Number.isFinite(r) ? Math.floor(Math.abs(r) * 0x100000000) : 0;
  const t = Math.floor(finiteOr(nowMs, 0));
  return `t-${t.toString(36)}-${base.toString(36)}`;
}

/**
 * 新建一条三元组。时间由 nowMs 注入（模块自己不看时钟）；id 可由 id/random 注入，
 * 都没给就用「nowMs + 进程内单调计数」生成——保证同一进程内不重复，且测试可复现。
 */
export function newTriple({ subject, predicate, object, speakerId, importance, nowMs, source, id, random } = {}) {
  const now = finiteOr(nowMs, 0);
  idSeq += 1;
  const rawId = cleanText(id, C.maxIdLength);
  const finalId = rawId || (typeof random === 'function' ? idFromRandom(random, now) : `t-${Math.floor(now).toString(36)}-${idSeq.toString(36)}`);
  return {
    id: finalId,
    subject: cleanText(subject),
    predicate: cleanText(predicate),
    object: cleanText(object),
    speakerId: cleanText(speakerId, C.maxIdLength),
    importance: clampNumber(importance, C.minImportance, C.maxImportance, C.defaultImportance),
    validFromMs: now,
    validToMs: null,
    accessCount: C.minimumAccessCount,
    lastAccessMs: now,
    source: cleanText(source, C.maxSourceLength),
    v: TRIPLE_VERSION,
  };
}

/**
 * 脏数据归一：任何非法输入返回 null（调用方 filter 掉），绝不抛异常。
 * 判定「无意义」的标准：subject/predicate/object 三者缺任一，或 id 归一后为空。
 * 时间字段只做「有限数」校正：NaN/Infinity/字符串 → 退回 0 或 null，不允许出现 NaN。
 */
export function normalizeTriple(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const id = cleanText(raw.id, C.maxIdLength);
    const subject = cleanText(raw.subject);
    const predicate = cleanText(raw.predicate);
    const object = cleanText(raw.object);
    if (!subject || !predicate || !object) return null;

    const validFromMs = finiteOr(raw.validFromMs, 0);
    const rawTo = raw.validToMs === null || raw.validToMs === undefined ? null : finiteOr(raw.validToMs, null);
    const accessCount = Math.max(0, Math.floor(finiteOr(raw.accessCount, 0)));
    const lastAccessRaw = finiteOr(raw.lastAccessMs, validFromMs);

    return {
      id: id || `t-x-${subject.length}${predicate.length}${object.length}`,
      subject,
      predicate,
      object,
      speakerId: cleanText(raw.speakerId, C.maxIdLength),
      importance: clampNumber(raw.importance, C.minImportance, C.maxImportance, C.defaultImportance),
      validFromMs,
      // 失效时间早于生效时间属于脏数据：夹到 validFromMs（零长度有效窗），而不是当成「没失效」。
      // 为什么不能置 null：置 null 等于把一条**已经失效**的记忆复活成当前事实，
      // 冲突消解就白做了（线上会表现为「她同时记得两个互相矛盾的说法」）。
      validToMs: rawTo === null ? null : Math.max(rawTo, validFromMs),
      accessCount,
      lastAccessMs: lastAccessRaw,
      source: cleanText(raw.source, C.maxSourceLength),
      v: TRIPLE_VERSION,
    };
  } catch {
    return null;
  }
}

/** id 缺失时的兜底补号（用于 deserialize 出来的老数据），保证列表内 id 唯一。 */
function ensureIds(list) {
  const seen = new Set();
  return list.map((t) => {
    if (t.id && !seen.has(t.id)) { seen.add(t.id); return t; }
    let candidate = t.id || `t-imp-${t.subject.length}${t.predicate.length}${t.object.length}`;
    let n = 1;
    while (seen.has(candidate)) { candidate = `${t.id || 't-imp'}#${n}`; n += 1; }
    seen.add(candidate);
    return { ...t, id: candidate };
  });
}

/**
 * 边界扩展判定：短的那个是长的前缀或后缀时返回 true。
 * 为什么单独判这一条：中文里「信息追加」和「信息插入」在纯词面相似度上几乎同分——
 *   无糖冰美式 → 无糖冰美式咖啡（加后缀，是**同一条记忆的补充**，应当覆盖）
 *   美式咖啡   → 美式冰咖啡  （中间插「冰」，是**另一个东西**，应当并存）
 * 实测两者三层 Jaccard 都在 0.46~0.55 之间分不开，只有「短句是否是长句的边」这一条结构信息能分开。
 * 所以要给边界扩展一个乘性加成：它把「补充」抬到阈值上，同时不动「插入」那一类。
 */
function isEdgeExtension(short, long) {
  if (!short || !long || short.length >= long.length) return false;
  return long.startsWith(short) || long.endsWith(short);
}

/**
 * 词面相似度 0..1：三层 Jaccard 加权求和（中文靠字符+二元，英文靠整词），
 * 再对「短句是长句的前缀/后缀」这一情形乘 similarityEdgeExtensionBoost。
 * 对称（sim(a,b) === sim(b,a)），所以模式串照样能算。
 * 任一侧为空 → 0（空 object 不比任何东西相似，交给 normalizeTriple 拦掉）。
 */
export function similarity(a, b) {
  const left = a && typeof a === 'object' ? a.object : a;
  const right = b && typeof b === 'object' ? b.object : b;
  const la = foldText(left);
  const lb = foldText(right);
  if (!la || !lb) return 0;
  if (la === lb) return 1; // 完全一致直接短路，避免权重求和凑不满 1
  const w = C.similarityWeights;
  let s =
    w.char * jaccard(charSetOf(la), charSetOf(lb)) +
    w.bigram * jaccard(bigramSetOf(la), bigramSetOf(lb)) +
    w.word * jaccard(wordSetOf(la), wordSetOf(lb));
  if (isEdgeExtension(la, lb) || isEdgeExtension(lb, la)) s *= C.similarityEdgeExtensionBoost;
  return round4(clampNumber(s, 0, 1, 0));
}

function mergeMeta(prev, next) {
  // 合并时保留旧的元信息，只把「最近一次被提到」的时间与次数接上并取更可信的重要度。
  return {
    accessCount: Math.max(prev.accessCount, next.accessCount) + 1,
    lastAccessMs: Math.max(prev.lastAccessMs, next.lastAccessMs),
    importance: Math.max(prev.importance, next.importance),
    source: next.source || prev.source,
  };
}

/**
 * 写入/合并一条新三元组（Mem0 式冲突消解）。
 * 返回 {list, action, target}：
 *   - 'added'      ：新面孔（或同 (subject,predicate) 但 object 是另一件事），直接追加；
 *   - 'merged'     ：完全同义 → 不新增，只累加 accessCount / 刷新 lastAccessMs；
 *   - 'superseded' ：同槽修正 → 旧条打 validToMs = nowMs，新条追加并接上。
 * 输入 list 不被修改（返回新数组），脏条目在过程中被丢掉。
 */
export function upsertTriple(list, incoming, { similarityThreshold = C.similarityThreshold, nowMs } = {}) {
  const now = finiteOr(nowMs, 0);
  const threshold = clampNumber(similarityThreshold, 0, 1, C.similarityThreshold);
  const next = normalizeTriple(incoming);
  const out = (Array.isArray(list) ? list : []).map(normalizeTriple).filter(Boolean);

  if (!next) return { list: out, action: 'added', target: null };

  /*
   * 时间线归属（这是本模块最容易踩的坑，别删）：
   * normalizeTriple 把「缺失的 validFromMs」兜成 0，所以 incoming 里没带时间时 next.validFromMs 就是 0。
   * 如果直接把它 push 进列表，这条记忆的 validFromMs 会永远是 0，freshnessOf 就会把它当 1970 年的东西
   * （0.995 ** 两万小时 ≈ 0），新鲜度被恒定为 0 —— 表现是「刚写进来的记忆立刻排到最后」，
   * 而且所有条目的新鲜度全都一样，0.25 这一项在排序里彻底失效（实测就是靠这个把 T7 的召回打乱的）。
   * 所以：默认由这次调用的 nowMs 决定写入时刻；调用方**显式**给了正的 validFromMs 才尊重它
   * （离线语料要自己摆时间线，必须能覆盖默认值，否则测不了「新旧对比」）。
   * nowMs 也缺失时（now === 0）保持原值，不做臆测 —— 「时间未知」由 freshnessOf 统一按最新处理。
   */
  const rawFrom = incoming && typeof incoming === 'object' ? finiteOr(incoming.validFromMs, null) : null;
  const entryFrom = rawFrom !== null && rawFrom > 0 ? rawFrom : (now > 0 ? now : next.validFromMs);
  const incomingForAppend = { ...next, validFromMs: entryFrom, lastAccessMs: entryFrom };

  let bestIdx = -1;
  let bestSim = -1;
  let exactIdx = -1;
  for (let i = 0; i < out.length; i += 1) {
    const t = out[i];
    if (t.subject !== next.subject || t.predicate !== next.predicate) continue; // 槽位 = (subject, predicate)
    if (t.object === next.object && exactIdx < 0) exactIdx = i;
    const s = similarity(t, next);
    if (s > bestSim) { bestSim = s; bestIdx = i; }
  }

  // ① 完全相同：只累加访问次数。为什么不做别的：字面一致的记忆重复出现只说明「这件事又被提了一次」，
  //    它是同一个事实的再次确认，不是新事实，追加会产生一堆一模一样的三元组。
  //    validFromMs 保持旧值（事实本身还是那时成立的），只有「最近一次用到」推进到 now，
  //    这样反复被提起的事会靠新鲜度+accessCount 自己浮上来，而不是靠刷新时间冒充新事实。
  if (exactIdx >= 0) {
    const prev = out[exactIdx];
    const merged = { ...prev, ...mergeMeta(prev, next), validFromMs: prev.validFromMs, lastAccessMs: now > 0 ? now : prev.lastAccessMs };
    out[exactIdx] = merged;
    return { list: out, action: 'merged', target: merged };
  }

  // ② 同槽且相似度超阈值：认定是同一件事的修正 → 覆盖（旧条失效但不删除）
  if (bestIdx >= 0 && bestSim > threshold) {
    const prev = out[bestIdx];
    const meta = mergeMeta(prev, next);
    const dead = { ...prev, validToMs: now };
    const fresh = { ...incomingForAppend, ...meta, validFromMs: entryFrom, validToMs: null, lastAccessMs: entryFrom };
    out[bestIdx] = dead;
    out.push(fresh);
    return { list: out, action: 'superseded', target: fresh };
  }

  // ③ 其余（含同槽但 object 是另一件事）：追加，两条并存
  out.push(incomingForAppend);
  return { list: out, action: 'added', target: incomingForAppend };
}

/** 新鲜度的「最近一次被用到」时刻：没被用过（accessCount 0）就退回 validFromMs，见常量注释。 */
function lastTouchedMs(triple) {
  return triple.accessCount > C.minimumAccessCount ? triple.lastAccessMs : triple.validFromMs;
}

function freshnessOf(triple, nowMs) {
  const now = finiteOr(nowMs, 0);
  const touched = lastTouchedMs(triple);
  /*
   * 为什么 touched <= 0 要当「时间未知」而不是「很久以前」：
   * 调用方没传 nowMs（或传了非法值）时 newTriple/normalizeTriple 会把 validFromMs 兜成 0，
   * 于是 (now - 0) / 3600000 是「1970 年到现在」的两万多天，0.995**20370 ≈ 0 —— 新鲜度被恒定为 0，
   * 这条记忆在打分里永远垫底，实际效果是「一条刚写进去的记忆立刻变成最老的记忆」。
   * 线上表现为：谁忘了传 nowMs，谁的记忆就再也想不起来（连 validToMs 的 ×0.3 都还没轮到它）。
   * 未知年龄按「最新」处理，是更安全的一侧：宁可让年龄未知的条目多拿 0.25 分，
   * 也不要让一条真事实因为少传一个参数而永久被埋。
   */
  const base = touched > 0 ? touched : now;
  const hours = Math.max(0, (now - base) / 3600000);
  return clampNumber(Math.pow(C.freshnessDecayPerHour, hours), 0, 1, 0);
}

/**
 * 字段覆盖率：该字段能在提问里**原样找到**多长的一段（连续字面重合）。
 * 中文没有词边界，整句会被切成一个长 token，所以纯 Jaccard 抓不住「奶茶」出现在
 * 「糖糖最喜欢喝什么」里的包含关系；这里改用「连续字面重合 / 字段长度」，
 * 再乘「命中长度 / 提问长度」惩罚短命中。
 *
 * 单字命中必须被禁掉（minSpan = 2）：否则「她妈妈」会靠一个「木」字跟「木木最喜欢的人」
 * 拿到 0.67 的实体分，把无关条目顶到正确答案前面（实测命中率卡在 0.75 就是它干的）。
 * 英文侧改用整词包含，避免 "cod" 命中 "codfishing" 这种前缀假阳性。
 */
/**
 * 提问口径归一：真实问句几乎不会复述存储时的谓词。
 * 「阿泽最爱的吃的？」问的是「(阿泽, 最喜欢, ?)」，但字面重合算出来是 0，
 * 同主体的两个候选（雨天/辣条）就只能靠重要度抽签——实测这一条直接把 Top-1 拉低 10 个点。
 * 所以打分前先把同义口径归一到存储侧的说法；**只在打分里归一，不改存储原文**，
 * 否则「记忆里写了什么」会被改写，用户回看时对不上。
 * 顺序有讲究：长的先说（最喜欢 在 最 之前替换，避免被拆碎）。
 */
const QUERY_CANON = Object.freeze([
  ['最喜欢', '最喜欢'], ['最喜爱', '最喜欢'], ['最爱的', '最喜欢'], ['最爱', '最喜欢'],
  ['最讨厌', '讨厌'], ['最烦', '讨厌'],
  ['爱喝', '喜欢'], ['爱吃', '喜欢'], ['爱玩', '喜欢'],
  ['喝什么', '什么'], ['吃什么', '什么'],
  ['她在哪', '经常去'], ['他在哪', '经常去'], ['去哪', '经常去'],
]);

function canonicalizeQuery(text) {
  let out = foldText(text);
  for (const [from, to] of QUERY_CANON) {
    if (from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
}

function containmentScore(field, query) {
  const a = foldText(field);
  const b = foldText(query);
  if (!a || !b) return 0;
  const minSpan = Math.min(2, a.length);
  if (a.length <= minSpan) {
    if (!CJK_RE.test(a)) return new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(b) ? a.length / b.length : 0;
    return b.includes(a) ? a.length / b.length : 0;
  }
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = a.length; j - i > best; j -= 1) {
      if (j - i < minSpan) break;
      if (b.includes(a.slice(i, j))) { best = j - i; break; }
    }
  }
  return best === 0 ? 0 : (best / a.length) * (best / b.length);
}

/**
 * 提问覆盖率：提问里有百分之多少的字能在这条记忆的字段里找到连续出处（只认 ≥2 字的重合）。
 * 覆盖率是**对称于提问长度**的：问句越长，蒙对的机会越小，所以它比字段覆盖率更抗假阳性。
 */
function coverageScore(triple, query) {
  const q = canonicalizeQuery(query);
  if (!q) return 0;
  const hay = `${foldText(triple.subject)}|${foldText(triple.predicate)}|${foldText(triple.object)}`;
  const chars = [...q];
  let hit = 0;
  for (let i = 0; i < chars.length; i += 1) {
    let ok = chars[i] !== '|' && hay.includes(chars[i]);
    if (ok && chars.length > 1) {
      const pair = i + 1 < chars.length ? chars[i] + chars[i + 1] : chars[i - 1] + chars[i];
      ok = hay.includes(pair);
    }
    if (ok) hit += 1;
  }
  return hit / chars.length;
}

/**
 * 匹配分：提问覆盖率为主 + 字段覆盖率 + 主体锚定 + 字符集相似度兜底，再抬到 matchFloor 以上。
 *
 * 每一版权重都是被实测否掉后改的（见 ops/test-memory-triples.mjs T7 的命中率）：
 * ① 三段字段 0.5/0.35/0.15：主体与谓词承载查询意图（「谁」+「最喜欢」），object 是答案本身。
 *    三段平分时同槽候选的匹配分挤在一起，Top-1 只有 25%。
 * ② 纯 Jaccard 对中文部分包含几乎无感，匹配分会整体塌到下限、排序退化成按重要度抽签（Top-10 只有 50%）。
 * ③ 只加字段覆盖率仍不够（0.75）：主体完全对不上的条目靠单字命中也能拿到实体分，
 *    所以再加「提问覆盖率」（抗蒙）+「主体锚定」（提问里点名主体才加分）。
 * ④ 保留 0.1 的字符集相似度兜底：字面不连续但有共同字的条目还能拿到少量分。
 */
function matchScoreOf(triple, query) {
  // 归一一次，三段打分共用同一份问句口径（canonicalizeQuery 幂等，重复调用不再变化）
  const q = canonicalizeQuery(query);
  const fields = [triple.subject, triple.predicate, triple.object];
  const weights = [0.4, 0.25, 0.25];
  let fieldPart = 0;
  for (let i = 0; i < fields.length; i += 1) {
    const cov = containmentScore(fields[i], q);
    const jac = similarity({ object: fields[i] }, { object: q });
    fieldPart += weights[i] * (0.8 * cov + 0.2 * jac);
  }
  const anchor = containmentScore(triple.subject, q);
  const raw = 0.5 * coverageScore(triple, q) + 0.45 * fieldPart + 0.35 * anchor;
  return clampNumber(C.matchFloor + (1 - C.matchFloor) * raw, 0, 1, C.matchFloor);
}

function reasonsOf(triple, parts, nowMs) {
  const out = [];
  out.push(parts.explicit
    ? `调用方给了匹配分 ${parts.rawMatch.toFixed(2)}`
    : `与提问话面重合 ${parts.rawMatch.toFixed(2)}（${triple.subject}·${triple.predicate}·${triple.object}）`);
  const hours = Math.max(0, (finiteOr(nowMs, 0) - triple.lastAccessMs) / 3600000);
  out.push(hours < 1 ? '刚提过（1 小时内）' : hours < 24 ? `今天/昨天说过（约 ${hours.toFixed(1)} 小时前）` : `已过去约 ${Math.round(hours / 24)} 天，新鲜度 ${parts.freshness.toFixed(2)}`);
  if (triple.importance >= 4) out.push(`标了高重要度 ${triple.importance}`);
  if (triple.accessCount > 0) out.push(`被提过 ${triple.accessCount + 1} 次`);
  if (triple.validToMs !== null) out.push('这条已过期（只留 30% 权重，除非你明确在问旧事）');
  if (parts.sameSpeaker) out.push('说话人亲口说的，加成 1.2');
  if (parts.capped) out.push('加权后超过 1，按 1 计');
  return out;
}

/**
 * 单条打分 0..1：
 *   base = 0.5*匹配分 + 0.25*新鲜度 + 0.15*重要度 + 0.10*log1p(accessCount)/3
 *   然后 过期 ×0.3、同说话人 ×1.2，最后 clamp 到 [0,1]（×1.2 后可能超过 1，必须夹回来）。
 * nowMs 必传：新鲜度是与「现在」的距离，函数内部不读时钟。
 */
export function scoreTriple(triple, { query = '', nowMs, speakerId = '', matchScore } = {}) {
  return scoreTripleDetailed(triple, { query, nowMs, speakerId, matchScore }).score;
}

/**
 * scoreTriple 的内部实现：除了 0..1 的分数，还带上拆解后的四个分项与中文原因。
 * recallTriples 与测试用这个；对外契约（scoreTriple 返回 number）不被污染。
 */
export function scoreTripleDetailed(triple, { query = '', nowMs, speakerId = '', matchScore } = {}) {
  const t = normalizeTriple(triple);
  if (!t) return { score: 0, parts: null, reasons: ['这条记忆数据不合法，已忽略'] };
  const now = finiteOr(nowMs, 0);

  const explicitMatch = typeof matchScore === 'number' && Number.isFinite(matchScore);
  const rawMatch = explicitMatch
    ? clampNumber(matchScore, 0, 1, 0)
    : (query ? matchScoreOf(t, query) : C.matchFloor);
  const match = clampNumber(rawMatch, 0, 1, 0);

  const freshness = freshnessOf(t, now);
  const imp = clampNumber(t.importance / C.maxImportance, 0, 1, 0);
  const acc = clampNumber(Math.log1p(t.accessCount) / C.accessSaturation, 0, 1, 0);

  const w = C.scoreWeights;
  let score = w.match * match + w.freshness * freshness + w.importance * imp + w.access * acc;
  if (t.validToMs !== null) score *= C.staleScoreMultiplier;

  const sameSpeaker = Boolean(speakerId) && t.speakerId === cleanText(speakerId, C.maxIdLength);
  if (sameSpeaker) score *= C.sameSpeakerMultiplier;

  const capped = score > 1;
  const parts = {
    match: round4(match),
    freshness: round4(freshness),
    importance: round4(imp),
    access: round4(acc),
    sameSpeaker,
    stale: t.validToMs !== null,
    explicitMatch,
    rawMatch: round4(match),
    capped,
  };
  return {
    score: round4(clampNumber(score, 0, 1, 0)),
    parts,
    reasons: reasonsOf(t, { explicitMatch, rawMatch: match, freshness, sameSpeaker, capped }, now),
  };
}

/** 排序比较：分数降序 → accessCount 降序 → id 升序 → 原始下标升序（同分绝不因 sort 实现而乱序）。 */
function compareRank(a, b) {
  if (Math.abs(a.score - b.score) > C.scoreEpsilon) return b.score - a.score;
  const ai = a.triple.accessCount;
  const bi = b.triple.accessCount;
  if (ai !== bi) return bi - ai;
  const aid = a.triple.id;
  const bid = b.triple.id;
  if (aid !== bid) return aid < bid ? -1 : 1;
  return a.index - b.index;
}

/**
 * 召回：按分数降序返回 [{triple, score, reasons}]，只回传纯数据（res1 是拆出来的值，不带内部引用）。
 * limit 非法时退回默认 10；list 里的脏条目直接跳过（不抛）。
 */
export function recallTriples(list, { query = '', nowMs, speakerId = '', limit = C.defaultRecallLimit, similarityThreshold } = {}) {
  const source = Array.isArray(list) ? list : [];
  const max = Math.max(0, Math.floor(clampNumber(limit, 0, 1000, C.defaultRecallLimit)));
  void similarityThreshold; // 保留形参：阈值只作用于写入侧（upsertTriple），召回不再做二次裁剪
  const scored = [];
  for (let i = 0; i < source.length; i += 1) {
    const t = normalizeTriple(source[i]);
    if (!t) continue;
    const s = scoreTripleDetailed(t, { query, nowMs, speakerId, matchScore: query ? undefined : C.recallMatchFloor });
    scored.push({ triple: t, score: s.score, reasons: s.reasons, detail: s.parts, index: i });
  }
  scored.sort(compareRank);
  return scored.slice(0, max).map((r) => ({ triple: r.triple, score: r.score, reasons: r.reasons, detail: r.detail }));
}

/** 序列化：带版本封套。写盘的永远是 {v, triples:[...]}，方便以后做 v1→v2 迁移。 */
export function serializeTriples(list) {
  const triples = (Array.isArray(list) ? list : []).map(normalizeTriple).filter(Boolean);
  return JSON.stringify({ v: TRIPLE_VERSION, triples });
}

/** 反序列化：版本不符 / 垃圾输入 / 非数组 → 一律 []，绝不抛。 */
export function deserializeTriples(raw) {
  try {
    let payload = raw;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text) return [];
      payload = JSON.parse(text);
    }
    // 接受两种形态：{v, triples} 封套，或裸数组（老数据/手工构造）。
    if (Array.isArray(payload)) {
      return ensureIds(payload.map(normalizeTriple).filter(Boolean));
    }
    if (!payload || typeof payload !== 'object') return [];
    if ('v' in payload || 'version' in payload) {
      const v = finiteOr(payload.v ?? payload.version, NaN);
      if (v !== TRIPLE_VERSION) return []; // 版本不符：宁可回空表让上层重建，也不做半吊子兼容
    }
    const arr = Array.isArray(payload.triples) ? payload.triples : Array.isArray(payload.items) ? payload.items : null;
    if (!arr) return [];
    return ensureIds(arr.map(normalizeTriple).filter(Boolean));
  } catch {
    return [];
  }
}

/**
 * 命中率测评：probes 为 [{query, expect}]，expect 与某条的 object 词面完全相同即算命中。
 * 返回 {n, top1Hit, top10Hit, top10HitRate, misses}。
 * top10HitRate 是阶段 5 的验收线（>0.8），misses 用来定位是哪几条问句没被想起来。
 */
export function tripleStats(probes, list, { nowMs } = {}) {
  const items = Array.isArray(probes) ? probes : [];
  const result = { n: items.length, top1Hit: 0, top10Hit: 0, top10HitRate: 0, misses: [] };
  if (!items.length) return result;

  items.forEach((probe, idx) => {
    const query = probe && typeof probe === 'object' ? probe.query : '';
    const expect = probe && typeof probe === 'object' ? probe.expect : undefined;
    const speaker = probe && typeof probe === 'object' ? probe.speakerId : undefined;
    const flat = recallTriples(list, { query, nowMs, speakerId: speaker, limit: 10 });
    const want = foldText(expect);
    const at = flat.findIndex((r) => foldText(r.triple.object) === want);
    if (at === 0) result.top1Hit += 1;
    if (at >= 0 && at < 10) result.top10Hit += 1;
    else result.misses.push({ index: idx, query, expect: cleanText(expect), rank: at < 0 ? null : at + 1, got: flat.slice(0, 3).map((r) => r.triple.object) });
  });

  result.top10HitRate = round4(result.top10Hit / items.length);
  return result;
}

// （调试用的临时导出已移除：模块对外只暴露下面的正式 API。）