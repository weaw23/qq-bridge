// L2 回归测试：待发文本的「AI 腔」离线检测（src/deai.js）
//
// 这个套件测什么、不测什么（先说清楚，免得又变成随机红绿的假失败）：
//   只测**纯函数**。src/deai.js 不改文本、不发网络请求、不读写文件、不看当前时间，
//   所以这里也没有任何连接线上桥接、读 state/ 或 bridge.log、依赖 state/ 目录、
//   依赖 Date.now() 的断言 —— 跑一百遍结果都一样，红就是真红。
//   不测的：桥接到底有没有调用它（那是接线检查，属于 S 段的事，本套件不碰）、
//   重说一遍的模型行为、阈值调优后的线上效果。
//
// 全部断言在交付时就应全绿。若某条红了，先看它是不是把打分规则（src/deai.js 头部注释）
// 改动了 —— 改规则就必须来改这里，两边必须同步。
//
// 跑：node ops/test-deai.mjs
//     （本套件不写任何日志文件、不改任何配置，随时可跑）

import {
  AI_TONE_WORDS,
  sentenceLengths,
  lengthJitter,
  scanAiTone,
  shouldRephrase
} from '../src/deai.js';

let pass = 0, fail = 0, skip = 0;
function say(line) { console.log(line); }
function check(name, ok, extra = '') {
  if (ok) { pass++; say(`✅ ${name}${extra ? '  ' + extra : ''}`); } else { fail++; say(`❌ ${name}${extra ? '  ' + extra : ''}`); }
}
// 本套件没有活体段（没有真路由、没有真落盘），所以 skipped 正常永远是 0。
// 保留它是为了跟 ops/test-wake-throttle.mjs 的输出风格一致，将来若要加 A 段可直接用。
function skipped(name) { skip++; say(`⏭️  ${name}（跳过）`); }
function section(t) { say(`\n── ${t} ──`); }

// ══════════════════════════════════════════════════════════════════
section('T 段：纯函数穷举（src/deai.js）');
// ══════════════════════════════════════════════════════════════════

say('T1 sentenceLengths 切句与边界');
check('T1.1 空串 → 空数组', JSON.stringify(sentenceLengths('')) === '[]' && sentenceLengths('   ').length === 0);
check('T1.2 纯标点 → 空数组（空句忽略）', sentenceLengths('。。。？？！！').length === 0 && sentenceLengths('……').length === 0);
check('T1.3 没有句末标点 → 整段算一句', JSON.stringify(sentenceLengths('今天天气不错')) === '[6]');
check('T1.4 中英混排按句末标点切，空白不计入字数', JSON.stringify(sentenceLengths('Hello world. 你好呀。今天天气不错！')) === '[10,3,6]',
  `实得 ${JSON.stringify(sentenceLengths('Hello world. 你好呀。今天天气不错！'))}`);
check('T1.5 连续空白/换行不计入字数', JSON.stringify(sentenceLengths('你好    世界。')) === '[4]' && JSON.stringify(sentenceLengths('甲\n乙。')) === '[2]');
check('T1.6 非字符串输入不炸（null / undefined / 数字）',
  Array.isArray(sentenceLengths(null)) && sentenceLengths(null).length === 0
    && sentenceLengths(undefined).length === 0 && Array.isArray(sentenceLengths(42)));
check('T1.7 小数与版本号里的点不断句', JSON.stringify(sentenceLengths('版本 1.2 已发布')) === '[8]',
  `实得 ${JSON.stringify(sentenceLengths('版本 1.2 已发布'))}`);
check('T1.8 emoji 按 1 个字算（不因代理对变 2）', JSON.stringify(sentenceLengths('🐳🐳好。')) === '[3]',
  `实得 ${JSON.stringify(sentenceLengths('🐳🐳好。'))}`);

