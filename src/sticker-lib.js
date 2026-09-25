// 表情包体系（二代仿真模式）——本地表情知识库与策略提示纯函数。
//
// 职责：
// - state/stickers.json 的读写与字段归一化
// - 把 SnowLuma `fetch_custom_face_detail` 返回的 QQ 收藏表情合并进本地库
// - 支持按 emoji_id / md5 / url 查找、按备注/本地笔记/标签搜索
// - 生成注入 AI 的“表情包策略/可用表情”摘要
//
// 设计原则：
// - QQ 账号的收藏表情是“源”，本地库是“AI 认知层”：保留 AI 学习到的含义/标签/使用次数，
//   不覆盖 QQ 的备注；QQ desc 为空时 AI 可以看图后用 qq_sticker_note 记录自己的理解。
// - 所有文本只做展示/提示，不执行任何本地操作。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  // P1-5 三态：state 缺失时按「有没有被整理过」推默认值（见 defaultStickerState），
  // 这样老库里那批已经写过备注/标签的条目一次性迁成「收藏」，不必写迁移脚本。
  const state = normalizeStickerState(
    entry.state,
    defaultStickerState({ localNote: entry.localNote, tags, usage: entry.usage, useCount: entry.useCount })
  );
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso()),
    state,
    dhash: normalizeDhash(entry.dhash)
  };
}

export function loadStickerStore(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 把 SnowLuma 返回的 QQ 收藏表情详情合并进本地库。
// 保留本地 AI 认知字段（localNote/tags/usage/useCount/lastUsedAt/lastContext），
// 只更新 QQ 侧字段（id/resId/url/md5/desc）。
export function mergeStickerLibrary(existing, fetched, { complete = true } = {}) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
      byId.set(id, merged);
    }
  }
  // 清理已被 QQ 端删除的收藏表情（保留手动/本地新增的非 qq 来源条目）。
  // count 限制导致的部分结果不能证明其他表情已被删除。
  return out.filter((e) => !complete || e.source !== 'qq' || fetchedIds.has(e.id));
}

function stickerUrlKey(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw) && !/^[^\s/]+\/[^\s]*$/.test(raw)) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

// id/md5 精确匹配优先；URL 只忽略协议、尾斜杠与查询参数，不做任意子串匹配。
export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const id = raw;
  const md5 = raw.toUpperCase();
  const list = Array.isArray(entries) ? entries : [];
  const exact = list.find((e) => {
    if (!e) return false;
    if (e.id === id || e.resId === id) return true;
    if (e.md5 && e.md5 === md5) return true;
    return false;
  });
  if (exact) return exact;
  const urlNormalized = stickerUrlKey(raw);
  return (urlNormalized && list.find((e) => e && stickerUrlKey(e.url) === urlNormalized)) || null;
}

// 格式化给 AI 看的表情列表。
//
// P1-5 起这里只是 searchStickers 的薄包装：query 走「标签命中 + 同义词扩展 + 打分」
// 的语义检索（见文件末尾），state 默认只显示「收藏 + 待整理」，回收站要显式点名才看。
// 之所以不再自己拼 haystack.includes(q)：库小的时候子串匹配够用，但「嘲讽」搜不到
// 只标了「阴阳怪气」的那张 —— 这一类miss只能靠同义词表补。
export function formatStickerList(entries, query = '', limit = 48, opts = {}) {
  return searchStickers(entries, query, { ...opts, limit });
}

