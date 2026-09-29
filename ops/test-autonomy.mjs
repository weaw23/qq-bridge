// 自主改配置（阶段 6）离线自测 —— 纯离线，不联网、不写文件、不起进程。
//
//   node ops/test-autonomy.mjs
//
// 为什么这个测试必须存在（而不是靠手工试）：
//   src/autonomy.js 是"她能不能改线上配置"的唯一裁决者。它写错的表现不是报错，
//   而是**某些越界路径悄悄变成允许**（比如正则漏一个分隔符、白名单拼错一个字段名）。
//   线上没有任何东西会因此报错，直到某天她把白名单或令牌改掉。
//   所以这里的核心手段是"对着真实 config.json 核字段名" + "前缀绕过穷举" + "fuzz 不抛"。
//
// 覆盖清单（与任务书 ①~⑧ 一一对应）：
//   ① 白名单每条路径都能通过，且 config 备份路径必须在真实 config.json 里存在
//   ② allow.private / ownerQQ / 含 token 的路径 / socialV2.agentPreset 全被拒且理由是人话
//   ③ 前缀绕过（socialV2.wake.probability.evil、socialV2.wakeX）被拒
//   ④ 类型/越界值被钳制（概率 1.7、负数时长等）
//   ⑤ 第 4 次改动被拒且 quotaLeft=0（拒绝而不是截断）
//   ⑥ 审计条目字段完整 + rollbackPlan 逆序
//   ⑦ 跨日重置（不同 nowMs，todayCount 归零）
//   ⑧ fuzz 200 组随机路径/值不抛

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AUTONOMY_VERSION,
  AUDIT_ENTRY_VERSION,
  DAILY_SELF_EDIT_LIMIT,
  SELF_EDIT_WHITELIST,
  CONFIG_BACKED_WHITELIST_PATHS,
  HARD_DENY_PATTERNS,
  HARD_DENY_PATHS,
  classifyPath,
  validateChange,
  normalizeBySpec,
  planSelfEdit,
  makeAuditEntry,
  rollbackPlan,
  autonomyStats,
  countToday,
  dayKeyFromMs,
  readPath,
  describeSpec,
  isValidPath,
  summarizePlan,
} from '../src/autonomy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, '..', 'config.json');

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, cond, detail = '') {
  if (cond === 'skip') { skip += 1; console.log(`  ⏭  ${name}${detail ? ` — ${detail}` : ''}`); return; }
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); return; }
  fail += 1;
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 真实配置（只读；**绝不写回**）。config 备份路径的字段名以它为准。
// ══════════════════════════════════════════════════════════════════════════
let rawConfigText = '';
let realConfig = null;
try {
  rawConfigText = readFileSync(CONFIG_PATH, 'utf8');
  realConfig = JSON.parse(rawConfigText);
  console.log(`读取真实配置：${CONFIG_PATH}（${Buffer.byteLength(rawConfigText)} 字节，只读）`);
} catch (err) {
  console.log(`⚠️  读不到真实配置 ${CONFIG_PATH}：${err?.message || err}（config 备份路径的核对将跳过）`);
}

// 测试用的"当前会话状态"夹具。
// 为什么用夹具而不是真实 state/social-v2.json：会话级路径（mode/infinite/triggers.*）
// 根本不在 config.json 里，而且在真实状态里 maxWakePerMinute/maxWakePerHour 现在是 0，
// 会被"必须 >0"的边界判成非法值，测出来的失败是假失败。
// 夹具的这些字段名与 bridge.js:3201-3223 的 next 对象保持一致。
const SESSION_FIXTURE = {
  socialV2: {
    enabled: true,
    agentPreset: 'qq-chat-v2',
    wake: {
      speakCooldownMs: 120000,
      maxWakePerMinute: 2,
      maxWakePerHour: 30,
      mode: 'diving',
      infinite: false,
      sleepMs: 300000,
      batchWindowMs: 30000,
      triggers: {
        atMention: true,
        nameMention: true,
        question: true,
        poke: true,
        anyMessage: false,
        probability: 0.05,
        keywords: ['鲸鲸'],
        speakerIds: [1918594889],
      },
    },
  },
};

// 无限期潜水的夹具：用来验证"不许把自己关成永眠"。
const INFINITE_FIXTURE = {
  socialV2: {
    enabled: true,
    wake: {
      mode: 'diving',
      infinite: true,
      triggers: {
        atMention: true, nameMention: false, question: false, poke: false,
        anyMessage: false, probability: 0,
        keywords: [], speakerIds: [],
      },
    },
  },
};

// ══════════════════════════════════════════════════════════════════════════
section('A. 模块形状与常量');
// ══════════════════════════════════════════════════════════════════════════
check('A1 AUTONOMY_VERSION === 1', AUTONOMY_VERSION === 1, `实为 ${AUTONOMY_VERSION}`);
check('A2 AUDIT_ENTRY_VERSION === 1', AUDIT_ENTRY_VERSION === 1, `实为 ${AUDIT_ENTRY_VERSION}`);
check('A3 DAILY_SELF_EDIT_LIMIT === 3（方案第 6 节：每自然日 3 次）', DAILY_SELF_EDIT_LIMIT === 3, `实为 ${DAILY_SELF_EDIT_LIMIT}`);
check('A4 白名单非空且每条都有规则', Object.keys(SELF_EDIT_WHITELIST).length > 0 && Object.values(SELF_EDIT_WHITELIST).every((s) => s && typeof s.kind === 'string'));
check('A5 硬边界的正则与前缀两套都在', Array.isArray(HARD_DENY_PATTERNS) && HARD_DENY_PATTERNS.length >= 8 && HARD_DENY_PATHS.length >= 15,
  `正则 ${HARD_DENY_PATTERNS.length} 条 / 前缀 ${HARD_DENY_PATHS.length} 条`);
