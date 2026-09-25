// 重复提醒的时间计算（P0-1）——纯函数，可独立单测。
//
// 时区纪律：全部用本地时区构造（new Date() + setHours/setDate），绝不碰 toISOString()。
// P8 的教训：夜间维护的 lastMaintainDate 用 toISOString() 写进 UTC 日期，而锚点比较
// 用的是本地 01:00，两边对不齐（只是那个字段恰好 write-only 才没出事）。
// 提醒是要真触发的，必须从一开始就钉死本地时区。
//
// repeat 规格三种：
//   { kind: 'daily',   at: '09:00' }              每天 HH:MM（本地时区）
//   { kind: 'weekly',  at: '09:00', days: [1,3] } 每周指定几天，ISO 星期：1=周一 … 7=周日
//   { kind: 'interval', everyMinutes: 30 }        每 N 分钟一次（上限 15 天）

const DAY_MS = 86400000;
// interval 上限 = 15 天，与 /set 对一次性 fireAt 的 1296000000ms 上限保持一致
const MAX_INTERVAL_MIN = 21600;

export function parseHmString(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, min };
}

export function hmLabel(h, min) {
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// 把 AI/用户传入的 repeat 规格归一化；不合法返回 { error }，合法返回 { repeat }。
export function normalizeRepeatSpec(raw) {
  if (raw == null || raw === '') return { repeat: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'repeat 必须是对象' };
  const kind = String(raw.kind ?? '').trim();
  if (!['daily', 'weekly', 'interval'].includes(kind)) {
    return { error: 'repeat.kind 仅支持 daily（每天）/ weekly（每周几）/ interval（间隔分钟）' };
  }
  if (kind === 'interval') {
    const everyMinutes = Number(raw.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) return { error: 'repeat.everyMinutes 需 ≥ 1（分钟）' };
    if (everyMinutes > MAX_INTERVAL_MIN) return { error: `repeat.everyMinutes 最长 ${MAX_INTERVAL_MIN}（=15 天）` };
    return { repeat: { kind, everyMinutes: Math.round(everyMinutes) } };
  }
  const at = parseHmString(raw.at);
  if (!at) return { error: "repeat.at 需为 'HH:MM'（本地时区）" };
  const atLabel = hmLabel(at.h, at.min);
  if (kind === 'daily') return { repeat: { kind, at: atLabel } };
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : [])
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (!days.length) return { error: 'repeat.days 需为 1~7 的非空数组（1=周一 … 7=周日）' };
  return { repeat: { kind, at: atLabel, days } };
}

// 计算下一次触发的本地时间戳（毫秒）；算不出返回 0。
// 候选必须至少晚于 now 10 秒：提醒扫描器每 30s 跑一次，如果“下一次”落在当前
// 扫描窗口内，同一行会 触发→重排→立刻又到期→再触发 连环自触发。
export function nextRepeatFireMs(repeat, now = Date.now(), fromMs = 0) {
  if (!repeat || typeof repeat !== 'object') return 0;
  const minFuture = now + 10000;
  if (repeat.kind === 'interval') {
    const everyMinutes = Number(repeat.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1) return 0;
    const ms = Math.min(everyMinutes, MAX_INTERVAL_MIN) * 60000;
    // 基准取「上一次的触发时刻」而不是 now：扫描器每 30s 一轮，若按 now 算，
    // 「每 1 分钟」实际会变成每 60~90 秒，而且每触发一次就漂一点，一天下来能漂出几十分钟。
    // 用触发时刻做基准就锁住了相位。停机久了 next 会落在过去 → 用整数除直接跳到第一个未来周期
    // （写成 while 循环也行，但 1 分钟周期配一年前的基准要转 50 万次，算术一步到位更稳）。
    const base = Number(fromMs) > 0 ? Number(fromMs) : now;
    let next = base + ms;
    if (next <= minFuture) next = base + (Math.floor((minFuture - base) / ms) + 1) * ms;
    return next;
  }
  const at = parseHmString(repeat.at);
  if (!at) return 0;
  // 候选一律从 now 派生（不是 new Date()）：生产上两者相等，但可测性要求 now 说了算，
  // 否则传固定 now 做单测时，候选用的是真实今天、比较用的是假 now，结论会自相矛盾。
  if (repeat.kind === 'daily') {
    const cand = new Date(now);
    cand.setHours(at.h, at.min, 0, 0);
    if (cand.getTime() <= minFuture) cand.setTime(cand.getTime() + DAY_MS);
    return cand.getTime();
  }
  if (repeat.kind === 'weekly') {
    const days = Array.isArray(repeat.days) ? repeat.days : [];
    if (!days.length) return 0;
    // 最多往后看 8 天必然覆盖一周内所有星期组合
    for (let i = 0; i < 8; i++) {
      const cand = new Date(now);
      cand.setDate(cand.getDate() + i);
      cand.setHours(at.h, at.min, 0, 0);
      const isoDow = cand.getDay() === 0 ? 7 : cand.getDay(); // JS getDay(): 0=周日 → ISO 7
      if (days.includes(isoDow) && cand.getTime() > minFuture) return cand.getTime();
    }
    return 0;
  }
  return 0;
}

// 从 reminders 行还原 repeat 规格（列：repeat_kind/repeat_at/repeat_days/every_ms）。
// 规格损坏返回 null，由调用方兜底置 fired，避免坏行无限占着 pending。
export function repeatFromRow(row) {
  if (!row || !row.repeat_kind) return null;
  const kind = String(row.repeat_kind);
  if (kind === 'interval') {
    const everyMinutes = Math.round((Number(row.every_ms) || 0) / 60000);
    return everyMinutes >= 1 ? { kind, everyMinutes } : null;
  }
  const at = parseHmString(row.repeat_at);
  if (!at) return null;
  if (kind === 'daily') return { kind, at: hmLabel(at.h, at.min) };
  if (kind === 'weekly') {
    let days = [];
    try { days = JSON.parse(String(row.repeat_days || '[]')); } catch { return null; }
    const spec = normalizeRepeatSpec({ kind, at: hmLabel(at.h, at.min), days });
    return spec.repeat || null;
  }
  return null;
}

// INSERT 用的列值。
export function repeatColumnsFor(repeat) {
  if (!repeat) return { repeat_kind: '', repeat_at: '', repeat_days: '', every_ms: 0 };
  return {
    repeat_kind: repeat.kind,
    repeat_at: repeat.at || '',
    repeat_days: repeat.days ? JSON.stringify(repeat.days) : '',
    every_ms: repeat.everyMinutes ? Math.round(repeat.everyMinutes * 60000) : 0
  };
}

// 人类可读的重复描述（日志/列表用）。
export function describeRepeat(repeat) {
  if (!repeat || typeof repeat !== 'object') return '';
  if (repeat.kind === 'interval') return `每 ${repeat.everyMinutes} 分钟`;
  if (repeat.kind === 'daily') return `每天 ${repeat.at}`;
  if (repeat.kind === 'weekly') return `每周${repeat.days.map((d) => '日一二三四五六'[d % 7]).join('/')} ${repeat.at}`;
  return '';
}
