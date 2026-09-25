// P1-4 回归测试：好感度双维度（熟识度 + 好感度）
//
// 三段：
//   U 段  纯函数单测（src/affinity-model.js）—— 熟识度曲线、档位边界、主动乘数、让步判定，边界全喂
//   接线  源码级检查 —— 明确标注「只能证明那段代码还在，不等于行为被验证」，
//         但其中有一条是**真断言**：affinityBoostFor 的调用点数量（红线守卫，见下）
//   H 段  HTTP + DB 端到端 —— 只碰合成 memberId，跑完删除
//
// 三段各自的用途：
//   U 段防「公式写错」（熟识度封顶、负好感下限、让步误判）
//   接线段防「代码被删/被改回去」
//   H 段防「迁移没跑 / 端点没接线 / 只读端点偷偷建行」
//
// 🚫 红线（照搬 zaofan）：**低好感只降「她愿不愿意自己开口」的频率，绝不改变语气。**
//   代码层的落点就是：好感度唯一的消费点是 affinityBoostFor，
//   而 affinityBoostFor 在 bridge.js 里**只允许出现 2 次**（1 处定义 + 1 处调用）。
//   这条计数断言就是红线的自动化守卫 —— 谁把好感度接到措辞/称呼/是否回复上，这里立刻红。
//
// 跑：node ops/test-affinity.mjs

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  familiarityFromStats, familiarityTier, affinityTier, isNewActiveDay,
  affinityBoostFromScores, hasNegativeSignal, hasFriendlySignal, detectConcession,
  concessionDetectEnabled, concessionRollover, concessionAllowed, relationLine,
  CONCESSION_DELTA, CONCESSION_DAILY_CAP, FAM_DAYS_FULL, FAM_INTERACTIONS_FULL, FAM_MENTIONS_FULL,
  FAM_MAX, BOOST_MAX, BOOST_MIN
} from '../src/affinity-model.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';
const SYNTH_ID = '123456789';   // 合成靶子：真实库里不该有这个人的档案

const outFile = path.join(ROOT, '..', 'outbox', 'pc-jobs', 'test-affinity.log');
try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch {}
try { fs.writeFileSync(outFile, ''); } catch {}
function say(line) {
  console.log(line);
  try { fs.appendFileSync(outFile, line + '\n'); } catch {}
}
let pass = 0, fail = 0, skip = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; say(`✅ ${name}${extra ? '  ' + extra : ''}`); } else { fail++; say(`❌ ${name}${extra ? '  ' + extra : ''}`); }
}
function skipped(name, why = '') { skip++; say(`⏭️  ${name}（跳过${why ? '：' + why : ''}）`); }
function section(t) { say(`\n── ${t} ──`); }

// 令牌只读不打印（日志会落盘到 outbox，绝不把值写进去）
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));

const sessions = [];
(function walk(node, keyHint) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.agentToken === 'string' && node.agentToken) { sessions.push({ key: keyHint, token: node.agentToken }); return; }
  for (const [k, v] of Object.entries(node)) walk(v, /^(group|private):\d+$/.test(k) ? k : keyHint);
})(sv, '');
const ownerKey = 'private:' + String(cfg.ownerQQ ?? '').trim();
const owner = sessions.find((s) => s.key === ownerKey);
if (!owner) { console.log(`❌ 找不到主人私聊会话（${ownerKey}）的令牌，无法测试`); process.exit(1); }

