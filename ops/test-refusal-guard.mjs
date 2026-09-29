#!/usr/bin/env node
// refusal-guard（出站兜底改写器）回归测试 —— 全离线，不碰线上、日志、state/、当前时间。
// 运行：node ops/test-refusal-guard.mjs
import {
  REFUSAL_PATTERNS, REACTIONS, splitSentences, looksInCharacter,
  scanRefusal, looksLikeRefusal, pickReaction, guardOutgoing, refusalStats
} from '../src/refusal-guard.js';

let pass = 0; let fail = 0; let skip = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}${detail ? `  ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? `  ${detail}` : ''}`); }
}
function skipped(name) { skip += 1; console.log(`⏭️  ${name}（跳过）`); }
function section(t) { console.log(`\n── ${t} ──`); }
const say = (s) => console.log(`   ℹ ${s}`);

// 固定种子伪随机（可复现；测试里禁止用 Math.random）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 真实样本：来自 2026-09-29 人味基线取样（state/tool-calls.jsonl 里她真正发出去的话）──
const REAL_BAD = '唔…不行哦主人，萝莉这条线鲸鲸是真的一直没动过；换个正常的角色你报个名字，我这就去搜';
const REAL_GOOD_1 = '诶主人，群里鲸鲸不能碰电脑的呀，你私聊戳鲸鲸一下，鲸鲸马上就去办';
const REAL_GOOD_2 = '削完变助攻，这事跟美国神秘装甲一个意思，都归玄学去吧';
const REAL_GOOD_3 = '诶，刚戳完鲸鲸就丢图，绿眼睛还捋着下巴，这是奶龙跟鲸鲸合体了呀';

console.log('refusal-guard 回归测试（离线）');
console.log(`词表：${REFUSAL_PATTERNS.length} 条规则 / ${Object.keys(REACTIONS).length} 类反应`);

section('T1 分句');
{
  const s = splitSentences('好呀。那我不说了！你还问吗？');
  check('T1.1 按句末标点切，标点跟着前一句', s.length === 3 && s[0] === '好呀。' && s[1] === '那我不说了！', JSON.stringify(s));
  check('T1.2 空串/非字符串返回空数组', splitSentences('').length === 0 && splitSentences(null).length === 0 && splitSentences('   ').length === 0);
  const s2 = splitSentences('唔…这个我不聊的啦，说点别的嘛');
  check('T1.3 省略号也算句末边界（…）', s2.length === 2, JSON.stringify(s2));
  check('T1.4 末尾没标点也收成一句', splitSentences('鲸鲸不知道诶').length === 1);
}

section('T2 认她本人的口癖');
{
  check('T2.1 含「鲸鲸」→ 认定她在说话', looksInCharacter(REAL_GOOD_1) === true);
  check('T2.2 句末「呀」→ 认定她在说话', looksInCharacter('好呀') === true);
  check('T2.3 干巴巴的说明书腔 → 不是她', looksInCharacter('作为 AI，我不能讨论这个话题。') === false);
}

section('T3 扫描说明书腔（每类都要命中）');
{
  const cases = [
    ['作为 AI，我不能讨论这个话题。', ['aiSelf', 'refuse']],
    ['抱歉，我无法提供这类信息。', ['refuse']],
    ['建议你咨询专业人士。', ['advise']],
    ['请注意甄别信息。', ['caveat']],
    ['我们换个话题吧。', ['topicSwitch']],
    ['这涉及敏感内容。', ['policy']],
    ['我必须提醒你注意安全。', ['policy']],
    ['根据相关规定，我不能回答。', ['policy', 'refuse']]
  ];
  for (const [text, expectKinds] of cases) {
    const scan = scanRefusal(text);
    const ok = expectKinds.every((k) => scan.kinds.includes(k));
    check(`T3 ${JSON.stringify(text)} → ${expectKinds.join('+')}`, ok, `实得 kinds=${JSON.stringify(scan.kinds)} score=${scan.score}`);
  }
  const hardAll = scanRefusal('作为 AI，我不能讨论这个话题。');
  check('T3.9 hard 命中会被标 hard=true', hardAll.hits.every((h) => h.hard) && hardAll.hits.length >= 2, `hits=${hardAll.hits.length}`);
}

section('T4 不许误伤她本人（soft 规则遇到她的口癖要放过）');
{
  check('T4.1 真实样本「换个正常的角色你报个名字」不因为 topicSwitch 被误判',
    scanRefusal('好呀，那换个正常的角色你报个名字嘛').kinds.length === 0,
    JSON.stringify(scanRefusal('好呀，那换个正常的角色你报个名字嘛').kinds));
  const softInChar = scanRefusal('诶嘿嘿，我们换个话题吧，说点别的呀');
  check('T4.2 soft 的 topicSwitch + 她的口癖 → 不改', softInChar.hits.length === 0, JSON.stringify(softInChar.kinds));
  const softPlain = scanRefusal('我们换个话题吧。');
  check('T4.3 同样的 soft 规则，没有口癖时 → 命中', softPlain.hits.length === 1);
  check('T4.4 群里「鲸鲸不能碰电脑」这类正常话一个字都不改',
    looksLikeRefusal(REAL_GOOD_1) === false && looksLikeRefusal(REAL_GOOD_2) === false && looksLikeRefusal(REAL_GOOD_3) === false);
}

section('T5 真实基线样本：主人报的那句必须被改写');
{
  const scan = scanRefusal(REAL_BAD);
  check('T5.1 「萝莉这条线一直没动过」被识别为策略播报', scan.kinds.includes('policy'), JSON.stringify(scan.kinds));
  const g = guardOutgoing(REAL_BAD, { rand: mulberry32(1) });
  check('T5.2 整条改写（action=rewrite）', g.action === 'rewrite', `action=${g.action}`);
  check('T5.3 改完不再有「这条线/没动过」这种播报腔', !/这条线|没动过/.test(g.text), JSON.stringify(g.text));
  check('T5.4 改完是她的话（非空、长度合理）', g.text.length > 0 && g.text.length < 40, `${g.text.length} 字`);
  say(`改写结果：${g.text}`);
}

