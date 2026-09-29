// ops/test-splitter.mjs
// 纯本地测试：不联网、不读 state/、不看当前时间、不使用 Math.random（用固定种子的 mulberry32）。
import {
  SPLIT_DEFAULTS,
  splitMessage,
  planGaps,
  planSend,
  splitStats
} from '../src/splitter.js';

let pass = 0;
let fail = 0;
let skip = 0;

function section(title) {
  console.log(`\n── ${title} ──`);
}
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`✅ ${name}  ${detail}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}  ${detail}`);
  }
}
function skipped(name, detail = '') {
  skip += 1;
  console.log(`⏭ ${name}  ${detail}`);
}

// —— 固定种子的可重复伪随机数发生器（测试内禁止 Math.random）——
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const len = (s) => (typeof s === 'string' ? s.length : -1);
const lens = (arr) => arr.map(len);
const stddev = (xs) => {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return Math.sqrt(v);
};

const S1 = '诶主人，群里鲸鲸不能碰电脑的呀，你私聊戳鲸鲸一下，鲸鲸马上就去办';
const S2 = '唔…不行哦主人，萝莉这条线鲸鲸是真的一直没动过；换个正常的角色你报个名字，我这就去搜';
const S3 = '鲸鲸今天在群里看到有人问问题呢。你要不要也去凑个热闹呀。';

// ═══ A 段：空值 / 归一化 / 短句直通 ═══
section('A 段：空值与归一化');
{
  check('空串返回空数组', Array.isArray(splitMessage('')) && splitMessage('').length === 0, `got=${JSON.stringify(splitMessage(''))}`);
  check('非字符串返回空数组', splitMessage(null).length === 0 && splitMessage(undefined).length === 0 && splitMessage(123).length === 0 && splitMessage({}).length === 0, 'null/undefined/123/{} → []');
  check('全空白返回空数组', splitMessage('   \n\t  \n ').length === 0, `got=${JSON.stringify(splitMessage('   \n\t  \n '))}`);

  const messy = splitMessage('  你好  \n\n\n  世界   ');
  check('多余空行与行首尾空白被修掉', messy.length === 1 && messy[0] === '你好世界', `got=${JSON.stringify(messy)}`);

  const shortOne = splitMessage('在的');
  check('短句原样 1 条（不为了凑条数乱切）', shortOne.length === 1 && shortOne[0] === '在的', `got=${JSON.stringify(shortOne)}`);

  const exact = 'x'.repeat(SPLIT_DEFAULTS.maxLen);
  const exactOut = splitMessage(exact);
  check('正好 maxLen 也是 1 条', exactOut.length === 1 && exactOut[0] === exact, `len=${len(exactOut[0])}`);
  check('SPLIT_DEFAULTS 被冻结', Object.isFrozen(SPLIT_DEFAULTS) && SPLIT_DEFAULTS.maxLen === 25 && SPLIT_DEFAULTS.gapCv === 0.35, JSON.stringify(SPLIT_DEFAULTS));
}

