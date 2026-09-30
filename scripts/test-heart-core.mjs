// 鲸鲸 2.0 B1+B4+C 纯函数单测（docs/upgrade-plan-2026-10.md E 系列）：
//   node scripts/test-heart-core.mjs   （退出码 0 = 全绿）
// 覆盖：生活状态机窗口/跨零点/优先级、心流三态全迁移路径（含名额上限与兴趣缺失）、
//       配置归一化 clamp、按类型配额、群活跃度、话题匹配、兴趣解析容错、心核状态行。
import {
  LIFE_EFFECTS, lifeStateFor, HEARTFLOW_DEFAULTS,
  normalizeHeartflowConfig, heartflowTransition,
  groupActivityScore, topicMatchScore,
  buildInterestPrompt, parseInterestResult, heartLineFor
} from '../src/heart-core.mjs';
import { quotaPerDayFor } from '../src/proactive-quota.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); failed += 1; }
}

// ── B1 生活状态机 ──
assert(lifeStateFor(3).state === 'sleeping', 'default 3am sleeping');
assert(lifeStateFor(1).state === 'sleeping', 'sleep start inclusive');
assert(lifeStateFor(8).state === 'normal', 'sleep end exclusive');
assert(lifeStateFor(0).state === 'normal', 'midnight before sleep');
assert(lifeStateFor(12).state === 'normal', 'noon normal');
assert(lifeStateFor(20, { focusedWindows: [[19, 22]] }).state === 'focused', 'focused window hits');
assert(lifeStateFor(22, { focusedWindows: [[19, 22]] }).state === 'normal', 'focused end exclusive');
assert(lifeStateFor(14, { slackingWindows: [[13, 15]] }).state === 'slacking', 'slacking window hits');
assert(lifeStateFor(3).label === LIFE_EFFECTS.sleeping.label, 'life label attached');
// 跨零点睡眠 23→2
assert(lifeStateFor(23, { sleepStart: 23, sleepEnd: 2 }).state === 'sleeping', 'cross-midnight sleep 23');
assert(lifeStateFor(1, { sleepStart: 23, sleepEnd: 2 }).state === 'sleeping', 'cross-midnight sleep 1');
assert(lifeStateFor(2, { sleepStart: 23, sleepEnd: 2 }).state === 'normal', 'cross-midnight sleep end 2');
// 跨零点专注窗 22→2（关掉睡眠以便观察）
const noSleep = { sleepStart: 8, sleepEnd: 8 };
assert(lifeStateFor(23, { ...noSleep, focusedWindows: [[22, 2]] }).state === 'focused', 'cross-midnight focused 23');
assert(lifeStateFor(1, { ...noSleep, focusedWindows: [[22, 2]] }).state === 'focused', 'cross-midnight focused 1');
assert(lifeStateFor(5, { ...noSleep, focusedWindows: [[22, 2]] }).state === 'normal', 'cross-midnight focused outside');
// 优先级：睡眠 > 专注 > 摸鱼
assert(lifeStateFor(3, { focusedWindows: [[2, 5]] }).state === 'sleeping', 'sleep beats focused');
assert(lifeStateFor(14, { focusedWindows: [[13, 16]], slackingWindows: [[13, 15]] }).state === 'focused', 'focused beats slacking');
// 小时取模与负数
assert(lifeStateFor(25).state === 'sleeping', 'hour 25 wraps to 1');
assert(lifeStateFor(-1).state === 'normal', 'hour -1 wraps to 23');
// sleepStart === sleepEnd → 无睡眠窗口
assert(lifeStateFor(3, { sleepStart: 8, sleepEnd: 8 }).state === 'normal', 'no sleep window');
// 多窗口任一命中
assert(lifeStateFor(10, { slackingWindows: [[9, 11], [13, 15]] }).state === 'slacking', 'second window hits');

