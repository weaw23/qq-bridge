// 鲸鲸 2.0 · B2 每日计划 + B3 目标队列 + A7 画像刷新 —— 纯函数核心。
//
// 数据结构（全部 JSON 可序列化，持久化由 bridge.js 负责）：
//   plan: { date:'YYYY-MM-DD', drive:'curiosity', topics:[{text,why}], people:[{name,why}], learnings:[], createdAt }
//   goal: { id:number, text, drive, status:'active'|'done'|'abandoned', createdAt, updatedAt,
//           closedAt:null, closedNote:'', progressNotes:[{at,note}] }
//
// 持久化形态（state/memory-v2/）：
//   plans.jsonl —— 每天一行计划，读取时取「今天」的最后一行（重跑覆盖旧的）。
//   goals.jsonl —— 追加式事件日志：同 id 后行覆盖前行，foldGoals 折叠出当前状态。
//   （追加式 = 崩溃安全：写一半的行被跳过即可，不需要原子重写。）
//
// 三驱动（B3）：好奇 / 社交 / 关怀 —— 晨间轮盘按权重挑一个「今日主驱动」，
// 计划与目标生成都在该驱动的视角下进行；不同天自然切换关注面。

export const DRIVES = {
  curiosity: { label: '好奇', weight: 0.4, hint: '想弄明白什么新东西、想学什么梗、想研究什么话题' },
  sociability: { label: '社交', weight: 0.35, hint: '想找谁聊聊、想跟进谁、想活跃哪个场子' },
  care: { label: '关怀', weight: 0.25, hint: '谁最近状态怎么样、想关心谁、想为谁做点什么' }
};

export const DRIVE_KEYS = Object.keys(DRIVES);

export function normalizeDrive(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return DRIVE_KEYS.includes(s) ? s : 'curiosity';
}

// 加权轮盘：rand ∈ [0,1)。权重和不强制为 1（按比例归一）。
export function selectDrive(rand = Math.random()) {
  const total = DRIVE_KEYS.reduce((acc, k) => acc + Number(DRIVES[k].weight) || 0, 0) || 1;
  let r = Math.min(0.999999, Math.max(0, Number(rand) || 0)) * total;
  for (const k of DRIVE_KEYS) {
    r -= Number(DRIVES[k].weight) || 0;
    if (r <= 0) return k;
  }
  return DRIVE_KEYS[DRIVE_KEYS.length - 1];
}

// ── B2/B3 晨间规划 prompt ─────────────────────────────────────────────
// 输出契约：一行 JSON。goalOps 允许她对已有目标记账（完成/放弃/进展），
// 让「每日计划」和「目标队列」在同一次晨间思考里闭环。
export function buildMorningPlanPrompt({ dateStr, drive, lifeLabel = '', activeGoals = [], pendingThoughts = [], people = [] } = {}) {
  const d = DRIVES[normalizeDrive(drive)] ?? DRIVES.curiosity;
  const goalLines = (Array.isArray(activeGoals) ? activeGoals : []).slice(0, 8)
    .map((g) => `#${g.id} [${g.status ?? 'active'}] ${String(g.text ?? '').slice(0, 40)}`);
  const thoughtLines = (Array.isArray(pendingThoughts) ? pendingThoughts : []).slice(0, 6)
    .map((t) => '- ' + String(t.text ?? t.content ?? '').slice(0, 40));
  const peopleLines = (Array.isArray(people) ? people : []).slice(0, 8)
    .map((p) => `- ${String(p.name ?? p.memberId ?? '').slice(0, 12)}（好感 ${p.score ?? 0}）${String(p.note ?? p.notes ?? '').slice(0, 24)}`);
  return [
    '你是 QQ 里的虚拟少女「鲸鲸」。现在是早晨，请在醒来做事之前给自己定一份今日小计划。',
    `今天是 ${dateStr}。你今天的主驱动是「${d.label}」：${d.hint}。${lifeLabel ? '当前生活状态：' + lifeLabel + '。' : ''}`,
    '【她的目标（进行中/近期）】',
    goalLines.length ? goalLines.join('\n') : '（暂无）',
    '【昨晚留给今早的话头】',
    thoughtLines.length ? thoughtLines.join('\n') : '（无）',
    '【常联系的人】',
    peopleLines.length ? peopleLines.join('\n') : '（无）',
    '结合以上信息和你的记忆印象，规划今天：想跟进谁、想聊什么话题、想学什么、想为目标做什么。计划是给自己看的，要具体、可做、像真心想做的事，不要空话套话；数量宁少勿多。',
    '只输出一行 JSON（不要围栏不要解释）：',
    '{"topics":[{"text":"话题≤20字","why":"为什么≤15字"}],"people":[{"name":"称呼","why":"≤15字"}],"learnings":["想学/想弄明白的≤20字"],"goalOps":{"add":[{"text":"新目标≤40字","drive":"curiosity|sociability|care"}],"done":[目标id],"abandon":[目标id],"progress":[{"id":目标id,"note":"进展≤30字"}]}}',
    '约束：topics 2~4 条；people 0~3 条；learnings 0~2 条；goalOps.add 0~2 条（真的值得跨天跟踪才建目标）；done/abandon 只填确实该关的 id；所有字段可省略但不能是空壳。'
  ].filter(Boolean).join('\n');
}