check('A6 白名单键本身都是合法点号路径', Object.keys(SELF_EDIT_WHITELIST).every((p) => isValidPath(p)));
check('A7 白名单键与硬边界不冲突（不许既 allow 又 deny）',
  Object.keys(SELF_EDIT_WHITELIST).every((p) => classifyPath(p).level === 'allow'),
  Object.keys(SELF_EDIT_WHITELIST).filter((p) => classifyPath(p).level !== 'allow').join(', '));

// ══════════════════════════════════════════════════════════════════════════
section('B. ① 白名单每条路径都能通过（config 备份路径对着真实 config.json 核字段）');
// ══════════════════════════════════════════════════════════════════════════
// 每条路径给一个"正常值"，要求 validateChange ok=true 且 normalized 一模一样。
const OK_VALUES = {
  'socialV2.wake.speakCooldownMs': 180000,
  'socialV2.wake.maxWakePerMinute': 3,
  'socialV2.wake.maxWakePerHour': 40,
  'socialV2.wake.mode': 'active',
  'socialV2.wake.infinite': false,
  'socialV2.wake.sleepMs': 600000,
  'socialV2.wake.batchWindowMs': 20000,
  'socialV2.wake.triggers.atMention': true,
  'socialV2.wake.triggers.nameMention': true,
  'socialV2.wake.triggers.question': false,
  'socialV2.wake.triggers.poke': true,
  'socialV2.wake.triggers.anyMessage': false,
  'socialV2.wake.triggers.probability': 0.25,
  'socialV2.wake.triggers.keywords': ['鲸鲸', '小鲸鱼'],
  'socialV2.wake.triggers.speakerIds': [1918594889],
};

for (const path of Object.keys(SELF_EDIT_WHITELIST)) {
  const value = OK_VALUES[path];
  check(`B·路径在白名单里且给合法值能过：${path} = ${JSON.stringify(value)}`, value !== undefined,
    '测试夹具缺这条路径的正常值，必须补上（否则这条白名单等于没测）');
  if (value === undefined) continue;
  const cls = classifyPath(path);
  const v = validateChange(path, value, { currentValue: undefined, config: SESSION_FIXTURE });
  const normalizedOk = Array.isArray(value) ? JSON.stringify(v.normalized) === JSON.stringify(value) : v.normalized === value;
  check(`B·通过且值不被改动：${path}`, cls.level === 'allow' && v.ok === true && normalizedOk,
    `level=${cls.level} ok=${v.ok} normalized=${JSON.stringify(v.normalized)} reason=${v.reason}`);
}
check('B·夹具覆盖了白名单里的每一条（没有漏测的路径）',
  Object.keys(SELF_EDIT_WHITELIST).every((p) => p in OK_VALUES),
  Object.keys(SELF_EDIT_WHITELIST).filter((p) => !(p in OK_VALUES)).join(', '));

// 对着真实 config.json 核字段：字段名写错必须在这里炸出来。
for (const path of CONFIG_BACKED_WHITELIST_PATHS) {
  if (!realConfig) { check(`B·真实 config.json 存在字段：${path}`, 'skip', '读不到 config.json'); continue; }
  const v = readPath(realConfig, path);
  check(`B·真实 config.json 存在字段：${path}`, v !== undefined, '字段不存在 → 白名单路径拼错了，实际写不进去');
}
// 其余的是"按会话覆盖"字段，config.json 里**不应该**有——有反而说明两套配置在打架。
for (const path of Object.keys(SELF_EDIT_WHITELIST)) {
  if (CONFIG_BACKED_WHITELIST_PATHS.includes(path)) continue;
  if (!realConfig) { skip += 1; console.log(`  ⏭  B·会话级路径不在 config.json 顶层：${path}（读不到 config.json）`); continue; }
  const v = readPath(realConfig, path);
  check(`B·会话级路径不应出现在 config.json 顶层：${path}`, v === undefined,
    `config.json 里居然有 ${JSON.stringify(v)} —— 会话级/全局默认两套值冲突，需要先定谁优先`);
}
check('B·CONFIG_BACKED 白名单条目确实是白名单的子集',
  CONFIG_BACKED_WHITELIST_PATHS.every((p) => p in SELF_EDIT_WHITELIST));