say('T2 lengthJitter 变异系数');
check('T2.1 少于 2 句一律返回 0', lengthJitter([]) === 0 && lengthJitter([7]) === 0 && lengthJitter(null) === 0 && lengthJitter(undefined) === 0);
check('T2.2 均值为 0 返回 0（不返回 NaN）', lengthJitter([0, 0, 0]) === 0 && Number.isFinite(lengthJitter([0, 0])));
check('T2.3 齐整句（全等长）= 0', lengthJitter([20, 20, 20, 20]) === 0);
// 长短交替 vs 齐整句的对比 —— 这就是「AI 腔」与「人话」在句长上的差别
check('T2.4 长短交替句系数很高（>0.8），远高于齐整句的 0',
  lengthJitter([2, 30, 2, 30]) > 0.8 && lengthJitter([2, 30, 2, 30]) > lengthJitter([20, 20, 20, 20]),
  `交替=${lengthJitter([2, 30, 2, 30]).toFixed(3)} 齐整=${lengthJitter([20, 20, 20, 20]).toFixed(3)}`);
check('T2.5 轻微差异（10/12/14）仍在齐整阈值 0.25 之下', lengthJitter([10, 12, 14]) > 0 && lengthJitter([10, 12, 14]) < 0.25,
  `实得 ${lengthJitter([10, 12, 14]).toFixed(3)}`);
check('T2.6 脏数据先过滤：过滤后不足 2 个也返回 0', lengthJitter([NaN, 5]) === 0 && lengthJitter([10, 10, NaN]) === 0 && lengthJitter(['abc', {}]) === 0);

say('T3 词表与逐词命中');
const CATS = Object.keys(AI_TONE_WORDS);
const WORD_CATS = ['transition', 'buzzword', 'service', 'essay', 'refuse'];
say(`   分类 = ${CATS.join(', ')}`);
check('T3.1 词表 6 类（五类中文词表 + format），整体与外层数组全部冻结',
  CATS.length === 6 && Object.isFrozen(AI_TONE_WORDS)
    && CATS.every((k) => Array.isArray(AI_TONE_WORDS[k]) && Object.isFrozen(AI_TONE_WORDS[k])));
check('T3.2 五个词表类每类至少 6 个非空词', WORD_CATS.every((k) => AI_TONE_WORDS[k].length >= 6 && AI_TONE_WORDS[k].every((w) => typeof w === 'string' && w.length > 0)),
  WORD_CATS.map((k) => `${k}=${AI_TONE_WORDS[k].length}`).join(' '));
check('T3.3 指定的必收词一个不少（拒答腔尤其不能漏）',
  ['此外', '值得注意的是', '综上所述', '因此'].every((w) => AI_TONE_WORDS.transition.includes(w))
    && ['赋能', '深耕', '闭环', '底层逻辑', '全方位'].every((w) => AI_TONE_WORDS.buzzword.includes(w))
    && ['亲', '请问您', '还有什么可以帮到您', '建议您'].every((w) => AI_TONE_WORDS.service.includes(w))
    && ['首先', '其次', '最后', '综上所述', '总而言之'].every((w) => AI_TONE_WORDS.essay.includes(w))
    && ['我不能讨论', '作为 AI', '作为一个 AI', '建议你咨询专业人士', '我无法提供', '不适合讨论', '我建议你', '请注意甄别', '理性看待'].every((w) => AI_TONE_WORDS.refuse.includes(w)));

const hT = scanAiTone('此外，还是要谢谢你。');
check('T3.4 transition 命中：word / kind / index / 分值都对',
  hT.hits.length === 1 && hT.hits[0].word === '此外' && hT.hits[0].kind === 'transition' && hT.hits[0].index === 0 && hT.score === 8,
  `hits=${JSON.stringify(hT.hits)} score=${hT.score}`);
