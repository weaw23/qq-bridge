// 记忆引擎（P6）：对话自动摘要 + 人物画像 + 中文二元切分（供 FTS5 召回）
// 与 slang-learner.js 同构：由桥接创建独立 DSH 会话调用，输出严格 JSON。

/** 中英混排二元切分：中文按 2-gram 切，英文/数字按整词。用于 SQLite FTS5 中文召回。 */
export function toBigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const out = [];
  const tokens = s.match(/[\u4e00-\u9fff]+|[A-Za-z0-9_@.:/+-]+/g) ?? [];
  for (const tk of tokens) {
    if (/^[\u4e00-\u9fff]+$/.test(tk)) {
      if (tk.length === 1) out.push(tk);
      for (let i = 0; i < tk.length - 1; i++) out.push(tk.slice(i, i + 2));
      if (tk.length <= 2) out.push(tk);
    } else out.push(tk.toLowerCase());
  }
  return [...new Set(out)].join(' ');
}

/** 把用户查询也切成同样的二元词，用 OR 连接给 FTS5 MATCH 用。 */
export function queryToMatch(q) {
  const grams = toBigrams(q).split(' ').filter(Boolean);
  if (!grams.length) return '';
  return grams.map((g) => '"' + g.replace(/"/g, '') + '"').join(' OR ');
}

export function buildSummaryPrompt({ convLabel, messages, people }) {
  const lines = [];
  lines.push('你是「哦鲸鲸」的记忆整理模块（后台任务，不对外发言）。下面是一段 QQ 对话记录。');
  lines.push('');
  lines.push('任务：把它压缩成**结构化长期记忆**，只留以后真的用得上的东西。');
  lines.push('');
  lines.push('输出要求：**只输出一个 JSON 对象**，不要任何解释、不要 Markdown 代码块围栏。格式：');
  lines.push(JSON.stringify({
    facts: [{ content: '一句话事实（谁做了什么/喜欢什么/答应过什么）', category: 'event|preference|promise|person|joke', importance: 1 }],
    people: [{ name: '群友称呼', memberId: '如果记录里有 QQ 号就填，没有就空字符串', note: '一句话印象（不超过 40 字）', callName: '以后怎么称呼他', likes: '喜欢什么', dislikes: '雷区/不喜欢什么', style: '说话风格', status: '最近状态（在忙什么/心情）', scoreDelta: 0 }],
    followups: [{ name: '谁的', topic: '需要以后跟进的事（例如“说考完试再聊”）', dueInHours: 6 }]
  }, null, 1));
  lines.push('');
  lines.push('规则：');
  lines.push('- facts 最多 6 条，只记"长期有用"的；闲聊口水话不要记。importance 1~5（5 最重要）。');
  lines.push('- people 只在有真实观感/信息时填，最多 4 人；scoreDelta 范围 -5~5（态度变化，正=更亲近），不确定就 0。');
  lines.push('- followups 只在对话里明确提到"以后要做/以后再说"时才填，最多 2 条；dueInHours 是建议多久后跟进（1~168）。');
  lines.push('- 不确定的一律留空数组 []。不要编造没出现过的信息。');
  lines.push('');
  lines.push('【已知人物档案（供参考，避免重复写同样的印象）】');
  lines.push(people && people.length ? people.slice(0, 8).map((p) => `- ${p.name}(${p.memberId || '?'}) 好感${p.score}｜${p.note || '（无印象）'}｜${p.profile || ''}`).join('\n') : '（暂无）');
  lines.push('');
  lines.push('【待整理对话】会话：' + convLabel);
  messages.forEach((m, i) => {
    const who = m.isSelf ? '（她自己）' : (m.sender || '未知');
    const uid = m.userId ? `[${m.userId}]` : '';
    lines.push(`${i + 1}. ${who}${uid}: ${String(m.text ?? '').slice(0, 300)}`);
  });
  return lines.join('\n');
}

/** 从模型输出里抠出第一个完整 JSON 对象并做字段清洗。 */
export function parseSummaryJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { facts: [], people: [], followups: [] };
  let s = text.replace(/```json/gi, '```').replace(/```/g, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return { facts: [], people: [], followups: [] };
  s = s.slice(start, end + 1);
  let obj = null;
  try { obj = JSON.parse(s); } catch {
    // 容错：去掉尾随逗号再试一次
    try { obj = JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return { facts: [], people: [], followups: [] };
  const clamp = (n, lo, hi, dflt = 0) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  };
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const facts = (Array.isArray(obj.facts) ? obj.facts : [])
    .map((f) => ({ content: str(f?.content, 300), category: str(f?.category, 20) || 'event', importance: clamp(f?.importance, 1, 5, 1) }))
    .filter((f) => f.content.length >= 4)
    .slice(0, 6);
  const people = (Array.isArray(obj.people) ? obj.people : [])
    .map((p) => ({
      name: str(p?.name, 30),
      memberId: /^\d{5,12}$/.test(String(p?.memberId ?? '').trim()) ? String(p.memberId).trim() : '',
      note: str(p?.note, 120),
      callName: str(p?.callName, 20),
      likes: str(p?.likes, 60),
      dislikes: str(p?.dislikes, 60),
      style: str(p?.style, 60),
      status: str(p?.status, 60),
      scoreDelta: clamp(p?.scoreDelta, -5, 5, 0)
    }))
    .filter((p) => p.name || p.memberId)
    .slice(0, 4);
  const followups = (Array.isArray(obj.followups) ? obj.followups : [])
    .map((f) => ({ name: str(f?.name, 30), topic: str(f?.topic, 200), dueInHours: clamp(f?.dueInHours, 1, 168, 6) }))
    .filter((f) => f.topic.length >= 3)
    .slice(0, 2);
  return { facts, people, followups };
}

/** 把人物档案字段拼成一行（注入用）。 */
export function formatProfileLine(p) {
  const bits = [];
  if (p.callName) bits.push(`称呼"${p.callName}"`);
  if (p.likes) bits.push(`喜欢:${p.likes}`);
  if (p.dislikes) bits.push(`雷区:${p.dislikes}`);
  if (p.style) bits.push(`风格:${p.style}`);
  if (p.status) bits.push(`最近:${p.status}`);
  return bits.join('｜');
}