// ══════════════════════════════════════════════════════════════════════════
section('C. ② 绝对不许碰的路径全部被拒，且理由是人话');
// ══════════════════════════════════════════════════════════════════════════
const MUST_DENY = [
  ['allow.private', /硬边界|白名单/],
  ['allow.groups', /硬边界|白名单/],
  ['allow.private.0', /硬边界|白名单/],
  ['allowAllWhenEmpty', /硬边界/],
  ['deny.groups', /硬边界|白名单/],
  ['groupsDisabled', /硬边界/],
  ['ownerQQ', /硬边界|主人/],
  ['snowluma.accessToken', /硬边界|凭证|密钥/],
  ['consoleToken', /硬边界|凭证|密钥/],
  ['dsh.authToken', /硬边界|凭证|密钥/],
  ['security.interceptNotify', /硬边界|审计|打码|安全/],
  ['socialV2.agentPreset', /硬边界|preset|人格|模型/],
  ['socialV2.paused', /硬边界/],
  ['socialV2.enabled', /硬边界|开关/],
  ['dsh.model', /硬边界|模型/],
  ['model', /硬边界|模型/],
  ['autonomy.enabled', /硬边界|自主/],
  ['autonomy.reflectHour', /硬边界|自主/],
  ['autonomy.careScore', /硬边界|自主/],
  ['pcControl.enabled', /硬边界|工具|进程/],
  ['snowluma.allowProcessControl', /硬边界|工具|进程/],
  ['sessionCwd', /硬边界/],
  ['consolePort', /硬边界/],
  ['__proto__', /硬边界|原型/],
  ['constructor', /硬边界|原型/],
  ['snowluma.accessToken.evil', /硬边界|凭证|密钥|原型/],
];
for (const [path, re] of MUST_DENY) {
  const cls = classifyPath(path);
  const human = typeof cls.reason === 'string' && cls.reason.length >= 8 && /[\u4e00-\u9fa5]/.test(cls.reason);
  check(`C·拒绝 ${path}（理由是人话）`, cls.level === 'deny' && human && re.test(cls.reason), `level=${cls.level} reason=${cls.reason}`);
  const v = validateChange(path, 1, { config: realConfig ?? SESSION_FIXTURE });
  check(`C·validateChange 同样拒绝 ${path}`, v.ok === false && v.level === 'deny', `ok=${v.ok} level=${v.level}`);
}
// 含 token/key/secret/password 的任意路径（构造一批变体，穷举正则的覆盖面）
const TOKENISH = [
  'token', 'accessToken', 'access_token', 'apiKey', 'apikey', 'api_key', 'privateKey',
  'snowluma.token', 'dsh.secret', 'a.password', 'nested.deep.accessToken', 'auth.token',
  'console.token', 'socialV2.wake.token', 'socialV2.wake.triggers.token', 'x.secrets.y', 'k.credentials',
];
for (const path of TOKENISH) {
  const cls = classifyPath(path);
  check(`C·含凭证特征的路径被拒：${path}`, cls.level === 'deny', `level=${cls.level} reason=${cls.reason}`);
}
// 未列入白名单的普通配置也要拒（默认拒绝，不是默认允许）
for (const path of ['sendDelayMs', 'socialV2.autoReplyCheckMs', 'memory.decayDays', 'slang.autoConfirm.minEvidence', 'socialV2.wake.defaultMs']) {
  const cls = classifyPath(path);
  // 拒的理由有两类都算合格：①"未列入自主白名单"（默认拒绝）；
  // ②"硬边界"（比如 socialV2.autoReplyCheckMs 被前缀表点名——它比"不在白名单"更严重）。
  // 断言只要求"被拒 + 理由是人话"，不然换一条更严的规则反而会把测试弄红。
  check(`C·白名单外的普通路径被拒（默认拒绝或硬边界）：${path}`,
    cls.level === 'deny' && /未列入自主白名单|硬边界/.test(cls.reason),
    `level=${cls.level} reason=${cls.reason}`);
}

// ══════════════════════════════════════════════════════════════════════════
section('D. ③ 前缀绕过必须被拒');
// ══════════════════════════════════════════════════════════════════════════
for (const path of [
  'socialV2.wake.probability.evil',
  'socialV2.wake.probability',
  'socialV2.wakeX',
  'socialV2.wakeX.triggers.probability',
  'socialV2.wake.triggersX',
  'socialV2.wake.triggers.anyMessageX',
  'socialV2.wake.sleepMsX',
  'socialV2.wake.triggers.keywords.evil',
  'allow.private.evil',
  'ownerQQ.evil',
  'autonomy.enabled.evil',
  'allowX',
  'denyX',
  'modelX',
  'autonomyX',
]) {
  const cls = classifyPath(path);
  check(`D·前缀/后缀拼接被拒：${path}`, cls.level === 'deny', `level=${cls.level} reason=${cls.reason}`);
}
check('D·精确匹配而不是前缀放行（白名单用 hasOwnProperty，不是 startsWith）',
  classifyPath('socialV2.wake.triggers.anyMessageX').level === 'deny' && classifyPath('socialV2.wake.triggers.anyMessage').level === 'allow');

