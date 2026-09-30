// 鲸鲸 2.0 A 层纯函数单测（docs/upgrade-plan-2026-10.md E 系列）：
//   node scripts/test-memory-v2.mjs   （退出码 0 = 全绿）
// 覆盖：流行格式/三因子衰减/mem0 操作语义（ADD 去重升级、UPDATE、DELETE 软删、复活）/
//       Episode 解析 clamp/事实 ops 容错解析/存量导入映射/共享组过滤/渲染。
import {
  sanitizeStreamKey, makeStreamLine, threeFactorScore, applyFactOps,
  parseEpisodeJson, normalizeEpisode, parseFactOps, legacyFactToV2,
  visibleKeysFor, renderEpisodeLines, matchFact,
  scoreMemoryV2Candidates, maintainMemoryV2Rows
} from '../src/memory-v2.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); failed += 1; }
}

// ── A1 流行格式 ──
assert(sanitizeStreamKey('group:471975044') === 'group-471975044', 'sanitize group');
assert(sanitizeStreamKey('private:1918594889') === 'private-1918594889', 'sanitize private');
assert(sanitizeStreamKey('') === 'unknown', 'sanitize empty');
const line = makeStreamLine({ kind: 'message', sender: 'A', text: 'x'.repeat(600), time: 1000 });
assert(line.text.length === 500, 'text capped at 500');
assert(line.time === 1000, 'time passthrough');
assert(makeStreamLine(null).text === '', 'null msg safe');

// ── A4 三因子：指数衰减 + importance/relevance 边界 ──
const now = 1_000_000_000_000;
const sFresh = threeFactorScore({ atMs: now, importance: 10, relevance: 1, nowMs: now });
const sOld = threeFactorScore({ atMs: now - 14 * 86400000, importance: 10, relevance: 1, nowMs: now });
assert(sFresh > sOld, 'recency decay');
assert(sOld > 0, 'old not zero (floor)');
assert(threeFactorScore({ atMs: now, importance: 0, relevance: 0, nowMs: now }) > 0, 'floors avoid zero');
assert(threeFactorScore({ atMs: now, importance: 99, relevance: 5, nowMs: now }) <= threeFactorScore({ atMs: now, importance: 10, relevance: 1, nowMs: now }), 'clamps cap score');

// ── A3 mem0 操作语义 ──
const ctx = (nowMs) => ({ streamKey: 'private:1918594889', now: nowMs });
let rows = [];
const r1 = applyFactOps(rows, [{ op: 'ADD', person: '主人', fact: '喜欢吃辣', importance: 7 }], ctx(100));
assert(r1.rows.length === 1 && r1.rows[0].id === 1 && r1.applied[0].op === 'ADD', 'ADD creates row');

const r2 = applyFactOps(r1.rows, [{ op: 'ADD', person: '主人', fact: '喜欢吃吃辣的东西', importance: 7 }], ctx(200));
assert(r2.rows.length === 1 && r2.applied[0].op === 'UPDATE', 'similar ADD upgrades to UPDATE (dedupe)');

const r3 = applyFactOps(r2.rows, [{ op: 'UPDATE', person: '主人', fact: '最近吃不了辣，胃不舒服', importance: 8 }], ctx(300));
assert(r3.rows.length === 1 && r3.rows[0].fact.includes('胃不舒服') && r3.rows[0].updatedAt === 300, 'UPDATE rewrites fact');

const r4 = applyFactOps(r3.rows, [{ op: 'DELETE', person: '主人', fact: '最近吃不了辣，胃不舒服' }], ctx(400));
assert(r4.rows.length === 1 && r4.rows[0].invalidated === true && r4.rows[0].invalidatedAt === 400, 'DELETE is soft (invalidated)');

const r5 = applyFactOps(r4.rows, [{ op: 'ADD', person: '小张', fact: '喜欢熬夜', importance: 5 }], ctx(500));
assert(r5.rows.length === 2 && r5.applied[0].op === 'ADD', 'ADD after soft-delete adds new person');

