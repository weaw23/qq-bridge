// 鲸鲸 2.0 · 第 4 步单元测试：goals-core.mjs（B2 计划 / B3 目标 / A7 画像刷新纯函数）
// 跑法：node scripts/test-goals-core.mjs —— 全绿退出 0，任一失败退出 1。
import {
  DRIVES, DRIVE_KEYS, normalizeDrive, selectDrive,
  buildMorningPlanPrompt, parseMorningPlanResult,
  nextGoalId, normalizeGoal, foldGoalLines, applyGoalOps, maintainGoals,
  normalizePlan, planTopicsOf, renderPlanLines, renderGoalLines,
  buildPersonaRefreshPrompt, parsePersonaRefreshResult
} from '../src/goals-core.mjs';

let pass = 0;
let fail = 0;
const fails = [];
function check(cond, name) {
  if (cond) { pass += 1; } else { fail += 1; fails.push(name); console.error('FAIL:', name); }
}

// ── 1. 驱动定义与 normalizeDrive ─────────────────────────────────────
check(DRIVE_KEYS.length === 3 && DRIVE_KEYS.includes('curiosity') && DRIVE_KEYS.includes('sociability') && DRIVE_KEYS.includes('care'), 'DRIVE_KEYS 三驱动');
check(Math.abs(DRIVE_KEYS.reduce((a, k) => a + DRIVES[k].weight, 0) - 1) < 1e-9, '驱动权重和为 1');
check(normalizeDrive('curiosity') === 'curiosity', 'normalizeDrive 原样通过');
check(normalizeDrive('CARE') === 'care', 'normalizeDrive 大小写归一');
check(normalizeDrive(' 社交 ') === 'curiosity', 'normalizeDrive 中文/未知 → curiosity 默认');
check(normalizeDrive(null) === 'curiosity' && normalizeDrive('') === 'curiosity', 'normalizeDrive 空值 → 默认');

// ── 2. selectDrive 加权轮盘边界 ──────────────────────────────────────
check(selectDrive(0) === 'curiosity', '轮盘 rand=0 → curiosity');
check(selectDrive(0.399999) === 'curiosity', '轮盘 0.3999 → curiosity（权重 0.4 边界内）');
check(selectDrive(0.4) === 'curiosity', '轮盘 0.4 恰在边界 → 归 curiosity（r<=0 语义）');
check(selectDrive(0.4001) === 'sociability', '轮盘 0.4001 → sociability');
check(selectDrive(0.74) === 'sociability', '轮盘 0.74 → sociability');
check(selectDrive(0.75) === 'sociability', '轮盘 0.75 恰在边界 → 归 sociability（r<=0 语义）');
check(selectDrive(0.7501) === 'care', '轮盘 0.7501 → care');
check(selectDrive(0.999999) === 'care', '轮盘 0.9999 → care');
check(selectDrive(1) === 'care', '轮盘 rand=1 夹取到 care');
check(selectDrive(-5) === 'curiosity', '轮盘负数夹取到 curiosity');
check(selectDrive(5) === 'care', '轮盘超界夹取到末位');
// 分布抽样：10000 次比例接近权重（±0.03 容差）
{
  const n = 10000; const c = { curiosity: 0, sociability: 0, care: 0 };
  let seed = 42;
  for (let i = 0; i < n; i += 1) { seed = (seed * 1103515245 + 12345) % 2147483648; c[selectDrive(seed / 2147483648)] += 1; }
  check(Math.abs(c.curiosity / n - 0.4) < 0.03 && Math.abs(c.sociability / n - 0.35) < 0.03 && Math.abs(c.care / n - 0.25) < 0.03, '轮盘分布比例接近权重');
}

// ── 3. buildMorningPlanPrompt 内容 ───────────────────────────────────
{
  const p = buildMorningPlanPrompt({
    dateStr: '2026-10-20', drive: 'care', lifeLabel: '刚睡醒，有点迷糊',
    activeGoals: [{ id: 2, status: 'active', text: '学会发晚安表情' }],
    pendingThoughts: [{ text: '想问主人新耳机好不好用' }],
    people: [{ name: '主人', score: 80, note: '投喂好梗' }]
  });
  check(p.includes('2026-10-20'), '晨间 prompt 含日期');
  check(p.includes('关怀'), '晨间 prompt 含驱动标签');
  check(p.includes('#2'), '晨间 prompt 含目标行');
  check(p.includes('想问主人'), '晨间 prompt 含话头');
  check(p.includes('主人'), '晨间 prompt 含人物行');
  check(p.includes('只输出一行 JSON'), '晨间 prompt 含输出契约');
  const empty = buildMorningPlanPrompt({ dateStr: '2026-10-20' });
  check(empty.includes('（暂无）') && empty.includes('（无）'), '空入参渲染占位符');
}

