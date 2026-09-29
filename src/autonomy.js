// 自主改配置（阶段 6）——纯函数模块
//
// 为什么单独抽一个纯函数模块：
//   这是**唯一**一处"她自己能改线上配置"的入口。这类代码的错误不是"功能不好用"，
//   而是"她把刹车拆了"——白名单写漏一条、正则少一个分隔符、上限算错一次，
//   后果是她能改掉令牌/白名单/主人 QQ，而且没有任何东西会报错。
//   所以验证方式必须是**离线穷举**（ops/test-autonomy.mjs），而不是拿真配置去撞。
//
// 三条设计原则（比参数本身更重要）：
//   1) **默认拒绝**：不在白名单里的一律 deny。白名单只有一条来源（NEXT-UPGRADE-PLAN.md 第 6 节），
//      任何"顺手加一条"都要在测试里对着真实 config.json 核字段，不然拼错路径就等于静静失效。
//   2) **deny 优先于 allow**：先过硬边界（HARD_DENY_PATTERNS / HARD_DENY_PATHS）再看白名单。
//      这样即使将来有人往白名单里误加一条越界路径，硬边界仍然拦得住——两道锁，不是一道。
//   3) **钳制而不是报错**：越界值夹到合法区间并如实写入审计（from → to），
//      因为"她给 1.7 结果变成 0.8"是可解释的，而"她给 1.7 结果整条被拒"会让她反复重试。
//
// 纯函数约束（硬要求，别破坏）：不看时钟、不读写文件、不联网、零依赖。
//   时间一律由 nowMs 注入，随机根本不用（概率归一化是确定性的）——
//   否则"每日 3 次上限"这种逻辑就没法离线验证跨日重置。
//
// 与桥接的关系：本模块只做"能不能改 / 改成什么 / 怎么回滚"的**决策**，
//   真正的落盘写入仍由 src/bridge.js 现有 /api/socialV2/wake-config 路由完成。

export const AUTONOMY_VERSION = 1;

// 审计条目结构版本：将来要给条目加字段（比如 reason 分级）时先升这个号，
// 面板与回滚逻辑按版本分支处理，避免读到旧条目时把缺字段当 undefined 用。
export const AUDIT_ENTRY_VERSION = 1;

// ── 硬边界 ────────────────────────────────────────────────────────────────
// 双重保险：**正则**负责特征（任何含 token/secret/key/password 的路径，无论在哪一层），
// **前缀**负责那几处必须点名的高危路径（正则写不全，或写宽了会误伤）。
//
// 为什么正则是"段匹配"而不是简单 includes：
//   'socialV2.wake.triggers.keywords' 里恰好含有 "key" 子串。如果直接 includes('key')，
//   关键词白名单会被自己的硬边界打死——这类自相矛盾最难发现（表现为"功能整体不可用"）。
//   所以按点号切段，只匹配"整段等于 key / 以 key 结尾 / 以 key 开头"。
export const HARD_DENY_PATTERNS = Object.freeze([
  // 令牌/密钥：出站审计、雪花令牌、控制台令牌、DSH authToken 全在这条线上。
  // 理由：自主体不能改自己的凭证，否则审计与打码同时失去意义。
  /(^|\.)(token|tokens|secret|secrets|password|passwd|pwd|credential|credentials|apikey|api[_-]?key|access[_-]?token|auth[_-]?token|console[_-]?token|authToken|consoleToken)$/i,
  /(^|\.)[a-z0-9_]*(token|secret|password|credential)[a-z0-9_]*(\.|$)/i,
  // 群/私聊白名单与黑名单：这是"她闯祸时主人还能收拾"的边界本身。
  /(^|\.)(allow|deny)(\.|$)/i,
  /(^|\.)allowAllWhenEmpty$/i,
  /(^|\.)(groupsDisabled|whitelist|blacklist|allowedGroups|allowedUsers)$/i,
  // 主人身份：改掉 ownerQQ = 把自己变成没有主人的机器人。
  /(^|\.)(ownerQQ|ownerId|owner|adminQQ|masterQQ)$/i,
  // 模型与人格：换模型/换 preset 等于换掉"她是谁"，不属于"调自己的说话节奏"。
  /(^|\.)model[a-z0-9_]*$/i,
  /(^|\.)models$/i,
  /(^|\.)(provider|agentPreset|preset|persona|role|systemPrompt|workspaceTitle)$/i,
  // 审计与打码本身：能动它就能抹掉自己的记录。
  /(^|\.)(maskTokens|sensitiveVerdict|interceptNotify|audit|auditLog|security)(\.|$)/i,
  // 工具白名单/权限与进程控制：pc_* 在群里的可用性、qq-tool-restrict 都归主人。
  /(^|\.)(pcControl|allowProcessControl|toolRestrict|toolWhitelist|tools|permissions|permission)(\.|$)/i,
  // 暂停开关：她可以把自己调安静，但不能"解除暂停"或"关掉整个社交模块"来解绑刹车。
  /(^|\.)(paused|killSwitch|disabled|enabled|active)$/i,
  // 自主模块自身：自己改自己的上限 = 3 次/日变成无限次。这条是必须写死的自指保护。
  /(^|\.)autonomy(\.|$)/i,
  // 路径里出现原型链/构造函数关键字：防原型污染（'__proto__' 一旦被 set 进去，
  // 影响的是**整个进程**的对象行为，比改配置严重得多）。
  /(^|\.)(__proto__|prototype|constructor)(\.|$)/,
]);
// 上面第 11 条把 '<x>.enabled' 一律禁掉，是因为 config.json 里 enabled 全是模块级总开关
// （social / pcControl / socialV2 / slang / memory / expressions）。
// 她能调的是**唤醒条件里的行为**（mode / infinite / 触发开关），不是模块的生死。
// 唯一例外：社交模块整体被主人 paused 时，她不能靠改触发条件绕过暂停——见 validateChange ④。