const hBuzz = scanAiTone('我们要深耕这个领域。');
check('T3.5 buzzword 命中 +12', hBuzz.hits.length === 1 && hBuzz.hits[0].kind === 'buzzword' && hBuzz.score === 12, `score=${hBuzz.score}`);
const hSvc = scanAiTone('亲，还有什么可以帮到您？');
check('T3.6 service 命中（两处共 +24）', hSvc.hits.length === 2 && hSvc.score === 24 && hSvc.hits.every((h) => h.kind === 'service'), `score=${hSvc.score}`);
const hEss = scanAiTone('首先我要说明，其次再谈别的。');
check('T3.7 essay 命中（每处 +6）', hEss.hits.length === 2 && hEss.score === 12 && hEss.hits.every((h) => h.kind === 'essay'), `score=${hEss.score}`);
const hRef = scanAiTone('我不能讨论这个话题。');
check('T3.8 refuse 命中 +25（单一命中就能顶到重说线的一半以上）', hRef.hits.length === 1 && hRef.hits[0].kind === 'refuse' && hRef.score === 25, `score=${hRef.score}`);

// 综上所述 / 总而言之 同时躺在 transition 与 essay 两张表里 —— 同一 index 必须只算一次，
// 且取权重更高的那一类（transition +8 > essay +6）。这是「用 index 去重」的核心用例。
const hDup = scanAiTone('综上所述，情况就是这样。');
const hDup2 = scanAiTone('总而言之');
check('T3.9 ★同一 index 的双表词只算一次，取权重更高的 transition(+8)',
  hDup.hits.length === 1 && hDup.hits[0].kind === 'transition' && hDup.score === 8
    && hDup2.hits.length === 1 && hDup2.score === 8,
  `综上所述 hits=${hDup.hits.length} score=${hDup.score}`);
const hRep = scanAiTone('此外要注意，此外要小心。');
check('T3.10 同一个词出现多次，每次各自计分（index 0 与 6）',
  hRep.hits.length === 2 && hRep.score === 16 && hRep.hits[0].index === 0 && hRep.hits[1].index === 6,
  `hits=${JSON.stringify(hRep.hits)}`);
// 重叠短语在不同 index 上，按规则各算一次（这里只记录行为，不评价好坏：宁可严格）
const hOverlap = scanAiTone('我建议你咨询专业人士。');
check('T3.11 重叠短语落在不同 index 上时各算一次（我建议你 / 建议你咨询专业人士）',
  hOverlap.hits.length === 2 && hOverlap.score === 50, `hits=${JSON.stringify(hOverlap.hits.map((h) => h.word))} score=${hOverlap.score}`);
check('T3.12 hits 按 index 升序排列', scanAiTone('首先此外，其次助力。').hits.every((h, i, arr) => i === 0 || arr[i - 1].index <= h.index));

say('T4 打分：加成、上限与 reasons');
// 注意 PILE 是「文本」、pile 是 scanAiTone 的「结果」—— shouldRephrase 收的是文本，
// 传错成结果对象不会报错（String({}) → '[object Object]'，长度刚好过 12 字早退线），
// 只会静默给出错误答案。这个坑第一次跑就踩了，所以名字故意写得不一样。
const PILE = '作为 AI，我不能讨论，我无法提供，不适合讨论，我建议你咨询专业人士，请注意甄别，理性看待。';
const pile = scanAiTone(PILE);
check('T4.1 ★分数上限 100（拒答腔堆到 200 分也只算 100）',
  pile.hits.length >= 5 && pile.score === 100, `命中 ${pile.hits.length} 处、原始分远超 100、实得 ${pile.score}`);
const md1 = scanAiTone('**你好**');
const md2 = scanAiTone('- 甲\n# 乙');
check('T4.2 Markdown 每处 +10、kind 记为 markdown（** 两处、行首 - 与 # 各一处）',
  md1.hits.length === 2 && md1.score === 20 && md1.hits.every((h) => h.kind === 'markdown' && h.word === '**')
    && md2.hits.length === 2 && md2.score === 20 && md2.hits.map((h) => h.word).join(',') === '- ,#',
  `**…** score=${md1.score} / 列表与标题 score=${md2.score}`);
