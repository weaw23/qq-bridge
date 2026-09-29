// 三元组抽取回归测试：**从她的 facts 句子里抽「主体 + 谓词 + 客体」**
//
// 背景（这是这个模块存在的理由，别删）：
//   阶段 5 要把 facts 三元组化（谁喜欢什么 → 结构化槽位），好让她换话题时按
//   (subject, predicate) 召回，而不是靠 LIKE 撞关键词。抽取器是这个环节的第一道闸门，
//   它判错一次就是「她记错人」——线上表现是当着当事人的面把别人的喜好安在他头上，
//   比记不住更糟。所以抽取器从 bridge.js 里拆出来（src/triple-extract.js），
//   纯函数、不看钟、不读盘、不随机，可以脱离线上跑。
//
// 证据强度分层（跟 ops/test-sensitive.mjs 同一套规矩）：
//   T 段  纯函数穷举 —— 真正的行为验证，离线、不需要桥接在跑。
//   S 段  源码级接线检查 —— 只证明「那段代码还在、还是那个写法」，不是行为验证。
//
// 基线说明：用**命名空间导入**（`import * as X`）。具名导入一个还不存在的导出会让
//   ESM 在链接期直接失败，整个文件加载不了 —— 看起来像"测试坏了"而不是"断言红了"。
//
// 跑：node ops/test-triple-extract.mjs
//     纯离线，不打任何 HTTP 接口，不改任何配置，不需要桥接在跑。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as X from '../src/triple-extract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? '  ' + extra : ''}`); }
}
function group(title) { console.log(`\n── ${title} ──`); }

const extract = (text) => (typeof X.extractTriples === 'function' ? X.extractTriples(text) : []);
const one = (text) => {
  const out = extract(text);
  return out.length === 1 ? out[0] : null;
};

group('T1 基本抽取：七种谓词各来一句');

{
  const t = one('小满最喜欢草莓蛋糕');
  ok('T1.1 最喜欢', !!t && t.subject === '小满' && t.predicate === '最喜欢' && t.object === '草莓蛋糕', JSON.stringify(t));
}
{
  const t = one('主人很喜欢冰美式');
  ok('T1.2 很喜欢 → 喜欢', !!t && t.subject === '主人' && t.predicate === '喜欢' && t.object === '冰美式', JSON.stringify(t));
}
{
  const t = one('阿伟最讨厌香菜');
  ok('T1.3 最讨厌 → 讨厌', !!t && t.subject === '阿伟' && t.predicate === '讨厌' && t.object === '香菜', JSON.stringify(t));
}
{
  const t = one('小满的生日是五月三号');
  ok('T1.4 生日（带"的"）', !!t && t.subject === '小满' && t.predicate === '生日' && t.object === '五月三号', JSON.stringify(t));
}
{
  const t = one('梟鸟住在杭州');
  ok('T1.5 住在', !!t && t.subject === '梟鸟' && t.predicate === '住在' && t.object === '杭州', JSON.stringify(t));
}
{
  const t = one('她叫小柚');
  ok('T1.6 叫 → 名字', !!t && t.subject === '她' && t.predicate === '名字' && t.object === '小柚', JSON.stringify(t));
}
{
  const t = one('小满在字节跳动上班');
  ok('T1.7 在…上班（客体在中间）', !!t && t.subject === '小满' && t.predicate === '在…工作' && t.object === '字节跳动', JSON.stringify(t));
}

group('T2 归一化：空白与句末标点不参与匹配');

{
  const t = one('  小满 最喜欢 草莓蛋糕  ');
  ok('T2.1 内部空格被吃掉', !!t && t.subject === '小满' && t.object === '草莓蛋糕', JSON.stringify(t));
}
{
  const t = one('小满最喜欢草莓蛋糕。');
  ok('T2.2 句末句号剥掉', !!t && t.object === '草莓蛋糕', JSON.stringify(t));
}
{
  const t = one('小满最喜欢草莓蛋糕！！');
  ok('T2.3 连续感叹号剥掉', !!t && t.object === '草莓蛋糕', JSON.stringify(t));
}
{
  const t = one('小满最喜欢草莓蛋糕～');
  ok('T2.4 波浪线剥掉（她自己的口头习惯）', !!t && t.object === '草莓蛋糕', JSON.stringify(t));
}
{
  const t = one('她最喜欢的是芒果');
  ok('T2.5 客体开头的"的"剥掉', !!t && t.object === '芒果', JSON.stringify(t));
}

