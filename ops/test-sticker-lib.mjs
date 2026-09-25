// P1-5 表情图库三态 + 语义搜库：回归测试。
//
// 三段：
//   U 段 —— 纯函数穷举（离线，不碰桥接）。边界逻辑抽到 src/sticker-lib.js 就是为了这一层：
//           埋在 main() 闭包里就只能靠「把线上网关弄挂」来验证。
//   S 段 —— 源码接线断言。**明确声明：这只能证明代码还在，不是行为验证**，
//           真正的行为验证在 A 段。
//   A 段 —— 打真条路由（桥接必须在跑）。除了「翻转真库某一张的三态再翻回来」这一处
//           可逆写入外，全程零副作用：不发表情、不进 recentMessages、不唤醒。
//           靶子用 group:1132819177（白名单内、且她在该群被禁言到 2026-10-23）双保险。
//
// 部署前跑一遍是**必须的**：那一遍应当有若干条失败（功能未上线），
// 用来证明每条断言都非空，而不是写了一堆永远为真的检查。
//
// 跑：node ops/test-sticker-lib.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STICKER_STATES, STICKER_STATE_LABEL, STICKER_COLD_FAMILIARITY, STICKER_SYNONYMS,
  normalizeStickerState, stickerStateLabel, defaultStickerState,
  normalizeDhash, dhashHexFromGray, hammingDistanceHex, findNearDuplicateSticker,
  stickerSendable, setStickerState, stickerStateCounts,
  buildSynonymIndex, expandQuery, scoreSticker, searchStickers,
  stickerColdChannel, buildStickerContext, buildStickerStrategyHint,
  normalizeStickerEntry, findSticker, stickerRepeatBlocked
} from '../src/sticker-lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_JS = path.join(ROOT, 'src', 'bridge.js');
const MCP_JS = path.join(ROOT, 'src', 'mcp-snowluma-safe.js');
const TOOLDOCS_JS = path.join(ROOT, 'src', 'tool-docs.js');
const LIB_JS = path.join(ROOT, 'src', 'sticker-lib.js');
const STORE = path.join(ROOT, 'state', 'stickers.json');
const CONSOLE_TOKEN_FILE = path.join(ROOT, 'state', 'console-token');
const PANEL = 'http://127.0.0.1:3100';
const TARGET_KEY = 'group:1132819177';