export const HARD_DENY_PATHS = Object.freeze([
  'allow',
  'deny',
  'ownerQQ',
  'autonomy',
  'autonomy.enabled',
  'autonomy.reflectHour',
  'autonomy.careScore',
  'autonomy.careAfterDays',
  'autonomy.careCooldownDays',
  'config',
  'config.json',
  '__proto__',
  'constructor',
  'prototype',
  'model',
  'model.name',
  'dsh.model',
  'dsh.authToken',
  'dsh.provider',
  'socialV2.agentPreset',
  'socialV2.paused',
  'socialV2.enabled',
  'socialV2.autoReplyCheckMs',
  'socialV2.consoleToken',
  'snowluma.accessToken',
  'snowluma.wsUrl',
  'snowluma.httpUrl',
  'security.interceptNotify',
  'pcControl.enabled',
  'pcControl.allowProcessControl',
  'groupsDisabled',
  'allowAllWhenEmpty',
  'sessionCwd',
  'consoleToken',
  'consolePort',
]);

// ── 白名单（唯一来源：NEXT-UPGRADE-PLAN.md 第 6 节）───────────────────────
// 每条的 spec 就是"她最多能把它拧到哪"的硬范围。kind 决定形状，其余字段是该 kind 的参数。
//
// 说明：'socialV2.wake.*' 这一段在真实 config.json 里是**全局默认值**，
//   'socialV2.wake.triggers.*' 与 mode/infinite 则是**按会话覆盖**（见 bridge.js:3201-3223 的 next 对象，
//   以及 9794-9796 的 `st.wakeConfig?.x ?? cfg.socialV2?.wake?.x` 回落链）。
//   两种都落盘（state/social-v2.json），重启后仍在——满足方案里"必须落盘且在重启后保留"的要求。
export const SELF_EDIT_WHITELIST = Object.freeze({
  // ① 发言后冷却：方案给 [60s, 3600s]。
  //    下界 60s：比这更短等于没有冷却，她刚说完话会被群里的下一句话立刻叫起来。
  //    上界 3600s：再长她就整段错过对话，且和"潜水时长"功能重复（那边本来就是给长时间静默用的）。
  'socialV2.wake.speakCooldownMs': Object.freeze({ kind: 'number', min: 60000, max: 3600000, integer: true }),
  // ② 频率帽：方案给 maxWakePerHour ∈ [5, 200]、maxWakePerMinute ∈ [1, 30]。
  //    刻意**不允许 0**：0 在两个默认值里没有意义，但在 bridge.js:3200 的语义里 0 = "不限"，
  //    所以"允许 0"等于给她一个一键放开频率帽的后门——这正是硬边界要防的事。
  'socialV2.wake.maxWakePerMinute': Object.freeze({ kind: 'number', min: 1, max: 30, integer: true }),
  'socialV2.wake.maxWakePerHour': Object.freeze({ kind: 'number', min: 5, max: 200, integer: true }),
  // ③ 潜水/活跃模式：只允许这两个枚举值。null 表示"不改"，由调用方不传该字段来表达，
  //    不在这里开一个 'none' 之类的新枚举（枚举越宽，越容易被拼错后静默通过）。
  'socialV2.wake.mode': Object.freeze({ kind: 'enum', values: Object.freeze(['diving', 'active']) }),
  // infinite=true 只在 mode='active' 时有意义（bridge.js:3235-3239 会强制置 true）；
  // diving + infinite=true 要求至少留一个触发条件，那条守卫在路由里，不在这里重复。
  'socialV2.wake.infinite': Object.freeze({ kind: 'boolean' }),
  // ④ 潜水时长：方案说"潜水时长（现有 qq_set_wake_config）"。
  //    下界 60s：短于 1 分钟不叫潜水，叫"每句话都醒"。
  //    上界 24h：她可以在深夜睡长一点，但不能把自己设成"永远不见人"。
  'socialV2.wake.sleepMs': Object.freeze({ kind: 'number', min: 60000, max: 86400000, integer: true }),
  // ⑤ 触发条件开关（方案明确点名 anyMessage / probability 等"现有能力"）。
  //    这五个布尔就是 set_wake_config 的 triggers 原生字段（bridge.js:3213-3217）。
  //    注意：允许置 false。这是"她可以决定以后不被某类事件叫醒"，不是"关掉自己的能力"——
  //    真正的自我致残路径是"全部关掉 + infinite"，由 validateChange ④ 用"至少留一个条件"堵死。
  'socialV2.wake.triggers.atMention': Object.freeze({ kind: 'boolean' }),
  'socialV2.wake.triggers.nameMention': Object.freeze({ kind: 'boolean' }),
  'socialV2.wake.triggers.question': Object.freeze({ kind: 'boolean' }),
  'socialV2.wake.triggers.poke': Object.freeze({ kind: 'boolean' }),
  'socialV2.wake.triggers.anyMessage': Object.freeze({ kind: 'boolean' }),
  // 概率触发：下界 0（等于关掉这一路，但无限期潜水+概率0 会被路由的"防永眠"守卫拒），
  // 上界 1（≥1 在语义上就等于 anyMessage，留着只会让配置更难读）。
  'socialV2.wake.triggers.probability': Object.freeze({ kind: 'number', min: 0, max: 1, integer: false }),
  // 关键词触发：数组，逐项限长限数。空数组 = 规则允许的清空（她可以不靠关键词醒）。
  'socialV2.wake.triggers.keywords': Object.freeze({ kind: 'stringArray', maxItems: 50, maxLength: 50 }),
  // 指定成员触发：只收正整数 QQ 号。上限 20 与 MCP 工具 schema（maxItems: 20）对齐，
  // 不然她改得进去、工具却读不回来，表现为"设了没用"。
  'socialV2.wake.triggers.speakerIds': Object.freeze({ kind: 'speakerIds', maxItems: 20 }),
  // 合并唤醒窗口：下界 1s（更短没有合并意义），上界 10min（比这更长会把即时对话也拖住）。
  'socialV2.wake.batchWindowMs': Object.freeze({ kind: 'number', min: 1000, max: 600000, integer: true }),
});