// ── 解析：剥围栏 + 取首尾大括号 + 逐字段消毒 ─────────────────────────
function firstJsonObject(text) {
  const s = String(text ?? '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function cleanStr(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
}

function cleanTopicList(v, maxN, textMax, whyMax) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (out.length >= maxN) break;
    if (typeof item === 'string') { const t = cleanStr(item, textMax); if (t) out.push({ text: t, why: '' }); continue; }
    if (!item || typeof item !== 'object') continue;
    // people 契约键是 name，topics 契约键是 text/topic——统一归一到 text
    const text = cleanStr(item.text ?? item.topic ?? item.name, textMax);
    if (!text) continue;
    out.push({ text, why: cleanStr(item.why ?? item.reason, whyMax) });
  }
  return out;
}

function cleanStrList(v, maxN, maxLen) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (out.length >= maxN) break;
    const s = cleanStr(typeof item === 'string' ? item : (item && typeof item === 'object' ? (item.text ?? item.content) : ''), maxLen);
    if (s) out.push(s);
  }
  return out;
}

function cleanIdList(v, maxN) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (out.length >= maxN) break;
    const n = Number(item);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

export function parseMorningPlanResult(text) {
  const obj = firstJsonObject(text);
  if (!obj) return null;
  const goalOpsRaw = obj.goalOps && typeof obj.goalOps === 'object' ? obj.goalOps : {};
  const plan = {
    topics: cleanTopicList(obj.topics, 4, 20, 15),
    people: cleanTopicList(obj.people, 3, 12, 15),
    learnings: cleanStrList(obj.learnings, 2, 20)
  };
  const goalOps = {
    add: (Array.isArray(goalOpsRaw.add) ? goalOpsRaw.add : []).slice(0, 2)
      .map((a) => ({ text: cleanStr(a && typeof a === 'object' ? a.text : a, 40), drive: normalizeDrive(a && typeof a === 'object' ? a.drive : '') }))
      .filter((a) => a.text),
    done: cleanIdList(goalOpsRaw.done, 6),
    abandon: cleanIdList(goalOpsRaw.abandon, 6),
    progress: (Array.isArray(goalOpsRaw.progress) ? goalOpsRaw.progress : []).slice(0, 6)
      .map((p) => ({ id: Number(p && typeof p === 'object' ? p.id : 0), note: cleanStr(p && typeof p === 'object' ? p.note : p, 30) }))
      .filter((p) => Number.isInteger(p.id) && p.id > 0 && p.note)
  };
  if (!plan.topics.length && !plan.people.length && !plan.learnings.length && !goalOps.add.length) return null;
  return { ...plan, goalOps };
}

// ── B3 目标队列维护（纯函数） ────────────────────────────────────────
export function nextGoalId(rows) {
  let max = 0;
  for (const r of rows) { const n = Number(r?.id); if (Number.isInteger(n) && n > max) max = n; }
  return max + 1;
}

export function normalizeGoal(raw, { id, nowMs }) {
  return {
    id: Number.isInteger(id) && id > 0 ? id : nextGoalId([]),
    text: cleanStr(raw?.text, 60),
    drive: normalizeDrive(raw?.drive),
    status: 'active',
    createdAt: Number.isFinite(nowMs) ? nowMs : Date.now(),
    updatedAt: Number.isFinite(nowMs) ? nowMs : Date.now(),
    closedAt: null,
    closedNote: '',
    progressNotes: Array.isArray(raw?.progressNotes)
      ? raw.progressNotes.slice(-10).map((p) => ({ at: Number(p?.at) || Date.now(), note: cleanStr(p?.note, 80) })).filter((p) => p.note)
      : []
  };
}