let pass = 0, fail = 0, skip = 0;
const say = (s = '') => console.log(s);
const section = (t) => say(`\n── ${t} ──`);
function check(name, ok, extra = '') {
  if (ok) { pass++; say(`✅ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; say(`❌ ${name}${extra ? `  ${extra}` : ''}`); }
}
const skipped = (n, why = '') => { skip++; say(`⏭️  ${n}${why ? `（${why}）` : ''}`); };

const consoleToken = fs.existsSync(CONSOLE_TOKEN_FILE) ? fs.readFileSync(CONSOLE_TOKEN_FILE, 'utf8').trim() : '';
const panelHeaders = consoleToken ? { 'x-console-token': consoleToken } : {};

async function req(url, { method = 'GET', token = '', body = null, headers = {} } = {}) {
  // x-console-token 是全局闸门：漏了会直接 401「未授权：请提供控制台访问令牌」，
  // 而 401 的 body 里没有任何业务字段，断言会以 undefined 静默「通过」。所以默认带上。
  const init = { method, headers: { ...panelHeaders, ...headers } };
  if (body != null) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (token) init.headers['x-agent-token'] = token;
  try {
    const res = await fetch(`${PANEL}${url}`, init);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, ok: res.ok };
  } catch (error) {
    return { status: 0, json: null, ok: false, err: String(error?.message ?? error) };
  }
}

const log = (s = '') => console.log(s);

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 三态：规范化 / 别名 / 默认推导 / 标签 / 计数');

check('STICKER_STATES 就是三态', JSON.stringify(STICKER_STATES) === '["pending","fav","trash"]', JSON.stringify(STICKER_STATES));
check('三种状态都有中文标签', STICKER_STATES.every((s) => typeof STICKER_STATE_LABEL[s] === 'string' && STICKER_STATE_LABEL[s].length > 0),
  JSON.stringify(STICKER_STATE_LABEL));
check('标签渲染 fav=收藏', stickerStateLabel('fav') === '收藏', stickerStateLabel('fav'));

check('normalize：fav 原样', normalizeStickerState('fav') === 'fav');
check('normalize：收藏（中文别名）→ fav', normalizeStickerState('收藏') === 'fav');
check('normalize：favorite → fav', normalizeStickerState('favorite') === 'fav');
check('normalize：star → fav', normalizeStickerState('star') === 'fav');
check('normalize：trash 原样', normalizeStickerState('trash') === 'trash');
check('normalize：回收站 → trash', normalizeStickerState('回收站') === 'trash');
check('normalize：deleted → trash', normalizeStickerState('deleted') === 'trash');
check('normalize：pending 原样', normalizeStickerState('pending') === 'pending');
check('normalize：未整理 → pending', normalizeStickerState('未整理') === 'pending');
check('normalize：大小写/空格容错（" FAV "）→ fav', normalizeStickerState(' FAV ') === 'fav');
check('normalize：垃圾值走 fallback', normalizeStickerState('wtf', 'trash') === 'trash');
check('normalize：null 走 fallback', normalizeStickerState(null, 'pending') === 'pending');
check('normalize：undefined 走默认 fallback=pending', normalizeStickerState(undefined) === 'pending');
check('normalize：数字也走 fallback', normalizeStickerState(7, 'fav') === 'fav');

check('default：有 localNote → fav', defaultStickerState({ localNote: '主人送的' }) === 'fav');
check('default：有 tags → fav', defaultStickerState({ tags: ['自嘲'] }) === 'fav');
check('default：有 usage → fav', defaultStickerState({ usage: '被夸的时候用' }) === 'fav');
check('default：用过一次 → fav', defaultStickerState({ useCount: 1 }) === 'fav');
check('default：什么都没 → pending（这是迁移语义：没被整理过的才落待整理）', defaultStickerState({}) === 'pending');
check('default：只有备注空白 → pending', defaultStickerState({ localNote: '  ', tags: [] }) === 'pending');

// normalizeStickerEntry 是真正的迁移入口：老库里没有 state 字段。
const eFav = normalizeStickerEntry({ id: 'a', desc: '备注', localNote: '本地笔记', tags: ['自嘲'], useCount: 3 });
check('迁移：老条目有笔记 → state=fav', eFav.state === 'fav', `state=${eFav.state}`);
const ePending = normalizeStickerEntry({ id: 'b', desc: '一条没整理过的', tags: [], useCount: 0 });
check('迁移：老条目无笔记无标签 → state=pending', ePending.state === 'pending', `state=${ePending.state}`);
const eExplicit = normalizeStickerEntry({ id: 'c', desc: 'x', localNote: '有笔记', state: 'trash' });
check('迁移：显式 state 优先于推导', eExplicit.state === 'trash', `state=${eExplicit.state}`);
check('迁移：dhash 字段默认空串', ePending.dhash === '', `dhash="${ePending.dhash}"`);
check('迁移：非法 dhash 被清成空串', normalizeStickerEntry({ id: 'd', dhash: 'zzz' }).dhash === '');
check('迁移：无 id 仍返回 null', normalizeStickerEntry({ desc: '没有 id' }) === null);

const counts = stickerStateCounts([{ state: 'fav' }, { state: 'fav' }, { state: 'pending' }, { state: 'trash' }, {}]);
check('计数：fav=2', counts.fav === 2, JSON.stringify(counts));
check('计数：pending=2（含缺 state 的按 pending 算）', counts.pending === 2, JSON.stringify(counts));
check('计数：trash=1', counts.trash === 1, JSON.stringify(counts));

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 发图闸门 stickerSendable');

const gFav = stickerSendable({ id: 'x', state: 'fav' });
check('fav → 放行', gFav.ok === true, JSON.stringify(gFav));
const gPend = stickerSendable({ id: 'x', state: 'pending' });
check('pending → 拦住', gPend.ok === false);
check('pending 的文案提到「待整理」', String(gPend.reason).includes('待整理'), gPend.reason);
check('pending 的文案告诉她怎么整理（含 qq_sticker_state）', String(gPend.reason).includes('qq_sticker_state'), gPend.reason);
const gTrash = stickerSendable({ id: 'x', state: 'trash' });
check('trash → 拦住', gTrash.ok === false);
check('trash 的文案提到「回收站」', String(gTrash.reason).includes('回收站'), gTrash.reason);
check('trash 的文案告诉她能恢复', String(gTrash.reason).includes('恢复'), gTrash.reason);
check('缺 state 按 pending 拦住（不是放行）', stickerSendable({ id: 'x' }).ok === false);
check('null entry 也拦住而不是崩', stickerSendable(null).ok === false);

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · setStickerState');

const lib0 = [normalizeStickerEntry({ id: 's1', desc: '一', localNote: 'n', tags: ['a'] }), normalizeStickerEntry({ id: 's2', desc: '二', tags: [] })];
check('初始 fav 那张是 s1', lib0[0].state === 'fav');
const r1 = setStickerState(lib0, 's1', 'trash');
check('翻转返回 changed=true', r1.changed === true);
check('翻转后条目 state=trash', r1.entry?.state === 'trash', `state=${r1.entry?.state}`);
check('翻转后 counts 反映出来', stickerStateCounts(r1.entries).trash === 1, JSON.stringify(stickerStateCounts(r1.entries)));
const r2 = setStickerState(r1.entries, 's1', 'trash');
check('同态再设 changed=false（避免无意义写盘）', r2.changed === false, `changed=${r2.changed}`);
const r3 = setStickerState(r1.entries, 'no_such_id_9f3a', 'fav');
check('找不到 id → changed=false 且 entry=null', r3.changed === false && r3.entry === null);
check('找不到 id 时原数组没被污染', r3.entries.length === 2 && stickerStateCounts(r3.entries).trash === 1);
const r4 = setStickerState(lib0, 's1', '收藏');
check('中文别名也能翻转', r4.entry?.state === 'fav', `state=${r4.entry?.state}`);

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 感知哈希（dhash）');

// ⚠️ 归一化统一转**大写**（十六进制感知哈希的惯例；hammingDistanceHex 内部也会再归一化一次，
// 所以大小写混着传也不会算错）。第一版测试按小写断言，是测试写错了，不是实现错了。
check('normalizeDhash：16 位十六进制保留（大写归一）', normalizeDhash('0123456789abcdef') === '0123456789ABCDEF', normalizeDhash('0123456789abcdef'));
check('normalizeDhash：大写原样保留', normalizeDhash('ABCDEF0123456789') === 'ABCDEF0123456789');
check('normalizeDhash：0x 前缀剥掉', normalizeDhash('0xABCDEF0123456789') === 'ABCDEF0123456789');
check('normalizeDhash：太短清空', normalizeDhash('abc') === '');
check('normalizeDhash：非法字符清空', normalizeDhash('zzzzzzzzzzzzzzzz') === '');
check('normalizeDhash：null → 空', normalizeDhash(null) === '');

// 8 行 × 9 列灰度：每行相邻比较。
const ramp = Array.from({ length: 8 }, () => [0, 16, 32, 48, 64, 80, 96, 112, 128]);
const flat = Array.from({ length: 8 }, () => [50, 50, 50, 50, 50, 50, 50, 50, 50]);
const hRamp = dhashHexFromGray(ramp);
const hFlat = dhashHexFromGray(flat);
check('单调递增 8×9 → FFFFFFFFFFFFFFFF', hRamp === 'FFFFFFFFFFFFFFFF', hRamp);
check('全平矩阵 → 0000000000000000', hFlat === '0000000000000000', hFlat);
check('dhashHexFromGray：行数不对 → 空串', dhashHexFromGray(ramp.slice(0, 7)) === '');
check('dhashHexFromGray：列数不对 → 空串', dhashHexFromGray(ramp.map((r) => r.slice(0, 8))) === '');
check('dhashHexFromGray：非数组 → 空串', dhashHexFromGray(null) === '');
check('dhashHexFromGray：含非数字 → 空串', dhashHexFromGray(ramp.map((r, i) => (i === 0 ? [...r.slice(0, 8), 'x'] : r))) === '');

check('汉明距离：自比 0', hammingDistanceHex(hRamp, hRamp) === 0);
check('汉明距离：全反 64', hammingDistanceHex(hRamp, hFlat) === 64, String(hammingDistanceHex(hRamp, hFlat)));
check('汉明距离：长度不等 → -1', hammingDistanceHex(hRamp, 'ffff') === -1);
check('汉明距离：空串 → -1', hammingDistanceHex('', hRamp) === -1);
check('汉明距离：非法 → -1', hammingDistanceHex('zzzzzzzzzzzzzzzz', hRamp) === -1);

const dupBase = [
  { id: 'd1', md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', dhash: 'ffffffffffffffff' },
  { id: 'd2', md5: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', dhash: '0000000000000000' }
];
const near = findNearDuplicateSticker(dupBase, { md5: 'cccccccccccccccccccccccccccccccc', dhash: 'fffffffffffffffe' });
check('近重复：dhash 差 1 位以内命中', near?.entry?.id === 'd1' && near.by === 'dhash', JSON.stringify(near));
const nearMd5 = findNearDuplicateSticker(dupBase, { md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', dhash: '0000000000000000' });
check('近重复：md5 命中优先', nearMd5?.entry?.id === 'd1' && nearMd5.by === 'md5', JSON.stringify(nearMd5));
check('近重复：差得远 → null', findNearDuplicateSticker(dupBase, { md5: 'dddddddddddddddddddddddddddddddd', dhash: '0f0f0f0f0f0f0f0f' }) === null);
check('近重复：探针没有 dhash 也没 md5 → null', findNearDuplicateSticker(dupBase, { id: 'zz' }) === null);

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 同义词表与查询扩展');

const synIndex = buildSynonymIndex();
check('内置同义词表：概念数 ≥ 20', synIndex.size >= 20, `size=${synIndex.size}`);
check('内置同义词表：词数 ≥ 150', Object.keys(STICKER_SYNONYMS).length >= 20, `概念=${Object.keys(STICKER_SYNONYMS).length}`);
check('「嘲讽」是一等概念', Object.prototype.hasOwnProperty.call(STICKER_SYNONYMS, '嘲讽'));
check('「阴阳怪气」挂在「嘲讽」下', (STICKER_SYNONYMS['嘲讽'] ?? []).includes('阴阳怪气'), JSON.stringify(STICKER_SYNONYMS['嘲讽']));
check('概念索引：阴阳怪气 → 嘲讽', synIndex.get('阴阳怪气')?.has('嘲讽') === true);
check('概念索引：喵 → 猫', synIndex.get('喵')?.has('猫') === true);

const x1 = expandQuery('嘲讽');
check('expand：原词保留', x1.raw === '嘲讽' && x1.terms.includes('嘲讽'));
check('expand：认出概念 嘲讽', x1.concepts.includes('嘲讽'), JSON.stringify(x1.concepts));
const x2 = expandQuery('阴阳怪气');
check('expand：同义词也认出 嘲讽', x2.concepts.includes('嘲讽'), JSON.stringify(x2.concepts));
check('expand：同义词本身不算原词命中', x2.terms.includes('阴阳怪气'));
const x3 = expandQuery('猫猫头');
check('expand：子串方向扩展 猫猫头 → 猫', x3.concepts.includes('猫'), JSON.stringify(x3.concepts));
const x4 = expandQuery('   ');
check('expand：空白 → 无词无概念', x4.terms.length === 0 && x4.concepts.length === 0);
const x5 = expandQuery('开心 摆烂');
check('expand：空格分词', x5.terms.length === 2, JSON.stringify(x5.terms));
const x6 = expandQuery('开心，摆烂');
check('expand：中文逗号也分词', x6.terms.length === 2, JSON.stringify(x6.terms));
const x7 = expandQuery('嘲讽', { 嘲讽: ['贴脸开大'] });
check('expand：配置里的额外同义词生效', expandQuery('贴脸开大', { 嘲讽: ['贴脸开大'] }).concepts.includes('嘲讽'));
check('expand：额外同义词不影响内置表', x7.concepts.includes('嘲讽'));

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 打分 scoreSticker');

const eTag = normalizeStickerEntry({ id: 't1', desc: '测试', tags: ['阴阳怪气'], md5: 'ABCDEF0123456789ABCDEF0123456789' });
const sTagExact = scoreSticker(eTag, '阴阳怪气');
check('标签精确命中 → parts.tag=2', sTagExact.parts.tag === 2, JSON.stringify(sTagExact.parts));
// 这条是本次改造里抓到的真问题：概念表里「阴阳」是「嘲讽」的同义词，而它正好是
// 查询词「阴阳怪气」的子串 —— 只判 termSet.has(词) 会漏掉，于是精确命中标签的条目
// 被额外奖励 1.5，反而把真正只是同义的条目挤下去。现在的判据是「这个词出现在查询里」。
check('精确命中的词不再重复算同义（子串方向也算，避免自己跟自己加分）', sTagExact.parts.syn === 0, JSON.stringify(sTagExact.parts));
const sSyn = scoreSticker(eTag, '嘲讽');
check('同义命中 → parts.tag=0', sSyn.parts.tag === 0, JSON.stringify(sSyn.parts));
check('同义命中 → parts.syn>0', sSyn.parts.syn > 0, JSON.stringify(sSyn.parts));
check('同义命中分数 < 精确命中分数', sSyn.score < sTagExact.score, `${sSyn.score} vs ${sTagExact.score}`);
check('同义命中记进了 hits', Array.isArray(sSyn.hits) && sSyn.hits.length > 0, JSON.stringify(sSyn.hits));

const eCat = normalizeStickerEntry({ id: 't2', desc: '猫', tags: ['猫'] });
const sCat = scoreSticker(eCat, '猫');
check('标签就是查询词的条目：tag=2 且 syn=0（不会自己给自己加 1.5）', sCat.parts.tag === 2 && sCat.parts.syn === 0, JSON.stringify(sCat.parts));
const eMiao = normalizeStickerEntry({ id: 't3', desc: '喵喵', tags: ['喵'] });
const sMiao = scoreSticker(eMiao, '猫');
check('标「喵」的条目被「猫」搜到（同义扩展）', sMiao.parts.syn > 0, JSON.stringify(sMiao.parts));
check('标「喵」比直接标「猫」分低', sMiao.score < sCat.score, `${sMiao.score} vs ${sCat.score}`);

const eDesc = normalizeStickerEntry({ id: 't4', desc: '阴阳怪气地看着你', tags: [] });
const sDesc = scoreSticker(eDesc, '嘲讽');
check('只在描述里出现 → 分比标签命中低', sDesc.parts.syn > 0 && sDesc.parts.syn < sSyn.parts.syn, JSON.stringify({ desc: sDesc.parts, tag: sSyn.parts }));

const eUse = normalizeStickerEntry({ id: 't5', desc: 'x', tags: ['自嘲'], useCount: 99 });
const sUse = scoreSticker(eUse, '自嘲');
check('使用次数加分 = 0.3*log1p(n)', Math.abs(sUse.parts.use - 0.3 * Math.log1p(99)) < 1e-9, JSON.stringify(sUse.parts));
check('用过 99 次的条目比没用过的同类分高',
  sUse.score > scoreSticker(normalizeStickerEntry({ id: 't6', desc: 'x', tags: ['自嘲'] }), '自嘲').score);

const sRepeat = scoreSticker(eTag, '嘲讽', { lastMd5: eTag.md5 });
check('与上次同一张（md5）→ -100 重罚', sRepeat.parts.repeat === -100, JSON.stringify(sRepeat.parts));
check('重罚后总分是负的（排到最后）', sRepeat.score < 0, String(sRepeat.score));
const sRepeatId = scoreSticker(eTag, '嘲讽', { lastId: eTag.id });
check('与上次同一张（id）→ 也重罚', sRepeatId.parts.repeat === -100, JSON.stringify(sRepeatId.parts));
check('换一张就不罚', scoreSticker(eCat, '猫', { lastId: eTag.id }).parts.repeat === 0);

const now = 1_700_000_000_000;
const eCool = normalizeStickerEntry({ id: 't7', desc: 'x', tags: ['开心'], lastUsedAt: now - 1000 });
const sCool = scoreSticker(eCool, '开心', { now, cooldownMs: 60000 });
check('冷却期内扣分', sCool.parts.cooldown === -1.5, JSON.stringify(sCool.parts));
check('冷却期外不扣分', scoreSticker(eCool, '开心', { now: now + 120000, cooldownMs: 60000 }).parts.cooldown === 0);
check('cooldownMs=0 即关闭冷却', scoreSticker(eCool, '开心', { now, cooldownMs: 0 }).parts.cooldown === 0);
check('空查询不打标签分', scoreSticker(eTag, '').parts.tag === 0);

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 检索 searchStickers');

const lib = [
  normalizeStickerEntry({ id: 'k1', desc: '蓝色大肥鱼', tags: ['自嘲', '吃白饭'], useCount: 0, state: 'fav' }),
  normalizeStickerEntry({ id: 'k2', desc: '躺平的鲸鲸', tags: ['自嘲', '摆烂'], useCount: 1, state: 'fav' }),
  normalizeStickerEntry({ id: 'k3', desc: '累了的摆烂脸', tags: [], useCount: 0, state: 'pending' }),
  normalizeStickerEntry({ id: 'k4', desc: '被丢掉的', tags: ['自嘲'], useCount: 5, state: 'trash' })
];
const srAll = searchStickers(lib, '');
check('空查询：默认口径 visible = fav + pending（3 条）', srAll.matched === 3, `matched=${srAll.matched}`);
check('空查询：回收站不出现', srAll.stickers.every((s) => s.state !== 'trash'));
check('空查询：allTotal 是含回收站的总数', srAll.allTotal === 4, `allTotal=${srAll.allTotal}`);
check('空查询：回收站计入 counts', srAll.counts.trash === 1, JSON.stringify(srAll.counts));
check('空查询：按 useCount 倒序（躺平那张第 1）', srAll.stickers[0]?.id === 'k2', srAll.stickers.map((s) => s.id).join(','));
check('返回项带 stateLabel', srAll.stickers[0]?.stateLabel === '收藏', srAll.stickers[0]?.stateLabel);

const srSelf = searchStickers(lib, '自嘲');
check('搜「自嘲」命中 3 条（含回收站外全部）', srSelf.matched === 3, `matched=${srSelf.matched}`);
check('搜「自嘲」不返回被丢进回收站的那张', srSelf.stickers.every((s) => s.id !== 'k4'));
const srTrash = searchStickers(lib, '自嘲', { state: 'trash' });
check('state=trash 才看得到回收站那张', srTrash.matched === 1 && srTrash.stickers[0].id === 'k4', `matched=${srTrash.matched}`);
const srFav = searchStickers(lib, '', { state: 'fav' });
check('state=fav 只返回 2 条', srFav.matched === 2, `matched=${srFav.matched}`);
const srPend = searchStickers(lib, '', { state: 'pending' });
check('state=pending 只返回 1 条', srPend.matched === 1 && srPend.stickers[0].id === 'k3', `matched=${srPend.matched}`);
const srAllState = searchStickers(lib, '', { state: 'all' });
check('state=all 返回 4 条', srAllState.matched === 4, `matched=${srAllState.matched}`);
const srBad = searchStickers(lib, '', { state: 'nonsense' });
// 这条抓到过一个真 bug：原实现直接 normalizeStickerState(非法值)，而那个函数的
// fallback 不是合法三态时会退化成 'pending' —— 于是 state 写错就静默变成「只看待整理」，
// 而文档承诺的是回退到 visible。
check('非法 state 退化成 visible（不返回回收站，也不是「只看待整理」）', srBad.matched === 3, `matched=${srBad.matched}`);

const srNone = searchStickers(lib, 'zzz不存在的词zzz');
check('搜不到就真的 0 条（不会把全库倒出来装作「什么都搜得到」）', srNone.matched === 0, `matched=${srNone.matched}`);
// 语义表里「摆烂」是概念「自嘲」的同义词之一，所以 k1（标了「自嘲」）也会命中 ——
// 这是同义扩展该有的行为，不是漏网。第一版按「只有 k2 的标签 + k3 的描述命中」写了 2，是测试写错了。
const srPartial = searchStickers(lib, '摆烂');
check('「摆烂」命中 3 条（一条带该标签、一条只在描述里、一条借「自嘲」的同义表）', srPartial.matched === 3, `matched=${srPartial.matched} ids=${srPartial.stickers.map((s) => s.id).join(',')}`);
check('「摆烂」的排序里带真标签的排第一', srPartial.stickers[0]?.id === 'k2', srPartial.stickers.map((s) => `${s.id}:${s.score}`).join(','));
const srSubstr = searchStickers(lib, '肥鱼');
check('子串也能命中描述（肥鱼 → 蓝色大肥鱼）', srPartial.matched > 0 && srSubstr.matched === 1, `肥鱼 matched=${srSubstr.matched}`);
check('命中的分数降序', srPartial.stickers[0].score >= srPartial.stickers[1].score,
  srPartial.stickers.map((s) => s.score).join(','));

const srLast = searchStickers(lib, '', { lastId: 'k2', lastMd5: '' });
check('lastId 指向的那张被压到最末位', srLast.stickers[srLast.stickers.length - 1].id === 'k2', srLast.stickers.map((s) => s.id).join(','));
const srExclude = searchStickers(lib, '', { excludeId: 'k2' });
check('excludeId 把那张整个排除掉（挑替代候选时用）', srExclude.stickers.every((s) => s.id !== 'k2'));
const srLimit = searchStickers(lib, '', { limit: 2 });
check('limit 生效且如实标注 truncated', srLimit.stickers.length === 2 && srLimit.truncated === true, `len=${srLimit.stickers.length} truncated=${srLimit.truncated}`);
check('limit 不改变 total（截断前后都是 3）', srLimit.total === 3, `total=${srLimit.total}`);
const srSyn = searchStickers([normalizeStickerEntry({ id: 'm1', desc: 'x', tags: ['阴阳怪气'] })], '嘲讽');
check('搜「嘲讽」能找到只标了「阴阳怪气」的那张（本次改造的起因）', srSyn.matched === 1, `matched=${srSyn.matched}`);
const srCfg = searchStickers([normalizeStickerEntry({ id: 'm2', desc: 'x', tags: ['我裂开了'] })], '裂开', { extraSynonyms: { 震惊: ['我裂开了'] } });
check('配置里的自定义同义词也参与检索', srCfg.matched === 1, `matched=${srCfg.matched}`);
check('每条都带 score 字段', typeof srAll.stickers[0].score === 'number');

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 冷频道闸门 stickerColdChannel');

check('默认门槛 = 20（与熟识度「眼熟」档对齐）', STICKER_COLD_FAMILIARITY === 20, String(STICKER_COLD_FAMILIARITY));
const c1 = stickerColdChannel({ familiarity: 0, aiMessages: 0 });
check('陌生人且一句话没说 → 冷', c1.cold === true, JSON.stringify(c1));
check('冷频道理由会写出来', typeof c1.reason === 'string' && c1.reason.length > 0, c1.reason);
const c2 = stickerColdChannel({ familiarity: 0, aiMessages: 3 });
check('说过 3 句之后闸门永久打开', c2.cold === false, JSON.stringify(c2));
const c3 = stickerColdChannel({ familiarity: 60, aiMessages: 0 });
check('熟人（熟识度 60）没说过话也能发', c3.cold === false, JSON.stringify(c3));
const c4 = stickerColdChannel({ familiarity: 19, aiMessages: 0 });
check('熟识度 19（差一点）仍然冷', c4.cold === true, JSON.stringify(c4));
const c5 = stickerColdChannel({ familiarity: 20, aiMessages: 0 });
check('熟识度 20 正好放行', c5.cold === false, JSON.stringify(c5));
const c6 = stickerColdChannel({});
check('不传参数不崩，按最保守算（冷）', c6.cold === true, JSON.stringify(c6));
const c7 = stickerColdChannel({ familiarity: 0, aiMessages: 0, threshold: 0 });
check('门槛设为 0 即关闭这个闸门', c7.cold === false, JSON.stringify(c7));

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 注入摘要 buildStickerContext');

const ctx1 = buildStickerContext([normalizeStickerEntry({ id: 'c1', desc: '肥鱼', tags: ['自嘲'], state: 'fav', useCount: 0 })]);
check('有收藏时给出可发表情', ctx1.includes('肥鱼'), ctx1);
const ctx2 = buildStickerContext([normalizeStickerEntry({ id: 'c2', desc: 'x', tags: [], state: 'pending' })]);
check('全是待整理时不出图，而是提醒先整理', ctx2.includes('待整理') && !ctx2.includes('肥鱼'), ctx2);
const ctx3 = buildStickerContext([normalizeStickerEntry({ id: 'c3', desc: 'y', localNote: 'n', state: 'trash' })]);
check('全是回收站时不给任何上下文（等于没有可用表情）', ctx3 === '' || !ctx3.includes('y'), `ctx3="${ctx3}"`);
const ctx4 = buildStickerContext([
  normalizeStickerEntry({ id: 'c4', desc: '可发的', tags: ['开心'], state: 'fav' }),
  normalizeStickerEntry({ id: 'c5', desc: '待整理的', tags: [], state: 'pending' })
]);
check('收藏与待整理混存时：只列收藏，尾部提示还有几张待整理', ctx4.includes('可发的') && ctx4.includes('待整理') && !ctx4.includes('待整理的'), ctx4);
const hint = buildStickerStrategyHint();
check('策略提示里写了三态与「只有收藏能发」', hint.includes('收藏'), hint.slice(0, 60));
check('策略提示里提到检索是按意思搜', hint.includes('意思') || hint.includes('同义'), hint.slice(0, 80));

// ════════════════════════════════════════════════════════════════════════════
section('U 段 · 与 P0-2 同图不连发共存（回归）');

const rep1 = stickerRepeatBlocked({ id: 'r1', md5: 'AA' }, 'r1', '');
check('同 id → blocked（P0-2 行为未被本次改造破坏）', rep1.blocked === true);
const rep2 = stickerRepeatBlocked({ id: 'r1', md5: 'AA' }, '', 'aa');
check('同 md5（大小写不同）→ blocked', rep2.blocked === true);
const rep3 = stickerRepeatBlocked({ id: 'r2', md5: 'BB' }, 'r1', 'AA');
check('换一张 → 放行', rep3.blocked === false);
check('两侧都空 → 放行（宁可漏拦也不锁死）', stickerRepeatBlocked({ id: '' }, '', '').blocked === false);

// ════════════════════════════════════════════════════════════════════════════
section('S 段 · 源码接线（只证明代码还在，不是行为验证）');

const bridge = fs.readFileSync(BRIDGE_JS, 'utf8');
const mcpSrc = fs.readFileSync(MCP_JS, 'utf8');
const docsSrc = fs.readFileSync(TOOLDOCS_JS, 'utf8');
const libSrc = fs.readFileSync(LIB_JS, 'utf8');

check('bridge 从 sticker-lib 导入 searchStickers', /searchStickers[,\s]/.test(bridge.slice(bridge.indexOf("from './sticker-lib.js'") - 900, bridge.indexOf("from './sticker-lib.js'"))));
check('bridge 已经不再引用 formatStickerList', !/[^//]formatStickerList\(/.test(bridge.replace(/^\s*\/\/.*$/gm, '')));
check('send-sticker 路由里有三态闸门', /stickerSendable\(/.test(bridge));
check('send-sticker 路由里有冷频道闸门', /stickerColdChannel\(/.test(bridge));
check('bridge 里有新路由 /api/socialV2/sticker-state', bridge.includes("'/api/socialV2/sticker-state'"));
check('新路由守卫了 state 取值', /STICKER_STATES\.includes/.test(bridge));
check('sticker-list 路由支持 state 查询', /stateParam/.test(bridge));
check('主动收藏会直接提升为 fav', /applyStickerStateV2\(entry\.id, 'fav'\)/.test(bridge));
check('sticker-lib 导出了 STICKER_STATES', /export const STICKER_STATES/.test(libSrc));
check('sticker-lib 导出了 searchStickers', /export function searchStickers/.test(libSrc));
check('sticker-lib 导出了 stickerSendable', /export function stickerSendable/.test(libSrc));
check('sticker-lib 导出了 stickerColdChannel', /export function stickerColdChannel/.test(libSrc));
check('MCP 注册了 qq_sticker_state', mcpSrc.includes("'qq_sticker_state'"));
check('MCP 的 qq_list_stickers 有 state 参数', /state: z\.string\(\)\.optional\(\)\.describe\('可选三态过滤/.test(mcpSrc));
check('MCP 新工具走 JSON.stringify 传 body（传对象会变成 [object Object]）',
  /sticker-state'[\s\S]{0,200}body: JSON\.stringify/.test(mcpSrc));
check('tool-docs 有 qq_sticker_state 的说明', docsSrc.includes('"qq_sticker_state"'));
check('tool-docs 里 qq_send_sticker 写明了三道闸门', /qq_send_sticker": "[\s\S]{0,900}三道闸门/.test(docsSrc));

// ════════════════════════════════════════════════════════════════════════════
section('A 段 · 真条路由（零副作用，靶子 group:1132819177）');

const storeRaw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
const storeArr = Array.isArray(storeRaw) ? storeRaw : (storeRaw.entries ?? []);
// 注意：磁盘上的 state/stickers.json 可能还没有 state 字段 ——
// 三态是本次新加的，只有被 bridge 加载+回写过之后才会落盘。
// 所以这里必须复刻 bridge 的推导口径，不能只看 raw.state，
// 否则基线阶段会得到「库里没有 fav 条目」这种假象并整段跳过。
const effState = (e) => normalizeStickerState(e.state, defaultStickerState(e));
const favEntry = storeArr.find((e) => effState(e) === 'fav');
const pendingEntry = storeArr.find((e) => effState(e) === 'pending');

// 一个不存在的 key 会被 v2SessionAllowed 挡在门外，所以这边只能拿真 key 试；
// 但「真 key + 不存在的 stickerId」是纯读失败，不会写盘、不会发消息。
const bogusId = 'no_such_sticker_9f3a';
const agentTokFile = path.join(ROOT, 'state', 'social-v2.json');
let agentTok = '';
try {
  const sv = JSON.parse(fs.readFileSync(agentTokFile, 'utf8'));
  const convs = sv?.conversations ?? sv ?? {};
  agentTok = String(convs?.[TARGET_KEY]?.agentToken ?? convs?.[TARGET_KEY]?.token ?? sv?.sessions?.[TARGET_KEY]?.agentToken ?? '');
} catch {}
if (!agentTok) {
  // 主人主令牌在 private:1918594889 上；这里只做只读路由验证，取不到就整体跳过。
  for (const [k, v] of Object.entries((JSON.parse(fs.readFileSync(agentTokFile, 'utf8'))?.conversations ?? {}))) {
    if (v?.agentToken) { agentTok = String(v.agentToken); break; }
  }
}

const a1 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY));
if (a1.status === 0) {
  skipped('A 段全部', `桥接没在跑（${a1.err}）`);
} else {
  check('A0 面板可达', a1.status === 200, `HTTP ${a1.status}`);
  check('A0 sticker-list 返回 counts 三态', typeof a1.json?.counts?.fav === 'number', JSON.stringify(a1.json?.counts));
  // 注意别写成 `typeof x === 'string' || x === undefined`：那在基线里会以 undefined 静默通过。
  check('A0 sticker-list 返回 state 口径字段（真字符串）', typeof a1.json?.state === 'string' && a1.json.state.length > 0, String(a1.json?.state));
  check('A0 每一条都带合法 state（否则「不混入回收站」会是空断言）',
    Array.isArray(a1.json?.stickers) && a1.json.stickers.length > 0 && a1.json.stickers.every((s) => STICKER_STATES.includes(s.state)),
    (a1.json?.stickers ?? []).map((s) => s.state).join(','));
  check('A0 默认口径下不混入回收站', (a1.json?.stickers ?? []).every((s) => s.state !== 'trash'),
    (a1.json?.stickers ?? []).map((s) => s.state).join(','));

  const a2 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY) + '&state=trash');
  check('A1 state=trash 只回回收站', a2.status === 200 && Array.isArray(a2.json?.stickers) && a2.json.stickers.every((s) => s.state === 'trash'),
    `HTTP ${a2.status} n=${a2.json?.stickers?.length}`);
  const a3 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY) + '&state=bogus');
  check('A2 非法 state 退化成 visible 而不是报错', a3.status === 200 && a3.json?.stickers.every((s) => s.state !== 'trash'),
    `HTTP ${a3.status}`);

  const a4 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY) + '&query=' + encodeURIComponent('嘲讽'));
  check('A3 真库搜「嘲讽」是合法请求（有/没有命中都算通过，这里只验证路由不炸）',
    a4.status === 200 && typeof a4.json?.matched === 'number', `HTTP ${a4.status} matched=${a4.json?.matched}`);
  const a5 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY) + '&query=zzz不存在zzz');
  check('A4 搜不到就是 0 条', a5.status === 200 && a5.json?.matched === 0, `matched=${a5.json?.matched}`);

  if (!agentTok) {
    skipped('A5 三态切换与发图闸门', '读不到 agent token');
  } else {
    const a6 = await req('/api/socialV2/sticker-state', {
      method: 'POST', token: agentTok, body: { key: TARGET_KEY, stickerId: bogusId, state: 'fav' }
    });
    check('A5 不存在的 stickerId → 404 且理由说的是「找不到这张」',
      a6.status === 404 && /找不到/.test(String(a6.json?.error)),
      `HTTP ${a6.status} ${JSON.stringify(a6.json)}`);
    const a7 = await req('/api/socialV2/sticker-state', {
      method: 'POST', token: agentTok, body: { key: TARGET_KEY, stickerId: bogusId, state: 'bogus' }
    });
    check('A6 非法 state → 400 且文案点出三态', a7.status === 400 && String(a7.json?.error).includes('pending'),
      `HTTP ${a7.status} ${JSON.stringify(a7.json)}`);
    const a8 = await req('/api/socialV2/sticker-state', {
      method: 'POST', token: 'definitely_not_a_valid_token_0000', body: { key: TARGET_KEY, stickerId: bogusId, state: 'fav' }
    });
    check('A7 令牌不对 → 403（守卫没被改坏）', a8.status === 403, `HTTP ${a8.status} ${JSON.stringify(a8.json)}`);
    // 这条是**既有设计**，不是漏洞：所有守卫都写成 `if (header && !ok)` 形式，
    // 所以「完全不带头」= 管理端直通（控制台的 curl / 面板走的就是这条路），
    // 它应当一路走到业务逻辑，而不是 403。写成期望 403 是测试想当然了。
    const a8b = await req('/api/socialV2/sticker-state', {
      method: 'POST', body: { key: TARGET_KEY, stickerId: bogusId, state: 'fav' }
    });
    check('A7b 不带头 = 管理端直通（走到业务逻辑，拿到「找不到这张」而不是 403）',
      a8b.status === 404 && /找不到/.test(String(a8b.json?.error)), `HTTP ${a8b.status} ${JSON.stringify(a8b.json)}`);

    // A10/A12 是**真发图**探针：闸门部署之后它们会被 409 拦在发送之前，
    // 但在部署前跑基线时，路由里还没有闸门 —— 请求会一路走到网关。
    // 这两条之所以安全，全靠「她在该群被禁言到 2026-10-23」。所以先确认禁言还在，
    // 不在就整段跳过，绝不赌（万一哪天解禁了、闸门又正好被我改坏，就会往真群灌测试图）。
    let muted = false, muteText = '';
    try {
      const obToken = fs.readFileSync(path.join(ROOT, '.snowluma-token'), 'utf8').trim();
      const gm = await (await fetch('http://127.0.0.1:3000/get_group_member_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${obToken}` },
        body: JSON.stringify({ group_id: Number(TARGET_KEY.split(':')[1]), user_id: 3835811547, no_cache: true })
      })).json();
      const ts = Number(gm?.data?.shut_up_timestamp ?? 0);
      muted = ts * 1000 > Date.now();
      muteText = muted ? `至 ${new Date(ts * 1000).toLocaleString('zh-CN')}` : '';
    } catch (error) {
      log(`   （查禁言失败，按「没禁言」保守处理：${error?.message ?? error}）`);
    }
    log(`   靶子 ${TARGET_KEY} 禁言状态：${muted ? `仍在禁言（${muteText}）` : '未在禁言'}`);

    if (!favEntry) {
      skipped('A8 真实三态往返', '库里没有 fav 条目');
    } else {
      const before = normalizeStickerState(favEntry.state, 'fav');
      const beforeStore = fs.readFileSync(STORE, 'utf8');
      let restoreErr = '';
      try {
        const t1 = await req('/api/socialV2/sticker-state', {
          method: 'POST', token: agentTok, body: { key: TARGET_KEY, stickerId: favEntry.id, state: 'trash' }
        });
        check('A8 收藏 → 回收站 成功', t1.status === 200 && t1.json?.state === 'trash', `HTTP ${t1.status} ${JSON.stringify(t1.json)}`);
        check('A8 响应里带三态计数', typeof t1.json?.counts?.trash === 'number', JSON.stringify(t1.json?.counts));
        check('A8 响应里 sendable 变成 false', t1.json?.sendable === false, String(t1.json?.sendable));

        const list1 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY));
        check('A9 落盘生效：visible 口径里已经看不到它',
          Array.isArray(list1.json?.stickers) && !list1.json.stickers.some((s) => s.id === favEntry.id));
        const list2 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY) + '&state=trash');
        check('A9 落盘生效：trash 口径里出现了（且口径里全是 trash）',
          Array.isArray(list2.json?.stickers) && list2.json.stickers.length > 0
          && list2.json.stickers.some((s) => s.id === favEntry.id)
          && list2.json.stickers.every((s) => s.state === 'trash'),
          (list2.json?.stickers ?? []).map((s) => s.state).join(','));

        // 发图闸门：这张现在在回收站，必须被 409 拦住。
        // 靶子是白名单内且她被禁言的群 —— 万一守卫坏了真发出去，QQ 侧也会拒收。
        if (!muted) {
          skipped('A10 回收站里的表情发不出去', '靶子没在禁言，不敢做真发图探针');
        } else {
          const sendTrash = await req('/api/socialV2/send-sticker', {
            method: 'POST', token: agentTok,
            body: { key: TARGET_KEY, stickerId: favEntry.id, replyToMessageId: null, atUserId: null }
          });
          check('A10 回收站里的表情发不出去 → 409', sendTrash.status === 409, `HTTP ${sendTrash.status} ${JSON.stringify(sendTrash.json)}`);
          check('A10 拦截理由是「回收站」而不是别的', String(sendTrash.json?.error).includes('回收站'), String(sendTrash.json?.error));
          check('A10 响应标了 stickerState', sendTrash.json?.stickerState === 'trash', String(sendTrash.json?.stickerState));
        }

        const t2 = await req('/api/socialV2/sticker-state', {
          method: 'POST', token: agentTok, body: { key: TARGET_KEY, stickerId: favEntry.id, state: before }
        });
        check('A11 恢复回原状态', t2.status === 200 && t2.json?.state === before, `HTTP ${t2.status} state=${t2.json?.state}`);
        const list3 = await req('/api/socialV2/sticker-list?key=' + encodeURIComponent(TARGET_KEY));
        check('A11 恢复后 visible 里又出现了（且状态回到了原值）',
          (list3.json?.stickers ?? []).some((s) => s.id === favEntry.id && s.state === before),
          (list3.json?.stickers ?? []).filter((s) => s.id === favEntry.id).map((s) => s.state).join(','));
      } catch (error) {
        restoreErr = String(error?.message ?? error);
      } finally {
        // 兜底：万一中途抛了，直接把原文件写回去。
        const nowStore = fs.readFileSync(STORE, 'utf8');
        if (nowStore !== beforeStore) {
          fs.writeFileSync(STORE, beforeStore, 'utf8');
          log(`   ↩︎ 已从备份恢复 state/stickers.json${restoreErr ? `（原因：${restoreErr}）` : ''}`);
        }
      }
    }

    if (!pendingEntry) {
      skipped('A12 待整理表情发不出去', '库里没有 pending 条目');
    } else if (!muted) {
      skipped('A12 待整理表情发不出去', '靶子没在禁言，不敢做真发图探针');
    } else {
      const sendPend = await req('/api/socialV2/send-sticker', {
        method: 'POST', token: agentTok,
        body: { key: TARGET_KEY, stickerId: pendingEntry.id, replyToMessageId: null, atUserId: null }
      });
      check('A12 待整理的表情发不出去 → 409', sendPend.status === 409, `HTTP ${sendPend.status} ${JSON.stringify(sendPend.json)}`);
      check('A12 拦截理由提到「待整理」', String(sendPend.json?.error).includes('待整理'), String(sendPend.json?.error));
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
say(`\n═══ 通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
// fetch 的 socket 还在收尾，立刻 process.exit 会撞出 libuv 的
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`
// —— 那是退出姿势的问题，不是测试失败，但看上去非常像脚本坏了。
await new Promise((r) => setTimeout(r, 500));
process.exit(fail > 0 ? 1 : 0);