// 这些白名单路径在**真实 config.json 里必须有对应字段**（测试①会逐条核对，拼错即失败）。
// 其余白名单路径属于"按会话覆盖"，只存在于 state/social-v2.json 的 st.wakeConfig 里，
// 不在 config.json —— 把它们也拿去核 config.json 会得到假失败，所以显式分开。
//
// 注意 speakCooldownMs **故意不在这张表里**：它不在 config.json 的 socialV2.wake 下
// （真实字段只有 maxWakePerMinute / maxWakePerHour / defaultMs / maxMs / preSleepWaitMs），
// 只是在 bridge.js:9796 按 `st.wakeConfig?.speakCooldownMs ?? cfg.socialV2?.wake?.speakCooldownMs ?? WAKE_SPEAK_COOLDOWN_MS`
// 三级回落读取——写它等于写"按会话覆盖"，落盘在 state/social-v2.json。
// 硬把它塞进这张表，测出来的失败是假失败（路径没错，只是不在这个文件里）。
export const CONFIG_BACKED_WHITELIST_PATHS = Object.freeze([
  'socialV2.wake.maxWakePerMinute',
  'socialV2.wake.maxWakePerHour',
]);

// 每自然日自改上限（方案第 6 节：每自然日自改上限 3 次）。
// 为什么是 3：单次自改都可回滚，一天连改 3 次仍能靠审计还原；再多就说明她在"试探边界"，
// 而不是在调自己的节奏了——那种情况下应该由主人而不是她来改。
export const DAILY_SELF_EDIT_LIMIT = 3;

const MS_PER_DAY = 86400000;
const PATH_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const MAX_PATH_LEN = 200;

// ── 基础工具 ──────────────────────────────────────────────────────────────

// 路径合法性：只允许 a.b.c 形式的标识符段。
// 为什么不用更宽的正则：'[' / ']' / '/' 这些一旦放进来，就可能被用来表达
// 取下标（allow.groups[0]）或路径穿越，绕开前缀匹配的判断。
export function isValidPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH_LEN && PATH_RE.test(path);
}

function asSegments(path) {
  return String(path ?? '').split('.');
}

function segmentsOf(path) {
  return PATH_RE.test(String(path ?? '')) ? String(path).split('.') : [];
}

// 段匹配：整段等于 key / 以 key 结尾 / 以 key 开头。
// 结尾匹配挡住 'dsh.authToken'；开头匹配挡住 'tokenValue' 这类变体；全等匹配挡住 'token'。
function segmentMatchesKey(seg, key) {
  const s = seg.toLowerCase();
  const k = String(key).toLowerCase();
  return s === k || s.endsWith(k) || s.startsWith(k);
}