// ── 4. parseMorningPlanResult 解析容错 ───────────────────────────────
{
  const raw = '{"topics":[{"text":"问问主人周末干嘛","why":"想找他聊天"},{"text":"把新梗用起来","why":"学以致用"}],"people":[{"name":"主人","why":"两天没私聊了"}],"learnings":["查一下 MBTI 梗"],"goalOps":{"add":[{"text":"攒 3 个能逗笑主人的梗","drive":"sociability"}],"done":[3],"abandon":[5],"progress":[{"id":2,"note":"已收藏两张"}]}}';
  const r = parseMorningPlanResult(raw);
  check(r && r.topics.length === 2 && r.topics[0].text === '问问主人周末干嘛', '解析 topics');
  check(r.people.length === 1 && r.people[0].text === '主人', '解析 people（字段名归一为 text）');
  check(r.learnings.length === 1, '解析 learnings');
  check(r.goalOps.add.length === 1 && r.goalOps.add[0].drive === 'sociability', '解析 goalOps.add');
  check(r.goalOps.done.length === 1 && r.goalOps.done[0] === 3, '解析 goalOps.done');
  check(r.goalOps.abandon[0] === 5, '解析 goalOps.abandon');
  check(r.goalOps.progress[0].id === 2 && r.goalOps.progress[0].note === '已收藏两张', '解析 goalOps.progress');

  const fenced = '```json\n' + raw + '\n```';
  check(parseMorningPlanResult(fenced) !== null, '围栏包裹可解析');
  check(parseMorningPlanResult('她说"随便聊聊"就好了') === null, '无 JSON → null');
  check(parseMorningPlanResult('{"topics":[]}') === null, '空壳（无内容无 add）→ null');
  check(parseMorningPlanResult(null) === null, 'null 输入 → null');
  // 超量截断：topics 5→4、add 3→2、字符串混入
  const big = parseMorningPlanResult('{"topics":["a","b","c","d","e"],"goalOps":{"add":[{"text":"x"},{"text":"y"},{"text":"z"}]}}');
  check(big.topics.length === 4, 'topics 超量截断到 4');
  check(big.goalOps.add.length === 2, 'add 超量截断到 2');
  check(big.topics[0].text === 'a' && big.topics[0].why === '', '字符串 topic 归一为 {text,why}');
  // progress 坏行过滤：id 非正整数 / 无 note 的被丢
  const prog = parseMorningPlanResult('{"goalOps":{"progress":[{"id":0,"note":"x"},{"id":7,"note":""},{"id":7}],"add":[{"text":"t"}]}}');
  check(prog.goalOps.progress.length === 0, 'progress 坏行全滤');
}

// ── 5. nextGoalId / normalizeGoal ────────────────────────────────────
check(nextGoalId([]) === 1, 'nextGoalId 空表 → 1');
check(nextGoalId([{ id: 3 }, { id: 7 }, { id: 'x' }]) === 8, 'nextGoalId 取最大+1');
{
  const g = normalizeGoal({ text: '  学会发晚安表情  ', drive: 'SOCIAL', progressNotes: [{ at: 1, note: '第一条' }, { at: 2, note: '' }, '坏行'] }, { id: 9, nowMs: 1000 });
  check(g.id === 9 && g.status === 'active' && g.createdAt === 1000, 'normalizeGoal 基本字段');
  check(g.text === '学会发晚安表情', 'normalizeGoal 文本清洗');
  check(g.drive === 'curiosity', 'normalizeDrive 非法驱动默认');
  check(g.progressNotes.length === 1 && g.progressNotes[0].note === '第一条', 'progressNotes 消毒（去空/去坏行）');
}