// 齐整句：3 句、每句 20 字、无任何词命中 → 只拿齐整加成 15
const C20 = '一二三四五六七八九十';
const flat3 = `${C20}${C20}。${C20}${C20}。${C20}${C20}。`;
const rFlat = scanAiTone(flat3);
check('T4.3 ★句子齐整加成 +15（3 句 20 字、零词命中，净得分就是 15）',
  rFlat.hits.length === 0 && rFlat.score === 15 && rFlat.reasons.some((r) => r.includes('齐整')),
  `score=${rFlat.score} reasons=${JSON.stringify(rFlat.reasons)}`);
check('T4.4 齐整加成与词命中叠加（1 个过渡词 +8 且句长仍齐整 → 23）',
  scanAiTone(`${C20}${C20}。此外${C20}${C20}。${C20}${C20}。`).score === 23,
  `实得 ${scanAiTone(`${C20}${C20}。此外${C20}${C20}。${C20}${C20}。`).score}`);
const spread = scanAiTone('好。这是一个很长很长的句子用来把变异系数拉高。嗯。');
check('T4.5 ≥3 句但长短悬殊（1/20/1）→ 没有齐整加成',
  spread.score === 0 && !spread.reasons.some((r) => r.includes('齐整')),
  `score=${spread.score} jitter=${lengthJitter(sentenceLengths('好。这是一个很长很长的句子用来把变异系数拉高。嗯。')).toFixed(3)}`);
const twoEven = `${C20}。${C20}。`;
check('T4.6 只有 2 句时即使等长也不加成（3 句才是「齐整」的起点）',
  scanAiTone(twoEven).score === 0 && lengthJitter(sentenceLengths(twoEven)) === 0);
check('T4.7 score 恒为 0~100 的整数', [pile, md1, md2, rFlat, spread, hT].every((r) => Number.isInteger(r.score) && r.score >= 0 && r.score <= 100));
check('T4.8 干净文本 reasons 说人话、不空数组',
  scanAiTone('今天群里挺热闹的').reasons.length === 1 && scanAiTone('今天群里挺热闹的').reasons[0].includes('未发现'),
  JSON.stringify(scanAiTone('今天群里挺热闹的').reasons));
check('T4.9 reasons 只统计真正命中的类别（只有过渡词时不会冒出客服腔）',
  hT.reasons.length === 1 && hT.reasons[0].includes('过渡词') && !hT.reasons[0].includes('客服腔'),
  JSON.stringify(hT.reasons));

say('T5 shouldRephrase 早退与阈值边界');
check('T5.1 空串/纯空白不重说', shouldRephrase('') === false && shouldRephrase('   ') === false);
check('T5.2 ★太短早退：12 字以下即使满是拒答腔也不重说',
  shouldRephrase('我不能讨论', {}) === false && shouldRephrase('我不能讨论', { minLength: 6, maxScore: 20 }) === false);
check('T5.3 恰好等于 minLength 不再早退（长度是左闭的）',
  shouldRephrase('我不能讨论', { minLength: 5, maxScore: 20 }) === true,
  `长度=${'我不能讨论'.length} score=${scanAiTone('我不能讨论').score}`);
const border = '此外，我们要深耕。';   // score 恰为 20，长度 9 → 必须显式给 minLength 才不被早退
check('T5.4 ★阈值边界：score 等于 maxScore 不重说、超过 1 分才重说',
  scanAiTone(border).score === 20
    && shouldRephrase(border, { minLength: 1, maxScore: 20 }) === false
    && shouldRephrase(border, { minLength: 1, maxScore: 19 }) === true,
  `score=${scanAiTone(border).score}`);
check('T5.5 阈值可放宽到关掉（maxScore=100 → 再 AI 也不重说）',
  shouldRephrase(PILE, { maxScore: 100 }) === false && shouldRephrase(PILE, { maxScore: 99, minLength: 1 }) === true,
  `PILE score=${pile.score}`);
check('T5.6 默认参数就是 maxScore=40 / minLength=12（不传第二参也能用）',
  shouldRephrase(PILE) === true && shouldRephrase(border) === false);