group('T3 该拒绝的必须拒绝（宁可漏，不可错）');

{
  ok('T3.1 问句不抽', extract('主人喜欢喝什么？').length === 0);
  ok('T3.2 半角问号同样不抽', extract('小满喜欢猫?').length === 0);
  ok('T3.3 她自己不确定的不抽', extract('小满好像喜欢猫').length === 0);
  ok('T3.4 记不清的不抽', extract('阿伟喜欢什么我记不清').length === 0);
  ok('T3.5 也许不抽', extract('主人也许喜欢甜食').length === 0);
  ok('T3.6 太短（无谓词）', extract('好的').length === 0);
  ok('T3.7 超长叙述句不抽', extract('今天小满跟我聊了很久他说他最喜欢草莓蛋糕而且还讲了别的很多事情总之很长很长很长很长很长很长').length === 0);
  ok('T3.8 空串不抽', extract('').length === 0);
  ok('T3.9 null 不抽', extract(null).length === 0);
  ok('T3.10 undefined 不抽', extract(undefined).length === 0);
  ok('T3.11 数字不抽（不抛）', extract(12345).length === 0);
  ok('T3.12 对象不抽（不抛）', extract({ a: 1 }).length === 0);
  ok('T3.13 数组不抽（不抛）——String() 会把数组拍成一句很像事实的话，必须显式挡掉', extract(['小满最喜欢草莓蛋糕']).length === 0);
  ok('T3.14 没有谓词词的句子不抽', extract('小满和草莓蛋糕都在桌上').length === 0);
  ok('T3.15 主体等于客体不抽', extract('喜欢喜欢').length === 0);
  ok('T3.16 客体超长时不抽', extract('小满最喜欢' + '草'.repeat(31)).length === 0);
  ok('T3.17 叙述型主体不抽（短句也挡：小满跟我聊了很久说他最喜欢草莓）', extract('小满跟我聊了很久说他最喜欢草莓').length === 0);
}

group('T4 一句话只出一条：长句不许拆成两条错关系');

{
  const out = extract('她喜欢猫也喜欢狗');
  ok('T4.1 "也喜欢"只出第一条', out.length === 1, JSON.stringify(out));
  ok('T4.2 出的是最靠前的那条', out.length === 1 && out[0].predicate === '喜欢', JSON.stringify(out[0]));
}
{
  const out = extract('他最喜欢打游戏最讨厌下雨天');
  ok('T4.3 喜欢+讨厌混在一句：只出一条', out.length === 1, JSON.stringify(out));
  ok('T4.4 取优先级更高/更靠前的谓词', out.length === 1 && out[0].predicate === '最喜欢', JSON.stringify(out[0]));
}
{
  const out = extract('小满最喜欢草莓蛋糕');
  ok('T4.5 正常句也只出一条', out.length === 1);
}

group('T5 优先级与覆盖：最喜欢 不会被 喜欢 抢走');

{
  const t = one('小满最喜欢草莓');
  ok('T5.1 最喜欢 优先于 喜欢', !!t && t.predicate === '最喜欢', JSON.stringify(t));
}
{
  const t = one('小满最爱草莓');
  ok('T5.2 最爱 也归 最喜欢', !!t && t.predicate === '最喜欢', JSON.stringify(t));
}
{
  const t = one('主人不爱吃辣');
  ok('T5.3 不爱 → 讨厌（否定不能反向）', !!t && t.predicate === '讨厌' && t.object === '吃辣', JSON.stringify(t));
}
{
  const t = one('阿伟不喜欢香菜');
  ok('T5.4 不喜欢 → 讨厌', !!t && t.predicate === '讨厌', JSON.stringify(t));
}

group('T6 渲染：召回注入与日志共用一个措辞');

{
  const line = typeof X.renderTriple === 'function'
    ? X.renderTriple({ subject: '小满', predicate: '最喜欢', object: '草莓蛋糕' })
    : undefined;
  ok('T6.1 拼成一句话', line === '小满最喜欢草莓蛋糕', String(line));
}
{
  const line = typeof X.renderTriple === 'function'
    ? X.renderTriple({ subject: '小满', predicate: '住在', object: '杭州', validToMs: 1700000000000 })
    : undefined;
  ok('T6.2 已作废条目带标注', line === '小满住在杭州（已作废）', String(line));
}
{
  const line = typeof X.renderTriple === 'function' ? X.renderTriple(null) : 'x';
  ok('T6.3 坏输入返回空串不抛', line === '', String(line));
}