// goals.jsonl 折叠：同 id 后行覆盖前行（追加式事件日志）。
export function foldGoalLines(lines) {
  const map = new Map();
  for (const line of lines) {
    const s = String(line ?? '').trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    const id = Number(obj?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    map.set(id, obj);
  }
  return [...map.values()];
}

// 把 goalOps 应用到 rows：返回 {rows, applied}。rows 数组本身不被修改（返回新数组）。
// 只对 active 行生效（done/abandon 的 id 打在已关闭目标上 = NOOP，防止旧 id 复用造成误关）。
export function applyGoalOps(rows, ops, nowMs = Date.now()) {
  const applied = { added: 0, done: 0, abandoned: 0, progressed: 0, texts: [] };
  if (!Array.isArray(rows) || !ops || typeof ops !== 'object') return { rows: rows ?? [], applied };
  let next = [...rows];
  for (const add of (Array.isArray(ops.add) ? ops.add : []).slice(0, 2)) {
    if (!add?.text) continue;
    const g = normalizeGoal({ text: add.text, drive: add.drive }, { id: nextGoalId(next), nowMs });
    next.push(g);
    applied.added += 1;
    applied.texts.push(`+${g.id} ${g.text}`);
  }
  const doneSet = new Set(Array.isArray(ops.done) ? ops.done.map(Number).filter(Number.isInteger) : []);
  const abandonSet = new Set(Array.isArray(ops.abandon) ? ops.abandon.map(Number).filter(Number.isInteger) : []);
  if (doneSet.size || abandonSet.size) {
    next = next.map((g) => {
      if (g?.status !== 'active') return g;
      if (doneSet.has(Number(g.id))) { applied.done += 1; return { ...g, status: 'done', closedAt: nowMs, updatedAt: nowMs }; }
      if (abandonSet.has(Number(g.id))) { applied.abandoned += 1; return { ...g, status: 'abandoned', closedAt: nowMs, updatedAt: nowMs }; }
      return g;
    });
  }
  const progressList = Array.isArray(ops.progress) ? ops.progress : [];
  if (progressList.length) {
    const notesById = new Map();
    for (const p of progressList) {
      const id = Number(p?.id);
      if (Number.isInteger(id) && id > 0 && p?.note) notesById.set(id, [...(notesById.get(id) ?? []), String(p.note).slice(0, 30)]);
    }
    if (notesById.size) {
      next = next.map((g) => {
        if (g?.status !== 'active' || !notesById.has(Number(g.id))) return g;
        const add = notesById.get(Number(g.id)).map((note) => ({ at: nowMs, note }));
        const progressNotes = [...(Array.isArray(g.progressNotes) ? g.progressNotes : []), ...add].slice(-10);
        applied.progressed += 1;
        return { ...g, progressNotes, updatedAt: nowMs };
      });
    }
  }
  return { rows: next, applied };
}

// 维护：active 超龄 → 自动放弃（记 closedNote）；收敛 closed 历史；active 超上限时保留最新的。
export function maintainGoals(rows, { nowMs = Date.now(), maxActive = 8, maxAgeDays = 14, keepClosed = 60 } = {}) {
  if (!Array.isArray(rows)) return [];
  const maxAgeMs = Math.max(1, Number(maxAgeDays) || 14) * 86400000;
  let next = [];
  for (const g of rows) {
    if (g?.status === 'active' && nowMs - Number(g.createdAt || 0) > maxAgeMs) {
      next.push({ ...g, status: 'abandoned', closedAt: nowMs, updatedAt: nowMs, closedNote: '过期自动放弃（超过 ' + maxAgeDays + ' 天没有进展）' });
    } else next.push(g);
  }
  const active = next.filter((g) => g?.status === 'active').sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const keepActiveIds = new Set(active.slice(0, Math.max(1, Number(maxActive) || 8)).map((g) => Number(g.id)));
  next = next.filter((g) => g?.status !== 'active' || keepActiveIds.has(Number(g.id)));
  const closed = next.filter((g) => g?.status !== 'active').sort((a, b) => Number(b.closedAt || b.updatedAt || 0) - Number(a.closedAt || a.updatedAt || 0));
  const keepClosedIds = new Set(closed.slice(0, Math.max(0, Number(keepClosed) || 60)).map((g) => Number(g.id)));
  return next.filter((g) => g?.status === 'active' || keepClosedIds.has(Number(g.id)));
}

// ── 渲染（注入唤醒 prompt） ──────────────────────────────────────────
export function normalizePlan(raw, { dateStr, drive, nowMs = Date.now() } = {}) {
  const plan = {
    date: cleanStr(raw?.date ?? dateStr, 10) || new Date(nowMs).toISOString().slice(0, 10),
    drive: normalizeDrive(raw?.drive ?? drive),
    topics: cleanTopicList(raw?.topics, 4, 20, 15),
    people: cleanTopicList(raw?.people, 3, 12, 15),
    learnings: cleanStrList(raw?.learnings, 2, 20),
    createdAt: Number(raw?.createdAt) || nowMs
  };
  return plan;
}

export function planTopicsOf(plan) {
  return (plan?.topics ?? []).map((t) => String(t?.text ?? '')).filter(Boolean);
}

export function renderPlanLines(plan) {
  if (!plan || (!plan.topics?.length && !plan.people?.length && !plan.learnings?.length)) return '';
  const lines = ['【今日计划（今早自己定的）】'];
  for (const t of plan.topics.slice(0, 4)) lines.push('- 话题：' + t.text + (t.why ? `（${t.why}）` : ''));
  for (const p of plan.people.slice(0, 3)) lines.push('- 想找：' + p.text + (p.why ? `（${p.why}）` : ''));
  for (const l of plan.learnings.slice(0, 2)) lines.push('- 想学：' + l);
  lines.push('（像人一样记得自己今天想干嘛，找机会自然地做；做完的计划不用汇报，改主意也随意）');
  return lines.join('\n') + '\n\n';
}

export function renderGoalLines(goals, { max = 5 } = {}) {
  const active = (Array.isArray(goals) ? goals : []).filter((g) => g?.status === 'active').slice(0, Math.max(1, Number(max) || 5));
  if (!active.length) return '';
  const lines = ['【她的目标（跨天跟踪）】'];
  for (const g of active) {
    const d = DRIVES[normalizeDrive(g.drive)];
    const last = Array.isArray(g.progressNotes) && g.progressNotes.length ? `（最近：${String(g.progressNotes[g.progressNotes.length - 1].note).slice(0, 30)}）` : '';
    lines.push(`- #${g.id} [${d ? d.label : '目标'}] ${String(g.text).slice(0, 40)}${last}`);
  }
  lines.push('（自己真正想做的事，有机会就推进一点；有进展/完成/放弃时用 qq_goal 记一笔）');
  return lines.join('\n') + '\n\n';
}

// ── A7 画像刷新（夜间消费事实账本，重写 affinity.profile） ─────────────
export function buildPersonaRefreshPrompt({ name, facts = [] } = {}) {
  const factLines = (Array.isArray(facts) ? facts : []).slice(0, 16)
    .map((f, i) => `${i + 1}. ${String(f?.text ?? f ?? '').slice(0, 60)}`);
  return [
    '你是 QQ 里的虚拟少女「鲸鲸」。根据你最近记下的关于一个人的长期事实，更新你对 TA 的结构化画像。',
    `【这个人】${String(name ?? '未知')}`,
    '【关于 TA 的事实（你的记忆账本）】',
    factLines.length ? factLines.join('\n') : '（无）',
    '旧画像如果有就以此为准做增量修订；冲突时以新事实为准。只输出一行 JSON（不要围栏不要解释）：',
    '{"callName":"你以后怎么称呼TA≤12字","likes":"TA喜欢什么≤60字","dislikes":"TA的雷区≤60字","style":"TA的说话风格≤40字","status":"TA最近状态≤40字","note":"一句话总印象≤40字"}',
    '约束：不确定的字段输出空字符串，不要编造。'
  ].filter(Boolean).join('\n');
}

export function parsePersonaRefreshResult(text) {
  const obj = firstJsonObject(text);
  if (!obj) return null;
  const out = {
    callName: cleanStr(obj.callName, 12),
    likes: cleanStr(obj.likes, 60),
    dislikes: cleanStr(obj.dislikes, 60),
    style: cleanStr(obj.style, 40),
    status: cleanStr(obj.status, 40),
    note: cleanStr(obj.note, 40)
  };
  if (!out.callName && !out.likes && !out.dislikes && !out.style && !out.status && !out.note) return null;
  return out;
}
