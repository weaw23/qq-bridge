// 离线自测：节奏参数 / 呼吸参数的切分（阶段 6 的第二版口径）
//
// 为什么单独有一份测试：这一版改的不是"能不能改"，而是**谁会被每日 3 次额度卡住**。
// 第一版把整套白名单都挂上额度，结果是"她当天第 4 次收尾会被 403"——收不了尾。
// 这个测试就是钉住那条线：呼吸参数永远不进闸门，节奏参数才吃额度。
//
// 运行：node ops/test-autonomy-tuning.mjs
import {
  AUTONOMY_TUNING_PATHS,
  DAILY_SELF_EDIT_LIMIT,
  SELF_EDIT_WHITELIST,
  isTuningPath,
  mergeTuningInput,
  planSelfEdit,
  splitTuningInput,
} from '../src/autonomy.js';

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 她一轮收尾最典型的入参（升级之前她就能这么写，升级后也必须照样能写）。
const TURN_END_INPUT = {
  mode: 'diving',
  infinite: false,
  sleepMs: 1800000,
  triggers: { atMention: true, nameMention: true, question: true, poke: true, anyMessage: true, keywords: ['鲸鲸'], speakerIds: [1918594889] },
};
// 她自己抠节奏时才会动的入参。
const TUNING_INPUT = { speakCooldownMs: 900000, maxWakePerMinute: 5, maxWakePerHour: 40, triggers: { probability: 0.25 } };

section('A. 哪些路径算「节奏参数」');
{
  check('A1 唤醒频率/冷却/概率 4 条在名单里', AUTONOMY_TUNING_PATHS.length === 4, `实际 ${AUTONOMY_TUNING_PATHS.length}`);
  check('A2 speakCooldownMs 是节奏参数', isTuningPath('socialV2.wake.speakCooldownMs'));
  check('A3 maxWakePerMinute 是节奏参数', isTuningPath('socialV2.wake.maxWakePerMinute'));
  check('A4 maxWakePerHour 是节奏参数', isTuningPath('socialV2.wake.maxWakePerHour'));
  check('A5 triggers.probability 是节奏参数', isTuningPath('socialV2.wake.triggers.probability'));
  check('A6 mode 不是节奏参数（呼吸）', !isTuningPath('socialV2.wake.mode'));
  check('A7 sleepMs 不是节奏参数（呼吸）', !isTuningPath('socialV2.wake.sleepMs'));
  check('A8 infinite 不是节奏参数（呼吸）', !isTuningPath('socialV2.wake.infinite'));
  check('A9 triggers.anyMessage 不是节奏参数（呼吸）', !isTuningPath('socialV2.wake.triggers.anyMessage'));
  check('A10 名单里的每条都在白名单里（不许出现"额度管着白名单外的东西"）',
    AUTONOMY_TUNING_PATHS.every((p) => Object.prototype.hasOwnProperty.call(SELF_EDIT_WHITELIST, p)),
    JSON.stringify(AUTONOMY_TUNING_PATHS.filter((p) => !Object.prototype.hasOwnProperty.call(SELF_EDIT_WHITELIST, p))));
  check('A11 白名单里除这 4 条外都是呼吸参数（口径没有第三种）',
    Object.keys(SELF_EDIT_WHITELIST).filter((p) => !AUTONOMY_TUNING_PATHS.includes(p) && /probability|Cooldown|maxWake/.test(p)).length === 0);
  check('A12 非法输入不抛', isTuningPath(null) === false && isTuningPath(undefined) === false && isTuningPath({}) === false);
}