// 生成注入 AI 的“可用表情包”摘要（不暴露完整 URL，避免上下文爆炸）。
// P1-5：回收站里的不再出现（反正发不出去，列出来只会白占上下文）；
// 待整理的只报个数并说明「整理过才能发」，否则她会挑一张根本发不出去的。
export function buildStickerContext(entries, max = 8) {
  const all = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const counts = stickerStateCounts(all);
  const list = all.filter((e) => normalizeStickerState(e.state) === 'fav');
  if (!list.length) {
    if (!counts.pending) return '';
    return `【可用表情包】你收藏了 ${counts.pending} 个表情，但都还在「待整理」状态，现在一张都不能发。`
      + '先用 qq_get_sticker_image 看图、qq_sticker_note 记下它表达什么，再用 qq_sticker_state 收进收藏。';
  }
  const top = [...list]
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || ((b.desc || b.localNote) ? 1 : 0) - ((a.desc || a.localNote) ? 1 : 0))
    .slice(0, Math.max(1, Math.min(30, Number(max) || 8)));
  const lines = top.map((e) => {
    const label = e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '';
    return `- ${label}${extra}${used}`;
  });
  const pendingNote = counts.pending ? `，另有 ${counts.pending} 个在「待整理」得先整理才能发` : '';
  return `【可用表情包】你手上能用的收藏表情有 ${list.length} 个${pendingNote}（以下为常用/有备注的 ${top.length} 个，`
    + `完整列表用 qq_list_stickers 查看或搜索）：\n${lines.join('\n')}`;
}

// 二代仿真模式下的“真人发表情包”策略提示。
// 这是软策略：AI 仍自主判断是否使用，桥接不强制。
export function buildStickerStrategyHint() {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    '- 频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 qq_get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 qq_send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 qq_send_message / qq_reply 作为单独气泡发出，再单独发表情。需要引用/点名时传 replyToMessageId / atUserId（群聊）。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里；不要把表情包当回复的唯一内容（偶尔可以，但别让群友觉得你在敷衍）。',
    '- 学习：看到新表情不确定含义时，先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解，下次就能更准地选。',
    '- 库有三态（state）：**待整理**（刚同步进来的，发不出去）/ **收藏**（整理过，能发）/ **回收站**（软删除，能恢复）。只有收藏能发。',
    '- 整理一张 = 看图 + qq_sticker_note 写含义标签 + qq_sticker_state 设成 fav。新图先整理再用，别瞎发。',
    '- 搜库：qq_list_stickers 的 query 是按意思搜的（「嘲讽」能搜到标了「阴阳怪气」的那张），按 state 可以只看某一态。',
    '- 冷频道：如果对方跟你还不熟、你在这个会话里还没说过话，先用文字聊两句再发表情 —— 一上来就甩图别人看不懂。'
  ].join('\n');
}

// 把 AI 本地认知（note/tags/usage）更新到一条表情记录上，并返回新数组。
export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

// 记录一次“使用”，返回新数组。
export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

// P0-2 同图不连发：判断这次要发的表情，是否就是该会话「上一张成功发出去的」那张。
//
// 为什么单独成纯函数：判定有三个容易写错的地方，而且全都可以离线穷举——
//   ① stickerId 允许传 id / md5 / url 三种写法，只比原串会被「换个写法」绕过
//      （所以调用方先 findSticker 解析，这里再比解析后的 id 与 md5）；
//   ② md5 大小写不固定，比较前统一大写；
//   ③ 解析不出来时（传了个不存在的 id）rid 会退回原串，否则「刚发过的那张」
//      原样再发一次就会漏过。
// 留在发图路由里就只能真发一张图之后靠 409 验证——而测试消息会进主人的真实聊天。
// 抽出来所有分叉都能离线覆盖。
//
// 语义是「上一张不同才算翻篇」：中间发了别的表情就解锁；中间只发文字不解锁。
// 任一侧为空一律放行 —— 宁可漏拦，也不能把正常发表情拦死。
export function stickerRepeatBlocked(entry, lastId = '', lastMd5 = '') {
  const rid = String(entry?.id ?? '').trim();
  const rmd5 = String(entry?.md5 ?? '').trim().toUpperCase();
  const prevId = String(lastId ?? '').trim();
  const prevMd5 = String(lastMd5 ?? '').trim().toUpperCase();
  const blocked = (!!rid && rid === prevId) || (!!rmd5 && rmd5 === prevMd5);
  return { blocked, rid, rmd5 };
}