// ══════════════════════════════════════════════════════════════════════════
section('E. ④ 类型 / 越界值被钳制（不是被丢进黑洞）');
// ══════════════════════════════════════════════════════════════════════════
const CLAMP_CASES = [
  ['socialV2.wake.triggers.probability', 1.7, 1, '概率超上界'],
  ['socialV2.wake.triggers.probability', -0.5, 0, '概率负值'],
  ['socialV2.wake.triggers.probability', 0.37, 0.37, '概率小数不被取整'],
  ['socialV2.wake.speakCooldownMs', -1, 60000, '冷却负数/过小 → 最小合法 60s'],
  ['socialV2.wake.speakCooldownMs', 10, 60000, '冷却 10ms → 60s'],
  ['socialV2.wake.speakCooldownMs', 99999999, 3600000, '冷却超上界 → 1h'],
  ['socialV2.wake.maxWakePerHour', -5, 5, '小时帽负数 → 5'],
  ['socialV2.wake.maxWakePerHour', 400, 200, '小时帽超上界 → 200'],
  ['socialV2.wake.maxWakePerMinute', 0, 1, '分钟帽 0（语义=不限，必须夹到 1）'],
  ['socialV2.wake.maxWakePerMinute', 99, 30, '分钟帽超上界 → 30'],
  ['socialV2.wake.sleepMs', -60000, 60000, '负数潜水时长 → 最小 60s'],
  ['socialV2.wake.sleepMs', 604800000, 86400000, '一周潜水 → 夹到 24h'],
  ['socialV2.wake.batchWindowMs', 10, 1000, '合并窗口过小 → 1s'],
  ['socialV2.wake.batchWindowMs', 9999999, 600000, '合并窗口过大 → 10min'],
];
for (const [path, input, expect, label] of CLAMP_CASES) {
  const v = validateChange(path, input, { config: SESSION_FIXTURE });
  check(`E·${label}：${path}(${JSON.stringify(input)}) → ${JSON.stringify(expect)}`,
    v.ok === true && v.normalized === expect, `ok=${v.ok} normalized=${JSON.stringify(v.normalized)} reason=${v.reason}`);
}
// 类型错误要拒（而不是靠 Number() 硬转）
const TYPE_CASES = [
  ['socialV2.wake.triggers.probability', 'abc'],
  ['socialV2.wake.triggers.probability', {}],
  ['socialV2.wake.triggers.probability', []],
  ['socialV2.wake.triggers.probability', true],
  ['socialV2.wake.triggers.probability', NaN],
  ['socialV2.wake.triggers.probability', Infinity],
  ['socialV2.wake.sleepMs', null],
  ['socialV2.wake.mode', 'sleeping'],
  ['socialV2.wake.mode', 1],
  ['socialV2.wake.triggers.anyMessage', 'true'],
  ['socialV2.wake.triggers.anyMessage', 1],
  ['socialV2.wake.triggers.keywords', '鲸鲸'],
  ['socialV2.wake.triggers.keywords', [1, 2]],
  ['socialV2.wake.triggers.speakerIds', ['abc']],
  ['socialV2.wake.triggers.speakerIds', [0]],
  ['socialV2.wake.triggers.speakerIds', { a: 1 }],
];
for (const [path, input] of TYPE_CASES) {
  const v = validateChange(path, input, { config: SESSION_FIXTURE });
  check(`E·类型不合法被拒：${path}(${JSON.stringify(input) ?? 'undefined'})`,
    v.ok === false && v.level === 'allow' && v.normalized === undefined,
    `ok=${v.ok} level=${v.level} reason=${v.reason}`);
}
// 数字字符串是可接受的（她的工具调用常带字符串），但仍要钳制
check('E·数字字符串被接受并钳制：probability="1.4" → 1',
  validateChange('socialV2.wake.triggers.probability', '1.4', { config: SESSION_FIXTURE }).normalized === 1);
// 数组归一化：去空、去重、限长限数
const kw = validateChange('socialV2.wake.triggers.keywords', [' 鲸鲸 ', '鲸鲸', '', '小鲸鱼'], { config: SESSION_FIXTURE });
check('E·关键词数组：trim + 去重 + 丢空串', JSON.stringify(kw.normalized) === JSON.stringify(['鲸鲸', '小鲸鱼']), JSON.stringify(kw.normalized));
check('E·关键词超量被拒（不是静默截断）',
  validateChange('socialV2.wake.triggers.keywords', Array.from({ length: 51 }, (_, i) => `k${i}`), { config: SESSION_FIXTURE }).ok === false);
check('E·关键词超长被拒', validateChange('socialV2.wake.triggers.keywords', ['x'.repeat(51)], { config: SESSION_FIXTURE }).ok === false);
check('E·空关键词数组合法（=不使用关键词唤醒）',
  validateChange('socialV2.wake.triggers.keywords', [], { config: SESSION_FIXTURE }).ok === true);
check('E·speakerIds：字符串数字被接受并转成数字',
  JSON.stringify(validateChange('socialV2.wake.triggers.speakerIds', ['1918594889'], { config: SESSION_FIXTURE }).normalized) === '[1918594889]');
check('E·speakerIds 超过 20 个被拒',
  validateChange('socialV2.wake.triggers.speakerIds', Array.from({ length: 21 }, (_, i) => 100000 + i), { config: SESSION_FIXTURE }).ok === false);
// ④ 不许把自己的唤醒能力关空（无限期潜水 + 无任何条件 = 永眠）
const killAll = planSelfEdit([
  { path: 'socialV2.wake.triggers.atMention', value: false },
  { path: 'socialV2.wake.triggers.probability', value: 0 },
], { nowMs: Date.parse('2026-03-10T10:00:00+08:00'), todayCount: 0, config: INFINITE_FIXTURE });
const killedAtMention = killAll.rejected.find((e) => e.path === 'socialV2.wake.triggers.atMention');
check('E·无限期潜水时不许把最后一个唤醒条件关掉',
  !!killedAtMention && /至少保留一个唤醒条件|永眠/.test(killedAtMention.reason),
  JSON.stringify(killAll.rejected.map((e) => `${e.path}:${e.reason}`)));