function patternHits(path) {
  const segments = segmentsOf(path);
  if (segments.length === 0) return null;
  const rules = [
    // 注意这里**没有**裸 'key' 这一项：segments 是"以 key 结尾"匹配，
    // 而白名单里就有 'socialV2.wake.triggers.probability'（probability 正好以 "key" 结尾）。
    // 裸 key 会把概率触发直接打成硬边界——自己拦自己，且报的理由完全看不懂。
    // 驼峰/拼接变体（apiKey / accessToken / consoleToken）由下面的正则覆盖。
    ['凭证/密钥类字段（token、secret、password、credential…）', (seg) => ['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'apikey', 'api_key', 'api-key', 'access_token', 'auth_token', 'console_token', 'private_key'].some((k) => segmentMatchesKey(seg, k))],
    ['群/私聊白名单与黑名单', (seg) => ['allow', 'deny', 'whitelist', 'blacklist', 'allowedgroups', 'allowedusers', 'groupsdisabled'].includes(seg.toLowerCase())],
    ['主人身份字段', (seg) => ['ownerqq', 'ownerid', 'owner', 'adminqq', 'masterqq'].includes(seg.toLowerCase())],
    ['模型 / 人格 / preset 字段', (seg) => seg.toLowerCase() === 'model' || seg.toLowerCase().startsWith('model') || ['models', 'provider', 'agentpreset', 'preset', 'persona', 'role', 'systemprompt', 'workspacetitle'].includes(seg.toLowerCase())],
    ['审计 / 打码 / 安全开关', (seg) => ['masktokens', 'sensitiveverdict', 'interceptnotify', 'audit', 'auditlog', 'security'].includes(seg.toLowerCase())],
    ['工具权限 / 进程控制', (seg) => ['pccontrol', 'allowprocesscontrol', 'toolrestrict', 'toolwhitelist', 'tools', 'permissions', 'permission'].includes(seg.toLowerCase())],
    ['暂停 / 总开关 / enabled 类开关', (seg) => ['paused', 'killswitch', 'disabled', 'enabled', 'active'].includes(seg.toLowerCase())],
    ['自主模块自身的配置', (seg) => seg.toLowerCase() === 'autonomy'],
    ['原型链关键字（防原型污染）', (seg) => ['__proto__', 'prototype', 'constructor'].includes(seg)],
  ];
  for (const [label, test] of rules) {
    if (test(segments[segments.length - 1]) || segments.some(test)) {
      // 段级命中只报"哪一类"，不报具体值：审计日志不该把密钥值抄一遍。
      return label;
    }
  }
  // 再跑一遍正则（正则里有更细的变体，比如 accessToken / consoleToken 的驼峰拼接）。
  for (const re of HARD_DENY_PATTERNS) {
    if (re.test(path)) return '硬边界正则命中（凭证/边界/身份/审计/工具权限之一）';
  }
  return null;
}

function prefixHits(path) {
  const p = String(path ?? '');
  for (const deny of HARD_DENY_PATHS) {
    if (p === deny || p.startsWith(deny + '.')) return deny;
  }
  return null;
}

function whitelistHint(path) {
  const p = String(path ?? '');
  const near = Object.keys(SELF_EDIT_WHITELIST).filter((w) => w.startsWith(p + '.') || p.startsWith(w + '.'));
  if (near.length === 0) return '';
  // 只给出"最近的白名单条目"，不给具体值——提示够她改对就行。
  return `（你可能是想改 ${near[0]}？）`;
}

// ── ① 路径分类 ────────────────────────────────────────────────────────────

// 返回 { level, reason }。level: 'allow' | 'deny'。
// 顺序不可换：非法 → 硬边界正则 → 硬边界前缀 → 白名单 → 默认拒绝。
export function classifyPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    return { level: 'deny', reason: '路径必须是非空字符串' };
  }
  const p = path.trim();
  if (p !== path) {
    return { level: 'deny', reason: '路径首尾不能有空白字符（写对不写巧，避免出现两个看起来一样的键）' };
  }
  if (!isValidPath(p)) {
    return { level: 'deny', reason: `路径格式非法（只允许 a.b.c 形式的字母/数字/下划线段，长度 ≤ ${MAX_PATH_LEN}）` };
  }
  const hit = patternHits(p);
  if (hit) {
    return { level: 'deny', reason: `硬边界：${hit} 属于主人专属，任何人任何理由都不放开` };
  }
  const prefix = prefixHits(p);
  if (prefix) {
    return { level: 'deny', reason: `硬边界：'${prefix}' 及其子树绝对不许自改（动了它等于把自己的刹车拆掉）` };
  }
  const spec = Object.prototype.hasOwnProperty.call(SELF_EDIT_WHITELIST, p) ? SELF_EDIT_WHITELIST[p] : null;
  if (!spec) {
    return { level: 'deny', reason: `未列入自主白名单${whitelistHint(p)}` };
  }
  return { level: 'allow', reason: `在白名单内（只允许 ${describeSpec(spec)}）` };
}

// 给错误提示和面板显示用的人话范围描述。
export function describeSpec(spec) {
  if (!spec || typeof spec !== 'object') return '未知规则';
  if (spec.kind === 'number') {
    const unit = spec.unit ? ` ${spec.unit}` : '';
    return `${spec.min} ~ ${spec.max}${unit} 的${spec.integer === false ? '数字' : '整数'}`;
  }
  if (spec.kind === 'boolean') return '布尔值 true/false';
  if (spec.kind === 'enum') return `枚举之一：${spec.values.join(' / ')}`;
  if (spec.kind === 'stringArray') return `最多 ${spec.maxItems} 条、每条 ≤ ${spec.maxLength} 字的字符串数组`;
  if (spec.kind === 'speakerIds') return `最多 ${spec.maxItems} 个正整数 QQ 号`;
  return '未知规则';
}

// ── ② 类型 / 范围归一化 ────────────────────────────────────────────────────

function normalizeNumber(raw, spec) {
  // 只接受 number 或"看起来像数字的字符串"。
  // 为什么比路由的 numOr 更严：路由那边非法值 = 保留原值（安全），
  // 而她主动给一个 'abc' 说明她判断错了自己该给什么，应该明确拒绝并告诉她范围，
  // 而不是静默保留——静默保留会让她以为改成功了。
  let n;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) n = Number(raw);
  else return { ok: false, reason: `需要数字，收到 ${typeName(raw)}` };
  if (!Number.isFinite(n)) return { ok: false, reason: '数值必须是有限数字（不接受 NaN / Infinity）' };
  const before = n;
  // integer:false（只有概率）保留小数；其余一律取整——半毫秒的冷却时间没有意义，
  // 而路由那边的 numOr 也会 Math.round，这里先取整能让审计里的值就是最终落盘的值。
  const clamped = Math.min(spec.max, Math.max(spec.min, n));
  const normalized = spec.integer === false ? clamped : Math.round(clamped);
  const note = normalized !== before ? `（已从 ${before} 钳制到 ${normalized}）` : '';
  return { ok: true, normalized, note };
}