say('T6 真实反例：两条 AI 腔 vs 两条 QQ 口语');
// 这四条是给人看的：跑测试时把原文与分数一起打出来，规则改坏了肉眼也能发现。
const AI_SAMPLE_1 = '此外，我们要深耕底层逻辑，打造闭环，助力群友。';
const AI_SAMPLE_2 = '作为 AI，我不能讨论这个话题，建议你咨询专业人士。';
const QQ_SAMPLE_1 = '诶你今天咋没来啊？群里都在等你呢，快点快点';
const QQ_SAMPLE_2 = '哈哈哈哈笑死我了！这破天气热得人想原地融化成一摊水。还是空调房舒服。';
const sAi1 = scanAiTone(AI_SAMPLE_1);
const sAi2 = scanAiTone(AI_SAMPLE_2);
const sQq1 = scanAiTone(QQ_SAMPLE_1);
const sQq2 = scanAiTone(QQ_SAMPLE_2);
say(`   【AI 腔样本 1】${AI_SAMPLE_1}`);
say(`      score=${sAi1.score}  hits=${JSON.stringify(sAi1.hits.map((h) => `${h.word}@${h.index}/${h.kind}`))}`);
say(`      reasons=${JSON.stringify(sAi1.reasons)}`);
say(`   【AI 腔样本 2】${AI_SAMPLE_2}`);
say(`      score=${sAi2.score}  hits=${JSON.stringify(sAi2.hits.map((h) => `${h.word}@${h.index}/${h.kind}`))}`);
say(`      reasons=${JSON.stringify(sAi2.reasons)}`);
say(`   【QQ 口语样本 1】${QQ_SAMPLE_1}`);
say(`      score=${sQq1.score}  hits=${JSON.stringify(sQq1.hits)}  jitter=${lengthJitter(sentenceLengths(QQ_SAMPLE_1)).toFixed(3)}`);
say(`   【QQ 口语样本 2】${QQ_SAMPLE_2}`);
say(`      score=${sQq2.score}  hits=${JSON.stringify(sQq2.hits)}  jitter=${lengthJitter(sentenceLengths(QQ_SAMPLE_2)).toFixed(3)}`);
check('T6.1 ★AI 腔样本 1 判为高 AI 腔（score ≥ 40）', sAi1.score >= 40, `score=${sAi1.score}`);
check('T6.2 ★AI 腔样本 2（拒答腔）判为高 AI 腔（score ≥ 40）', sAi2.score >= 40, `score=${sAi2.score}`);
check('T6.3 ★QQ 口语样本 1 判为干净（score ≤ 15）', sQq1.score <= 15, `score=${sQq1.score}`);
check('T6.4 ★QQ 口语样本 2 判为干净（score ≤ 15）', sQq2.score <= 15, `score=${sQq2.score}`);
check('T6.5 两类样本拉得开（AI 样本最低分比口语样本最高分高 25 分以上）',
  Math.min(sAi1.score, sAi2.score) > Math.max(sQq1.score, sQq2.score) + 25,
  `${Math.min(sAi1.score, sAi2.score)} vs ${Math.max(sQq1.score, sQq2.score)}`);
// 两条口语样本都超过默认 minLength=12，所以这里的 false 是「分低」而不是「被早退挡掉」——
// 少了这句断言，T6.3/T6.4 有可能因为文本太短而假绿。
check('T6.6 ★口语样本确实走完了完整判定（长度 ≥ 12，false 不是被早退挡掉的）',
  QQ_SAMPLE_1.trim().length >= 12 && QQ_SAMPLE_2.trim().length >= 12
    && shouldRephrase(QQ_SAMPLE_1) === false && shouldRephrase(QQ_SAMPLE_2) === false,
  `长度=${QQ_SAMPLE_1.trim().length}/${QQ_SAMPLE_2.trim().length}`);
check('T6.7 AI 样本在默认阈值下会被要求重说', shouldRephrase(AI_SAMPLE_1) === true && shouldRephrase(AI_SAMPLE_2) === true);

// ══════════════════════════════════════════════════════════════════
say(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
await new Promise((r) => setTimeout(r, 200));
process.exit(fail > 0 ? 1 : 0);