// ═══ B 段：语义切分（真实样本）═══
section('B 段：语义切分');
{
  const p1 = splitMessage(S1);
  check('S1 切成 2 条', p1.length === 2, `parts=${JSON.stringify(p1)}`);
  check('S1 每条例都 ≤ maxLen', p1.every((p) => len(p) <= SPLIT_DEFAULTS.maxLen), `lens=${JSON.stringify(lens(p1))}`);
  check('S1 没有以「，」开头的碎片', p1.every((p) => !'，、；：'.includes(p[0])), `首字=${JSON.stringify(p1.map((p) => p[0]))}`);
  check('S1 拼接后与原文一致（不丢字）', p1.join('') === S1, `joinLen=${p1.join('').length}/${S1.length}`);
  check('S1 首条结束在逗号后（标点跟着前一句）', p1[0].endsWith('，'), `tail="${p1[0].slice(-2)}"`);

  const p2 = splitMessage(S2);
  check('S2 切成 3 条', p2.length === 3, `parts=${JSON.stringify(p2)}`);
  check('S2 每条例都 ≤ maxLen', p2.every((p) => len(p) <= SPLIT_DEFAULTS.maxLen), `lens=${JSON.stringify(lens(p2))}`);
  check('S2 拼接后与原文一致', p2.join('') === S2, `joinLen=${p2.join('').length}/${S2.length}`);
  check('S2 尾条被短化到 ≤ tailMaxLen', len(p2[p2.length - 1]) <= SPLIT_DEFAULTS.tailMaxLen, `tail="${p2[p2.length - 1]}" len=${len(p2[p2.length - 1])}`);
  check('S2 短尾内容正确（靠后的逗号处切）', p2[1] === '换个正常的角色你报个名字，' && p2[2] === '我这就去搜', `p1="${p2[1]}" p2="${p2[2]}"`);
  check('S2 「唔…」没有被切出来当独立碎片', p2[0].startsWith('唔…不行哦主人'), `p0="${p2[0]}"`);

  const p3 = splitMessage(S3);
  check('S3 在句末标点后切且句号跟在前一句', p3[0] === '鲸鲸今天在群里看到有人问问题呢。', `p0="${p3[0]}"`);
  check('S3 尾条切不动就算了（保持原样）', p3.length === 2 && p3[1] === '你要不要也去凑个热闹呀。', `tail="${p3[1]}"`);

  const samples = [S1, S2, S3, 'aaaaaaaaaa，bbbbbbbbbb，cccccccccc，dddddddddd', 'x'.repeat(60)];
  check('所有样本都没有短于 minLen 的碎片', samples.every((s) => splitMessage(s).every((p) => len(p) >= SPLIT_DEFAULTS.minLen)), `最短=${Math.min(...samples.flatMap((s) => lens(splitMessage(s))))}`);
}

// ═══ C 段：次级标点与硬切 ═══
section('C 段：次级标点与硬切');
{
  const lat = 'aaaaaaaaaa，bbbbbbbbbb，cccccccccc，dddddddddd';
  const p = splitMessage(lat);
  // 43 字无句末标点：先在 ≤maxLen 内最靠后的逗号（index 21）切出 22 字，尾条 21 字再被 E 段尾条短化切成 11+10
  check('无句末标点时退到逗号切', JSON.stringify(lens(p)) === JSON.stringify([22, 11, 10]), `lens=${JSON.stringify(lens(p))}`);
  check('逗号切点保留在前一条尾部', p[0] === 'aaaaaaaaaa，bbbbbbbbbb，' && p[1] === 'cccccccccc，', `p0="${p[0]}" p1="${p[1]}"`);

  const hard = 'x'.repeat(60);
  const h = splitMessage(hard);
  check('完全无标点时按字数硬切', h.length === 3 && h.every((s) => len(s) <= SPLIT_DEFAULTS.maxLen), `lens=${JSON.stringify(lens(h))}`);
  check('硬切点尽量靠近 maxLen', h[0].length === SPLIT_DEFAULTS.maxLen && h[1].length === SPLIT_DEFAULTS.maxLen, `lens=${JSON.stringify(lens(h))}`);
  check('硬切后拼接无丢失', h.join('') === hard, `joinLen=${h.join('').length}`);
}

// ═══ D 段：碎片合并与 maxParts ═══
section('D 段：碎片合并与 maxParts');
{
  const merged = '今天天气真的特别特别好呀我们一起去公园里散步吧。嗯。';
  const m = splitMessage(merged);
  check('短碎片并回上一条（并回后可超过 maxLen）', m.length === 1 && m[0] === merged && m[0].length > SPLIT_DEFAULTS.maxLen, `parts=${m.length} len=${len(m[0])}`);

  const unit = '一二三四五六七八九十。';
  const many = unit.repeat(12);
  const mp = splitMessage(many);
  check('超过 maxParts 时收进 4 条', mp.length === SPLIT_DEFAULTS.maxParts, `len=${mp.length}`);
  check('多出来的并进最后一条（不丢字）', mp.join('') === many, `joinLen=${mp.join('').length}/${many.length} tailLen=${len(mp[3])}`);

  const capped = splitMessage(unit.repeat(6), { maxParts: 2 });
  check('maxParts=2 时并成 2 条且不丢字', capped.length === 2 && capped.join('') === unit.repeat(6), `lens=${JSON.stringify(lens(capped))}`);
}