// ============================================================================
// P1-5 表情库「三态 + 语义搜库」
// ============================================================================
//
// 为什么单独成模块（而不是写进 bridge.js 的路由里）：
//   三态迁移、同义词扩展、打分排序这三件事全是纯函数，但它们的分支极多
//   （空查询 / 别名 / 大小写 / 连发惩罚 / 冷却 / 回收站 / 未知 state …），
//   埋在路由里就只能靠「真发一张图进主人的真群」来验证。抽出来全部可离线穷举，
//   见 ops/test-sticker-lib.mjs。
//
// 为什么不上 CLIP（调研过 15 个仓库后的结论，详见 docs/upgrade-plan-2026-09.md §P1-5）：
//   chinese-clip 只有 base/large 两个 ONNX 版本，对「梗 + 文字 + 画风」这种语义很弱；
//   几百条规模下 ANN 索引（sqlite-vec / hnswlib-node）是负优化；transformers.js 首次
//   要联网下模型 + 拖 onnxruntime 原生依赖，而原生模块在 Windows/Node 升级时最容易炸。
//   我们的优势是「入库时本来就有一个多模态 AI 在看图」—— 让她入库时打 3~8 个中文标签，
//   检索走标签命中 + 同义词扩展即可，**检索阶段零模型调用**（这才是省 token 的关键）。
//
// 三态语义（state）：
//   pending 待整理 —— 刚从 QQ 同步进来、本地一无所知。**不能发**，先看图写标签。
//   fav     收藏   —— 整理过、可以发。
//   trash   回收站 —— 软删除，保留记录（用过的次数/上下文都还在），随时可以恢复。
// 只有 fav 能发：给「没见过这张图就瞎发」加一道闸。

export const STICKER_STATES = ['pending', 'fav', 'trash'];
export const STICKER_STATE_LABEL = { pending: '待整理', fav: '收藏', trash: '回收站' };

const STATE_ALIASES = {
  pending: 'pending', todo: 'pending', new: 'pending', raw: 'pending', 待整理: 'pending', 未整理: 'pending',
  fav: 'fav', favorite: 'fav', favourite: 'fav', star: 'fav', starred: 'fav', ok: 'fav', 收藏: 'fav', 可用: 'fav',
  trash: 'trash', deleted: 'trash', delete: 'trash', removed: 'trash', bin: 'trash', 回收站: 'trash', 删除: 'trash'
};

export function normalizeStickerState(raw, fallback = 'pending') {
  const key = String(raw ?? '').trim().toLowerCase();
  const hit = STATE_ALIASES[key];
  if (hit) return hit;
  return STICKER_STATES.includes(String(fallback ?? '').trim().toLowerCase()) ? String(fallback).trim().toLowerCase() : 'pending';
}

export function stickerStateLabel(state) {
  return STICKER_STATE_LABEL[normalizeStickerState(state)] || '待整理';
}

// 老库一次性迁移的判据：写过备注 / 打过标签 / 记过用法 / 用过的，都算她已经整理过。
export function defaultStickerState(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const hasNote = String(e.localNote ?? '').trim().length > 0;
  const hasTags = Array.isArray(e.tags) && e.tags.length > 0;
  const hasUsage = String(e.usage ?? '').trim().length > 0;
  const used = Number(e.useCount) > 0;
  return hasNote || hasTags || hasUsage || used ? 'fav' : 'pending';
}

// 感知哈希（dHash）：调研结论是「md5 去重不可靠 —— QQ 会重编码图片导致 md5 变化」，
// 所以留了 dhash 字段与汉明距离比较。解码器故意不引：能解码的库（sharp / jimp）要么是
// 原生模块、要么拖一堆依赖，而我们的图是 AI 自己看得见的 —— 近重复判定交给她的眼睛，
// 这里只提供「两边都有 dhash 时」的自动比对（阈值默认 6，经验值 5~8）。
export function normalizeDhash(raw) {
  const s = String(raw ?? '').trim().replace(/^0x/i, '').toUpperCase();
  return /^[0-9A-F]{8,64}$/.test(s) ? s : '';
}

