// 发送失败出箱重投：分类 + 退避 + 去重键（纯函数，无副作用，可离线穷举单测）
//
// 为什么单独成模块：这些判定埋在 `main()` 闭包里的 `onebotSend` 旁边，就只能靠「真把网关打挂」
// 来验证，而打挂网关会波及正在跑的会话。抽出来之后边界值可以离线穷举。
//
// 核心原则：**宁可漏重投，不可乱重投**。
//   - 网络抖动、网关重启、5xx、待重连 → 可重投
//   - 被禁言 / 被移出 / 参数错 / 令牌错 / 本地守卫取消 → **不可重投**
//     （这类重投是空烧 token，而且被禁言期反复尝试只会加重风控）
//   - 认不出来的一律**不重投**（保守）
//
// 另一条硬约束（见 P8-3b）：重投必须尊重 sendBlock 冷却。冷却期内重投 = 空烧 + 加风险，
// 所以冷却只「推迟」而不「消耗」重投次数，冷却结束后继续用原额度。

export const OUTBOX_MAX_ATTEMPTS = 3;

// 退避：第 1 次失败后 60s 试，之后 3min、9min。整体跨度约 13 分钟，
// 足够跨过「网关重启」「QQ 客户端短暂重连」这类抖动，又不至于让消息在半小时后才冒出来（那时语境已经过了）。
const BACKOFF_MS = [60000, 180000, 540000];
// 超过这个年龄的消息不再重投：语境早没了，重投反而是打扰。
export const OUTBOX_MAX_AGE_MS = 30 * 60 * 1000;

// 同一会话同一条内容在这个窗口内重复入箱 → 视为重复，直接归并。
// 存在的理由：发送失败后 AI 看到报错很容易自己再发一遍，而桥接同时也把它放进了出箱
// → 不归并就是双份消息。窗口取 5 分钟，比最短退避（60s）长得多。
export const OUTBOX_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 稳定哈希（djb2），只用来做去重键，不作任何安全用途。
 * 用哈希而不是原文当索引，是因为同一会话下 message 可能很长，索引列越短越省。
 */