section('B. splitTuningInput：切开，且不串味');
{
  const s = splitTuningInput({ ...TURN_END_INPUT, ...TUNING_INPUT, triggers: { ...TURN_END_INPUT.triggers, probability: 0.25 } });
  check('B1 节奏参数进 tuning', eq(s.tuning, { speakCooldownMs: 900000, maxWakePerMinute: 5, maxWakePerHour: 40, triggers: { probability: 0.25 } }), JSON.stringify(s.tuning));
  check('B2 呼吸参数进 rest', eq(s.rest, { mode: 'diving', infinite: false, sleepMs: 1800000, triggers: { atMention: true, nameMention: true, question: true, poke: true, anyMessage: true, keywords: ['鲸鲸'], speakerIds: [1918594889] } }), JSON.stringify(s.rest));
  check('B3 triggers 被深切，而不是整块归一边', 'probability' in (s.tuning.triggers ?? {}) && 'anyMessage' in (s.rest.triggers ?? {}));
  // 数顶层键会漏掉/重复 triggers（它在两半里各有一个对象），所以要按**叶子路径**比对。
  const leafPaths = (obj, prefix = '') => {
    const out = [];
    for (const [k, v] of Object.entries(obj ?? {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, p));
      else out.push(p);
    }
    return out;
  };
  const inputLeaves = leafPaths({ ...TURN_END_INPUT, ...TUNING_INPUT, triggers: { ...TURN_END_INPUT.triggers, probability: 0.25 } }).sort();
  const splitLeaves = [...leafPaths(s.tuning), ...leafPaths(s.rest)].sort();
  check('B4 两份加起来没有丢字段（按叶子路径比）', eq(splitLeaves, inputLeaves), `${JSON.stringify(splitLeaves)} vs ${JSON.stringify(inputLeaves)}`);

  const original = { mode: 'diving', speakCooldownMs: 60000, triggers: { anyMessage: true, probability: 0.1 } };
  const snapshot = JSON.parse(JSON.stringify(original));
  splitTuningInput(original);
  check('B5 不改原入参（她传进来的对象不能被就地改写）', eq(original, snapshot), JSON.stringify(original));

  check('B6 典型收尾入参的 tuning 是空的（= 不进闸门）', eq(splitTuningInput(TURN_END_INPUT).tuning, {}), JSON.stringify(splitTuningInput(TURN_END_INPUT).tuning));
  check('B7 典型收尾入参的 rest 就是原文', eq(splitTuningInput(TURN_END_INPUT).rest, TURN_END_INPUT));
  check('B8 只有节奏参数时 rest 为空', eq(splitTuningInput(TUNING_INPUT).rest, {}), JSON.stringify(splitTuningInput(TUNING_INPUT).rest));
  check('B9 空/垃圾入参不抛', eq(splitTuningInput(null), { tuning: {}, rest: {} }) && eq(splitTuningInput([1, 2]), { tuning: {}, rest: {} }) && eq(splitTuningInput('x'), { tuning: {}, rest: {} }));
  check('B10 triggers 是数组/字符串时不炸', eq(splitTuningInput({ mode: 'diving', triggers: [1] }).rest, { mode: 'diving' }) && eq(splitTuningInput({ mode: 'diving', triggers: 'x' }).rest, { mode: 'diving' }));
}

section('C. mergeTuningInput：拼回去，triggers 深合并');
{
  const rest = { mode: 'diving', triggers: { anyMessage: true, keywords: ['鲸鲸'] } };
  const merged = mergeTuningInput(rest, { speakCooldownMs: 300000, triggers: { probability: 0.4 } });
  check('C1 节奏参数写进去', merged.speakCooldownMs === 300000);
  check('C2 triggers 深合并（不覆盖 rest 那半边）', eq(merged.triggers, { anyMessage: true, keywords: ['鲸鲸'], probability: 0.4 }), JSON.stringify(merged.triggers));
  check('C3 不改 rest 本体', eq(rest, { mode: 'diving', triggers: { anyMessage: true, keywords: ['鲸鲸'] } }), JSON.stringify(rest));
  check('C4 同一字段冲突时以闸门过滤后的 tuning 为准', mergeTuningInput({ speakCooldownMs: 1 }, { speakCooldownMs: 2 }).speakCooldownMs === 2);
  check('C5 空参数不抛', eq(mergeTuningInput(null, null), {}) && eq(mergeTuningInput(undefined, { mode: 'active' }), { mode: 'active' }));

  // 拆分 → 过滤 → 合并 的往返：闸门全部放行时，结果必须和原文一致。
  const full = { ...TURN_END_INPUT, ...TUNING_INPUT, triggers: { ...TURN_END_INPUT.triggers, probability: 0.25 } };
  const s = splitTuningInput(full);
  check('C6 往返一致（全放行时不该有任何字段变形）', eq(mergeTuningInput(s.rest, s.tuning), full), JSON.stringify(mergeTuningInput(s.rest, s.tuning)));

  // 闸门把 tuning 全部拒掉（= 今日额度用完）时，rest 必须原样留下 —— 这是"收尾不被卡死"的核心断言。
  const quotaDead = mergeTuningInput(s.rest, {});
  check('C7 节奏参数被拒时，呼吸参数一条不少', eq(quotaDead, TURN_END_INPUT), JSON.stringify(quotaDead));
  check('C8 被拒后她依然能设置"下次怎么被叫醒"', quotaDead.mode === 'diving' && quotaDead.sleepMs === 1800000 && quotaDead.triggers.anyMessage === true);
}

