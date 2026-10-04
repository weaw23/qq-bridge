// P8 自测：A) 记忆召回质量（私聊隔离 + 近似去重）B) 补跑调度日期数学 C) 夜间近似合并只读演练
// 用法：node ops/test-p8.mjs   （只读，不写库、不改状态）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { toBigrams, queryToMatch } from '../src/memory-engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'state', 'memory.db'));
const cfgFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const cfg = { memory: cfgFile.memory ?? {}, ownerQQ: cfgFile.ownerQQ };

// ── recallFactLines：与 src/bridge.js 中实现逐行对应（改动请同步两边） ──
function recallFactLines(key, st, limit) {
  try {
    if (cfg.memory?.enabled === false || cfg.memory?.recallInject === false) return [];
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const others = recent.filter((m) => m && !m.isSelf);
    if (!others.length) return [];
    const max = Math.max(1, Math.min(6, Number(limit) || Number(cfg.memory?.recallInjectMax) || 4));
    const pool = new Map();
    const isGroupKey = String(key).startsWith('group:');
    const ownerQQ = String(cfg.ownerQQ ?? '');
    const ownerPresent = isGroupKey && !!ownerQQ && others.some((m) => String(m.userId ?? '') === ownerQQ);
    const privateLeak = (r) => isGroupKey && !ownerPresent && String(r?.source_key ?? '').startsWith('private:');
    const add = (rows, weight) => {
      for (const r of rows) {
        if (privateLeak(r)) continue;
        const cur = pool.get(r.id) ?? { row: r, score: 0 };
        cur.score += weight * (1 + 0.2 * (Number(r.importance) || 1)) + (String(r.source_key) === String(key) ? 0.8 : 0);
        pool.set(r.id, cur);
      }
    };
    const people = [];
    const seenPeople = new Set();
    for (let i = others.length - 1; i >= 0 && people.length < 6; i--) {
      const m = others[i];
      const uid = m.userId ? String(m.userId) : '';
      const nm = String(m.sender || '').slice(0, 20);
      if (uid && !seenPeople.has(uid)) { seenPeople.add(uid); people.push(uid); }
      if (nm && nm.length >= 2 && !seenPeople.has(nm)) { seenPeople.add(nm); people.push(nm); }
    }
    for (const p of people) {
      const like = '%' + String(p).replace(/[%_\\]/g, '') + '%';
      if (like.length < 4) continue;
      try { add(db.prepare('SELECT id, content, category, importance, source_key FROM facts WHERE content LIKE ? ORDER BY updated_at DESC LIMIT 3').all(like), 2.4); } catch {}
    }
    const texts = others.slice(-6).map((m) => String(m.plain || m.text || '')).filter((t) => t.replace(/\s/g, '').length >= 4);
    for (const t of texts) {
      const match = queryToMatch(t.slice(0, 80));
      if (!match) continue;
      try { add(db.prepare('SELECT f.id, f.content, f.category, f.importance, f.source_key FROM facts f JOIN facts_fts ON facts_fts.rowid = f.id WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts), f.importance DESC LIMIT 4').all(match), 1); } catch {}
    }
    const sigOf = (s) => toBigrams(String(s ?? '').slice(0, 80)).split(' ').filter(Boolean);
    const picked = [];
    for (const cand of [...pool.values()].sort((a, b) => b.score - a.score)) {
      const cs = sigOf(cand.row.content);
      const dup = cs.length > 0 && picked.some((p) => p.sig.length > 0 &&
        cs.filter((g) => p.sig.includes(g)).length / Math.min(cs.length, p.sig.length) >= 0.6);
      if (dup) continue;
      picked.push({ row: cand.row, score: cand.score, sig: cs });
      if (picked.length >= max) break;
    }
    let out = picked;
    if (!out.length) {
      try {
        out = db.prepare('SELECT id, content, category, importance, source_key FROM facts WHERE importance >= 4 ORDER BY updated_at DESC LIMIT 8').all()
          .filter((row) => !privateLeak(row))
          .slice(0, 2)
          .map((row) => ({ row, score: 0.5, sig: sigOf(row.content) }));
      } catch {}
    }
    return out.map((x) => ({ id: x.row.id, src: x.row.source_key, score: Number(x.score.toFixed(2)), line: '- ' + String(x.row.content).slice(0, 80) }));
  } catch (e) { console.log('recall outer err:', e.message); return []; }
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' ' + detail : ''}`);
};

console.log('=== A) 记忆召回（私聊隔离 + 近似去重）===');
const nFacts = db.prepare('SELECT COUNT(*) c FROM facts').get().c;
const nFts = db.prepare('SELECT COUNT(*) c FROM facts_fts').get().c;
console.log(`facts=${nFacts} fts=${nFts} ownerQQ=${cfg.ownerQQ}`);
check('FTS 索引条数与 facts 一致', nFacts === nFts, `(${nFacts}/${nFts})`);

const sv2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const convs = sv2.conversations || {};
let leak = 0, dupInBatch = 0, totalRecalled = 0;
const dupDetail = [];
// 与 src/bridge.js 里 recallFactLines 的 sigOf 逐字对应（改动请同步两边）。
const sigOf = (s) => toBigrams(String(s ?? '').slice(0, 80)).split(' ').filter(Boolean);
for (const k of Object.keys(convs)) {
  const st = convs[k];
  const res = recallFactLines(k, st, 4);
  totalRecalled += res.length;
  const ownerHere = k.startsWith('group:') && (st.recentMessages || []).some((m) => !m.isSelf && String(m.userId ?? '') === String(cfg.ownerQQ));
  console.log(`\n--- ${k}（recent ${Array.isArray(st.recentMessages) ? st.recentMessages.length : 0} 条，主人${k.startsWith('group:') ? (ownerHere ? '在场' : '不在场') : '—'}）→ ${res.length} 条`);
  // 判据必须跟产品一致：bridge.js 的召回去重是「前 80 字的二元词包含度 ≥ 0.6 视为同文变体」。
  // 别拿「前 16 字相同」当同文判据 —— 事实句普遍带说话人前缀（[盖刚]、[Autmi]、[爱吃布拉瓦［猫又连结］]、
  // [🔥❄🥷收藏家…]），同一个人的两条毫不相干的事实，前 16 字天然一模一样。
  // 实测（2026-10-04，全库 1082 条）：16 组前 16 字相同的事实，包含度最高的一对也只有 56%，
  // 全部低于 0.6 —— 旧写法只会在这些误报上开火，反倒漏掉真正该抓的 #1068/#1073（它俩前 16 字并不相同）。
  const pickedSigs = [];
  for (const r of res) {
    const bad = k.startsWith('group:') && !ownerHere && String(r.src).startsWith('private:');
    if (bad) leak++;
    const content = String(db.prepare('SELECT content FROM facts WHERE id=?').get(r.id)?.content ?? '');
    const sig = sigOf(content);
    const dup = sig.length > 0 && pickedSigs.some((p) => p.sig.length > 0 &&
      sig.filter((g) => p.sig.includes(g)).length / Math.min(sig.length, p.sig.length) >= 0.6);
    if (dup) { dupInBatch++; dupDetail.push(`${k} 的 #${r.id} 与批内更靠前的一条包含度 ≥0.6`); }
    pickedSigs.push({ id: r.id, sig });
    console.log(`   ${bad ? '❌泄漏' : '✅'} [id=${r.id} src=${r.src || '-'} s=${r.score}] ${r.line.slice(2, 92)}`);
  }
}
console.log('');
check('私聊事实未外泄到群会话', leak === 0, `(泄漏 ${leak} 条)`);
check('同批召回内无同文变体重复（前 80 字二元词包含度 ≥0.6）', dupInBatch === 0,
  dupInBatch === 0 ? '' : `(重复 ${dupInBatch} 处：${dupDetail.join('；')})`);