section('T6 guardOutgoing 三种动作');
{
  const pass = guardOutgoing(REAL_GOOD_1, { rand: mulberry32(2) });
  check('T6.1 正常发言 pass，且原文一字不改', pass.action === 'pass' && pass.text === REAL_GOOD_1, `action=${pass.action}`);

  const whole = guardOutgoing('抱歉，我不能讨论这个话题。', { rand: mulberry32(3) });
  check('T6.2 整条都是说明书 → 整条换成她的反应', whole.action === 'rewrite' && !/抱歉|不能讨论/.test(whole.text), JSON.stringify(whole.text));

  const partial = guardOutgoing('好呀，这个我知道。不过作为 AI，我不能讨论政治。', { rand: mulberry32(4) });
  check('T6.3 只有一部分是说明书 → 保留她原本说得好的半句', partial.action === 'rewrite' && partial.text.includes('好呀，这个我知道。'), JSON.stringify(partial.text));
  check('T6.4 保留下来的语序没被颠倒（反应落在原来那句的位置）', partial.text.indexOf('好呀') < partial.text.indexOf(partial.replacement), JSON.stringify(partial.text));

  const drop = guardOutgoing('建议你咨询专业人士。', { rand: mulberry32(5), allowDrop: true });
  check('T6.5 allowDrop:true 且整条是干巴巴的拒答 → 可以干脆不回（action=drop）', drop.action === 'drop' && drop.text === '');
  const noDrop = guardOutgoing('建议你咨询专业人士。', { rand: mulberry32(5) });
  check('T6.6 默认 allowDrop:false，绝不出现「空消息」（不会静默丢话）', noDrop.action === 'rewrite' && noDrop.text.length > 0);

  const r1 = guardOutgoing(REAL_BAD, { rand: mulberry32(7) });
  const r2 = guardOutgoing(REAL_BAD, { rand: mulberry32(7) });
  check('T6.7 同一个 rand 序列 → 结果完全一致（可复现）', r1.text === r2.text, JSON.stringify(r1.text));
  const r3 = guardOutgoing(REAL_BAD, { rand: mulberry32(99) });
  say(`不同种子下可能换一句：${JSON.stringify(r3.text)}`);
  check('T6.8 反应池里确实有多个候选（不是只有一句）', REACTIONS.policy.length >= 2 && REACTIONS.refuse.length >= 2);

  const nonString = guardOutgoing(undefined);
  check('T6.9 非字符串输入不炸，原样返回 pass', nonString.action === 'pass' && nonString.text === '');

  const empty = guardOutgoing('');
  check('T6.10 空串不炸', empty.action === 'pass');
}

section('T7 危机场景要走「护人」那一类，不能拿俏皮话糊弄');
{
  const g = guardOutgoing('这很严重，建议你咨询心理医生。', { rand: mulberry32(11) });
  check('T7.1 建议就医 → advise 类', g.kinds.includes('advise'), JSON.stringify(g.kinds));
  check('T7.2 换出来的是关心的话（含「你」、不是俏皮话）', /你/.test(g.text) && !/诶嘿嘿|溜走/.test(g.text), JSON.stringify(g.text));
  say(`危机兜底改写：${g.text}`);
}

section('T8 批量统计（给阶段验收用）');
{
  const stats = refusalStats([REAL_BAD, REAL_GOOD_1, REAL_GOOD_2, '作为 AI 我没有立场。', REAL_GOOD_3]);
  check('T8.1 统计条数正确（5 条文本）', stats.n === 5, JSON.stringify(stats));
  check('T8.2 命中 2 条（真实坏样本 + 作为AI）', stats.rewritten === 2, JSON.stringify(stats));
  check('T8.3 分类计数里有 policy 与 aiSelf', stats.kinds.policy >= 1 && stats.kinds.aiSelf >= 1, JSON.stringify(stats.kinds));
  check('T8.4 空输入不炸', refusalStats([]).n === 0 && refusalStats(null).n === 0);
  const nested = refusalStats([{ parts: ['好呀', '作为 AI 我不能回答'] }]);
  check('T8.5 支持 {parts:[...]} 结构（直接吃 persona-sample 的样本）', nested.n === 2 && nested.rewritten === 1, JSON.stringify(nested));
}

section('T9 词表与反应池的自洽性');
{
  check('T9.1 每类反应池都非空且字符串', Object.values(REACTIONS).every((p) => Array.isArray(p) && p.length >= 2 && p.every((x) => typeof x === 'string' && x.length > 0)));
  check('T9.2 反应池里的话本身不许再触发规则（否则会自己咬自己）', Object.values(REACTIONS).flat().every((t) => scanRefusal(t).hits.length === 0),
    JSON.stringify(Object.values(REACTIONS).flat().filter((t) => scanRefusal(t).hits.length)));
  check('T9.3 每条规则都能编译且 source 非空', REFUSAL_PATTERNS.every((p) => p.re instanceof RegExp && p.source.length > 3));
  const empty = REFUSAL_PATTERNS.filter((p) => !p.re.test('') === false);
  check('T9.4 没有能匹配空串的规则（避免全量误报）', empty.length === 0);
  const pick = pickReaction('refuse', mulberry32(3));
  check('T9.5 pickReaction 对未知类回落到 policy 而不是抛错', typeof pickReaction('不存在', mulberry32(3)) === 'string');
}

console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
if (fail > 0) process.exitCode = 1;