// 无 id 的 UPDATE 不复活作废行：同 person 有效行不存在 → 退化为 ADD 新行，旧行保持 invalidated
const r6 = applyFactOps(r5.rows, [{ op: 'UPDATE', person: '主人', fact: '胃好了又能吃辣了', importance: 7 }], ctx(600));
assert(r6.rows.length === 3, 'UPDATE after delete adds a new row');
const revivedNew = r6.rows.find((r) => r.fact.includes('胃好了'));
assert(revivedNew && revivedNew.invalidated === false, 'new row valid');
assert(r6.rows[0].invalidated === true, 'old row stays invalidated');
// 带 id 的 UPDATE 直达作废行 → 复活
const r6b = applyFactOps(r6.rows, [{ op: 'UPDATE', id: 1, fact: '胃好了又能吃辣了', importance: 7 }], ctx(650));
assert(r6b.rows.length === 3 && r6b.rows.find((r) => r.id === 1).invalidated === false, 'UPDATE by id revives');

// person 不同的近似事实不该互相合并
const r7 = applyFactOps(r6.rows, [{ op: 'ADD', person: '别人', fact: '最近吃不了辣，胃不舒服', importance: 5 }], ctx(700));
assert(r7.rows.length === 4, 'person mismatch does not merge');

// matchFact 按 id 直达
const hit = matchFact(r7.rows, '', '', 2);
assert(hit.row && hit.row.id === 2, 'matchFact by id');
const noHit = matchFact(r7.rows, '陌生人', '完全无关的话');
assert(!noHit.row, 'no match returns null');

// ── A2 Episode 解析（围栏/前导文本/importance clamp）──
const epRaw = '好的，结果如下：\n```json\n{"summary":"大家周末聊了出游计划，气氛很轻松","participants":["A","B"],"feeling":"开心","importance":99,"tags":["出游"]}\n```';
const ne = normalizeEpisode(parseEpisodeJson(epRaw), { key: 'group:1', spanFrom: 1, spanTo: 2, msgCount: 30, id: 5, now: 123 });
assert(ne !== null, 'episode parsed from fenced output');
assert(ne.importance === 10, 'importance clamped to 10');
assert(ne.summary.includes('出游'), 'summary extracted');
assert(ne.time === 123 && ne.msgCount === 30, 'metadata passthrough');
assert(normalizeEpisode(parseEpisodeJson('not json at all'), {}) === null, 'garbage returns null');
assert(normalizeEpisode({ summary: '   ' }, {}) === null, 'empty summary rejected');

// ── A3 ops 解析容错（尾逗号）──
const ops = parseFactOps('{"ops":[{"op":"ADD","person":"A","fact":"f1","importance":4},{"op":"DELETE","person":"B","fact":"f2"},]}');
assert(ops.length === 2 && ops[0].op === 'ADD' && ops[1].op === 'DELETE', 'ops trailing comma tolerated');
assert(parseFactOps('{"ops":[]}').length === 0, 'empty ops');
assert(parseFactOps('完全不是JSON').length === 0, 'garbage ops safe');

// ── 存量导入映射 ──
const lf = legacyFactToV2({ id: 9, content: '旧事实', category: 'fact', source_key: 'private:1918594889', importance: 3, created_at: 50, updated_at: 60 }, 77);
assert(lf.id === 77 && lf.importance === 6 && lf.legacyId === 9, 'legacy maps id/importance×2');
assert(lf.invalidated === false, 'legacy starts valid');

// ── A4 共享组 ──
const vk = visibleKeysFor('group:471975044', [['private:1918594889', 'group:471975044']]);
assert(vk.has('private:1918594889') && vk.has('group:471975044'), 'shared group exposes both');
assert(!vk.has('group:1132819177'), 'other groups isolated');
assert(visibleKeysFor('group:1', null).size === 1, 'null groups = no sharing');

// ── A5 渲染 ──
const rl = renderEpisodeLines([
  { time: Date.now(), summary: '第一段', tags: ['t'], importance: 5 },
  { time: Date.now(), summary: '第二段', tags: [], importance: 5 },
  { time: Date.now(), summary: '已作废', invalidated: true }
], { limit: 3, maxChars: 400 });
assert(rl.includes('第一段') && rl.includes('第二段') && !rl.includes('已作废'), 'render skips invalidated');
assert(renderEpisodeLines([], {}) === '', 'empty render');