export function dhashHexFromGray(rows) {
  // rows: 8 行 × 9 列灰度（0~255）。每行按相邻像素比较取 1 bit，共 64 bit → 16 位十六进制。
  // 纯函数是为了可离线穷举（给一个手写的 8×9 矩阵就能断言输出），不需要真去解码一张图。
  if (!Array.isArray(rows) || rows.length !== 8) return '';
  let bits = '';
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 9) return '';
    for (let c = 0; c < 8; c += 1) {
      const a = Number(row[c]);
      const b = Number(row[c + 1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
      bits += a < b ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16).toUpperCase();
  return hex;
}

export function hammingDistanceHex(a, b) {
  const x = normalizeDhash(a);
  const y = normalizeDhash(b);
  if (!x || !y || x.length !== y.length) return -1;
  let d = 0;
  for (let i = 0; i < x.length; i += 1) {
    let v = parseInt(x[i], 16) ^ parseInt(y[i], 16);
    while (v) { d += v & 1; v >>= 1; }
  }
  return d;
}

// 近重复查找：先 md5 精确，再 dhash 汉明距离。返回 null 表示「是新图」。
export function findNearDuplicateSticker(entries, probe, { threshold = 6 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const p = probe && typeof probe === 'object' ? probe : {};
  const md5 = String(p.md5 ?? '').trim().toUpperCase();
  const dhash = normalizeDhash(p.dhash);
  const skipId = String(p.id ?? '').trim();
  const thr = Math.max(0, Math.min(32, Number(threshold) || 6));
  let best = null;
  for (const e of list) {
    if (skipId && e.id === skipId) continue;
    if (md5 && e.md5 === md5) return { entry: e, by: 'md5', distance: 0 };
    if (dhash && e.dhash) {
      const d = hammingDistanceHex(dhash, e.dhash);
      if (d >= 0 && d <= thr && (!best || d < best.distance)) best = { entry: e, by: 'dhash', distance: d };
    }
  }
  return best;
}

// —— 能不能发 ——
export function stickerSendable(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const state = normalizeStickerState(e.state, 'pending');
  if (state === 'trash') {
    return { ok: false, state, reason: '这张表情在回收站里。想发的话先用 qq_sticker_state 把它恢复成收藏（state=fav）。' };
  }
  if (state === 'pending') {
    return {
      ok: false,
      state,
      reason: '这张表情还没整理过（待整理），发出去容易牛头不对马嘴。先用 qq_get_sticker_image 看一眼它到底表达什么，'
        + '再用 qq_sticker_note 记下含义/标签/适用场合，最后用 qq_sticker_state 收进收藏，之后才能发。'
    };
  }
  return { ok: true, state, reason: '' };
}

export function setStickerState(entries, id, state) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null, changed: false };
  const next = normalizeStickerState(state, target.state);
  if (next === target.state) return { entries: list, entry: target, changed: false };
  const idx = list.findIndex((e) => e.id === target.id);
  const updated = normalizeStickerEntry({ ...target, state: next, updatedAt: nowIso() });
  if (!updated) return { entries: list, entry: null, changed: false };
  list[idx] = updated;
  return { entries: list, entry: updated, changed: true };
}