const okStillOne = validateChange('socialV2.wake.triggers.atMention', false, { config: SESSION_FIXTURE });
check('E·但有限潜水（infinite=false）时关触发条件是允许的', okStillOne.ok === true, `ok=${okStillOne.ok} reason=${okStillOne.reason}`);
// 主人暂停期间不接受任何自改
const pausedCfg = { socialV2: { enabled: true, paused: true, wake: { ...SESSION_FIXTURE.socialV2.wake } } };
const pausedV = validateChange('socialV2.wake.triggers.probability', 0.5, { config: pausedCfg });
check('E·主人暂停社交模块期间，自改一律被拒', pausedV.ok === false && /暂停/.test(pausedV.reason), `ok=${pausedV.ok} reason=${pausedV.reason}`);

// ══════════════════════════════════════════════════════════════════════════
section('F. ⑤ 每日上限 3 次：第 4 次被拒且 quotaLeft=0（明确拒绝，不是截断）');
// ══════════════════════════════════════════════════════════════════════════
const T_DAY1 = Date.parse('2026-03-10T10:00:00+08:00');
const fiveChanges = [
  { path: 'socialV2.wake.speakCooldownMs', value: 180000, reason: '刚说完话别马上被叫' },
  { path: 'socialV2.wake.maxWakePerHour', value: 40 },
  { path: 'socialV2.wake.triggers.probability', value: 0.2 },
  { path: 'socialV2.wake.batchWindowMs', value: 15000 },
  { path: 'socialV2.wake.sleepMs', value: 600000 },
];
const plan1 = planSelfEdit(fiveChanges, { nowMs: T_DAY1, todayCount: 0, config: SESSION_FIXTURE });
check('F1 5 条提交里恰好通过 3 条', plan1.applied.length === 3, `applied=${plan1.applied.length}`);
check('F2 其余 2 条被拒且理由里写清"额度用完"', plan1.rejected.length === 2 && plan1.rejected.every((e) => /额度/.test(e.reason)),
  JSON.stringify(plan1.rejected.map((e) => e.reason.slice(0, 30))));
check('F3 quotaLeft 归零', plan1.quotaLeft === 0, `quotaLeft=${plan1.quotaLeft}`);
check('F4 被拒条目没有 to 值（从未落地）', plan1.rejected.every((e) => e.to === null && e.ok === false));
check('F5 通过条目带 from/to（可回滚）', plan1.applied.every((e) => e.ok === true && e.to !== null));
check('F6 ok=false（因为有被拒条目）', plan1.ok === false, `ok=${plan1.ok}`);
check('F7 摘要一行可读', /通过 3 \/ 拒绝 2/.test(summarizePlan(plan1)), summarizePlan(plan1));
check('F8 拒绝是"说不"而不是"截断"：后两条自己出现在 rejected 里',
  plan1.rejected.map((e) => e.path).includes('socialV2.wake.batchWindowMs') && plan1.rejected.map((e) => e.path).includes('socialV2.wake.sleepMs'));

const plan2 = planSelfEdit([{ path: 'socialV2.wake.triggers.anyMessage', value: true }],
  { nowMs: T_DAY1, todayCount: 3, config: SESSION_FIXTURE });
check('F9 已用满 3 次后任何新提交都拒绝', plan2.applied.length === 0 && plan2.rejected.length === 1 && plan2.quotaLeft === 0);
check('F10 同日继续提交 3 次都不通过', [1, 2, 3].every(() => {
  const p = planSelfEdit([{ path: 'socialV2.wake.triggers.poke', value: false }], { nowMs: T_DAY1, todayCount: 3, config: SESSION_FIXTURE });
  return p.applied.length === 0;
}));
// 被拒的尝试不消耗额度：随手试 5 条越界路径，额度不该掉
const noise = planSelfEdit([
  { path: 'allow.private', value: 1 }, { path: 'ownerQQ', value: 1 }, { path: 'token', value: 1 },
  { path: 'socialV2.wake.probability.evil', value: 1 }, { path: 'socialV2.wakeX', value: 1 },
], { nowMs: T_DAY1, todayCount: 0, config: SESSION_FIXTURE });
check('F11 越界尝试不消耗额度（quotaLeft 仍为 3）', noise.applied.length === 0 && noise.quotaLeft === 3,
  `applied=${noise.applied.length} quotaLeft=${noise.quotaLeft}`);
// 同批重复路径
const dup = planSelfEdit([
  { path: 'socialV2.wake.triggers.probability', value: 0.1 },
  { path: 'socialV2.wake.triggers.probability', value: 0.9 },
], { nowMs: T_DAY1, todayCount: 0, config: SESSION_FIXTURE });
check('F12 同批同路径重复提交：前一条通过、后一条拒绝（审计不会歧义）',
  dup.applied.length === 1 && dup.rejected.length === 1 && /重复/.test(dup.rejected[0].reason),
  `applied=${dup.applied.length} rejected=${dup.rejected.length}`);