function normalizeStringArray(raw, spec) {
  if (!Array.isArray(raw)) return { ok: false, reason: `需要字符串数组，收到 ${typeName(raw)}` };
  if (raw.length > spec.maxItems) {
    return { ok: false, reason: `最多 ${spec.maxItems} 条，收到 ${raw.length} 条` };
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, reason: `数组每一项都必须是字符串，收到 ${typeName(item)}` };
    const s = item.trim();
    if (s === '') continue; // 空串无意义，直接丢弃（不是错误）
    if (s.length > spec.maxLength) {
      return { ok: false, reason: `单条最长 ${spec.maxLength} 字，收到 ${s.length} 字` };
    }
    if (seen.has(s)) continue; // 去重：重复词只会让唤醒判定更难读
    seen.add(s);
    out.push(s);
  }
  return { ok: true, normalized: out };
}

function normalizeSpeakerIds(raw, spec) {
  if (!Array.isArray(raw)) return { ok: false, reason: `需要 QQ 号数组，收到 ${typeName(raw)}` };
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const n = typeof item === 'number' ? item : (typeof item === 'string' && /^\d+$/.test(item.trim()) ? Number(item.trim()) : NaN);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: `每一项都必须是正整数 QQ 号，收到 ${typeName(item)}` };
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (out.length > spec.maxItems) return { ok: false, reason: `最多 ${spec.maxItems} 个，收到 ${out.length} 个` };
  return { ok: true, normalized: out };
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  if (v === undefined) return 'undefined';
  return typeof v === 'object' ? '对象' : `${typeof v}`;
}

// 按 spec 归一化。返回 { ok, normalized, note } 或 { ok:false, reason }。
export function normalizeBySpec(path, raw, spec) {
  const s = spec ?? (Object.prototype.hasOwnProperty.call(SELF_EDIT_WHITELIST, path) ? SELF_EDIT_WHITELIST[path] : null);
  if (!s) return { ok: false, reason: '该路径没有白名单规则' };
  if (raw === undefined) return { ok: false, reason: '缺少要写入的值' };
  if (s.kind === 'number') return normalizeNumber(raw, s);
  if (s.kind === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, reason: `需要布尔值 true/false，收到 ${typeName(raw)}` };
    return { ok: true, normalized: raw };
  }
  if (s.kind === 'enum') {
    if (typeof raw !== 'string') return { ok: false, reason: `需要字符串枚举，收到 ${typeName(raw)}` };
    const v = raw.trim();
    if (!s.values.includes(v)) return { ok: false, reason: `只允许 ${s.values.join(' / ')}，收到 '${v.slice(0, 40)}'` };
    return { ok: true, normalized: v };
  }
  if (s.kind === 'stringArray') return normalizeStringArray(raw, s);
  if (s.kind === 'speakerIds') return normalizeSpeakerIds(raw, s);
  return { ok: false, reason: '未知的白名单规则类型' };
}

// ── ③ 读配置（只读，不改）─────────────────────────────────────────────────

