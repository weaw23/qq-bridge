// L2 唤醒节流（纯函数）
//
// 背景：给 134 人群打开「每条消息都看」（triggers.anyMessage）之后，唤醒次数会逼近消息数，
// token 与刷屏风险同时失控。开源实现的做法高度一致：
//   - astrbot_plugin_wakepro：block(每个成员独立冷却) → wake(判定) → debounce(合并) → silence(沉默期)
//   - boba-when-to-speak-gate：冷却回合数 + rate_window_s 窗口内最多 N 次 + 被无视就抬高门槛
//   - OpenClaw：messages.inbound.debounceMs 防抖 + queue.cap 上限
//   - LLMafia (arXiv 2506.05309, Figure 7)：发言量排名 rank 1 的人显著更可能被投票出局 —— 发言量本身就是风险
//
// 本模块只回答一个问题：「这一条唤醒请求该不该放过」。
// 抽成纯函数是为了能离线穷举验证边界 —— 这类节流逻辑如果埋在 scheduleWakeV2 的闭包里，
// 唯一的验证方式就是拿真群去撞，代价太高（见 ops/test-wake-throttle.mjs 头部的证据强度说明）。
//
// 两条互相独立的约束：
//   1) 频率帽：maxPerMinute / maxPerHour —— 对**所有**唤醒原因生效，是硬上限。
//   2) 发言后冷却：她刚说完话时，别再因为「群里有人随便说了句话」而醒一次。
//
// 关键设计（比参数更重要）：**冷却绝不挡住「有人点她 / 她自己约好的事」。**
// 被 @、被提问、被叫名字、被拍、被指定的人发言、定时提醒、待跟进、健康检查一律直通。
// 否则会变成「群里 @ 她她不回」—— 那比刷屏严重得多，而且主人一眼就会发现。
// 未知原因也一律直通（fail-open）：宁可多醒一次，也不要因为枚举漏了一项就把它静音。

// 只对「闲聊类」原因生效的冷却名单。名单外的一律直通。
//   anyMessage     —— 群里有人说话（L0 打开的开关，最主要的来源）
//   probability    —— 概率兜底
//   replyCheck     —— 回合结束后 30s 的回复检查
//   proactiveCheck —— 主动机会检查（定时器）
//   timeout        —— 有限潜水到期
export const AMBIENT_WAKE_REASONS = Object.freeze([
  'anyMessage',
  'probability',
  'replyCheck',
  'proactiveCheck',
  'timeout'
]);

// 默认「发言后冷却」：2 分钟。
// 参照 boba 的 cooldown_turns=2（两个非 bot 回合）与 astrbot 的 silence≈345s，
// 取 120s：既挡住「她刚说完话、群里继续闲聊又把她叫起来」，又不至于让她整段错过对话。
export const WAKE_SPEAK_COOLDOWN_MS = 120000;

// 唤醒原因可能带子类型（`keyword:鲸鲸`、`speaker:某人`），取冒号前的基名。
export function wakeReasonBase(reason) {
  return String(reason ?? '').split(':')[0].trim();
}

export function isAmbientWakeReason(reason) {
  return AMBIENT_WAKE_REASONS.includes(wakeReasonBase(reason));
}

// 数窗口内的时间戳条数。
// 与 bridge.js 原实现（`now - t < 60000`）的唯一区别：**未来时间戳不计入**。
// 理由：系统时钟被 NTP 往回校正后，历史 wakeTimes 会全部「变成未来」，
// 原写法会把每一条都算进窗口 → 200 条打满 → 她会被冻住，而日志只会说「频率超限」，查不出来。
export function countWithin(times, now, windowMs) {
  if (!Array.isArray(times) || !(windowMs > 0)) return 0;
  let n = 0;
  for (const t of times) {
    const v = Number(t);
    if (!Number.isFinite(v)) continue;
    const age = now - v;
    if (age >= 0 && age < windowMs) n += 1;
  }
  return n;
}

// maxPerMinute / maxPerHour 为 0（或缺省）表示该项不限 —— 与原实现 `> 0` 的语义保持一致。
export function wakeRateVerdict({ wakeTimes, now, maxPerMinute, maxPerHour } = {}) {
  const perMin = Number(maxPerMinute) || 0;
  const perHour = Number(maxPerHour) || 0;
  const recentMinute = countWithin(wakeTimes, now, 60000);
  const recentHour = countWithin(wakeTimes, now, 3600000);
  const blockedByMinute = perMin > 0 && recentMinute >= perMin;
  const blockedByHour = perHour > 0 && recentHour >= perHour;
  return {
    ok: !blockedByMinute && !blockedByHour,
    blockedBy: blockedByMinute ? 'minute' : blockedByHour ? 'hour' : '',
    recentMinute,
    recentHour,
    maxPerMinute: perMin,
    maxPerHour: perHour
  };
}

// 她最近一次发言的时间。
// 直接复用已有的 st.sendTimes（发送路由在 5 个地方 push、发送失败时 splice 回滚、随 social-v2.json 落盘），
// 不新增任何持久化字段，也就不会有「老状态缺字段」这类迁移问题。
export function lastSpeakAtFrom(sendTimes) {
  if (!Array.isArray(sendTimes)) return 0;
  let last = 0;
  for (const t of sendTimes) {
    const v = Number(t);
    if (Number.isFinite(v) && v > last) last = v;
  }
  return last;
}