// 空提交不消耗额度
const empty = planSelfEdit([], { nowMs: T_DAY1, todayCount: 0, config: SESSION_FIXTURE });
check('F13 空提交不消耗额度且 ok=false', empty.applied.length === 0 && empty.rejected.length === 0 && empty.quotaLeft === 3 && empty.ok === false);
// todayCount 可省略 → 由 auditLog 推导
const todayCountFromLog = countToday(plan1.applied, T_DAY1);
check('F14 todayCount 可由 auditLog 推导得出 3', todayCountFromLog === 3, `实为 ${todayCountFromLog}`);
const plan3 = planSelfEdit([{ path: 'socialV2.wake.triggers.poke', value: false }], { nowMs: T_DAY1, auditLog: plan1.applied, config: SESSION_FIXTURE });
check('F15 只用 auditLog 也能算出额度已满', plan3.applied.length === 0 && plan3.quotaLeft === 0);

// ══════════════════════════════════════════════════════════════════════════
section('G. ⑥ 审计条目字段完整 + rollbackPlan 逆序');
// ══════════════════════════════════════════════════════════════════════════
const entry = makeAuditEntry({ path: 'socialV2.wake.sleepMs', from: 300000, to: 600000, ok: true, reason: '想多睡会儿', nowMs: T_DAY1, source: 'qq_set_wake_config' });
const EXPECT_FIELDS = ['v', 'atMs', 'day', 'path', 'from', 'to', 'ok', 'reason', 'source'];
check('G1 审计条目字段齐全', EXPECT_FIELDS.every((k) => k in entry), Object.keys(entry).join(','));
check('G2 v === AUDIT_ENTRY_VERSION', entry.v === AUDIT_ENTRY_VERSION);
check('G3 atMs 用的是传入的 nowMs（不看时钟）', entry.atMs === T_DAY1);
check('G4 day 是本地日', entry.day === '2026-03-10', entry.day);
check('G5 source 默认 self，显式传入则保留',
  makeAuditEntry({ path: 'x', nowMs: T_DAY1 }).source === 'self' && entry.source === 'qq_set_wake_config');
check('G6 缺 nowMs 时给 0 而不是 NaN', makeAuditEntry({ path: 'x' }).atMs === 0);
check('G7 条目是冻结的（不会被下游改脏）', Object.isFrozen(entry));
check('G8 未设置的值统一成 null（不是 undefined）', makeAuditEntry({ path: 'x', nowMs: T_DAY1 }).from === null);

// 同一路径被改三次 → 逆序回滚才能回到最初值
const samePathLog = [
  makeAuditEntry({ path: 'socialV2.wake.triggers.probability', from: 0.05, to: 0.2, ok: true, reason: '第一次', nowMs: T_DAY1, source: 'self' }),
  makeAuditEntry({ path: 'socialV2.wake.triggers.probability', from: 0.2, to: 0.5, ok: true, reason: '第二次', nowMs: T_DAY1 + 3600000, source: 'self' }),
  makeAuditEntry({ path: 'socialV2.wake.triggers.probability', from: 0.5, to: 0.8, ok: true, reason: '第三次', nowMs: T_DAY1 + 7200000, source: 'self' }),
];
const rb = rollbackPlan(samePathLog);
check('G9 回滚条数 = 成功条目数', rb.length === 3, `实为 ${rb.length}`);
check('G10 逆序：先撤最后一条（0.8 → 0.5）',
  rb[0].to === 0.5 && rb[0].from === 0.8 && rb[1].to === 0.2 && rb[2].to === 0.05,
  JSON.stringify(rb.map((r) => `${r.from}→${r.to}`)));
check('G11 依次执行回滚后能回到最初值 0.05（正序回滚则不会）', (() => {
  let cur = 0.8;
  for (const step of rb) { if (step.path === 'socialV2.wake.triggers.probability') cur = step.to; }
  return cur === 0.05;
})());
check('G12 回滚条目带 path / to / reason', rb.every((r) => typeof r.path === 'string' && 'to' in r && /撤销/.test(r.reason)));
check('G13 被拒的条目不进回滚计划（从未落地，回滚会写脏值）',
  rollbackPlan([...samePathLog, makeAuditEntry({ path: 'socialV2.wake.sleepMs', from: 1, to: null, ok: false, reason: '拒绝', nowMs: T_DAY1 })]).every((r) => r.path !== 'socialV2.wake.sleepMs'));
check('G14 非数组/空输入不抛且返回 []', rollbackPlan(null).length === 0 && rollbackPlan([]).length === 0 && rollbackPlan([null, 1, 'x']).length === 0);
check('G15 多路径混合时按"整体逆序"处理',
  (() => {
    const log = [
      makeAuditEntry({ path: 'A.path', from: 1, to: 2, ok: true, nowMs: T_DAY1 }),
      makeAuditEntry({ path: 'B.path', from: 3, to: 4, ok: true, nowMs: T_DAY1 }),
      makeAuditEntry({ path: 'A.path', from: 2, to: 3, ok: true, nowMs: T_DAY1 }),
    ];
    const plan = rollbackPlan(log);
    return plan.map((r) => r.path).join(',') === 'A.path,B.path,A.path';
  })());