// 从 config 或会话状态里读某个点号路径的值。
// 仅供 validateChange 做"至少留一个唤醒条件"这类跨字段判断使用；
// 不做深拷贝、不做序列化——传入的是实时配置对象，只读叶子字段。
export function readPath(obj, path) {
  if (!obj || typeof obj !== 'object' || !isValidPath(path)) return undefined;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// 无限期潜水时，必须至少留一个能把她叫醒的条件（与 bridge.js:3289 的守卫同源，
// 只是这里提前到"她提交之前"判，避免她用 3 次额度连续提交 3 条注定被路由拒的改动）。
const WAKE_CONDITION_PATHS = Object.freeze([
  'socialV2.wake.triggers.atMention',
  'socialV2.wake.triggers.nameMention',
  'socialV2.wake.triggers.poke',
  'socialV2.wake.triggers.question',
  'socialV2.wake.triggers.anyMessage',
]);
const WAKE_CONDITION_ARRAY_PATHS = Object.freeze([
  'socialV2.wake.triggers.keywords',
  'socialV2.wake.triggers.speakerIds',
]);

function wakeConditionAfterEdit(path, normalized, config) {
  // 先取"改完以后"的整个触发条件集合：config 里的现值 + 本次 after 值。
  const after = [];
  for (const p of WAKE_CONDITION_PATHS) {
    const v = p === path ? normalized : readPath(config, p);
    after.push({ p, on: v === true });
  }
  for (const p of WAKE_CONDITION_ARRAY_PATHS) {
    const v = p === path ? normalized : readPath(config, p);
    after.push({ p, on: Array.isArray(v) && v.length > 0 });
  }
  const probability = 'socialV2.wake.triggers.probability' === path
    ? Number(normalized)
    : Number(readPath(config, 'socialV2.wake.triggers.probability'));
  if (Number.isFinite(probability) && probability > 0) after.push({ p: 'socialV2.wake.triggers.probability', on: true });
  return after;
}

function wouldBeInfinite(path, normalized, config) {
  if (path === 'socialV2.wake.infinite') return normalized === true;
  // mode 改动的语义：active 一定是 infinite（见路由 3235-3239），diving 时 infinite 由状态里的现值决定。
  // 这里两种取值都返回 true —— 保守口径：宁可把她当成"可能一直睡着"，也不放任自改悄悄滑进无限潜水。
  if (path === 'socialV2.wake.mode') return true;
  // mode='diving' 时 infinite 由状态里的现值决定；active 一定是 infinite（见路由 3235-3239）。
  const mode = readPath(config, 'socialV2.wake.mode');
  if (mode === 'active') return true;
  return readPath(config, 'socialV2.wake.infinite') === true;
}

// ── ④ 主校验 ──────────────────────────────────────────────────────────────

// validateChange(path, value, { currentValue, config }) → { ok, level, reason, normalized }
// level: 'allow' 表示通过硬边界与白名单的检查（ok 反映"值是否合法"）；
//        'deny'  表示路径本身就不许碰（此时 ok 一定是 false）。
export function validateChange(path, value, opts = {}) {
  const { currentValue, config } = opts ?? {};
  const cls = classifyPath(path);
  if (cls.level !== 'allow') {
    return { ok: false, level: 'deny', reason: cls.reason, normalized: undefined };
  }
  const spec = SELF_EDIT_WHITELIST[path];
  const norm = normalizeBySpec(path, value, spec);
  if (!norm.ok) {
    return { ok: false, level: 'allow', reason: `值不合法（${describeSpec(spec)}）：${norm.reason}`, normalized: undefined };
  }
  // ③ 不允许把能把自己叫醒的能力关空。
  //    只有"无限期潜水"才需要这条：有限潜水到期本来就会醒来，关掉全部触发条件是合理的。
  if (wouldBeInfinite(path, norm.normalized, config)) {
    const after = wakeConditionAfterEdit(path, norm.normalized, config);
    const anyOn = after.some((x) => x.on);
    if (!anyOn) {
      return {
        ok: false,
        level: 'allow',
        reason: '拒绝：无限期潜水时必须至少保留一个唤醒条件（@/名字/拍一拍/提问/anyMessage/概率>0/关键词/指定成员），否则你会永眠——这条不是限制你，是防止你把自己说没了',
        normalized: undefined,
      };
    }
  }
  // ④ 主人按下的暂停/静默优先级最高：socialV2.paused 或 socialV2.enabled=false 时，
  //    她不能靠改唤醒条件绕过（那些字段在硬边界里，她本来就改不动，这里只是把语义说清楚）。
  if (config && typeof config === 'object') {
    const paused = readPath(config, 'socialV2.paused');
    const socialEnabled = readPath(config, 'socialV2.enabled');
    if (paused === true || socialEnabled === false) {
      return {
        ok: false,
        level: 'allow',
        reason: '拒绝：主人已暂停社交模块（socialV2.paused=true 或 socialV2.enabled=false），暂停期间不接受任何自改；恢复由主人决定',
        normalized: undefined,
      };
    }
  }
  const note = norm.note ? ` ${norm.note}` : '';
  const same = currentValue !== undefined && sameValue(currentValue, norm.normalized);
  return {
    ok: true,
    level: 'allow',
    reason: `通过${note}${same ? '（与当前值相同，仍会记一条审计）' : ''}`,
    normalized: norm.normalized,
  };
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  return a === b;
}

// ── ⑤ 每日配额与批量计划 ──────────────────────────────────────────────────

// 本地日 key（YYYY-MM-DD）。为什么用本地日而不是 UTC 日：
//   主人和她的作息都是本地时间，"今天改了几次"必须和主人看到的日期一致；
//   用 UTC 的话，晚上 8 点之后（UTC 跨日）配额会提前重置，看起来像"上限没生效"。
//   实现刻意只用 Date 的 getFullYear/getMonth/getDate（不调 Date.now()，时间由 nowMs 传入）。
export function dayKeyFromMs(nowMs) {
  const ms = Number(nowMs);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 统计审计日志里"今天已经成功改了几次"。
// 口径：只数 ok=true 的条目（被拒的尝试不算额度——否则她随手试几次就把额度耗光，
//   会退化成一整天不敢动任何配置）；跨日按本地日切分，由 nowMs 推导。
export function countToday(entries, nowMs) {
  const today = dayKeyFromMs(nowMs);
  if (!today) return 0;
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.ok !== true) continue;
    const ts = Number(e.atMs ?? e.nowMs ?? e.ts);
    if (!Number.isFinite(ts)) continue;
    if (dayKeyFromMs(ts) === today) n += 1;
  }
  return n;
}

// 审计条目。字段固定、全部是原始值（不含任何配置对象引用），可直接 JSON 落盘。
export function makeAuditEntry({ path, from, to, ok, reason, nowMs, source } = {}) {
  const ts = Number(nowMs);
  return Object.freeze({
    v: AUDIT_ENTRY_VERSION,
    atMs: Number.isFinite(ts) ? ts : 0,
    day: dayKeyFromMs(ts),
    path: typeof path === 'string' ? path : String(path ?? ''),
    from: from === undefined ? null : from,
    to: to === undefined ? null : to,
    ok: ok === true,
    reason: typeof reason === 'string' ? reason : String(reason ?? ''),
    source: typeof source === 'string' && source ? source : 'self',
  });
}