check('空会话不召回', recallFactLines('group:1', { recentMessages: [] }, 4).length === 0);
check('有会话能召回到记忆', totalRecalled > 0, `(共 ${totalRecalled} 条)`);

console.log('\n=== B) 复盘/维护补跑调度 ===');
function lastScheduledAt(hour, now) {
  const sched = new Date(now);
  sched.setHours(hour, 0, 0, 0);
  if (sched.getTime() > now.getTime()) sched.setTime(sched.getTime() - 86400000);
  return sched;
}
function shouldRun(now, targetHour, lastAt0) {
  const sched = lastScheduledAt(targetHour, now);
  const lastAt = Number(lastAt0) || 0;
  if (lastAt >= sched.getTime()) return { fire: false, why: '这一轮已跑过' };
  if (lastAt && now.getTime() - lastAt < 20 * 3600 * 1000) return { fire: false, why: '20h 内刚跑过' };
  const lateMin = Math.max(0, Math.round((now.getTime() - sched.getTime()) / 60000));
  return { fire: true, lateMin, why: lateMin > 20 ? `补跑(迟到${lateMin}分)` : '准点跑' };
}
const D = (s) => new Date(s);
const cases = [
  ['从未跑过，早上 10:00 启动', D('2026-09-24T10:00:00'), 23, 0, true],
  ['昨晚 23:00 准点跑过，今早 10:00', D('2026-09-24T10:00:00'), 23, D('2026-09-23T23:00:10').getTime(), false],
  ['今晚 23:10（当天还没跑）', D('2026-09-24T23:10:00'), 23, D('2026-09-23T23:00:10').getTime(), true],
  ['关机两天后 07:00 开机（欠 2 轮）', D('2026-09-26T07:00:00'), 23, D('2026-09-23T23:00:10').getTime(), true],
  ['今早 07:00 已补跑，今晚 23:10', D('2026-09-24T23:10:00'), 23, D('2026-09-24T07:00:00').getTime(), false],
  ['23:59 边界（仍在窗口内）', D('2026-09-24T23:59:00'), 23, D('2026-09-23T23:00:10').getTime(), true],
  ['维护 01:00 锚点，今天 01:00 跑过，现在 09:00', D('2026-09-24T09:00:00'), 1, D('2026-09-24T01:00:05').getTime(), false],
  ['维护 01:00 锚点，昨晚没跑，现在 09:00', D('2026-09-24T09:00:00'), 1, D('2026-09-22T01:00:05').getTime(), true]
];
for (const [name, now, hour, lastAt, expect] of cases) {
  const r = shouldRun(now, hour, lastAt);
  check(name, r.fire === expect, `→ fire=${r.fire}(期望${expect}) 锚点=${lastScheduledAt(hour, now).toLocaleString('zh-CN', { hour12: false })} [${r.why}]`);
}