async function req(pathname, body, token) {
  const headers = { 'x-console-token': consoleToken };
  if (token !== undefined && token !== null) headers['x-agent-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

let db = null;
function openDb() {
  if (!db) {
    db = new DatabaseSync(path.join(ROOT, 'state', 'memory.db'));
    db.exec('PRAGMA busy_timeout = 3000');
  }
  return db;
}
const hasTable = (t) => !!openDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
function finish(code) { setTimeout(() => process.exit(code), 500); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

say('P1-4 回归：好感度双维度（熟识度自动累计 + 好感度可升可降）');
say(`主人私聊 ${ownerKey}　合成靶子 memberId=${SYNTH_ID}（共 ${sessions.length} 个会话令牌，值不打印）`);

// ─────────────────────────────────────────────────────────────────────────────
section('U 段：familiarityFromStats（熟识度曲线：慢变量、只增不减、三维独立封顶）');
{
  const zero = familiarityFromStats({});
  check('全零 → 熟识度 0', zero.familiarity === 0, `parts=${JSON.stringify(zero.parts)}`);

  const full = familiarityFromStats({ activeDays: FAM_DAYS_FULL, interactions: FAM_INTERACTIONS_FULL, mentions: FAM_MENTIONS_FULL });
  check('三项都刷满 → 熟识度 100', full.familiarity === FAM_MAX, `parts=${JSON.stringify(full.parts)}`);

  const over = familiarityFromStats({ activeDays: 9999, interactions: 999999, mentions: 9999 });
  check('远超满分 → 仍封顶 100（不能溢出）', over.familiarity === FAM_MAX, `实际=${over.familiarity}`);

  const onlyDays = familiarityFromStats({ activeDays: 9999 });
  check('只刷天数 → 40 分封顶（单一维度到不了「自己人」）', onlyDays.familiarity === 40, `实际=${onlyDays.familiarity}`);
  const onlyMsg = familiarityFromStats({ interactions: 999999 });
  check('只刷条数 → 40 分封顶', onlyMsg.familiarity === 40, `实际=${onlyMsg.familiarity}`);
  const onlyAt = familiarityFromStats({ mentions: 9999 });
  check('只刷被点名 → 20 分封顶', onlyAt.familiarity === 20, `实际=${onlyAt.familiarity}`);

  let bad = '';
  for (const v of [-5, -1, NaN, undefined, 'abc', null, Infinity]) {
    const r = familiarityFromStats({ activeDays: v, interactions: v, mentions: v });
    if (!Number.isFinite(r.familiarity) || r.familiarity < 0 || r.familiarity > FAM_MAX) bad = String(v);
  }
  check('非法输入（负数/NaN/字符串/Infinity）不炸且被夹在 0~100', bad === '', bad ? `坏值=${bad}` : '');

  // 单调性：任一维增加，输出不得减少（熟识度「只增不减」的数学保证）
  let monoOk = true, monoCase = '';
  for (let i = 0; i < 40; i++) {
    const a = { activeDays: i % 25, interactions: i * 3, mentions: i % 12 };
    const b = { activeDays: a.activeDays + 1, interactions: a.interactions + 1, mentions: a.mentions + 1 };
    if (familiarityFromStats(b).familiarity < familiarityFromStats(a).familiarity) { monoOk = false; monoCase = JSON.stringify(a); }
  }
  check('单调不减（吵架/沉默不会让她忘记你）', monoOk, monoCase ? `反例=${monoCase}` : '穷举 40 组');

  const mid = familiarityFromStats({ activeDays: 9, interactions: 41, mentions: 1 });
  check('三项分数之和 === 熟识度', mid.parts.days + mid.parts.interactions + mid.parts.mentions === mid.familiarity, `${mid.parts.days}+${mid.parts.interactions}+${mid.parts.mentions}=${mid.familiarity}`);
}

section('U 段：档位边界（提示词里的称呼亲密度由它决定，边界错一格就会串档）');
{
  const famCases = [[0, '陌生'], [19, '陌生'], [20, '眼熟'], [39, '眼熟'], [40, '熟人'], [59, '熟人'], [60, '老友'], [79, '老友'], [80, '自己人'], [100, '自己人']];
  let bad = '';
  for (const [v, want] of famCases) { const got = familiarityTier(v).label; if (got !== want) bad += `${v}→${got}(期望${want}) `; }
  check('熟识度档位 10 个边界全对', bad === '', bad || '0/19/20/39/40/59/60/79/80/100');

  const affCases = [[-100, '疏离'], [-40, '疏离'], [-39, '冷淡'], [-10, '冷淡'], [-9, '中性'], [9, '中性'], [10, '亲近'], [39, '亲近'], [40, '亲密'], [100, '亲密']];
  bad = '';
  for (const [v, want] of affCases) { const got = affinityTier(v).label; if (got !== want) bad += `${v}→${got}(期望${want}) `; }
  check('好感度档位 10 个边界全对', bad === '', bad || '-100/-40/-39/-10/-9/9/10/39/40/100');
}

section('U 段：isNewActiveDay（「来过几天」的去重；必须按本地日，不能用 UTC）');
{
  check('首次见到（空 → 有）算新的一天', isNewActiveDay('', '2026-09-25') === true);
  check('同一天不算新的一天', isNewActiveDay('2026-09-25', '2026-09-25') === false);
  check('跨天算新的一天', isNewActiveDay('2026-09-24', '2026-09-25') === true);
  check('空白串当首次（不能因为脏数据把老面孔算成新面孔）', isNewActiveDay('   ', '2026-09-25') === true);
}

section('U 段：affinityBoostFromScores（好感度**唯一**的消费点；红线在这里落地）');
{
  check('没有任何好感记录 → 乘数 1（不认识 = 不加不减）', affinityBoostFromScores([]) === 1);
  check('全是 0 分 → 乘数 1', affinityBoostFromScores([0, 0]) === 1);
  check('非法值被过滤掉 → 乘数 1', affinityBoostFromScores([NaN, 'x', null, undefined]) === 1);
  check('正好感 → 提升（+50 → 1.2）', Math.abs(affinityBoostFromScores([50, 50]) - 1.2) < 1e-9);
  check(`正好感封顶 +${BOOST_MAX}（+1000 也只有 1.4）`, Math.abs(affinityBoostFromScores([1000]) - (1 + BOOST_MAX)) < 1e-9);
  check(`负好感下限 ${BOOST_MIN}（-1000 也只降到 0.7）`, Math.abs(affinityBoostFromScores([-1000]) - (1 + BOOST_MIN)) < 1e-9);
  check('正负混合互相抵消（-100 与 +100 → 1）', Math.abs(affinityBoostFromScores([-100, 100]) - 1) < 1e-9);

  // 红线守卫：无论输入多负，乘数都必须 > 0 且 >= 0.7 —— 负好感的唯一后果是「少主动」
  let floorOk = true, worst = Infinity;
  for (const v of [-100, -1000, -1e9, -50]) { const b = affinityBoostFromScores([v]); worst = Math.min(worst, b); if (!(b >= 1 + BOOST_MIN - 1e-9)) floorOk = false; }
  check('🚫 红线：负好感再低也只会少主动，乘数不为 0/不为负', floorOk && worst === 1 + BOOST_MIN, `最低=${worst}`);
  check('旧版行为已被改掉：全是负分时旧版返回 1（等于毫无后果），新版必须 < 1', affinityBoostFromScores([-50]) < 1, `新版=${affinityBoostFromScores([-50])}`);
}

section('U 段：让步判定（心里不肯、话仍照顾）—— 保守优先，宁可漏判');
{
  check('负面词命中：懒得理', hasNegativeSignal('哼，懒得理他。') === true);
  check('负面词命中：无语', hasNegativeSignal('……无语。') === true);
  check('没有负面词 → false（普通句子不能被误判）', hasNegativeSignal('好呀，我这就去看看。') === false);
  check('友好词命中：谢谢你呀～', hasFriendlySignal('谢谢你呀～') === true);
  check('友好词命中：抱抱', hasFriendlySignal('抱抱你') === true);
  check('友好词命中：emoji', hasFriendlySignal('好耶 🥰') === true);
  check('冷淡正文不算友好（「嗯。」）', hasFriendlySignal('嗯。') === false);

  const both = detectConcession('哼，懒得理他。', ['谢谢你呀～']);
  check('两侧都命中 → 判定为让步', both.concession === true && both.delta === CONCESSION_DELTA, `delta=${both.delta}`);
  const onlyNeg = detectConcession('哼，懒得理他。', ['嗯。']);
  check('只有内心负面、正文不友好 → **不算**让步（保守）', onlyNeg.concession === false && onlyNeg.delta === 0);
  const onlyFri = detectConcession('好呀，我来帮你。', ['谢谢你呀～']);
  check('内心本来就友好 → 不算让步（不能拿正常亲切扣分）', onlyFri.concession === false);
  const noWords = detectConcession('哼，懒得理他。', []);
  check('她这轮根本没说话 → 不算让步（没出口就不存在「照顾」）', noWords.concession === false);
  const multi = detectConcession('不想说话。', ['嗯。', '那你早点睡呀～']);
  check('多段正文里只要有一段友好 → 算让步', multi.concession === true);
  const strArg = detectConcession('哼，懒得理他。', '谢谢你呀～');
  check('第二个参数传字符串也能用（不给调用方埋坑）', strArg.concession === true);
  check('让步只扣 1 分（不能一次扣穿）', CONCESSION_DELTA === -1, `delta=${CONCESSION_DELTA}`);
  check('让步每天最多 2 次', CONCESSION_DAILY_CAP === 2, `cap=${CONCESSION_DAILY_CAP}`);
}

section('U 段：让步开关与每日限额');
{
  check('未配置 → 默认开启', concessionDetectEnabled(undefined) === true);
  check('显式 true → 开启', concessionDetectEnabled(true) === true);
  check('显式 false → 关闭（误判伤关系，必须能一键关断）', concessionDetectEnabled(false) === false);

  const same = concessionRollover('2026-09-25', '2026-09-25', 2);
  check('同一天 → 沿用当日已用次数', same.used === 2 && same.day === '2026-09-25', JSON.stringify(same));
  const next = concessionRollover('2026-09-24', '2026-09-25', 2);
  check('跨天 → 当日次数归零（否则昨天用完了今天就不能算）', next.used === 0 && next.day === '2026-09-25', JSON.stringify(next));
  const first = concessionRollover('', '2026-09-25', 0);
  check('首次（空日键）→ 从 0 开始', first.used === 0);

  check('已用 0 次 → 允许', concessionAllowed(0) === true);
  check('已用 1 次 → 允许（第 2 次）', concessionAllowed(1) === true);
  check('已用 2 次（到上限）→ 拒绝', concessionAllowed(2) === false);
  check('超出上限 → 仍拒绝', concessionAllowed(99) === false);
}

section('U 段：提示词注入行（熟识度必须真的写进上下文）');
{
  const line = relationLine({ name: '小明', uid: '123456', score: 12, familiarity: 45, activeDays: 9, interactions: 41 });
  check('关系行含好感度与档位', line.includes('好感度 12') && line.includes('亲近'), line);
  check('关系行含熟识度与档位', line.includes('熟识度 45') && line.includes('熟人'), line);
  check('关系行含「认识 N 天、说过 M 句」（她演得有据）', line.includes('认识 9 天') && line.includes('说过 41 句'), line);
  const blank = relationLine({ name: '陌生人', uid: '999999' });
  check('零数据的人显示「新面孔」而不是「认识 0 天」', blank.includes('新面孔'), blank);
  check('没有 uid 时不渲染空括号', relationLine({ name: '甲' }).includes('甲') === true && !relationLine({ name: '甲' }).includes('()'));

  const red = detectConcession('哼，懒得理他。', ['谢谢你呀～']);
  check('让步判定与注入行是两个独立出口（注入行不带判定结果）', red.concession === true && !line.includes('让步'));
}

// ─────────────────────────────────────────────────────────────────────────────
section('接线段：源码级检查（只证明代码还在，**不等于**行为被验证）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const strip = (block) => block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  check('bridge.js 导入了 affinity-model', /from '\.\/affinity-model\.js'/.test(src));
  check('迁移声明了 familiarity 列', src.includes('familiarity INTEGER NOT NULL DEFAULT 0'));
  check('迁移声明了 last_seen_day（本地日键）', /last_seen_day TEXT NOT NULL DEFAULT/.test(src));
  check('迁移声明了 concession_day / concession_used（每日限额）', src.includes('concession_used INTEGER NOT NULL DEFAULT 0'));
  check('入站消息处调用了 noteMemberActivityV2', /noteMemberActivityV2\(msg\.userId, sender/.test(src));
  check('已发送消息处调用了 noteOutboundV2', /noteOutboundV2\(key, list\)/.test(src));
  check('reserved2 内部输出分支调用了 noteConcessionV2', /noteConcessionV2\(key, plain, turnOutboundV2\.get\(key\)/.test(src));
  check('turnOutboundV2 在本轮结束后被清掉（防跨轮串味）', /finally \{ turnOutboundV2\.delete\(key\); \}/.test(src));
  check('withAffinityContext 用了 relationLine', /top\.map\(\(r\) => relationLine\(/.test(src));
  check('withAffinityContext 注入了红线说明', src.includes('AFFINITY_REDLINE_NOTE'));

  // 🚫 红线守卫：好感度的唯一消费点是主动概率乘数。
  // affinityBoostFor 只允许出现 2 次（1 处定义 + 1 处调用）。出现第 3 次 = 有人把好感度
  // 接到了措辞/称呼/是否回复上，那时「负好感也绝不冷落」的承诺就破了。
  const boostUses = (src.match(/affinityBoostFor\s*\(/g) ?? []).length;
  check('🚫 红线：affinityBoostFor 只有 1 处定义 + 1 处调用（好感度不得接进措辞分支）', boostUses === 2, `实际出现 ${boostUses} 次`);

  const boostBlock = strip(src.slice(src.indexOf('function affinityBoostFor'), src.indexOf('function affinityBoostFor') + 1200));
  check('affinityBoostFor 内部把判断交给了纯函数（不在闭包里手算）', boostBlock.includes('affinityBoostFromScores(scores)'));
  check('affinityBoostFor 上方写明了红线注释', src.slice(Math.max(0, src.indexOf('function affinityBoostFor') - 400), src.indexOf('function affinityBoostFor')).includes('红线'));

  // affinityTier / familiarityTier 只应出现在「展示层」（注入行、端点响应），不得出现在发送/唤醒判定里
  const tierInSend = /(sendToQQ|sendBurstToQQ|sendWakePromptV2|buildWakePromptV2)[\s\S]{0,4000}?affinityTier/.test(src);
  check('🚫 红线：好感度档位没有出现在发送/唤醒文案分支里', tierInSend === false);
}

// ─────────────────────────────────────────────────────────────────────────────
section('H 段：端到端（只碰合成 memberId，跑完删干净）');
{
  const p = await req('/api/panel/affinity');
  check('面板 /api/panel/affinity 可达', p.status === 200, `status=${p.status}`);
  check('返回体 ok=true', p.json?.ok === true, `json=${JSON.stringify(p.json)?.slice(0, 120)}`);
  check('affinity 是数组（功能未上线时这里是 undefined）', Array.isArray(p.json?.affinity), `实际=${typeof p.json?.affinity}`);
  check('让步每日上限被暴露出来（=2）', p.json?.concessionDailyCap === CONCESSION_DAILY_CAP, `实际=${p.json?.concessionDailyCap}`);
  check('让步判定开关被暴露出来（配置未设时为 true）', p.json?.concessionDetect === true, `实际=${p.json?.concessionDetect}`);

  // ⚠️ 守卫必须细到**列**，不能只判到表：affinity 表从 P4 起就存在，
  // 只是每次升级加列。只判表存在 → 后面的 SELECT familiarity 会以
  // `no such column` 崩掉整个测试（第一版就是这么死的），而崩溃看起来像脚本坏了，
  // 掩盖了「迁移没跑」这个真正要报的信号。
  const NEW_COLS = ['familiarity', 'first_seen', 'last_seen', 'last_seen_day', 'active_days', 'interactions', 'mentions', 'concessions', 'concession_day', 'concession_used'];
  const tableExists = hasTable('affinity');
  const colsNow = tableExists ? openDb().prepare('PRAGMA table_info(affinity)').all().map((c) => c.name) : [];
  const colsOk = tableExists && NEW_COLS.every((c) => colsNow.includes(c));

  if (!tableExists) {
    skipped('affinity 表存在', '表不存在（功能未上线/迁移没跑）');
  } else {
    const cols = colsNow;
    const missing = NEW_COLS.filter((c) => !cols.includes(c));
    check('affinity 表 10 个新列全部迁移到位', missing.length === 0, missing.length ? `缺=${missing.join(',')}` : `共 ${cols.length} 列`);
    check('老列没被弄丢（score/notes/name 仍在）', ['member_id', 'name', 'score', 'notes', 'updated_at'].every((c) => cols.includes(c)));
  }

  if (!colsOk) {
    skipped('H3 只读端点零副作用', '新列未迁移，查询无意义');
    skipped('H4 agent 端点回带 familiarity/档位', '新列未迁移，查询无意义');
    skipped('H4 bump 建行不伪造熟识度', '新列未迁移，查询无意义');
    skipped('H5 真实入站消息自动累计熟识度', '新列未迁移，查询无意义');
  } else {

    // H3 只读端点绝不能偷偷建行 —— 合成 memberId 查完必须一点痕迹都没有
    const before = openDb().prepare('SELECT COUNT(*) AS n FROM affinity WHERE member_id = ?').get(SYNTH_ID).n;
    await req(`/api/panel/affinity?memberId=${SYNTH_ID}`);
    const after = openDb().prepare('SELECT COUNT(*) AS n FROM affinity WHERE member_id = ?').get(SYNTH_ID).n;
    check('只读端点查不存在的人不建行（零副作用）', before === 0 && after === 0, `查前=${before} 查后=${after}`);

    // H4 走真实端点：get 不建行、bump 建行并回带新字段
    const g1 = await req('/api/socialV2/affinity', { key: ownerKey, action: 'get', memberId: SYNTH_ID }, owner.token);
    check('agent 端点 get 返回 familiarity 字段（未上线时这里是 undefined）', typeof g1.json?.affinity?.familiarity === 'number', `familiarity=${g1.json?.affinity?.familiarity}`);
    check('agent 端点 get 带档位标签', typeof g1.json?.affinity?.tier === 'string' && typeof g1.json?.affinity?.familiarityTier === 'string', `tier=${g1.json?.affinity?.tier}/${g1.json?.affinity?.familiarityTier}`);
    const cntAfterGet = openDb().prepare('SELECT COUNT(*) AS n FROM affinity WHERE member_id = ?').get(SYNTH_ID).n;
    check('agent 端点 get 也不建行', cntAfterGet === 0, `行数=${cntAfterGet}`);

    const b1 = await req('/api/socialV2/affinity', { key: ownerKey, action: 'bump', memberId: SYNTH_ID, delta: 5, name: '__affinity_test__' }, owner.token);
    check('agent 端点 bump 成功并回带 score', b1.json?.ok === true && Number(b1.json?.affinity?.score) === 5, `score=${b1.json?.affinity?.score}`);
    const seeded = openDb().prepare('SELECT member_id, name, score, familiarity, interactions, mentions FROM affinity WHERE member_id = ?').get(SYNTH_ID);
    check('bump 建出的行：熟识度 0、互动 0（**手填好感度不会伪造熟识度**）', Number(seeded?.familiarity) === 0 && Number(seeded?.interactions) === 0, JSON.stringify(seeded));

    // H5 真实累计：等一条真实入站消息把 interactions 顶起来。
    // 等不到就**跳过**，绝不 fail —— 没有新消息不是缺陷，不能为了绿灯去伪造消息。
    {
      const sum0 = Number(openDb().prepare('SELECT COALESCE(SUM(interactions),0) AS n FROM affinity').get().n);
      let grew = false;
      for (let i = 0; i < 36; i++) {   // 最多约 180 秒
        await sleep(5000);
        const s = Number(openDb().prepare('SELECT COALESCE(SUM(interactions),0) AS n FROM affinity').get().n);
        if (s > sum0) { grew = true; break; }
      }
      if (grew) {
        const top = openDb().prepare('SELECT member_id, name, interactions, mentions, active_days, familiarity FROM affinity WHERE interactions > 0 ORDER BY interactions DESC LIMIT 3').all();
        check('真实入站消息自动累计了熟识度（不靠 AI 手填）', grew, `样例=${JSON.stringify(top.map((r) => ({ id: r.member_id, 条数: r.interactions, 点名: r.mentions, 天数: r.active_days, 熟识度: r.familiarity })))}`);
      } else {
        skipped('真实入站消息会自动累计熟识度', '180 秒内没有新的入站消息（不是缺陷，等有真实消息时再看）');
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('收尾：清理探针行');
{
  try {
    if (!hasTable('affinity')) {
      skipped('收尾清理', '表不存在');
    } else {
      const n = openDb().prepare('DELETE FROM affinity WHERE member_id = ?').run(SYNTH_ID).changes;
      const left = openDb().prepare("SELECT COUNT(*) AS n FROM affinity WHERE name LIKE '__affinity_test__%'").get().n;
      check('收尾清干净（生产库里不留探针行）', Number(left) === 0, `删了 ${n} 行，剩余 ${left}`);
      const p = await req('/api/panel/affinity');
      check('收尾后面板仍可读（删行没把端点弄坏）', p.status === 200 && p.json?.ok === true);
    }
  } catch (e) {
    fail++;
    say(`❌ 收尾清理异常：${e?.message ?? e}`);
  }
}

if (db) { try { db.close(); } catch {} }
say(`\n──────── 结果：${pass} 通过 / ${fail} 失败 / ${skip} 跳过 ────────`);
say(`日志副本：${outFile}`);
finish(fail > 0 ? 1 : 0);