group('T7 常量契约（以后调参只动这一张表）');

{
  ok('T7.1 谓词表被冻结', typeof X.TRIPLE_PATTERNS !== 'undefined' && Object.isFrozen(X.TRIPLE_PATTERNS));
  ok('T7.2 表里每个条目也是冻结的', Array.isArray(X.TRIPLE_PATTERNS) && X.TRIPLE_PATTERNS.every((p) => Object.isFrozen(p)));
  ok('T7.3 表里 7 种谓词', Array.isArray(X.TRIPLE_PATTERNS) && X.TRIPLE_PATTERNS.length === 7, String(X.TRIPLE_PATTERNS?.length));
  ok('T7.4 长度上限被冻结', typeof X.EXTRACT_LIMITS !== 'undefined' && Object.isFrozen(X.EXTRACT_LIMITS));
  ok('T7.5 maxLength 40 / maxSubjectLength 14 / maxObjectLength 30',
    X.EXTRACT_LIMITS?.maxLength === 40 && X.EXTRACT_LIMITS?.maxSubjectLength === 14 && X.EXTRACT_LIMITS?.maxObjectLength === 30);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'triple-extract.js'), 'utf8');
  ok('T7.6 模块里没有 import（纯函数、不依赖任何东西）', !/^\s*import\s/m.test(src));
  ok('T7.7 模块里没有时钟/随机调用', !/Date\.now|new Date|Math\.random/.test(src));
}

group('S 段 源码级接线检查（只证明写法还在，不是行为验证）');

{
  ok('S1 bridge 导入了抽取器', /import \{ extractTriples, renderTriple \} from '\.\/triple-extract\.js'/.test(bridgeSrc));
  ok('S2 bridge 导入了三元组模块四个函数',
    /import \{ deserializeTriples, recallTriples, serializeTriples, upsertTriple \} from '\.\/memory-triples\.js'/.test(bridgeSrc));
  ok('S3 facts 写入路径挂上抽取（新增分支）',
    /ingestTriplesFromFact\(\{ content, sourceKey, importance \}\);\s*\n\s*return \{ id, deduped: false \}/.test(bridgeSrc));
  ok('S4 facts 写入路径挂上抽取（去重分支）',
    /ingestTriplesFromFact\(\{ content, sourceKey, importance \}\); \/\/ 重复事实也再抽一次/.test(bridgeSrc));
  ok('S5 召回复用同一套私聊隔离分寸', /if \(isGroupKey && !ownerPresent && String\(t\.source \?\? ''\)\.startsWith\('private:'\)\) continue;/.test(bridgeSrc));
  ok('S6 召回会推进 accessCount（打分权重 0.1 靠它）', /t\.accessCount = \(Number\(t\.accessCount\) \|\| 0\) \+ 1;/.test(bridgeSrc));
  ok('S7 三元组行排在 facts 行之前', /return \[\.\.\.tripleLines, \.\.\.factLines\];/.test(bridgeSrc));
  ok('S8 周合并在夜间维护里被调用', /triples = mergeTriplesWeekly\(\);/.test(bridgeSrc));
  ok('S9 夜间维护日志带三元组统计', /三元组 \$\{r\.triples\.before\} → \$\{r\.triples\.after\} 条/.test(bridgeSrc));
  ok('S10 落盘走 serializeTriples（不再自己 stringify）', /fs\.writeFileSync\(TRIPLES_FILE, serializeTriples\(triplesCache\)\)/.test(bridgeSrc));
  ok('S11 读盘走 deserializeTriples 并容错', /triplesCache = \[\]; \/\/ 文件不存在\/坏掉都从空库开始/.test(bridgeSrc));
  ok('S12 抽取失败不影响 facts 落库', /\[triples\] 抽取失败（已忽略，不影响 facts 落库）/.test(bridgeSrc));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  ok('S13 config.json 有 socialV2.triples 开关', cfg.socialV2?.triples?.enabled === true && Number(cfg.socialV2?.triples?.recallMax) === 3);
}

console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
process.exit(fail ? 1 : 0);