// ═══ E 段：纯函数性（不改入参）═══
section('E 段：纯函数性');
{
  const parts = ['aaa', 'bbb', 'ccc'];
  const snapshot = parts.slice();
  planGaps(parts, {}, mulberry32(7));
  check('planGaps 不修改传入数组', JSON.stringify(parts) === JSON.stringify(snapshot), `parts=${JSON.stringify(parts)}`);

  const opts = { maxLen: 12 };
  const optsSnapshot = JSON.stringify(opts);
  splitMessage(S2, opts);
  check('splitMessage 不修改 options', JSON.stringify(opts) === optsSnapshot, `opts=${JSON.stringify(opts)}`);

  const again = splitMessage(S2);
  check('同输入两次结果完全一致', JSON.stringify(again) === JSON.stringify(splitMessage(S2)), `parts=${again.length}`);
}

// ═══ F 段：planGaps ═══
section('F 段：planGaps');
{
  check('parts ≤ 1 时返回空间隔', planGaps([], {}, mulberry32(1)).length === 0 && planGaps(['a'], {}, mulberry32(1)).length === 0, '[] / [a] → []');

  const r = mulberry32(2024);
  const gaps = planGaps(['a', 'b', 'c', 'd'], {}, r);
  check('间隔长度 = 条数 - 1', gaps.length === 3, `gaps=${JSON.stringify(gaps)}`);
  check('间隔全部落在 [gapMin, gapMax]', gaps.every((g) => g >= SPLIT_DEFAULTS.gapMin && g <= SPLIT_DEFAULTS.gapMax), `gaps=${JSON.stringify(gaps)}`);
  check('间隔全部是整数毫秒', gaps.every((g) => Number.isInteger(g)), `gaps=${JSON.stringify(gaps)}`);

  const gLo = planGaps(['a', 'b'], {}, () => 0);
  const gHi = planGaps(['a', 'b'], {}, () => 1);
  check('使用注入的 rand（下界）', gLo[0] === SPLIT_DEFAULTS.gapMin, `rand=0 → ${gLo[0]}`);
  check('使用注入的 rand（上界）', gHi[0] === SPLIT_DEFAULTS.gapMax, `rand=1 → ${gHi[0]}`);

  const varied = planGaps(Array.from({ length: 30 }, (_, i) => `p${i}`), {}, mulberry32(99));
  check('间隔不是匀速的（有抖动）', new Set(varied).size > 5, `distinct=${new Set(varied).size}`);

  const custom = planGaps(['a', 'b'], { gapMin: 300, gapMax: 500, gapCv: 0.5 }, mulberry32(3));
  check('自定义 gapMin/gapMax 生效', custom[0] >= 300 && custom[0] <= 500, `gap=${custom[0]}`);
}

// ═══ G 段：planSend 结构 ═══
section('G 段：planSend');
{
  const r = planSend(S2, {}, mulberry32(11));
  check('planSend 返回四字段', r && Array.isArray(r.parts) && Array.isArray(r.gaps) && typeof r.chars === 'number' && typeof r.tailLen === 'number', `keys=${Object.keys(r).join(',')}`);
  check('gaps 长度 = parts 长度 - 1', r.gaps.length === r.parts.length - 1, `parts=${r.parts.length} gaps=${r.gaps.length}`);
  check('chars = 所有条字数之和', r.chars === r.parts.join('').length, `chars=${r.chars}`);
  check('tailLen = 最后一条字数', r.tailLen === len(r.parts[r.parts.length - 1]), `tailLen=${r.tailLen}`);

  const empty = planSend('   \n  ', {}, mulberry32(12));
  check('空输入 planSend 返回空结构', empty.parts.length === 0 && empty.gaps.length === 0 && empty.chars === 0 && empty.tailLen === 0, JSON.stringify(empty));
}