// ── B4 心流三态迁移 ──
assert(heartflowTransition({ state: 'xyz' }).state === 'watering', 'invalid state normalizes to watering');
// focused 降级
assert(heartflowTransition({ state: 'focused', silentCount: 3 }).state === 'watering', 'focused silent exit');
assert(heartflowTransition({ state: 'focused', silentCount: 2 }).changed === false, 'focused silent below threshold');
assert(heartflowTransition({ state: 'focused', idleMs: 30 * 60 * 1000 }).state === 'watering', 'focused idle timeout');
assert(heartflowTransition({ state: 'focused', idleMs: 29 * 60 * 1000 }).changed === false, 'focused idle below timeout');
// watering 升级/降级
assert(heartflowTransition({ state: 'watering', interestScore: 0.8, focusedCount: 0 }).state === 'focused', 'watering promotes on interest');
assert(heartflowTransition({ state: 'watering', interestScore: 0.8, focusedCount: 2 }).changed === false, 'cap blocks promotion');
assert(heartflowTransition({ state: 'watering', interestScore: null }).changed === false, 'no eval no promotion');
assert(heartflowTransition({ state: 'watering', interestScore: 0.7 }).changed === false, 'interest below focusedScore');
assert(heartflowTransition({ state: 'watering', silentCount: 5 }).state === 'absent', 'watering silent to absent');
assert(heartflowTransition({ state: 'watering', silentCount: 4 }).changed === false, 'watering silent below threshold');
// absent 重入
assert(heartflowTransition({ state: 'absent', interestScore: 0.8 }).state === 'focused', 'absent direct to focused');
assert(heartflowTransition({ state: 'absent', interestScore: 0.8, focusedCount: 2 }).state === 'watering', 'absent cap falls back to watering');
assert(heartflowTransition({ state: 'absent', interestScore: 0.6 }).state === 'watering', 'absent reentry to watering');
assert(heartflowTransition({ state: 'absent', interestScore: 0.3 }).changed === false, 'absent low interest stays');
assert(heartflowTransition({ state: 'absent', interestScore: null }).changed === false, 'absent no eval stays');
// 兴趣夹取
assert(heartflowTransition({ state: 'watering', interestScore: 1.5, focusedCount: 0 }).state === 'focused', 'interest clamps up');
assert(heartflowTransition({ state: 'watering', interestScore: -0.2 }).changed === false, 'interest clamps down to 0');
// 自定义阈值
assert(heartflowTransition({ state: 'watering', interestScore: 0.8, focusedScore: 0.9 }).changed === false, 'custom focusedScore blocks');
assert(heartflowTransition({ state: 'watering', interestScore: 0.95, focusedScore: 0.9 }).state === 'focused', 'custom focusedScore passes');
// 进 focused 的 idle 门（2026-09-30 自检：聊天静了半小时以上，再高的兴趣分也不算「聊得投入」，防 focused↔watering 每 tick 翻转抖动）
assert(heartflowTransition({ state: 'watering', interestScore: 0.8, idleMs: 31 * 60 * 1000 }).changed === false, 'stale chat blocks promotion to focused');
assert(heartflowTransition({ state: 'watering', interestScore: 0.8, idleMs: 5 * 60 * 1000 }).state === 'focused', 'fresh chat still promotes');
assert(heartflowTransition({ state: 'absent', interestScore: 0.8, idleMs: 31 * 60 * 1000 }).state === 'watering', 'absent stale chat falls back to watering (not focused)');
assert(heartflowTransition({ state: 'absent', interestScore: 0.8, idleMs: 5 * 60 * 1000 }).state === 'focused', 'absent fresh chat direct to focused');
assert(heartflowTransition({ state: 'watering', interestScore: 0.8, idleMs: 29 * 60 * 1000 }).state === 'focused', 'idle just under focusedIdleMs still promotes');

// ── 配置归一化 ──
const nc = normalizeHeartflowConfig({});
for (const k of Object.keys(HEARTFLOW_DEFAULTS)) assert(nc[k] === HEARTFLOW_DEFAULTS[k], 'defaults preserved: ' + k);
assert(normalizeHeartflowConfig({ focusedCap: 99 }).focusedCap === 10, 'focusedCap clamped to 10');
assert(normalizeHeartflowConfig({ focusedCap: -5 }).focusedCap === 0, 'focusedCap floor 0');
assert(normalizeHeartflowConfig({ evalThrottleMs: 0 }).evalThrottleMs === 60000, 'evalThrottleMs min 60s');
assert(normalizeHeartflowConfig({ reentryScore: 2 }).reentryScore === 1, 'reentryScore clamped to 1');
assert(normalizeHeartflowConfig({ junk: 'x' }).silentToAbsent === HEARTFLOW_DEFAULTS.silentToAbsent, 'junk ignored');
assert(normalizeHeartflowConfig({ silentToAbsent: 4.7 }).silentToAbsent === 4, 'silentToAbsent floored');

// ── C 按类型配额 ──
assert(quotaPerDayFor({ group: 40, private: 30 }, true) === 40, 'group quota picked');
assert(quotaPerDayFor({ group: 40, private: 30 }, false) === 30, 'private quota picked');
assert(quotaPerDayFor({ private: 30 }, true) === 10, 'missing group falls back to default 10');
assert(quotaPerDayFor({ group: 40, default: 5 }, false) === 5, 'explicit default used');
assert(quotaPerDayFor({ group: null, default: -1 }, true) === -1, 'group null + default -1');
assert(quotaPerDayFor(40, true) === 40, 'number raw passes through');
assert(quotaPerDayFor(null, false) === -1, 'null raw unlimited');
assert(quotaPerDayFor(undefined, true) === 10, 'undefined raw default 10');
assert(quotaPerDayFor(0, true) === 0, 'zero quota is a hard off switch');
assert(quotaPerDayFor(2.7, false) === 2, 'fraction floored');