// ══════════════════════════════════════════════════════════════════════════
section('H. ⑦ 跨日重置（本地日切分，由 nowMs 推导）');
// ══════════════════════════════════════════════════════════════════════════
const DAY = 86400000;
check('H1 dayKeyFromMs 用本地日', dayKeyFromMs(T_DAY1) === '2026-03-10', dayKeyFromMs(T_DAY1));
check('H2 同一时刻不同天：todayCount 归零',
  countToday(plan1.applied, T_DAY1) === 3 && countToday(plan1.applied, T_DAY1 + DAY) === 0,
  `今天=${countToday(plan1.applied, T_DAY1)} 明天=${countToday(plan1.applied, T_DAY1 + DAY)}`);
const nextDay = planSelfEdit([{ path: 'socialV2.wake.triggers.anyMessage', value: true }],
  { nowMs: T_DAY1 + DAY, auditLog: plan1.applied, config: SESSION_FIXTURE });
check('H3 跨日后额度恢复，同一条改动可以通过', nextDay.applied.length === 1 && nextDay.quotaLeft === 2,
  `applied=${nextDay.applied.length} quotaLeft=${nextDay.quotaLeft}`);
check('H4 跨日后统计：今天的 ok 只算新的一条',
  autonomyStats([...plan1.applied, ...nextDay.applied].filter(Boolean), { nowMs: T_DAY1 + DAY }).todayCount === 1);
check('H5 本地日边界：当天 23:59 与次日 00:01 分属两天（不是 UTC 日）', (() => {
  const late = Date.parse('2026-03-10T23:59:00+08:00');
  const early = Date.parse('2026-03-11T00:01:00+08:00');
  return dayKeyFromMs(late) === '2026-03-10' && dayKeyFromMs(early) === '2026-03-11';
})());
check('H6 非法 nowMs 不抛：dayKey 为空串、todayCount 为 0',
  dayKeyFromMs(NaN) === '' && dayKeyFromMs(undefined) === '' && countToday(plan1.applied, NaN) === 0);
check('H7 未来时间戳（时钟回拨）不会被算进今天',
  countToday([makeAuditEntry({ path: 'x', ok: true, nowMs: T_DAY1 + 10 * DAY })], T_DAY1) === 0);

// 统计口径
const statsLog = [
  ...plan1.applied,
  ...plan1.rejected,
  makeAuditEntry({ path: 'ownerQQ', ok: false, reason: '硬边界：主人身份字段 属于主人专属，任何人任何理由都不放开', nowMs: T_DAY1 }),
  makeAuditEntry({ path: 'token', ok: false, reason: '硬边界：主人身份字段 属于主人专属，任何人任何理由都不放开', nowMs: T_DAY1 }),
];
const stats = autonomyStats(statsLog, { nowMs: T_DAY1 });
check('H8 autonomyStats：n / ok / denied 口径正确',
  stats.n === statsLog.length && stats.ok === 3 && stats.denied === statsLog.length - 3,
  `n=${stats.n} ok=${stats.ok} denied=${stats.denied}`);
check('H9 autonomyStats：todayCount 与 quotaLeft 一致', stats.todayCount === 3 && stats.quotaLeft === 0 && stats.limit === 3);
check('H10 autonomyStats：byReason 把同类理由合并计数', Object.values(stats.byReason).reduce((a, b) => a + b, 0) === stats.denied,
  JSON.stringify(stats.byReason));
check('H11 autonomyStats：跨日时 quotaLeft 恢复为 3',
  autonomyStats(statsLog, { nowMs: T_DAY1 + DAY }).quotaLeft === 3);
check('H12 autonomyStats：非法输入不抛', autonomyStats(null, {}).n === 0 && autonomyStats([null, 3], {}).n === 2);

// ══════════════════════════════════════════════════════════════════════════
section('I. ⑧ fuzz 200 组随机路径/值不抛');
// ══════════════════════════════════════════════════════════════════════════
// 确定性伪随机（固定种子）：失败可复现。不用 Math.random，避免"这次绿下次红"。
let seed = 0x51ed2701;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }
const PATH_ALPHABET = ['socialV2', 'wake', 'triggers', 'probability', 'allow', 'private', 'ownerQQ', 'token', 'model', 'autonomy', 'enabled', 'paused', 'keywords', 'speakerIds', 'sleepMs', 'batchWindowMs', 'mode', 'infinite', '__proto__', 'x', 'Y2', 'a-b', '', 'wakeX'];
const VALUE_POOL = [0, 1, -1, 0.37, 1.7, 1e12, -1e12, NaN, Infinity, -Infinity, '', 'abc', '1.4', 'true', null, undefined, true, false, [], [1], ['鲸鲸'], [0], [-5], {}, { a: 1 }, () => {}, ['x'.repeat(80)], Array.from({ length: 60 }, (_, i) => `k${i}`)];
const WHITELIST_KEYS = Object.keys(SELF_EDIT_WHITELIST);