export function stableHash(str) {
  const s = String(str ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 去重键：会话 + 内容 + 引用（引用不同算不同的消息，因为 @/引用的语义不一样） */
export function outboxDedupeKey(kind, id, message, replyToMessageId = '', atUserId = '') {
  const k = String(kind ?? '').trim();
  const i = String(id ?? '').trim();
  const r = String(replyToMessageId ?? '').trim();
  const a = String(atUserId ?? '').trim();
  return `${k}:${i}:${stableHash(`${String(message ?? '')}\u0001${r}\u0001${a}`)}`;
}

/**
 * 失败分类。输入要么是 onebotSend 抛出的 Error（带 `ob` 结构化字段），
 * 要么是显式给出的 { httpStatus, retcode, wording, networkError }（方便离线单测）。
 *
 * @returns {{retryable: boolean, klass: string, reason: string}}
 */
export function classifySendFailure(input = {}) {
  // 已经是错误对象时，优先读它身上挂的结构化字段
  const ob = input?.ob && typeof input.ob === 'object' ? input.ob : input;
  const httpStatus = Number(ob?.httpStatus ?? ob?.status ?? 0) || 0;
  const retcode = Number(ob?.retcode ?? NaN);
  const wording = String(ob?.wording ?? ob?.message ?? '');
  const networkError = input?.networkError === true || ob?.networkError === true
    || (httpStatus === 0 && !Number.isFinite(retcode) && input instanceof Error);

  // ① 本地守卫：这些重投一万次也一样失败，而且属于「不该发」
  if (/发送已取消：会话、模式或白名单已变化/.test(wording)) {
    return { retryable: false, klass: 'cancelled', reason: '会话/模式/白名单已变化，本地守卫取消' };
  }
  if (/发送内容包含会话令牌/.test(wording)) {
    return { retryable: false, klass: 'token_leak', reason: '内容疑似含会话令牌，本地拦截' };
  }
  if (/replyToMessageId 必须是非零整数/.test(wording) || /atUserId 必须是正整数/.test(wording)) {
    return { retryable: false, klass: 'bad_param_local', reason: '本地参数校验失败' };
  }

  // ② HTTP 426：snowluma.httpUrl 指到了 WebSocket 端口 —— 配置错误，重投无用
  if (httpStatus === 426) {
    return { retryable: false, klass: 'misconfig', reason: 'HTTP 426：snowluma.httpUrl 可能是 WS 端口' };
  }
  // ③ 网关 5xx：典型的重启中 / 反代抖动 → 值得重投
  if (httpStatus >= 500) {
    return { retryable: true, klass: 'gateway_5xx', reason: `网关返回 HTTP ${httpStatus}` };
  }
  // ④ 纯网络错误（fetch 抛异常：连接被拒、超时、DNS）→ 第一种典型可重投场景
  if (networkError) {
    return { retryable: true, klass: 'network', reason: '网络错误（连接被拒/超时/中断）' };
  }

  // ⑤ OneBot retcode 分类
  if (Number.isFinite(retcode)) {
    if (retcode === 110 || /移出|重新加群/.test(wording)) {
      return { retryable: false, klass: 'kicked', reason: '已被移出该群' };
    }
    if (retcode === 120 || /rejected/i.test(wording)) {
      return { retryable: false, klass: 'muted_or_risk', reason: '被禁言/消息被服务端拒绝（rejected）' };
    }
    if (retcode === 100) {
      return { retryable: false, klass: 'bad_param', reason: '参数错误（retcode 100）' };
    }
    if (retcode === 103 || retcode === 104) {
      // 凭据失效/过期：QQ 客户端重连后常自愈，值得给有限次机会
      return { retryable: true, klass: 'credential', reason: `凭据失效/过期（retcode ${retcode}），可能是客户端重连中` };
    }
    if (retcode === 102) {
      return { retryable: true, klass: 'operation_failed', reason: '通用操作失败（retcode 102）' };
    }
    if (retcode !== 0) {
      return { retryable: false, klass: 'unknown_retcode', reason: `未知 retcode ${retcode}` };
    }
  }

  // ⑥ 认不出来 → 保守不重投。宁可漏，不可刷屏。
  return { retryable: false, klass: 'unknown', reason: '无法识别的失败，保守起见不重投' };
}

/** 第 attempt 次失败之后应该等多久再试（attempt 从 1 开始） */
export function outboxBackoffMs(attempt) {
  const a = Math.max(1, Math.floor(Number(attempt) || 1));
  return BACKOFF_MS[Math.min(a, BACKOFF_MS.length) - 1];
}

/** 已经试够次数了？ */
export function outboxExhausted(attempt, maxAttempts = OUTBOX_MAX_ATTEMPTS) {
  return (Number(attempt) || 0) >= Math.max(1, Number(maxAttempts) || OUTBOX_MAX_ATTEMPTS);
}

/** 过期了？（消息等太久，语境已经没了） */
export function outboxExpired(createdAt, now = Date.now(), maxAgeMs = OUTBOX_MAX_AGE_MS) {
  const c = Number(createdAt) || 0;
  if (c <= 0) return true;
  return now - c > maxAgeMs;
}

/** 这条出箱记录现在能不能试？冷却期内一律推迟（不消耗次数） */
export function outboxCanAttempt(row, now = Date.now(), sendBlockUntilMs = 0) {
  if (!row) return { ok: false, defer: false, reason: '记录不存在' };
  if ((Number(row.attempts) || 0) >= (Number(row.max_attempts) || OUTBOX_MAX_ATTEMPTS)) {
    return { ok: false, defer: false, reason: '已试满次数' };
  }
  if (outboxExpired(row.created_at, now)) return { ok: false, defer: false, reason: '已过期' };
  const block = Number(sendBlockUntilMs) || 0;
  if (block > now) {
    return { ok: false, defer: true, reason: `该群处于发送受阻冷却中，推迟到 ${new Date(block).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` };
  }
  if ((Number(row.next_at) || 0) > now) return { ok: false, defer: true, reason: '未到退避时间' };
  return { ok: true, defer: false, reason: '' };
}