// ═══ H 段：splitStats ═══
section('H 段：splitStats');
{
  const stats = splitStats([
    { parts: ['aa', 'bbb'], gaps: [1000] },
    { parts: ['cccc', 'd', 'eeee'], gaps: [900, 1100] },
    { parts: ['ff', 'ggg'], gaps: [1000] }
  ]);
  check('n 计样本数', stats.n === 3, `n=${stats.n}`);
  check('平均条数 = 7/3', Math.abs(stats.平均条数 - 7 / 3) < 1e-9, `平均条数=${stats.平均条数}`);
  check('单条最长 = 4', stats.单条最长 === 4, `单条最长=${stats.单条最长}`);
  check('单条最短 = 1', stats.单条最短 === 1, `单条最短=${stats.单条最短}`);
  check('尾条均值 = 10/3', Math.abs(stats.尾条均值 - 10 / 3) < 1e-9, `尾条均值=${stats.尾条均值}`);
  check('平均间隔 = 1000', stats.平均间隔 === 1000, `平均间隔=${stats.平均间隔}`);
  check('间隔标准差 ≈ 70.71', Math.abs(stats.间隔标准差 - Math.sqrt(5000)) < 1e-6, `间隔标准差=${stats.间隔标准差}`);

  const bare = splitStats([['aa', 'bbb'], ['cc', 'dd']]);
  check('splitStats 也接受 string[] 样本', bare.n === 2 && bare.平均条数 === 2 && bare.平均间隔 === 0, JSON.stringify(bare));
  check('空样本返回全 0', splitStats([]).n === 0 && splitStats(null).单条最长 === 0, `n=${splitStats([]).n}`);
}

// ═══ V 段：统计性质（固定种子）═══
section('V 段：统计性质（固定种子）');
{
  const corpus = [S1, S2, S3, 'aaaaaaaaaa，bbbbbbbbbb，cccccccccc，dddddddddd', 'x'.repeat(60)];
  const seed = 1337;

  const runAll = () => {
    const rnd = mulberry32(seed);
    const out = [];
    for (let i = 0; i < 200; i++) {
      out.push(planSend(corpus[i % corpus.length], {}, rnd));
    }
    return out;
  };

  const runs = runAll();
  const counts = runs.map((r) => r.parts.length);
  const multi = counts.filter((c) => c >= 2 && c <= 4).length;
  const ratio = multi / 200;
  check('① 2~4 条占比 ≥ 60%', ratio >= 0.6, `占比=${(ratio * 100).toFixed(1)}% (${multi}/200), 条数分布=${JSON.stringify([...new Set(counts)].sort())}`);

  const allGaps = runs.flatMap((r) => r.gaps);
  const sd = stddev(allGaps);
  check('② 间隔标准差 ≥ 100ms（有方差）', sd >= 100, `std=${sd.toFixed(1)}ms mean=${(allGaps.reduce((a, b) => a + b, 0) / allGaps.length).toFixed(1)}ms n=${allGaps.length}`);
  check('②b 间隔始终在 [gapMin, gapMax] 内', allGaps.every((g) => g >= SPLIT_DEFAULTS.gapMin && g <= SPLIT_DEFAULTS.gapMax), `min=${Math.min(...allGaps)} max=${Math.max(...allGaps)}`);

  const runsAgain = runAll();
  check('③ 同种子结果完全一致', JSON.stringify(runs) === JSON.stringify(runsAgain), `hash 相同，共 ${runs.length} 次`);

  const stats = splitStats(runs);
  check('③b splitStats 吃 planSend 结果', stats.n === 200 && stats.平均条数 > 1 && stats.间隔标准差 >= 100, `n=${stats.n} 平均条数=${stats.平均条数.toFixed(2)} 尾条均值=${stats.尾条均值.toFixed(2)} 间隔sd=${stats.间隔标准差.toFixed(1)}`);
  check('③c 单条最长 ≤ maxLen + minLen（并回容差内）', stats.单条最长 <= SPLIT_DEFAULTS.maxLen + SPLIT_DEFAULTS.minLen, `单条最长=${stats.单条最长} 单条最短=${stats.单条最短}`);

  skipped('真实 QQ 发送节奏（人味体感）', '需要桥接运行环境与真人对话，纯函数层无法断言');
}

console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
if (fail > 0) process.exitCode = 1;