// —— 同义词表：概念 → 说法 ——
// 只服务检索，不参与打分以外的任何逻辑。加词就直接往数组里塞，不需要改代码。
export const STICKER_SYNONYMS = {
  嘲讽: ['阴阳', '阴阳怪气', '嘲笑', '讥讽', '吐槽', '挖苦', '酸', 'diss', '讽刺', '开嘲'],
  无语: ['无语了', '沉默', '扶额', '汗', '无奈', 'emmm', '不想说话', '尬住', '服了'],
  开心: ['高兴', '笑', '哈哈', '大笑', '偷笑', '乐', '愉快', '兴奋', '雀跃', '好耶'],
  自嘲: ['摆烂', '摸鱼', '废物', '菜', '躺平', '吃白饭', '咸鱼', '菜鸡', '废物点心'],
  撒娇: ['卖萌', '可爱', '贴贴', '蹭', '抱', '投喂', '喵', '求求', '嘛'],
  生气: ['怒', '炸毛', '咆哮', '火大', '拍桌', '掀桌', '气死', '气愤'],
  委屈: ['哭', '难过', '伤心', '落泪', '可怜', '呜呜', '泪目', '想哭'],
  震惊: ['惊讶', '吃惊', '卧槽', '惊呆了', '吓', '目瞪口呆', '震撼'],
  赞同: ['同意', '点头', '赞成', '附议', '可以', '行', '好的', 'ok', '＋1', '支持'],
  拒绝: ['不要', '不行', '摆手', '打住', '停', '拒绝三连', 'no', '不'],
  安慰: ['鼓励', '加油', '抱抱', '摸摸', '打气', '别难过', '拍拍', '心疼'],
  告别: ['再见', '拜拜', '晚安', '走了', '下班', '睡觉', '886', '告辞'],
  打招呼: ['你好', '早安', '嗨', 'hi', '在吗', '来了', '冒泡', 'hello'],
  敷衍: ['随便', '哦', '嗯', '应付', '打发', '无所谓', '嗯嗯'],
  得意: ['嚣张', '骄傲', '牛', '强', '厉害', '666', '拽', '膨胀'],
  尴尬: ['社死', '难为情', '汗颜', '窘', '囧', '脚趾抠地'],
  求饶: ['投降', '服了', '认输', '别打我', '放过', '饶命', '抱歉', '对不起', '我错了'],
  感谢: ['谢谢', '多谢', '感恩', '谢', '感谢老板', 'thx'],
  催促: ['催', '快点', '赶紧', '等着', '急', 'gkd', '速速'],
  害羞: ['脸红', '羞', '捂脸', '不好意思', '羞涩'],
  困惑: ['疑惑', '不懂', '迷惑', '问号', '什么鬼', '？', '没懂'],
  猫: ['喵', '猫咪', '猫猫', '小猫'],
  狗: ['汪', '狗子', '柴犬', '小狗'],
  吃货: ['吃', '饿', '饭', '干饭', '美食', '好饿', '馋'],
  摸鱼: ['划水', '偷懒', '摆烂', '不想干活', '上班摸鱼']
};

// 词 → 概念集合。额外词表可来自配置（cfg.socialV2.sticker.synonyms），与内置表合并。
export function buildSynonymIndex(extra = {}) {
  const merged = { ...STICKER_SYNONYMS };
  if (extra && typeof extra === 'object') {
    for (const [concept, words] of Object.entries(extra)) {
      const list = Array.isArray(words) ? words.map((w) => String(w ?? '').trim()).filter(Boolean) : [];
      if (!list.length) continue;
      merged[concept] = [...(merged[concept] || []), ...list];
    }
  }
  const index = new Map();
  for (const [concept, words] of Object.entries(merged)) {
    for (const w of [concept, ...words]) {
      const key = String(w ?? '').trim().toLowerCase();
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(concept);
    }
  }
  return index;
}

// 查询拆词 + 同义扩展。返回原词（terms）与它唤起的「概念」（concepts）两组。
// 拆词按空白与常见分隔符，不做中文分词（离线、零依赖；库只有几百条，多召回一点没坏处）。
export function expandQuery(query, extra = {}) {
  const raw = String(query ?? '').trim();
  if (!raw) return { raw: '', terms: [], concepts: [] };
  const terms = [...new Set(
    raw.toLowerCase().split(/[\s,，、/|;；+]+/).map((s) => s.trim()).filter(Boolean)
  )];
  const index = buildSynonymIndex(extra);
  const concepts = new Set();
  for (const t of terms) {
    for (const c of index.get(t) || []) concepts.add(c);
    // 子串方向：查「猫猫头」也应唤起概念「猫」
    for (const [word, cs] of index) {
      if (word.length >= 2 && t.includes(word)) for (const c of cs) concepts.add(c);
    }
  }
  return { raw, terms, concepts: [...concepts] };
}

export const STICKER_USE_BONUS = 0.3;
export const STICKER_REPEAT_PENALTY = -100;