// ── A4/A5 三因子召回 ──
const nowMs = 1_000_000_000_000;
const scored = scoreMemoryV2Candidates({
  episodes: [
    { id: 1, key: 'group:1', time: nowMs - 3600000, summary: '大家约了周末爬山', importance: 6, tags: ['出游'] },
    { id: 2, key: 'group:1', time: nowMs - 200 * 86400000, summary: '旧聊天', importance: 2 },
    { id: 3, key: 'group:1', time: nowMs - 3600000, summary: '已作废情节', importance: 8, invalidated: true }
  ],
  facts: [
    { id: 10, person: '小张', fact: '喜欢熬夜打单机', importance: 6, sources: ['group:1'], updatedAt: nowMs - 86400000, lastHitAt: nowMs - 86400000 },
    { id: 11, person: '主人', fact: '主人只在我私聊里说过的事', importance: 8, sources: ['private:1918594889'], updatedAt: nowMs - 3600000, lastHitAt: nowMs - 3600000 },
    { id: 12, person: '小张', fact: '已作废事实', importance: 8, sources: ['group:1'], invalidated: true, updatedAt: nowMs - 3600000 }
  ],
  queryText: '周末爬山 熬夜',
  nowMs,
  allowedSources: new Set(['group:1']),
  presentPeople: ['小张'],
  maxEpisodes: 2, maxFacts: 4, minScore: 0.05
});
assert(scored.episodes.length >= 1 && scored.episodes[0].text.includes('爬山'), 'relevant episode surfaces');
assert(!scored.episodes.some((x) => x.text.includes('已作废情节')), 'invalidated episode skipped');
assert(scored.facts.some((x) => x.id === 10), 'person-present fact surfaces');
assert(!scored.facts.some((x) => x.id === 11), 'private-sourced fact blocked in group (allowedSources)');
assert(!scored.facts.some((x) => x.id === 12), 'invalidated fact skipped');
// 私聊（allowedSources=null）：主人的私聊事实可见
const scoredPrivate = scoreMemoryV2Candidates({
  facts: [{ id: 11, person: '主人', fact: '主人只在我私聊里说过的事', importance: 8, sources: ['private:1918594889'], updatedAt: nowMs - 3600000, lastHitAt: nowMs - 3600000 }],
  queryText: '随便聊点什么', nowMs, allowedSources: null, minScore: 0.05
});
assert(scoredPrivate.facts.length === 1, 'private chat sees private-sourced facts');

// ── A10 维护 ──
const mt = maintainMemoryV2Rows({
  episodes: [
    { id: 1, key: 'group:1', time: nowMs - 400 * 86400000, summary: '很久远的低分情节', importance: 1 },
    { id: 2, key: 'group:1', time: nowMs - 3600000, summary: '最近的情节', importance: 4 }
  ],
  facts: [
    { id: 20, person: '小张', fact: '低价值且很久没想起', importance: 3, sources: ['group:1'], createdAt: nowMs - 200 * 86400000, updatedAt: nowMs - 200 * 86400000, lastHitAt: nowMs - 200 * 86400000 },
    { id: 21, person: '主人', fact: '高价值事实', importance: 8, sources: ['private:1918594889'], createdAt: nowMs - 200 * 86400000, updatedAt: nowMs - 200 * 86400000, lastHitAt: nowMs - 200 * 86400000 },
    { id: 22, person: '小张', fact: '常被想起的低价值事实', importance: 3, sources: ['group:1'], createdAt: nowMs - 200 * 86400000, lastHitAt: nowMs - 86400000 },
    { id: 23, person: '小张', fact: '喜欢熬夜打单机', importance: 5, sources: ['group:1'], updatedAt: nowMs - 86400000, lastHitAt: nowMs - 86400000 },
    { id: 24, person: '小张', fact: '喜欢熬夜打游戏', importance: 5, sources: ['group:2'], updatedAt: nowMs - 86400000, lastHitAt: nowMs - 86400000 }
  ],
  nowMs, staleDays: 90, staleImportanceBelow: 5, episodeMaxAgeDays: 180, minEpisodeScore: 0.02, weeklyMerge: true
});
const mtFacts = new Map(mt.facts.map((f) => [f.id, f]));
assert(mtFacts.get(20)?.invalidated === true, 'stale low-importance fact invalidated');
assert(mtFacts.get(21)?.invalidated !== true, 'high-importance fact kept despite stale');
assert(mtFacts.get(22)?.invalidated !== true, 'recently-hit fact kept');
assert(!mt.episodes.some((e) => e.id === 1), 'old low-score episode dropped');
assert(mt.episodes.some((e) => e.id === 2), 'recent episode kept');
assert(mt.stats.factsMerged >= 1, 'similar same-person facts merged');
assert(mt.facts.some((f) => f.id === 23 || f.id === 24), 'merged row survives');

if (failed) { console.error(`${failed} test(s) failed`); process.exit(1); }
console.log('ALL MEMORY-V2 TESTS PASSED');
