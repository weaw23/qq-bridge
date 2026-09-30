// 鲸鲸 2.0 记忆引擎 A 层（docs/upgrade-plan-2026-10.md）：
//   A1 消息流 L0（streams/<key>.jsonl，由 bridge.js 落盘，本模块只定义行格式）
//   A2 Episode 情景卡 L1（Generative Agents importance 打分）
//   A3 事实账本 L2（mem0 操作语义 ADD/UPDATE/DELETE/NOOP，矛盾→标 invalidated 软删）
// 约束：纯函数，不依赖 bridge.js 运行时；所有字符串有界；JSON 解析容错（剥围栏/尾逗号/字段 clamp）。
// 检索三因子（A4 用，本步先定义评分函数）：score = recency(e^(-λ·Δt)) × importance × relevance。
import { toBigrams } from './memory-engine.js';

export const EPISODE_PROMPT_MAX_MESSAGES = 40;
export const FACT_PROMPT_MAX_MESSAGES = 40;
export const FACT_SIMILARITY_THRESHOLD = 0.55;
export const THREE_FACTOR_HALF_LIFE_DAYS = 14;

// ── A1：消息流行格式 ──
export function sanitizeStreamKey(key) {
  return String(key || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'unknown';
}

export function makeStreamLine(msg) {
  const text = String(msg?.text ?? msg?.plain ?? '').slice(0, 500);
  return {
    time: Number(msg?.time) || Date.now(),
    kind: String(msg?.kind || 'message'), // message | poke | notice
    sender: String(msg?.sender || '').slice(0, 60),
    userId: msg?.userId != null ? String(msg.userId).slice(0, 20) : '',
    isOwner: !!msg?.isOwner,
    isSelf: !!msg?.isSelf,
    text,
    quoteSelf: !!msg?.quoteTargetIsSelf,
    hasMedia: !!msg?.hasMedia,
    hasForward: !!msg?.hasForward,
    messageId: msg?.messageId != null ? String(msg.messageId).slice(0, 40) : null
  };
}

// ── A4：三因子评分（recency × importance × relevance，各有下限保底避免全零湮灭）──
export function threeFactorScore({ atMs, importance, relevance, nowMs = Date.now(), halfLifeDays = THREE_FACTOR_HALF_LIFE_DAYS }) {
  const age = Math.max(0, Number(nowMs) - Number(atMs || 0));
  const recency = Math.pow(0.5, age / (Math.max(0.5, halfLifeDays) * 86400000));
  const imp = Math.max(0, Math.min(10, Number(importance) || 0)) / 10;
  const rel = Math.max(0, Math.min(1, Number(relevance) || 0));
  return recency * (0.25 + 0.75 * imp) * (0.2 + 0.8 * rel);
}

export function bigramSimilarity(a, b) {
  const A = new Set(toBigrams(String(a ?? '')).split(/\s+/).filter(Boolean));
  const B = new Set(toBigrams(String(b ?? '')).split(/\s+/).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

// ── A3：事实账本操作语义 ──
// row：{id, streamKey, person, fact, confidence, importance(1-10), sources[], createdAt, lastHitAt, updatedAt, invalidated, invalidatedAt, invalidationReason}
function newFactRow(id, person, fact, op, ctx) {
  return {
    id,
    streamKey: String(ctx.streamKey || ''),
    person: String(person || '').slice(0, 60),
    fact: String(fact).slice(0, 200),
    confidence: Math.max(0.3, Math.min(1, Number(op.confidence) || 0.7)),
    importance: clampImportance(op.importance ?? 3),
    sources: [String(ctx.streamKey || '')].filter(Boolean),
    createdAt: ctx.now,
    lastHitAt: ctx.now,
    updatedAt: ctx.now,
    invalidated: false,
    invalidatedAt: 0,
    invalidationReason: ''
  };
}

export function clampImportance(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : 3;
}

// 事实匹配：op 带 id 直接命中（含已作废行，可作复活/再作废目标）；否则按人（空人视为通配）+ bigram 相似度找最近邻。
export function matchFact(rows, person, fact, opId) {
  const p = String(person || '').trim();
  if (opId != null && opId !== '') {
    const byId = rows.find((r) => String(r.id) === String(opId));
    if (byId) return { row: byId, score: 1 };
  }
  let best = null;
  let bestScore = 0;
  for (const r of rows) {
    if (r.invalidated) continue;
    if (p && r.person && r.person !== p) continue;
    const s = bigramSimilarity(r.fact, fact);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return { row: best, score: bestScore };
}

// UPDATE 无 id 时的目标：同 person 的「有效」行里与新事实最像的一条（similarity 仅用于挑选，不作门槛）。
function findPersonRow(rows, person, fact) {
  const p = String(person || '').trim();
  if (!p) return { row: null, score: 0 };
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
    if (r.invalidated) continue;
    if (r.person && r.person !== p) continue;
    const s = bigramSimilarity(r.fact, fact);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return { row: best, score: Math.max(0, bestScore) };
}

// 应用一批操作（mem0 语义）：
//   ADD：已有近似事实（≥阈值）→ 自动升级为 UPDATE（重写为新表述）；否则新增。
//   UPDATE：带 id → 直达行重写（invalidated 清零=复活）；无 id 带 person → 该人有效行中最像一条重写，没有 → 退化为 ADD；无 id 无 person → NOOP。
//   DELETE：匹配到（含 id 直达）→ 标 invalidated（软删，可被后续 UPDATE 复活）；没匹配到 → NOOP。
//   NOOP/未知：忽略。
export function applyFactOps(rows, ops, ctx) {
  const out = rows.map((r) => ({ ...r, sources: Array.isArray(r.sources) ? [...r.sources] : [] }));
  const applied = [];
  let nextId = out.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  for (const op of Array.isArray(ops) ? ops : []) {
    const kind = String(op?.op || '').toUpperCase();
    if (kind === 'NOOP' || !kind) continue;
    const fact = String(op?.fact ?? '').trim().slice(0, 200);
    const person = String(op?.person ?? '').trim().slice(0, 60);
    if (!fact) continue;
    const { row, score } = matchFact(out, person, fact, op?.id);
    if (kind === 'DELETE') {
      if (row && score >= FACT_SIMILARITY_THRESHOLD) {
        row.invalidated = true;
        row.invalidatedAt = ctx.now;
        row.invalidationReason = String(op?.reason || 'DELETE').slice(0, 120);
        applied.push({ op: 'DELETE', id: row.id, person, fact, importance: row.importance });
      } else {
        applied.push({ op: 'NOOP', reason: 'no-match', person, fact });
      }
    } else if (kind === 'UPDATE') {
      // 目标：带 id → matchFact 已直达（含作废行，可复活）；无 id 带 person → 同 person 有效行中最像的一条（相似度仅挑选，不作门槛）；无 id 无 person → NOOP。
      const byId = op?.id != null && String(op.id) !== '';
      let target = row;
      if (!byId && person) target = findPersonRow(out, person, fact).row;
      if (!byId && !person) target = null;
      if (target) {
        if (person && target.person !== person) target.person = person;
        target.fact = fact;
        target.importance = clampImportance(op?.importance ?? target.importance);
        target.lastHitAt = ctx.now;
        target.updatedAt = ctx.now;
        target.invalidated = false;
        target.invalidatedAt = 0;
        target.invalidationReason = '';
        if (!target.sources.includes(ctx.streamKey)) target.sources.push(ctx.streamKey);
        applied.push({ op: 'UPDATE', id: target.id, person, fact, importance: target.importance });
      } else if (person) {
        nextId += 1;
        out.push(newFactRow(nextId, person, fact, op, ctx));
        applied.push({ op: 'ADD', id: nextId, person, fact, importance: clampImportance(op?.importance ?? 5) });
      } else {
        applied.push({ op: 'NOOP', reason: 'no-target', person, fact });
      }
    } else if (kind === 'ADD') {
      if (row && score >= FACT_SIMILARITY_THRESHOLD) {
        row.fact = fact;
        row.importance = clampImportance(Math.max(Number(row.importance) || 3, Number(op?.importance) || 3));
        row.lastHitAt = ctx.now;
        row.updatedAt = ctx.now;
        if (!row.sources.includes(ctx.streamKey)) row.sources.push(ctx.streamKey);
        applied.push({ op: 'UPDATE', id: row.id, person, fact, importance: row.importance });
      } else {
        nextId += 1;
        const p = person || (row && row.person) || '未知';
        out.push(newFactRow(nextId, p, fact, op, ctx));
        applied.push({ op: 'ADD', id: nextId, person: p, fact, importance: clampImportance(op?.importance ?? 5) });
      }
    }
  }
  return { rows: out, applied };
}

// 存量导入：memory.db facts 表（importance 1-5）→ v2 账本（importance 1-10，×2 映射）。
export function legacyFactToV2(row, id, now = Date.now()) {
  return {
    id,
    streamKey: String(row.source_key || ''),
    person: String(row.person || '').slice(0, 60),
    fact: String(row.content || '').slice(0, 200),
    confidence: 0.8,
    importance: clampImportance((Number(row.importance) || 2) * 2),
    sources: [String(row.source_key || '')].filter(Boolean),
    createdAt: Number(row.created_at) || now,
    lastHitAt: Number(row.updated_at) || now,
    updatedAt: Number(row.updated_at) || now,
    invalidated: false,
    invalidatedAt: 0,
    invalidationReason: '',
    legacyId: Number(row.id) || null
  };
}

// ── A2：Episode 生成 prompt / 解析 ──
function messageLines(messages, herName) {
  return messages.map((m, i) => {
    const who = m.isSelf ? herName : String(m.sender || '某人');
    const tag = m.isSelf ? '' : (m.isOwner ? '（主人）' : '');
    const media = m.hasMedia ? ' [图]' : (m.hasForward ? ' [转发]' : (m.kind === 'poke' ? ' [拍一拍]' : ''));
    return `${i + 1}. ${who}${tag}: ${String(m.text ?? '').slice(0, 120)}${media}`;
  }).join('\n');
}

export function buildEpisodePrompt({ convLabel, messages, prevSummaries, herName = '鲸鲸' }) {
  const window = messages.slice(-EPISODE_PROMPT_MAX_MESSAGES);
  const prev = (Array.isArray(prevSummaries) ? prevSummaries : []).filter(Boolean).slice(0, 2)
    .map((s, i) => `前情${i + 1}：${String(s).slice(0, 160)}`).join('\n');
  return `你是「${herName}」的记忆整理器。下面是「${convLabel}」最近一段聊天记录${prev ? `和此前总结` : ''}。请把这段聊天压缩成一张情景记忆卡（Episode），站在${herName}的第一人称视角。

${prev ? prev + '\n\n' : ''}聊天记录：
${messageLines(window, herName)}

只输出一个 JSON 对象（无围栏无注释），字段：
- "summary"：≤120 字，说清发生了什么事（谁、聊了什么、氛围如何）；
- "participants"：这段里比较活跃的说话人名字，≤5 个；
- "feeling"：${herName}此刻对这段聊天的感受，一句话 ≤40 字；
- "importance"：对${herName}的重要程度 1-10（日常闲聊 1-3，聊到私人/情绪/约定 4-6，重大事件 7-10）；
- "tags"：话题标签 1-3 个，每个 ≤8 字。

判断标准：只记值得以后想起的内容；水群斗图给低分；有人提到${herName}或主人、聊到近况/约定/情绪给高分。`;
}

export function parseEpisodeJson(text) {
  return parseJsonLoose(text);
}

// ── A3：事实提取 prompt / 解析 ──
export function buildFactPrompt({ convLabel, messages, existingFacts, herName = '鲸鲸' }) {
  const window = messages.slice(-FACT_PROMPT_MAX_MESSAGES);
  const persons = [];
  const seen = new Set();
  for (const m of window) {
    if (m.isSelf) continue;
    const who = String(m.sender || '').trim();
    if (!who || seen.has(who)) continue;
    seen.add(who);
    persons.push(who);
  }
  const personList = persons.slice(0, 8).join('、') || '（未能识别）';
  const known = (Array.isArray(existingFacts) ? existingFacts : [])
    .filter((f) => f && !f.invalidated)
    .slice(0, 12)
    .map((f) => `- #${f.id} [${f.person || '未知'}] ${String(f.fact).slice(0, 80)}（重要度 ${f.importance}）`)
    .join('\n');
  return `你是「${herName}」的人物事实账本。从「${convLabel}」这段聊天里提取值得长期记住的人物事实（习惯/喜好/近况/身份/约定），不要记情绪化闲聊本身。

聊天记录：
${messageLines(window, herName)}

在场的人：${personList}
${known ? `账本里已有这些人/相关旧事实：\n${known}\n` : ''}
只输出一个 JSON 对象（无围栏无注释）：
{"ops":[{"op":"ADD|UPDATE|DELETE","id":null,"person":"说话人名字","fact":"≤80字事实","importance":1-10,"confidence":0-1,"reason":"为什么"}]}

规则：
- 新事实用 ADD；person 必须用聊天里出现过的名字。
- 与旧事实矛盾/过时（如换了城市、改了喜好）用 UPDATE 并带旧事实 id；id 记不清就留 null。
- 主人明说某旧信息作废用 DELETE 并带 id。
- 没有值得记的就输出 {"ops":[]}。一次最多 6 条，宁缺毋滥。
- importance：日常细节 1-3，偏好/近况 4-6，身份/约定/雷区 7-10。`;
}

export function parseFactOps(text) {
  const parsed = parseJsonLoose(text);
  if (!parsed) return [];
  const ops = Array.isArray(parsed.ops) ? parsed.ops : (Array.isArray(parsed) ? parsed : []);
  return ops.map((o) => ({
    op: String(o?.op || '').toUpperCase(),
    id: o?.id ?? null,
    person: String(o?.person || '').slice(0, 60),
    fact: String(o?.fact || '').slice(0, 200),
    importance: o?.importance,
    confidence: o?.confidence,
    reason: String(o?.reason || '').slice(0, 120)
  }));
}

// ── A5 预留：Episode 渲染 / 召回印象 prompt ──
export function renderEpisodeLines(episodes, { limit = 4, maxChars = 400, nowMs = Date.now() } = {}) {
  const rows = (Array.isArray(episodes) ? episodes : [])
    .filter((e) => e && !e.invalidated)
    .slice(0, limit);
  const out = [];
  let used = 0;
  for (const e of rows) {
    const day = new Date(Number(e.time) || nowMs).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    const line = `- ${day}${e.tags?.length ? `[${String(e.tags[0]).slice(0, 8)}]` : ''} ${String(e.summary || '').slice(0, 90)}`;
    if (used + line.length > maxChars) break;
    used += line.length;
    out.push(line);
  }
  return out.join('\n');
}

// 共享组过滤：key 可见的 key 集合（跨流检索只开共享组；群↔群默认隔离）。
// groups 形如 [['private:1918594889','group:471975044'], ...]；null = 不共享。
export function visibleKeysFor(key, groups) {
  const keys = new Set([key]);
  if (!Array.isArray(groups)) return keys;
  for (const g of groups) {
    if (Array.isArray(g) && g.includes(key)) {
      for (const k of g) if (typeof k === 'string' && k) keys.add(k);
    }
  }
  return keys;
}

// ── 共用：宽松 JSON 解析（剥围栏/尾逗号/前后杂文本）──
function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(t);
  if (fence) t = fence[1].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  else if (first > 0) t = t.slice(first);
  const attempts = [t, t.replace(/,\s*([}\]])/g, '$1')];
  for (const a of attempts) {
    try { return JSON.parse(a); } catch {}
  }
  return null;
}

// Episode 字段清洗（parseEpisodeJson 的后处理）
export function normalizeEpisode(parsed, { key, spanFrom, spanTo, msgCount, id, now = Date.now() } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = String(parsed.summary || '').trim().slice(0, 200);
  if (!summary) return null;
  return {
    id: Number(id) || 0,
    key: String(key || ''),
    time: now,
    spanFrom: Number(spanFrom) || now,
    spanTo: Number(spanTo) || now,
    msgCount: Number(msgCount) || 0,
    summary,
    participants: (Array.isArray(parsed.participants) ? parsed.participants : [])
      .map((p) => String(p || '').slice(0, 20)).filter(Boolean).slice(0, 5),
    feeling: String(parsed.feeling || '').slice(0, 60),
    importance: clampImportance(parsed.importance ?? 3),
    tags: (Array.isArray(parsed.tags) ? parsed.tags : [])
      .map((x) => String(x || '').slice(0, 8)).filter(Boolean).slice(0, 3),
    invalidated: false
  };
}

// ── A4/A5：三因子召回打分（时间衰减 × 重要度 × 相关性），纯函数 ──
// bridge.js 负责节流/缓存/命中强化；这里只挑行。
// allowedSources：null=不限（私聊）；Set=可见来源集合（群聊按共享组规则过滤，私聊来源默认不可见）。
// presentPeople：当前在场的人（名片/昵称/QQ号），当事人命中给相关性加成（更"自然想起"）。
export function scoreMemoryV2Candidates({
  episodes = [], facts = [], queryText = '', nowMs = Date.now(),
  allowedSources = null, presentPeople = [],
  maxEpisodes = 2, maxFacts = 4, minScore = 0.05, presentBoost = 0.25
} = {}) {
  const query = String(queryText || '').slice(0, 240);
  const people = [...new Set((presentPeople || []).map((p) => String(p || '').trim()).filter(Boolean))];
  const personHit = (person) => {
    const p = String(person || '').trim();
    if (!p) return false;
    return people.some((x) => x === p || (p.length >= 2 && x.includes(p)) || (x.length >= 2 && p.includes(x)));
  };
  const agoText = (atMs) => {
    const ago = Math.max(0, nowMs - (Number(atMs) || 0));
    if (ago < 3600000) return '刚才';
    if (ago < 86400000) return Math.max(1, Math.round(ago / 3600000)) + '小时前';
    return Math.max(1, Math.round(ago / 86400000)) + '天前';
  };
  const epScored = [];
  for (const e of episodes) {
    if (!e || e.invalidated) continue;
    const rel = query ? bigramSimilarity(String(e.summary || ''), query) : 0;
    const s = threeFactorScore({ atMs: Number(e.time) || 0, importance: Number(e.importance) || 3, relevance: rel, nowMs });
    if (s >= minScore) epScored.push({ e, s });
  }
  epScored.sort((a, b) => b.s - a.s);
  const factScored = [];
  for (const f of facts) {
    if (!f || f.invalidated) continue;
    if (allowedSources && !(Array.isArray(f.sources) && f.sources.some((k) => allowedSources.has(k)))) continue;
    const rel = Math.min(1, (query ? bigramSimilarity(String(f.fact || ''), query) : 0) + (personHit(f.person) ? presentBoost : 0));
    const s = threeFactorScore({ atMs: Number(f.updatedAt) || Number(f.createdAt) || 0, importance: Number(f.importance) || 3, relevance: rel, nowMs });
    if (s >= minScore) factScored.push({ f, s });
  }
  factScored.sort((a, b) => b.s - a.s);
  const episodesOut = epScored.slice(0, Math.max(0, maxEpisodes)).map(({ e }) => {
    const tags = Array.isArray(e.tags) && e.tags.length ? `（${e.tags.join('/')}）` : '';
    return { kind: 'episode', id: Number(e.id) || 0, text: `- 【${agoText(e.time)}】${String(e.summary || '').slice(0, 90)}${tags}` };
  });
  const factsOut = factScored.slice(0, Math.max(0, maxFacts)).map(({ f }) => ({
    kind: 'fact', id: Number(f.id) || 0, text: `- ${f.person ? String(f.person).slice(0, 20) + '：' : ''}${String(f.fact || '').slice(0, 90)}`
  }));
  return { episodes: episodesOut, facts: factsOut };
}

// ── A10：v2 记忆夜间维护（纯函数）──
// 1) stale 作废：超 staleDays 未被想起（lastHitAt）且重要度 < staleImportanceBelow → 软作废（不是删，主人可救）。
// 2) 同人近似合并：同人 + bigram 相似 ≥0.55 → 合并成一条（保留更强重要度/新表述/合并来源与命中时间）。
// 3) 老旧情节淘汰：Episode 超 episodeMaxAgeDays 且三因子分 < minEpisodeScore → 丢弃（L1 本来就是滚动窗口）。
export function maintainMemoryV2Rows({
  episodes = [], facts = [], nowMs = Date.now(),
  staleDays = 90, staleImportanceBelow = 5, episodeMaxAgeDays = 180, minEpisodeScore = 0.02, weeklyMerge = true
} = {}) {
  const stats = { factsInvalidated: 0, factsMerged: 0, episodesDropped: 0 };
  const staleMs = Math.max(1, staleDays) * 86400000;
  const out = [];
  for (const f of facts) {
    if (!f) continue;
    if (f.invalidated) { out.push(f); continue; }
    const lastHit = Number(f.lastHitAt) || Number(f.updatedAt) || Number(f.createdAt) || 0;
    if ((nowMs - lastHit) > staleMs && (Number(f.importance) || 3) < staleImportanceBelow) {
      stats.factsInvalidated += 1;
      out.push({ ...f, invalidated: true, invalidatedAt: nowMs, invalidationReason: 'stale（长期未被想起）' });
      continue;
    }
    out.push(f);
  }
  let mergedRows = out;
  if (weeklyMerge) {
    mergedRows = [];
    for (const f of out) {
      if (!f) continue;
      const dup = f.invalidated ? null : mergedRows.find((m) => m && !m.invalidated
        && String(m.person || '') === String(f.person || '')
        && bigramSimilarity(String(m.fact || ''), String(f.fact || '')) >= 0.55);
      if (dup) {
        if ((Number(f.importance) || 3) > (Number(dup.importance) || 3)) {
          dup.fact = f.fact;
          dup.importance = Number(f.importance);
        } else {
          dup.importance = Math.max(Number(dup.importance) || 3, Number(f.importance) || 3);
        }
        dup.updatedAt = Math.max(Number(dup.updatedAt) || 0, Number(f.updatedAt) || 0);
        dup.lastHitAt = Math.max(Number(dup.lastHitAt) || 0, Number(f.lastHitAt) || 0);
        dup.sources = [...new Set([...(dup.sources || []), ...(f.sources || [])])];
        if (f.legacyId && !dup.legacyId) dup.legacyId = f.legacyId;
        stats.factsMerged += 1;
      } else {
        mergedRows.push({ ...f, sources: Array.isArray(f.sources) ? [...f.sources] : [] });
      }
    }
  }
  const eps = [];
  for (const e of episodes) {
    if (!e) continue;
    const age = nowMs - (Number(e.time) || 0);
    const s = threeFactorScore({ atMs: Number(e.time) || 0, importance: Number(e.importance) || 3, relevance: 0, nowMs });
    if (age > Math.max(1, episodeMaxAgeDays) * 86400000 && s < minEpisodeScore) { stats.episodesDropped += 1; continue; }
    eps.push(e);
  }
  return { episodes: eps, facts: mergedRows, stats };
}