// 打分：标签命中*2 + 同义命中*1.5 + 0.3*ln(1+useCount) - 同图连发惩罚 - 冷却惩罚
// 同图连发给的是「一票否决」级别的大负数（-100），因为连着两张一样的表情比少发一张难看得多。
export function scoreSticker(entry, query, opts = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const tags = (Array.isArray(e.tags) ? e.tags : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  const tagsLower = tags.map((t) => t.toLowerCase());
  const tagText = tagsLower.join(' ');
  const wideText = [e.desc, e.localNote, e.usage].map((v) => String(v ?? '').trim().toLowerCase()).join(' ');
  const q = expandQuery(query, opts.extraSynonyms);
  const parts = { tag: 0, syn: 0, use: 0, repeat: 0, cooldown: 0 };
  const hits = [];
  if (q.raw) {
    for (const term of q.terms) {
      if (tagsLower.includes(term)) { parts.tag += 2; hits.push(`标签:${term}`); continue; }
      if (tagText.includes(term)) { parts.tag += 1.5; hits.push(`标签~:${term}`); continue; }
      if (wideText.includes(term)) { parts.tag += 1; hits.push(`描述:${term}`); }
    }
    const termSet = new Set(q.terms);
    // 「这个词本身就是查询里出现过的字」也算重复计量：语义表的词之间会互相包含
    // （概念「嘲讽」里有「阴阳」，而「阴阳」正好是查询词「阴阳怪气」的子串），
    // 只判 termSet.has 会漏掉这种，导致精确命中标签的条目被额外奖励 1.5，
    // 反而把真正只是同义的条目挤下去 —— 那正是本次改造要解决的问题。
    const seenInQuery = (w) => termSet.has(w) || q.terms.some((t) => t.includes(w));
    for (const concept of q.concepts) {
      const words = [concept, ...((opts.extraSynonyms?.[concept]) || []), ...(STICKER_SYNONYMS[concept] || [])]
        .map((w) => String(w ?? '').trim().toLowerCase()).filter(Boolean);
      // 命中的那个词如果本身就是查询原词，上面已经计过分了 —— 不能重复加，否则
      // 「猫」搜 tagged「猫」的条目会拿到 2 + 1.5 的分，把真正同义的条目挤下去。
      const hitTag = words.find((w) => tagsLower.some((t) => t.includes(w)));
      if (hitTag) {
        if (!seenInQuery(hitTag)) { parts.syn += 1.5; hits.push(`同义:${concept}`); }
        continue;
      }
      const hitWide = words.find((w) => wideText.includes(w));
      if (hitWide && !seenInQuery(hitWide)) { parts.syn += 0.8; hits.push(`同义~:${concept}`); }
    }
  }
  parts.use = STICKER_USE_BONUS * Math.log1p(Math.max(0, Number(e.useCount) || 0));
  const rid = String(e.id ?? '').trim();
  const rmd5 = String(e.md5 ?? '').trim().toUpperCase();
  const lastId = String(opts.lastId ?? '').trim();
  const lastMd5 = String(opts.lastMd5 ?? '').trim().toUpperCase();
  if ((rid && rid === lastId) || (rmd5 && rmd5 === lastMd5)) {
    parts.repeat = STICKER_REPEAT_PENALTY;
    hits.push('同图连发');
  }
  const cooldownMs = Math.max(0, Number(opts.cooldownMs) || 0);
  const lastUsedAt = Number(e.lastUsedAt) || 0;
  const now = Number(opts.now) || Date.now();
  if (cooldownMs > 0 && lastUsedAt > 0 && now - lastUsedAt < cooldownMs) {
    parts.cooldown = -1.5;
    hits.push('冷却中');
  }
  return { score: parts.tag + parts.syn + parts.use + parts.repeat + parts.cooldown, parts, hits };
}

export function stickerStateCounts(entries) {
  const counts = { pending: 0, fav: 0, trash: 0 };
  // 这里**不能**先过 normalizeStickerEntry：那个函数对没有 id 的条目返回 null，
  // 于是一份「还没分配 id」的数据会被静默数成全 0（看着像「库里空空的」）。
  // 计数只关心状态，按 normalizeStickerState(显式 state → 老库推导) 统计即可。
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || typeof e !== 'object') continue;
    counts[normalizeStickerState(e.state, defaultStickerState(e))] += 1;
  }
  return counts;
}

