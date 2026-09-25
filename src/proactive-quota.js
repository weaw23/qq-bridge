// 主动消息每日配额的纯逻辑（P0-2）。
//
// 为什么单独成模块：这套判定的边界值（0 / 负数 / null / 未配置 / used 刚好等于 quota）
// 全在 main() 闭包里的话，测试就只能靠 grep 源码里有没有那段字符串——那是「接线检查」，
// 不是「行为验证」。抽成纯函数后可以喂固定时间戳跑遍所有分叉。
//
// 时区纪律（与 repeat-schedule.js 同一套）：日期一律本地时区构造，绝不使用 toISOString()。
// 用 UTC 的话「今天」要在当地早上 8 点才翻页，配额得拖到下午才刷新——这类错误在白天
// 完全看不出来，只在跨零点那几小时发疯。

const DAY_MS = 86400000;

// 本地日期键 'YYYY-MM-DD'
export function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 从配置值解析每日上限：
//   未配置 / 非法  → 10（默认）
//   null / false   → -1（显式关闭配额 = 不限制）
//   负数           → -1（同「不限制」，写成 -1 更直观）
//   0              → 0（完全禁止主动冒泡，一个明确好用的开关）
//   小数           → 向下取整
export function quotaPerDayFromConfig(raw) {
  if (raw === null || raw === false) return -1;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 10;
  return v < 0 ? -1 : Math.floor(v);
}

// 配额是否还允许这次主动冒泡。quota < 0 表示不限制。
// 边界：used 刚好等于 quota 时必须拒绝（「第 10 次用完就不再是第 11 次」）。
export function proactiveAllowed(quota, used) {
  if (quota < 0) return true;
  return Number(used) < Number(quota);
}

// 下一天的本地零点（今天还剩多少时间是准的，给日志/面板用）
export function nextLocalMidnight(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export { DAY_MS };