// planSelfEdit(changes, { nowMs, todayCount, auditLog })
//   changes: [{ path, value, reason?, source? }] 或 { path: value, ... } 映射
//   返回 { ok, applied:[], rejected:[], quotaLeft, reason }
//
// 语义要点：
//   - **超过每日上限的一律拒绝，不截断**：截断会让她以为 5 条都改了，实际只落了 2 条，
//     下一个回合她读到的配置和她以为的不一样 —— 这种"静默部分成功"最难排查。
//   - 同一批里同一个路径出现两次 → 后一条拒绝（避免一条审查看不出到底最终值是多少）。
//   - 一条都没通过时 ok=false，但 rejected 里每条都有具体理由。
export function planSelfEdit(changes, opts = {}) {
  const { nowMs, auditLog } = opts ?? {};
  const ts = Number(nowMs);
  const used = Number.isFinite(Number(opts?.todayCount))
    ? Math.max(0, Math.round(Number(opts.todayCount)))
    : countToday(auditLog, ts);
  const limit = DAILY_SELF_EDIT_LIMIT;
  let left = Math.max(0, limit - used);

  const list = normalizeChangeList(changes);
  const applied = [];
  const rejected = [];
  const withValue = new Map(); // 存"当前值"，用于同批重复路径检测与 from 回填

  for (const item of list) {
    const cls = classifyPath(item.path);
    if (left <= 0) {
      const reason = `已用完今天 ${limit} 次自改额度（今天已成功 ${used} 次），本条未执行；额度按本地日 ${dayKeyFromMs(ts)} 计算，明天自动重置`;
      rejected.push(makeAuditEntry({ path: item.path, from: null, to: null, ok: false, reason, nowMs: ts, source: item.source }));
      continue;
    }
    if (cls.level === 'deny') {
      rejected.push(makeAuditEntry({ path: item.path, from: null, to: null, ok: false, reason: cls.reason, nowMs: ts, source: item.source }));
      continue;
    }
    if (withValue.has(item.path)) {
      const reason = '同一次提交里同一路径重复出现，后一条被拒（避免审计看不出最终值）';
      rejected.push(makeAuditEntry({ path: item.path, from: null, to: null, ok: false, reason, nowMs: ts, source: item.source }));
      continue;
    }
    const currentValue = item.currentValue !== undefined ? item.currentValue : readPath(opts?.config, item.path);
    const v = validateChange(item.path, item.value, { currentValue, config: opts?.config });
    if (!v.ok) {
      rejected.push(makeAuditEntry({ path: item.path, from: currentValue === undefined ? null : currentValue, to: null, ok: false, reason: v.reason, nowMs: ts, source: item.source }));
      continue;
    }
    applied.push(makeAuditEntry({
      path: item.path,
      from: currentValue === undefined ? null : currentValue,
      to: v.normalized,
      ok: true,
      reason: item.reason ? String(item.reason) : v.reason,
      nowMs: ts,
      source: item.source,
    }));
    withValue.set(item.path, v.normalized);
    left -= 1;
  }

  const ok = applied.length > 0 && rejected.length === 0;
  const reason = applied.length === 0
    ? (rejected.length === 0 ? '没有要改的项' : `全部被拒：${rejected[0].reason}`)
    : (rejected.length === 0
      ? `通过 ${applied.length} 条，剩余今日额度 ${left} 次`
      : `通过 ${applied.length} 条、拒绝 ${rejected.length} 条，剩余今日额度 ${left} 次`);
  return { ok, applied, rejected, quotaLeft: left, reason, todayCount: used, limit };
}

function normalizeChangeList(changes) {
  const out = [];
  if (Array.isArray(changes)) {
    for (const c of changes) {
      if (!c || typeof c !== 'object') continue;
      if (!('path' in c)) continue;
      out.push({
        path: String(c.path ?? ''),
        value: c.value,
        currentValue: c.currentValue,
        reason: c.reason,
        source: c.source,
      });
    }
    return out;
  }
  if (changes && typeof changes === 'object') {
    for (const [path, value] of Object.entries(changes)) out.push({ path, value });
  }
  return out;
}

// ── ⑥ 回滚 ────────────────────────────────────────────────────────────────

// rollbackPlan(entries) → [{ path, to, reason, from }]
//
// 为什么必须**逆序**：同一路径一天内可能被改多次（额度是 3，不是 1）。
//   `概率 0.05 → 0.2 → 0.5` 的三条审计，只有倒着回滚（0.5→0.2、0.2→0.05）
//   才能回到最初的 0.05；正序回滚会把 0.05 写回去、再被 0.2 覆盖，最终停在中间值，
//   而面板上看起来"回滚成功"——这是最容易在真实事故里踩的坑：事后想还原却发现更乱。
// 只回滚 ok=true 的条目；被拒的条目从未落地，回滚它反而会写入脏值。
export function rollbackPlan(entries) {
  if (!Array.isArray(entries)) return [];
  const ok = entries.filter((e) => e && typeof e === 'object' && e.ok === true && typeof e.path === 'string' && e.path);
  const out = [];
  for (let i = ok.length - 1; i >= 0; i -= 1) {
    const e = ok[i];
    out.push({
      path: e.path,
      to: e.from,
      from: e.to,
      reason: `撤销 ${e.day || dayKeyFromMs(e.atMs) || '未知日期'} 的改动（原值 ${fmt(e.from)} → 改后 ${fmt(e.to)}）`,
      atMs: Number.isFinite(Number(e.atMs)) ? Number(e.atMs) : 0,
    });
  }
  return out;
}