// ── 6. foldGoalLines 折叠 ────────────────────────────────────────────
{
  const lines = [
    JSON.stringify({ id: 1, text: '旧', status: 'active' }),
    '不是 JSON',
    '',
    JSON.stringify({ id: 1, text: '新', status: 'done' }),
    JSON.stringify({ id: 2, text: '正常', status: 'active' }),
    JSON.stringify({ id: 0, text: '坏 id' }),
    'null'
  ];
  const rows = foldGoalLines(lines);
  check(rows.length === 2, 'fold 行数（同 id 覆盖+坏行跳过）');
  check(rows.find((g) => g.id === 1).text === '新' && rows.find((g) => g.id === 1).status === 'done', 'fold 后行覆盖前行');
  check(foldGoalLines([]).length === 0, 'fold 空数组');
}

// ── 7. applyGoalOps 全路径 ───────────────────────────────────────────
{
  const base = [
    { id: 1, text: '目标一', drive: 'curiosity', status: 'active', createdAt: 1, progressNotes: [] },
    { id: 2, text: '目标二', drive: 'care', status: 'done', createdAt: 1, progressNotes: [] },
    { id: 3, text: '目标三', drive: 'sociability', status: 'active', createdAt: 1, progressNotes: [] }
  ];
  const ops = {
    add: [{ text: '新目标A', drive: 'care' }, { text: '新目标B' }, { text: '新目标C' }],
    done: [1, 2],            // 2 已 done → NOOP
    abandon: [999],           // 不存在的 id → NOOP
    progress: [{ id: 3, note: '推进了一步' }, { id: 2, note: '不该记' }]
  };
  const { rows, applied } = applyGoalOps(base, ops, 5000);
  check(applied.added === 2, 'add 截 2 且计数');
  check(applied.done === 1, 'done 只对 active 生效');
  check(applied.abandoned === 0, '不存在的 abandon NOOP');
  check(applied.progressed === 1, 'progress 只对 active 生效');
  check(rows.length === 5, '行数 = 3 原有 + 2 新增');
  check(rows.find((g) => g.id === 1).status === 'done' && rows.find((g) => g.id === 1).closedAt === 5000, 'done 写 closedAt');
  check(rows.find((g) => g.id === 2).status === 'done' && rows.find((g) => g.id === 2).closedAt == null, '已关目标不被再关');
  const g3 = rows.find((g) => g.id === 3);
  check(g3.progressNotes.length === 1 && g3.progressNotes[0].note === '推进了一步' && g3.progressNotes[0].at === 5000, 'progress 追加 {at,note}');
  check(rows.find((g) => g.text === '新目标A').id === 4 && rows.find((g) => g.text === '新目标B').id === 5, '新目标 id 顺延');
  check(rows.find((g) => g.text === '新目标B').drive === 'curiosity', '无驱动默认 curiosity');
  check(base.length === 3 && base.find((g) => g.id === 1).status === 'active', '入参 rows 不被原地修改');
  // progressNotes 截 10
  let many = [{ id: 1, text: 'x', status: 'active', createdAt: 1, progressNotes: Array.from({ length: 9 }, (_, i) => ({ at: i, note: 'n' + i })) }];
  for (let i = 0; i < 3; i += 1) many = applyGoalOps(many, { progress: [{ id: 1, note: 'p' + i }] }, 1000 + i).rows;
  check(many[0].progressNotes.length === 10 && many[0].progressNotes[9].note === 'p2', 'progressNotes 上限 10（滚动窗口）');
  // 空 ops / 坏 ops
  const noop = applyGoalOps(base, null, 1);
  check(noop.applied.added === 0 && noop.rows === base, 'null ops 原样返回');
}

// ── 8. maintainGoals 维护 ────────────────────────────────────────────
{
  const now = 100000000;
  const day = 86400000;
  const rows = [
    { id: 1, text: '超龄', status: 'active', createdAt: now - 15 * day },
    { id: 2, text: '新鲜', status: 'active', createdAt: now - day },
    { id: 3, text: '老但已关', status: 'done', createdAt: now - 90 * day, closedAt: now - day }
  ];
  const out = maintainGoals(rows, { nowMs: now, maxActive: 8, maxAgeDays: 14, keepClosed: 60 });
  const g1 = out.find((g) => g.id === 1);
  check(g1.status === 'abandoned' && g1.closedNote.includes('过期自动放弃'), '超龄 active 自动放弃');
  check(out.find((g) => g.id === 2).status === 'active', '未超龄保留 active');
  check(out.find((g) => g.id === 3).status === 'done', '已关闭行原样保留');
  // active 超上限 → 保留最新
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, text: 'g' + i, status: 'active', createdAt: i }));
  const capped = maintainGoals(many, { nowMs: 9999, maxActive: 3, maxAgeDays: 14, keepClosed: 60 });
  const actives = capped.filter((g) => g.status === 'active');
  check(actives.length === 3 && actives.every((g) => g.id >= 8), 'active 超上限保留最新 3 个');
  check(maintainGoals('not-array') .length === 0, '非数组入参 → []');
}