console.log('\n=== C) 夜间近似合并演练（只读，不写库）===');
const rows = db.prepare('SELECT id, content, importance, source_key FROM facts ORDER BY id ASC').all();
const sig = (s) => new Set(toBigrams(String(s ?? '').slice(0, 120)).split(' ').filter(Boolean));
const sigs = rows.map((r) => sig(r.content));
const pairs = [];
for (let i = 0; i < rows.length; i++) {
  if (sigs[i].size < 4) continue;
  for (let j = i + 1; j < rows.length; j++) {
    if (sigs[j].size < 4) continue;
    let inter = 0;
    for (const g of sigs[i]) if (sigs[j].has(g)) inter++;
    const c = inter / Math.min(sigs[i].size, sigs[j].size);
    if (c >= 0.6) pairs.push({ a: rows[i], b: rows[j], c });
  }
}
pairs.sort((x, y) => y.c - x.c);
if (!pairs.length) console.log('（无 ≥0.6 包含度的候选对）');
for (const p of pairs) {
  console.log(`${p.c >= 0.85 ? '🔴会合并' : '⚪保留(低于0.85)'} 包含度${(p.c * 100).toFixed(0)}%  #${p.a.id} vs #${p.b.id}`);
  console.log(`     A: ${String(p.a.content).slice(0, 70)}`);
  console.log(`     B: ${String(p.b.content).slice(0, 70)}`);
}
const willMerge = pairs.filter((p) => p.c >= 0.85).length;
console.log(`\n≥0.85 将合并 ${willMerge} 对；0.6~0.85 保留 ${pairs.length - willMerge} 对`);
// 断言随「维护是否已跑过今天的锚点」而变，否则维护真跑完合并后本项必然误报失败：
//   已跑 → 库里不该再残留 ≥0.85 的近似重复（这才证明合并逻辑生效了）
//   没跑 → 只要有候选，就要求 0.85 这条线两边都有样本（阈值确实能区分）
let maintDone = false;
let lastMaintainAt = 0;
try {
  const autoM = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'autonomy.json'), 'utf8'));
  lastMaintainAt = Number(autoM.lastMaintainAt) || 0;
  maintDone = shouldRun(new Date(), 1, lastMaintainAt).fire === false;
} catch { maintDone = false; }
// 「维护跑过」只能推出「今天的 01:00 锚点被消费过了」，推不出「库里没有比它更新的事实」。
// 维护是每天一次的：锚点之后白天新写进库的事实，要等下一轮 01:00 才会被合并，
// 这期间残留 ≥0.85 的近似重复是设计内的正常状态，不是合并逻辑失效。
// 实测（2026-10-04）：lastMaintainAt=01:00:00，而 #1068(21:51:57)/#1073(21:54:31) 都在它之后新增，
// 期间共新增 57 条事实 —— 旧断言就是在这样的库里误报「合并逻辑可能失效」的。
const newestFactAt = Number(db.prepare('SELECT MAX(created_at) AS c FROM facts').get()?.c ?? 0);
const newSinceMaint = newestFactAt > lastMaintainAt;
const fmtT = (v) => (v ? new Date(Number(v)).toLocaleString('sv-SE') : '—');
const freshEnough = maintDone && !newSinceMaint;
if (freshEnough) {
  check('维护跑过且其后无新事实 → 库内不应残留 ≥0.85 的近似重复', willMerge === 0,
    willMerge === 0 ? '（重复已合并完毕，低包含度的对按设计保留）' : `（仍有 ${willMerge} 对未合并，合并逻辑可能失效）`);
  check('近似合并有候选且阈值区分明显', pairs.length > 0 && willMerge > 0 && pairs.some((p) => p.c < 0.85));
} else {
  const why = !maintDone
    ? `今天 01:00 锚点还没跑（lastMaintainAt=${fmtT(lastMaintainAt)}）`
    : `01:00 维护（${fmtT(lastMaintainAt)}）之后又新增了事实（最新 ${fmtT(newestFactAt)}），今晚 01:00 才轮到合并`;
  console.log(`⏭️  跳过「零残留」断言：${why}`);
  check('近似合并有候选且阈值区分明显', pairs.length > 0 && willMerge > 0 && pairs.some((p) => p.c < 0.85));
}

db.close();
console.log(`\n===== ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} =====`);
// 不能写 process.exit(0)：库连接与 SQLite 句柄还挂在事件循环上时强退，
// Node 24 在 Windows 上会撞 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`
// （src\win\async.c line 94）→ 进程以 -1073740791 收场，把已经跑完的通过结果全糊掉。
// 交给事件循环自然退出即可，db 已经 close 过了。
process.exitCode = failures === 0 ? 0 : 1;