function fmt(v) {
  if (v === null || v === undefined) return '未设置';
  if (Array.isArray(v)) return `[${v.join(',')}]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

// ── ⑦ 统计（面板用）──────────────────────────────────────────────────────

// autonomyStats(auditLog) → { n, ok, denied, byReason, todayCount, quotaLeft, limit, day }
// 口径写清楚（不然面板上的数字会被误读）：
//   n          —— 审计条目总数（含被拒的尝试）
//   ok         —— ok=true 的条数（= 真正落地过的自改次数）
//   denied     —— ok=false 的条数（**尝试但被拒**，不消耗额度）
//   byReason   —— 按拒绝理由归类计数（理由做了截断，避免同一原因因参数不同被拆成几十类）
//   todayCount —— 本地日切分，由 nowMs 推导；只数 ok=true
//   quotaLeft  —— max(0, 3 - todayCount)
export function autonomyStats(auditLog, opts = {}) {
  const entries = Array.isArray(auditLog) ? auditLog : [];
  const nowMs = Number(opts?.nowMs);
  const byReason = {};
  let ok = 0;
  let denied = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.ok === true) { ok += 1; continue; }
    denied += 1;
    const key = reasonKey(e.reason);
    byReason[key] = (byReason[key] || 0) + 1;
  }
  const todayCount = countToday(entries, nowMs);
  const limit = DAILY_SELF_EDIT_LIMIT;
  return {
    n: entries.length,
    ok,
    denied,
    byReason,
    todayCount,
    quotaLeft: Math.max(0, limit - todayCount),
    limit,
    day: dayKeyFromMs(nowMs),
  };
}

// 拒绝理由归一：'未列入自主白名单（你可能是想改 xxx？）' 与 '未列入自主白名单'
// 应该算同一类。只取第一个分隔符前的主干。
function reasonKey(reason) {
  const s = String(reason ?? '').trim();
  if (!s) return '（无理由）';
  const head = s.split(/[（(：:，,。；;]/)[0].trim() || s;
  return head.slice(0, 40);
}

// 一行摘要，方便日志里直接打。
export function summarizePlan(plan) {
  const p = plan || {};
  return `自改计划：通过 ${(p.applied || []).length} / 拒绝 ${(p.rejected || []).length} / 今日剩余 ${p.quotaLeft ?? '?'} 次 —— ${p.reason || ''}`;
}

// ── 节奏参数（tuning）与呼吸参数（breathing）之分 ───────────────────────────
//
// 为什么必须分开：`/api/socialV2/wake-config` 既是"调参数"的地方，**也是她结束每一轮的
// 呼吸口**（睡多久、下次被什么叫醒）。如果把整套白名单都挂上"每天 3 次"的硬额度，
// 她当天第 4 次收尾就会被 403 —— 那不是"限制她的自主权"，那是把她的呼吸管掐了
// （收尾失败 → 桥接反复提醒"你还没收尾" → 可能变成唤醒循环）。
//
// 所以真正需要限量的是**能把自己变成话痨的那几个旋钮**（唤醒频率、冷却、概率）：
//   speakCooldownMs / maxWakePerMinute / maxWakePerHour / triggers.probability
// 它们一天最多改 3 次；而 mode / infinite / sleepMs / batchWindowMs / 触发开关 /
// keywords / speakerIds 这些"呼吸参数"仍然逐一过白名单与区间校验，但不吃每日额度
// —— 因为这批能力在本次升级之前她本来就有，限量等于凭空收回主人已经批准的东西。
export const AUTONOMY_TUNING_PATHS = Object.freeze([
  'socialV2.wake.speakCooldownMs',
  'socialV2.wake.maxWakePerMinute',
  'socialV2.wake.maxWakePerHour',
  'socialV2.wake.triggers.probability',
]);

export function isTuningPath(path) {
  return AUTONOMY_TUNING_PATHS.includes(String(path ?? ''));
}

const TUNING_TOP_FIELDS = Object.freeze(['speakCooldownMs', 'maxWakePerMinute', 'maxWakePerHour']);
const TUNING_TRIGGER_FIELDS = Object.freeze(['probability']);

// 把 qq_set_wake_config 的入参切成 {tuning, rest} 两份（都是新对象，不改入参）。
// triggers 要单独深切一层：probability 属于 tuning，其余开关属于 rest。
export function splitTuningInput(input) {
  const safe = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const tuning = {};
  const rest = {};
  for (const [k, v] of Object.entries(safe)) {
    if (k === 'triggers') continue;
    const bucket = TUNING_TOP_FIELDS.includes(k) ? tuning : rest;
    bucket[k] = v;
  }
  const trg = safe.triggers && typeof safe.triggers === 'object' && !Array.isArray(safe.triggers) ? safe.triggers : null;
  if (trg) {
    const tuningTrg = {};
    const restTrg = {};
    for (const [k, v] of Object.entries(trg)) {
      const bucket = TUNING_TRIGGER_FIELDS.includes(k) ? tuningTrg : restTrg;
      bucket[k] = v;
    }
    if (Object.keys(tuningTrg).length) tuning.triggers = tuningTrg;
    if (Object.keys(restTrg).length) rest.triggers = restTrg;
  }
  return { tuning, rest };
}

// rest ⊕ 过闸门后的 tuning（triggers 深合并），拼回一个完整入参交给原路由。
export function mergeTuningInput(rest, tuningInput) {
  const out = { ...(rest && typeof rest === 'object' ? rest : {}) };
  const t = tuningInput && typeof tuningInput === 'object' ? tuningInput : {};
  for (const [k, v] of Object.entries(t)) {
    if (k === 'triggers') out.triggers = { ...(out.triggers ?? {}), ...v };
    else out[k] = v;
  }
  return out;
}