// ── 9. normalizePlan / planTopicsOf / renderPlanLines / renderGoalLines ─
{
  const plan = normalizePlan({ topics: [{ text: '话题一', why: 'why' }], learnings: ['学个梗'] }, { dateStr: '2026-10-20', drive: 'care', nowMs: 123 });
  check(plan.date === '2026-10-20' && plan.drive === 'care' && plan.createdAt === 123, 'normalizePlan 字段');
  check(planTopicsOf(plan).length === 1 && planTopicsOf(plan)[0] === '话题一', 'planTopicsOf 取 text');
  check(planTopicsOf(null).length === 0, 'planTopicsOf(null) 安全');
  const rendered = renderPlanLines(plan);
  check(rendered.includes('【今日计划（今早自己定的）】') && rendered.includes('- 话题：话题一') && rendered.includes('- 想学：学个梗'), 'renderPlanLines 渲染');
  check(rendered.endsWith('\n\n'), 'renderPlanLines 尾部空行分隔');
  check(renderPlanLines(null) === '' && renderPlanLines({ topics: [], people: [], learnings: [] }) === '', '空计划渲染空串');
  const goals = [
    { id: 1, text: '攒梗', drive: 'sociability', status: 'active', progressNotes: [{ at: 1, note: '收了两张' }] },
    { id: 2, text: '关闭的不显示', drive: 'care', status: 'abandoned' }
  ];
  const goalLines = renderGoalLines(goals);
  check(goalLines.includes('【她的目标（跨天跟踪）】') && goalLines.includes('#1 [社交] 攒梗') && goalLines.includes('（最近：收了两张）'), 'renderGoalLines 渲染（驱动标签+最近进展）');
  check(!goalLines.includes('关闭的不显示'), 'closed 不渲染');
  check(renderGoalLines([]) === '', '无目标渲染空串');
  check(renderGoalLines([{ id: 9, text: '无驱动', status: 'active' }]).includes('#9 [好奇]'), '未知驱动归一 curiosity 渲染');
}

// ── 10. A7 画像刷新 prompt + 解析 ────────────────────────────────────
{
  const prompt = buildPersonaRefreshPrompt({ name: '主人', facts: [{ text: '喜欢耳机' }, '讨厌加班', { text: '最近在搞 NAS' }] });
  check(prompt.includes('主人') && prompt.includes('喜欢耳机') && prompt.includes('讨厌加班'), '画像 prompt 渲染人物与事实');
  check(prompt.includes('不确定的字段输出空字符串'), '画像 prompt 含不编造约束');
  const ok = parsePersonaRefreshResult('```json\n{"callName":"主人","likes":"耳机、数码","dislikes":"加班","style":"直球","status":"折腾 NAS","note":"投喂好梗的靠谱主人"}\n```');
  check(ok && ok.callName === '主人' && ok.likes === '耳机、数码', '画像解析成功');
  check(parsePersonaRefreshResult('{"callName":"","likes":"","dislikes":"","style":"","status":"","note":""}') === null, '全空画像 → null（不覆盖）');
  check(parsePersonaRefreshResult('随便聊聊') === null, '画像垃圾输入 → null');
  const partial = parsePersonaRefreshResult('{"callName":"柚子"}');
  check(partial && partial.callName === '柚子' && partial.likes === '', '部分画像字段补空串');
}

// ── 汇总 ─────────────────────────────────────────────────────────────
console.log(`\ngoals-core: ${pass} passed, ${fail} failed`);
if (fail) { console.error('FAILED:', fails.join(' | ')); process.exit(1); }
console.log('ALL PASSED');