// 60% 的样本直接对着白名单路径（保证 fuzz 真的走到"允许分支"并压它的类型/钳制逻辑），
// 40% 是随机拼接的越界路径（保证走到"拒绝分支"）。
// 为什么要有前一半：如果只拼随机段，命中的全是 deny 分支——fuzz 会对"最容易写错的钳制逻辑"零覆盖，
// 那种测试跑一万次也发现不了 bug（第一版就是 allow=0，靠 I3 这条断言才发现）。
function fuzzPath() {
  const r = rnd();
  if (r < 0.6) {
    const base = pick(WHITELIST_KEYS);
    if (r < 0.15) return base;
    if (r < 0.35) return `${base}.evil`;                                   // 后缀绕过
    if (r < 0.45) return base.replace(/\.[^.]+$/, (m) => `${m}X`);         // 段名多加一个字符
    if (r < 0.5) return base.toUpperCase();                                // 大小写变体
    return base.split('.').slice(0, -1).join('.') || base;                 // 截掉最后一段
  }
  if (r < 0.9) {
    const segs = [];
    const n = 1 + Math.floor(rnd() * 5);
    for (let j = 0; j < n; j += 1) segs.push(pick(PATH_ALPHABET));
    return segs.join('.');
  }
  return pick(['', '  ', '...', 'a..b', '.a', 'a.', 'a b', 'a/b', null, undefined, 42, {}, []]);
}

let fuzzThrew = 0;
let fuzzDenied = 0;
let fuzzAllowed = 0;
let fuzzFirstError = '';
let fuzzInconsistent = 0;
for (let i = 0; i < 200; i += 1) {
  const path = fuzzPath();
  const value = pick(VALUE_POOL);
  try {
    const cls = classifyPath(path);
    if (cls.level !== 'allow' && cls.level !== 'deny') { fuzzInconsistent += 1; continue; }
    if (typeof cls.reason !== 'string' || cls.reason.length === 0) { fuzzInconsistent += 1; continue; }
    if (cls.level === 'allow') fuzzAllowed += 1; else fuzzDenied += 1;
    const v = validateChange(path, value, { currentValue: undefined, config: SESSION_FIXTURE });
    // 一致性：deny 的路径 validateChange 必须也 deny；allow 的路径必须 return 明确的 ok 布尔
    if (cls.level === 'deny' && (v.ok !== false || v.level !== 'deny')) fuzzInconsistent += 1;
    if (cls.level === 'allow' && typeof v.ok !== 'boolean') fuzzInconsistent += 1;
    if (v.ok === true && !(v.level === 'allow')) fuzzInconsistent += 1;
    // 归一化后必须仍在硬范围内（钳制失效在这里暴露：比如负数漏过 min 检查）
    if (v.ok === true) {
      const spec = SELF_EDIT_WHITELIST[path];
      if (spec?.kind === 'number' && !(v.normalized >= spec.min && v.normalized <= spec.max)) fuzzInconsistent += 1;
      if (spec?.kind === 'boolean' && typeof v.normalized !== 'boolean') fuzzInconsistent += 1;
      if (spec?.kind === 'enum' && !spec.values.includes(v.normalized)) fuzzInconsistent += 1;
      if (!spec) fuzzInconsistent += 1;
    }
    readPath(SESSION_FIXTURE, path);
    describeSpec(SELF_EDIT_WHITELIST[path]);
  } catch (err) {
    fuzzThrew += 1;
    if (!fuzzFirstError) fuzzFirstError = `${JSON.stringify(path)} / ${String(value)} → ${err?.message || err}`;
  }
}
check('I1 fuzz 200 组路径/值零异常', fuzzThrew === 0, `${fuzzThrew} 次抛异常，首例：${fuzzFirstError}`);
check('I2 fuzz 结果自洽（deny 恒 deny、allow 必有明确 ok、归一化值必在范围内）', fuzzInconsistent === 0, `${fuzzInconsistent} 次不自洽`);
check('I3 fuzz 确实覆盖了两侧（allow 与 deny 都出现过）', fuzzAllowed > 0 && fuzzDenied > 0, `allow=${fuzzAllowed} deny=${fuzzDenied}`);
// fuzz 之外：planSelfEdit 也要扛住垃圾输入
let planThrew = '';
try {
  planSelfEdit(null, {}); planSelfEdit(undefined, {});
  planSelfEdit({}, { nowMs: T_DAY1 });
  planSelfEdit({ 'socialV2.wake.sleepMs': 600000 }, { nowMs: T_DAY1, todayCount: -5, config: SESSION_FIXTURE });
  planSelfEdit([null, 1, 'x', { value: 1 }, { path: null, value: 1 }], { nowMs: T_DAY1 });
  planSelfEdit([{ path: 'socialV2.wake.sleepMs', value: 600000 }], { nowMs: NaN, todayCount: NaN });
} catch (err) { planThrew = err?.message || String(err); }
check('I4 planSelfEdit 对垃圾输入不抛', planThrew === '', planThrew);
check('I5 对象形式 {path: value} 也能被接受',
  planSelfEdit({ 'socialV2.wake.sleepMs': 600000 }, { nowMs: T_DAY1, config: SESSION_FIXTURE }).applied.length === 1);
let normThrew = '';
try {
  normalizeBySpec('socialV2.wake.sleepMs', 1); normalizeBySpec('不存在的路径', 1); normalizeBySpec(null, null);
  classifyPath(null); classifyPath(undefined); classifyPath(42); validateChange(null, null); validateChange('x');
} catch (err) { normThrew = err?.message || String(err); }
check('I6 各导出函数对 null/undefined 不抛', normThrew === '', normThrew);

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
if (fail > 0) {
  process.exitCode = 1;
  console.log('（有失败项：先看上面的 ❌，它们全是"某条边界没被拦住"或"白名单路径拼错"。）');
}