// 语义检索主入口。state 口径：
//   'visible'（默认）= 收藏 + 待整理（回收站不出现，避免她误发删掉的图）
//   'all' / 'pending' / 'fav' / 'trash'
// 空查询时按「常用 + 有备注」排（保持老行为），有查询时才按打分排。
export function searchStickers(entries, query = '', opts = {}) {
  const {
    limit = 48,
    state = 'visible',
    lastId = '',
    lastMd5 = '',
    now = Date.now(),
    cooldownMs = 0,
    extraSynonyms = {},
    excludeId = ''
  } = opts;
  const all = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  // ⚠️ 这里必须自己白名单校验，不能直接 normalizeStickerState(bucket)：
  // 那个函数的 fallback 一旦不是合法三态就会退化成 'pending'，
  // 于是 state='随便写的' 会静默变成「只看待整理」，而文档承诺的是回退到 visible。
  const rawBucket = String(state ?? 'visible').trim().toLowerCase();
  const bucket = rawBucket === 'all' || rawBucket === 'visible' || STICKER_STATES.includes(rawBucket) ? rawBucket : 'visible';
  const inBucket = bucket === 'all'
    ? all
    : bucket === 'visible'
      ? all.filter((e) => normalizeStickerState(e.state) !== 'trash')
      : all.filter((e) => normalizeStickerState(e.state) === bucket);
  const skipped = String(excludeId ?? '').trim();
  const pool = skipped ? inBucket.filter((e) => e.id !== skipped) : inBucket;
  const q = String(query ?? '').trim();
  const scored = pool.map((e) => {
    const { score, parts, hits } = scoreSticker(e, q, { lastId, lastMd5, now, cooldownMs, extraSynonyms });
    return { e, score, parts, hits };
  });
  // 有查询时，只有真正命中（标签或同义）的才算「搜到了」——否则一次搜不到就会把
  // 全库按 useCount 倒出来，看着像「什么都搜得到」，她反而更困惑。
  const matchedRows = q ? scored.filter((s) => s.parts.tag > 0 || s.parts.syn > 0) : scored;
  matchedRows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ua = Number(a.e.useCount) || 0;
    const ub = Number(b.e.useCount) || 0;
    if (ub !== ua) return ub - ua;
    return String(a.e.id).localeCompare(String(b.e.id));
  });
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = matchedRows.slice(0, max).map(({ e, score, parts, hits }) => ({
    id: e.id,
    resId: e.resId,
    md5: e.md5,
    url: e.url,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    usage: e.usage || '',
    useCount: e.useCount || 0,
    lastUsedAt: e.lastUsedAt || 0,
    source: e.source || 'qq',
    state: normalizeStickerState(e.state),
    stateLabel: stickerStateLabel(e.state),
    score: Math.round(score * 100) / 100,
    hits
  }));
  return {
    total: pool.length,
    allTotal: all.length,
    matched: matchedRows.length,
    truncated: matchedRows.length > max,
    state: bucket,
    counts: stickerStateCounts(all),
    stickers: items
  };
}

// —— 冷频道不发表情 ——
// 刚认识的人（熟识度低）且她在该会话里一句话都还没说过时，别一上来就甩表情包：
// 真人不会这么干，而且对方看不懂你的图。发过第一句话之后闸门就永久打开。
export const STICKER_COLD_FAMILIARITY = 20;

export function stickerColdChannel({ familiarity = 0, aiMessages = 0, threshold = STICKER_COLD_FAMILIARITY } = {}) {
  const fam = Number.isFinite(Number(familiarity)) ? Number(familiarity) : 0;
  const sent = Math.max(0, Math.floor(Number(aiMessages) || 0));
  const cold = fam < threshold && sent <= 0;
  return {
    cold,
    familiarity: fam,
    aiMessages: sent,
    threshold,
    reason: cold
      ? `你和对方还没真正聊起来（熟识度 ${fam}/100，而且你在这个会话里还没说过话）。先用文字聊两句再发表情，一上来就甩图对方会看不懂。`
      : ''
  };
}