// ── C 群活跃度 ──
assert(groupActivityScore([], 1000) === 0, 'empty activity');
assert(groupActivityScore(null) === 0, 'null activity');
const nowA = 1_000_000_000_000;
const msg = (time, isSelf = false) => ({ time, isSelf });
assert(Math.abs(groupActivityScore(Array.from({ length: 10 }, () => msg(nowA - 60000)), nowA) - 0.5) < 1e-9, '10 msgs → 0.5');
assert(groupActivityScore(Array.from({ length: 30 }, () => msg(nowA - 60000)), nowA) === 1, '30 msgs capped at 1');
assert(Math.abs(groupActivityScore(Array.from({ length: 10 }, (_, i) => (i < 5 ? msg(nowA - 60000) : msg(nowA - 60000, true))), nowA) - 0.25) < 1e-9, 'self messages excluded');
assert(groupActivityScore([msg(nowA - 11 * 60 * 1000)], nowA) === 0, 'stale messages excluded');
assert(groupActivityScore([msg(0)], nowA) === 0, 'zero time excluded');

// ── C 话题匹配 ──
assert(topicMatchScore('明天去吃火锅吧', ['明天去吃火锅']) === 1, 'exact substring');
assert(topicMatchScore('我在跑步呢', ['计划：写代码、跑步']) === 1, 'fragment fallback hits');
assert(topicMatchScore('完全无关的内容', ['明天去吃火锅']) === 0, 'no match');
assert(topicMatchScore('随便聊聊', []) === 0, 'no topics');
assert(topicMatchScore('', ['跑步']) === 0, 'empty text');
assert(Math.abs(topicMatchScore('说到火锅了', ['火锅', '睡觉', '游戏']) - 1 / 3) < 1e-9, 'one of three');
assert(Math.abs(topicMatchScore('火锅和游戏都聊了', ['火锅', '睡觉', '游戏']) - 2 / 3) < 1e-9, 'two of three');
assert(Math.abs(topicMatchScore('只聊火锅', ['火锅', '睡觉']) - 0.5) < 1e-9, 'denominator min(3, len)');

// ── B4 兴趣评估 prompt / 解析 ──
const ip = buildInterestPrompt({ streamLabel: '群聊 471975044', lifeLabel: '正常', recentLines: ['A：今天好累', 'B：摸鱼吧'], planTopics: ['火锅', '游戏'] });
assert(ip.includes('群聊 471975044') && ip.includes('火锅'), 'prompt embeds label and topics');
assert(ip.includes('want'), 'prompt asks for want');
assert(buildInterestPrompt({ recentLines: [] }).includes('最近没有新消息'), 'empty recent placeholder');
// quietMinutes 行（2026-09-30 自检：没这行 LLM 会拿几小时前的旧梗打高分）
assert(buildInterestPrompt({ recentLines: ['A：嗨'], quietMinutes: 94 }).includes('已经安静了 94 分钟'), 'quiet minutes line present');
assert(!buildInterestPrompt({ recentLines: ['A：嗨'] }).includes('已经安静了'), 'no quiet line without quietMinutes');
assert(!buildInterestPrompt({ recentLines: ['A：嗨'], quietMinutes: 1 }).includes('已经安静了'), 'quiet line suppressed under 2 minutes');
assert(buildInterestPrompt({ recentLines: ['A：嗨'], quietMinutes: 94 }).includes('旧消息'), 'quiet line marks stale content');
const p1 = parseInterestResult('{"want":0.8,"reason":"好玩"}');
assert(p1 && p1.want === 0.8 && p1.reason === '好玩', 'clean json parses');
assert(parseInterestResult('```json\n{"want":0.5}\n```').want === 0.5, 'fenced json parses');
assert(parseInterestResult('我觉得 {"want":0.65,"reason":"有点意思"} 吧').want === 0.65, 'surrounded json parses');
assert(parseInterestResult('{"want":1.5}').want === 1, 'want clamps to 1');
assert(parseInterestResult('{"want":-0.2}').want === 0, 'want clamps to 0');
assert(parseInterestResult('{"want":"0.7"}').want === 0.7, 'numeric string want');
assert(parseInterestResult('{"reason":"没有打分"}') === null, 'missing want → null');
assert(parseInterestResult('完全不是 JSON') === null, 'garbage → null');
assert(parseInterestResult('') === null, 'empty → null');
assert(parseInterestResult(null) === null, 'null → null');

// ── 心核状态行 ──
assert(heartLineFor({}) === '', 'empty heart line');
const onlyLife = heartLineFor({ lifeLabel: '睡眠' });
assert(onlyLife.includes('【她的心核状态】生活状态：睡眠') && onlyLife.endsWith('\n'), 'life only line');
const full = heartLineFor({ lifeLabel: '专注时段', lifeDepthHint: '投入一点', heartflowLabel: '聊得很投入', streamLabel: '群' });
assert(full.includes('生活状态：专注时段') && full.includes('你此刻对这个群：聊得很投入') && full.includes('投入一点'), 'full heart line');
assert(heartLineFor({ heartflowLabel: '随便看看' }).includes('对这个聊天'), 'stream label placeholder');

console.log(failed === 0 ? `heart-core 全部断言通过` : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