export function speakCooldownVerdict({ sendTimes, now, cooldownMs } = {}) {
  const ms = Number(cooldownMs) || 0;
  const last = lastSpeakAtFrom(sendTimes);
  if (ms <= 0) {
    return { ok: true, lastSpeakAt: last, elapsedMs: 0, remainingMs: 0, cooldownMs: ms, disabled: true };
  }
  if (last <= 0 || !(Number(now) > 0)) {
    return { ok: true, lastSpeakAt: last, elapsedMs: 0, remainingMs: 0, cooldownMs: ms, disabled: false };
  }
  const elapsedMs = Number(now) - last;
  const remainingMs = ms - elapsedMs;
  return {
    ok: remainingMs <= 0,
    lastSpeakAt: last,
    elapsedMs,
    remainingMs: remainingMs > 0 ? remainingMs : 0,
    cooldownMs: ms,
    disabled: false
  };
}

// 总判定。stage：'ok' | 'rate' | 'speak-cooldown'。
// park=true 表示「别丢弃，塞进 pendingWakeReasons 等回合结束再补」——
// 只对**被频率帽挡住、且不是闲聊类**的原因成立：有人 @ 她却被限流，不能就这么算了。
// 闲聊类被限流则直接丢掉，这正是节流的意义（它会在回合结束时由补发逻辑兜一层，但主体就是被压掉）。
export function wakeThrottleVerdict({ reason, wakeTimes, sendTimes, now, maxPerMinute, maxPerHour, speakCooldownMs } = {}) {
  const ts = Number(now) > 0 ? Number(now) : Date.now();
  const ambient = isAmbientWakeReason(reason);
  const base = wakeReasonBase(reason);
  const rate = wakeRateVerdict({ wakeTimes, now: ts, maxPerMinute, maxPerHour });

  if (!rate.ok) {
    return {
      ok: false,
      stage: 'rate',
      ambient,
      base,
      rate,
      cooldown: null,
      park: !ambient,
      detail: rate.blockedBy === 'minute'
        ? `每分钟上限 ${rate.maxPerMinute} 次（近一分钟已 ${rate.recentMinute} 次）`
        : `每小时上限 ${rate.maxPerHour} 次（近一小时已 ${rate.recentHour} 次）`
    };
  }

  if (!ambient) {
    return { ok: true, stage: 'ok', ambient: false, base, rate, cooldown: null, park: false, detail: '' };
  }

  const cooldown = speakCooldownVerdict({ sendTimes, now: ts, cooldownMs: speakCooldownMs });
  if (!cooldown.ok) {
    return {
      ok: false,
      stage: 'speak-cooldown',
      ambient: true,
      base,
      rate,
      cooldown,
      park: false,
      detail: `她 ${Math.round(cooldown.elapsedMs / 1000)}s 前刚发过消息，冷却还剩 ${Math.ceil(cooldown.remainingMs / 1000)}s`
    };
  }
  return { ok: true, stage: 'ok', ambient: true, base, rate, cooldown, park: false, detail: '' };
}

// ── 永眠兜底重置时「该保留什么」────────────────────────────────────────
//
// bridge.js 有三处把唤醒配置重置为默认值的兜底（ensureWakeableV2 / 连续无行动 / 连续未设置唤醒
// 条件），原本都是 `st.wakeConfig = defaultWakeConfigV2()` —— 换掉整个对象。而默认值里
// anyMessage 取的是 `mode === 'active'`（diving 就是 false），三个节流参数也不在里面。
// 后果（实测会踩）：给大群开了「每条消息都看」之后，只要她**连续 3 个回合选择不说话**
// —— 在这种群里这是常态，不是卡死 —— 主人的 anyMessage 与成本闸门就被无声抹掉，
// 退回「只看被 @ 的」+ 全局默认 20 次/分、200 次/时。
//
// 判断依据只有一句：这几处重置的唯一目的是「别永眠」。anyMessage 与频率帽都只会让她
// **更容易**被唤醒 / **限制**唤醒频率，不可能造成永眠，所以它们不在重置范围内。
export const THROTTLE_OVERRIDE_FIELDS = Object.freeze(['maxWakePerMinute', 'maxWakePerHour', 'speakCooldownMs']);

// 从旧配置里挑出主人配的、不该被重置抹掉的部分。
// 规则从严：anyMessage 只在严格 true 时保留；三个节流字段只接受有限且 >= 0 的数（取整），
// 脏值一律丢弃、宁可退回全局默认 —— 兜底重置是最不该被脏数据影响的一条路径。
// 不认识的字段一律不带出来：默认值结构由 defaultWakeConfigV2() 负责。
export function preservedOwnerOverrides(oldConfig) {
  const old = oldConfig && typeof oldConfig === 'object' ? oldConfig : {};
  const anyMessage = old.triggers && typeof old.triggers === 'object' ? old.triggers.anyMessage === true : false;
  const fields = {};
  for (const field of THROTTLE_OVERRIDE_FIELDS) {
    const value = old[field];
    if (Number.isFinite(value) && value >= 0) fields[field] = Math.round(value);
  }
  return { anyMessage, fields };
}