section('D. 和 planSelfEdit 连起来：谁吃额度、谁不吃');
{
  const config = { socialV2: { paused: false, wake: { maxWakePerMinute: 3, maxWakePerHour: 60, speakCooldownMs: 120000 }, autonomy: { enabled: true } } };
  const nowMs = Date.parse('2026-09-29T12:00:00+08:00');

  // D1：三次节奏自改都能过，第四次被额度拒。
  const audit = [];
  let last = null;
  for (let i = 1; i <= DAILY_SELF_EDIT_LIMIT + 1; i++) {
    const plan = planSelfEdit([{ path: 'socialV2.wake.speakCooldownMs', value: 60000 * i * 2 }], { nowMs, auditLog: audit, config });
    audit.push(...plan.applied, ...plan.rejected);
    last = plan;
  }
  check(`D1 第 ${DAILY_SELF_EDIT_LIMIT} 次仍通过`, audit.filter((e) => e.ok).length === DAILY_SELF_EDIT_LIMIT, String(audit.filter((e) => e.ok).length));
  check('D2 第 4 次被额度拒（有条目、有理由）', last.applied.length === 0 && last.rejected.length === 1 && /额度/.test(last.rejected[0].reason), JSON.stringify(last.rejected));
  check('D3 额度用完后 quotaLeft = 0', last.quotaLeft === 0, String(last.quotaLeft));

  // D4：额度用完后，她的收尾入参仍然一条不改地通过（因为它压根没进闸门）。
  const split = splitTuningInput(TURN_END_INPUT);
  check('D4 额度用完也不影响收尾（tuning 为空 → 不进闸门）', Object.keys(split.tuning).length === 0);
  check('D5 收尾入参原样送达路由', eq(mergeTuningInput(split.rest, {}), TURN_END_INPUT));

  // D6：越界节奏值被收进区间内，绝不会落到"0 = 不限"那侧。
  const clamp = planSelfEdit([{ path: 'socialV2.wake.maxWakePerMinute', value: 0 }], { nowMs, auditLog: [], config });
  check('D6 maxWakePerMinute 写 0 会被收到下限 1（0 在本桥接里的语义是"不限"）', clamp.applied.length === 1 && clamp.applied[0].to === 1, JSON.stringify(clamp.applied));

  // D7：非法枚举仍然被硬拒（这条不依赖额度）。
  const bad = planSelfEdit([{ path: 'socialV2.wake.mode', value: 'banana' }], { nowMs, auditLog: [], config });
  check('D7 非白名单内的值类型/枚举仍然被拒', bad.ok === false && bad.rejected.length === 1);

  // D8：被拒的条目不该消耗额度（否则她探两次边界当天就废了）。
  const probeOnce = planSelfEdit([{ path: 'socialV2.wake.mode', value: 'banana' }], { nowMs, auditLog: [], config });
  check('D8 被拒不占额度', probeOnce.quotaLeft === DAILY_SELF_EDIT_LIMIT, String(probeOnce.quotaLeft));
}

console.log('\n═══ 汇总：通过 ' + pass + ' / 失败 ' + fail + ' / 跳过 ' + skip + ' ═══');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
