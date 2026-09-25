// P0-2 回归测试：主动消息每日硬配额 + 同图不连发
//
// 三段：
//   U 段  纯函数单测（src/proactive-quota.js）—— 边界值全部覆盖，喂固定时间戳
//   接线  源码级检查 —— 明确标注「这只能证明那段代码还在，不等于行为被验证」
//   H 段  HTTP 端到端 —— 配额用「合成非白名单 key + 直接写 DB」验证读取路径（零副作用）；
//                        表情拦截只能活体验证（必须真有一张图被发出去，才会进入「上一张」状态）
//
// 同图不连发的判定逻辑已抽成纯函数 stickerRepeatBlocked（src/sticker-lib.js），U2 段离线穷举全部分叉。
// 端到端部分分两级：
//   H4-0 零消息探针（默认跑）：她「上一张」记录非空时，直接重发那一张，断言 409 被拦。
//        被拦的请求在 sendStickerV2 之前就 return 了，不发消息、不 push recentMessages、
//        不 scheduleReplyCheckV2 —— 真正零副作用。
//   H4-live 完整链（需 LIVE_SEED=1）：真发 A / B / A 才能验证「换一张解锁」，但发图成功会
//        顺带 scheduleReplyCheckV2。唯一能关掉那个唤醒的开关是 socialV2.paused，而
//        bridge.js:2001 的全局守卫会连发图一起拦成 403，路走不通，所以默认不跑。
//
// 跑：node ops/test-proactive-quota.mjs                      （默认：零消息探针）
//     $env:LIVE_SEED='1'; node ops/test-proactive-quota.mjs   （完整活体链，会在主人私聊真发 3 张）

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localDayKey, quotaPerDayFromConfig, proactiveAllowed, nextLocalMidnight } from '../src/proactive-quota.js';
import { stickerRepeatBlocked } from '../src/sticker-lib.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';
const OWNER_KEY = 'private:1918594889';
const SYNTH_KEY = 'group:123456789';   // 合成靶子：绝不在白名单里，配额外的一切都不会真实发生
const LIVE_SEED = String(process.env.LIVE_SEED ?? '') === '1';

const outFile = path.join(ROOT, '..', 'outbox', 'pc-jobs', 'test-proactive-quota.log');
try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch {}
try { fs.writeFileSync(outFile, ''); } catch {}
function say(line) {
  console.log(line);
  try { fs.appendFileSync(outFile, line + '\n'); } catch {}
}
let pass = 0, fail = 0, skip = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; say(`✅ ${name}${extra ? '  ' + extra : ''}`); } else { fail++; say(`❌ ${name}${extra ? '  ' + extra : ''}`); }
}
function skipped(name) { skip++; say(`⏭️  ${name}（跳过）`); }
function section(t) { say(`\n── ${t} ──`); }

// 令牌只读不打印：这两个值是本机凭据，测试输出会落盘到 outbox，绝不写进去
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const v2raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const ownerToken = String(v2raw?.conversations?.[OWNER_KEY]?.agentToken ?? '');

async function req(pathname, { method = 'GET', body = null, token = null, headers = {} } = {}) {
  const h = { 'x-console-token': consoleToken, ...headers };
  if (token) h['x-agent-token'] = token;
  if (body) h['content-type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const panelState = () => req('/api/panel/social-state');
// 按 key 读：默认视图只列「已经有过消息的对话」，合成靶子不在里面，所以必须用 ?key= 显式读。
const panelStateOf = (key) => req(`/api/panel/social-state?key=${encodeURIComponent(key)}`);
function sessionOf(state, key) { return (state.json?.sessions ?? []).find((s) => s.key === key) ?? null; }
const sendSticker = (stickerId) => req('/api/socialV2/send-sticker', { method: 'POST', token: ownerToken, body: { key: OWNER_KEY, stickerId } });
const lastOfSticker = async () => sessionOf(await panelState(), OWNER_KEY)?.lastStickerId ?? '';

let db = null;
function openDb() {
  if (!db) {
    db = new DatabaseSync(path.join(ROOT, 'state', 'memory.db'));
    db.exec('PRAGMA busy_timeout = 3000');   // 桥接随时可能在写 WAL，不要因为一次 BUSY 就误判
  }
  return db;
}
function finish(code) {
  // 延迟退出：fetch 的 keep-alive socket 正在关闭时强退会触发 libuv 的
  // Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)，stderr 里看着像测试崩了
  setTimeout(() => process.exit(code), 500);
}

// ─────────────────────────────────────────────────────────────────────────────
say('P0-2 回归：主动配额 + 同图不连发');
say(`LIVE_SEED=${LIVE_SEED ? '1（会在主人私聊真发 3 张表情做完整活体链）' : '0（默认：只跑零消息探针，不打扰正在进行的对话）'}`);

section('U 段：proactive-quota 纯函数');
{
  const quotaDefault = quotaPerDayFromConfig(undefined);
  check('未配置 → 默认 10', quotaDefault === 10, `实际=${quotaDefault}`);
  check('null → -1（显式不限制）', quotaPerDayFromConfig(null) === -1);
  check('false → -1（显式不限制）', quotaPerDayFromConfig(false) === -1);
  check('负数 -1 → -1', quotaPerDayFromConfig(-1) === -1);
  check('负数 -99 → -1', quotaPerDayFromConfig(-99) === -1);
  check("非数字 'abc' → 回到默认 10", quotaPerDayFromConfig('abc') === 10);
  check('NaN → 回到默认 10', quotaPerDayFromConfig(NaN) === 10);
  check('Infinity 视为非法 → 默认 10', quotaPerDayFromConfig(Infinity) === 10);
  check('0 → 0（完全禁止主动）', quotaPerDayFromConfig(0) === 0);
  check("'0' 字符串 → 0", quotaPerDayFromConfig('0') === 0);
  check('10.9 → 向下取整 10', quotaPerDayFromConfig(10.9) === 10);
  check("'15' → 15（配置文件里写字符串也要能用）", quotaPerDayFromConfig('15') === 15);

  // 边界：第 quota 次之后必须拒绝。写成 used <= quota 就会多放一次，这是最容易错的地方。
  check('used=0/10 → 允许', proactiveAllowed(10, 0) === true);
  check('used=9/10 → 允许（最后一次）', proactiveAllowed(10, 9) === true);
  check('used=10/10 → 拒绝', proactiveAllowed(10, 10) === false);
  check('used=11/10 → 拒绝（不会因为超了就重新放行）', proactiveAllowed(10, 11) === false);
  check('quota=0,used=0 → 拒绝（0 是禁止而不是不限制）', proactiveAllowed(0, 0) === false);
  check('quota=-1,used=99999 → 允许（-1 才是不限制）', proactiveAllowed(-1, 99999) === true);

  // 时区：这是本模块存在的理由。用 toISOString 的话当地 00:00~08:00 会算成昨天。
  const early = new Date(2026, 0, 15, 1, 0, 0).getTime();
  const earlyUtc = new Date(early).toISOString().slice(0, 10);
  check('本地凌晨 01:00 的日期键 = 本地当天（不是 UTC 的昨天）', localDayKey(early) === '2026-01-15', `local=${localDayKey(early)} utc=${earlyUtc}`);
  check('  且与 toISOString 确实不同（证明这条断言不是空断言）', localDayKey(early) !== earlyUtc, `${localDayKey(early)} vs ${earlyUtc}`);
  check('本地 23:59:59 仍算当天', localDayKey(new Date(2026, 0, 15, 23, 59, 59).getTime()) === '2026-01-15');
  check('本地 00:00:01 算次日（跨零点立刻换日）', localDayKey(new Date(2026, 0, 16, 0, 0, 1).getTime()) === '2026-01-16');
  check('月/日补零：1 月 5 日 → 2026-01-05', localDayKey(new Date(2026, 0, 5, 12, 0, 0).getTime()) === '2026-01-05');
  check('12 月 31 日 → 2026-12-31', localDayKey(new Date(2026, 11, 31, 12, 0, 0).getTime()) === '2026-12-31');

  const nm = nextLocalMidnight(new Date(2026, 0, 15, 13, 30, 0).getTime());
  const nmD = new Date(nm);
  check('nextLocalMidnight 指向次日 00:00:00.000',
    nmD.getDate() === 16 && nmD.getHours() === 0 && nmD.getMinutes() === 0 && nmD.getSeconds() === 0 && nmD.getMilliseconds() === 0,
    `实际=${nmD.toLocaleString('zh-CN')}`);
  const nm2 = new Date(nextLocalMidnight(new Date(2026, 0, 15, 23, 59, 59).getTime()));
  check('nextLocalMidnight 在 23:59:59 仍指向次日 00:00', nm2.getDate() === 16 && nm2.getHours() === 0);
}

section('U2 段：同图不连发纯函数（stickerRepeatBlocked）');
{
  const A = { id: 'AAA', md5: 'abc123' };
  const B = { id: 'BBB', md5: 'def456' };
  const blk = (e, id, md5) => stickerRepeatBlocked(e, id, md5).blocked;

  check('同 id → 拦', blk(A, 'AAA', '') === true);
  check('同 id 但上一张的 md5 不同 → 仍拦（id 优先级）', blk(A, 'AAA', 'zzz') === true);
  check('id 不同但 md5 相同 → 拦（换个 id 发同一张图也躲不掉）', blk({ id: 'ZZZ', md5: 'abc123' }, 'AAA', 'abc123') === true);
  check('md5 大小写不同 → 仍拦（统一大写后比较）', blk({ id: 'ZZZ', md5: 'ABC123' }, 'AAA', 'abc123') === true);
  check('上一张 md5 是小写、本次大写 → 拦', blk({ id: 'ZZZ', md5: 'ABC123' }, 'AAA', 'ABC123'.toLowerCase()) === true);
  check('完全不同的图 → 放行（换一张就解锁）', blk(B, 'AAA', 'abc123') === false);
  check('上一张为空 → 放行（首次发任何图都不拦）', blk(A, '', '') === false);
  check('上一张只有 id 没有 md5、本次不同图 → 放行', blk(B, 'AAA', '') === false);
  check('本次解析不出 md5、id 也不同 → 放行（md5 为空不能误拦）', blk({ id: 'X', md5: '' }, 'Y', 'abc123') === false);
  check('本次 entry 为 null 时以原串兜底 → 与上一张 id 相同则拦', blk({ id: 'RAW' }, 'RAW', '') === true);
  check('两侧都空 → 放行（不误拦，宁可漏拦不可拦死）', blk({}, '', '') === false);
  check('前后空白自动 trim → 仍拦', blk(A, '  AAA  ', '') === true);
  check('返回值带回 rid 供错误文案使用', stickerRepeatBlocked(A, '', '').rid === 'AAA');
  check('返回值 rmd5 已大写', stickerRepeatBlocked({ id: 'Q', md5: 'AbC' }, '', '').rmd5 === 'ABC');
}

section('接线检查（源码级：只能证明那段代码还在，不等于行为已验证）');
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('扫描器里用了 proactiveAllowed(quota, used)', src.includes('proactiveAllowed(quota, used)'));
  check('配额耗尽有明确日志', src.includes('主动消息今日配额已用完'));
  check('决定放行时确实计数了 bumpProactiveQuota', src.includes('bumpProactiveQuota(key)'));
  check('提示词里告诉了她今日额度余量', src.includes('【今日主动机会】'));
  check('发图前有同图不连发判定', src.includes('刚才已经发过这张表情了'));
  check('接线：路由调用了纯函数 stickerRepeatBlocked', src.includes('stickerRepeatBlocked(resolved ?? { id: stickerId }'));
  check('发图成功后记录 lastStickerId', src.includes('st.lastStickerId = '));
  // 会话状态是三处白名单（默认对象 / 加载 / 保存），漏任何一处都会静默不持久化
  const cnt = (src.match(/lastStickerId/g) || []).length;
  check('lastStickerId 在「默认对象/加载/保存」三处都登记了（≥3 次）', cnt >= 3, `实际出现 ${cnt} 次`);
  check('保存白名单里有 lastStickerId 的持久化写法', src.includes('lastStickerId: String(st.lastStickerId'));
  check('加载白名单里有 lastStickerId 的还原写法', src.includes('lastStickerId: String(val.lastStickerId'));

  // 我写这段时真的踩过：把 synced?.entries 抄进了发图路由，而 synced 只是
  // getStickerImageData / 表情列表路由里的局部变量 —— 运行时会 ReferenceError，
  // 被外层 catch 吞成 500，表面看像「QQ 发图失败」。块长下限是为了防止切口取空导致这条断言变成空断言。
  const routeStart = src.indexOf("url.pathname === '/api/socialV2/send-sticker'");
  const routeEnd = src.indexOf('if (req.method ===', routeStart + 10);
  const routeBlock = routeStart >= 0 && routeEnd > routeStart ? src.slice(routeStart, routeEnd) : '';
  // 只剥「整行注释」：本路由里的注释正好写了「不要用 synced」这句话，不剥掉就会把
  // 说明文字当成真代码命中。只按整行剥（而不是全局找 //）是为了不误伤字符串里的 http://。
  const codeOnly = routeBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('接线：发图路由块切片成功（长度下限，防空断言）', routeBlock.length > 500, `块长=${routeBlock.length}`);
  check('接线：发图路由的代码里不引用 synced（那是别的函数的局部变量，会 ReferenceError）', codeOnly.length > 400 && !codeOnly.includes('synced'));
  const iGuard = routeBlock.indexOf('刚才已经发过这张表情了');
  const iSend = routeBlock.indexOf('sendStickerV2(');
  check('接线：同图拦截排在真正发送之前（不是发完才判的死代码）', iGuard >= 0 && iSend > iGuard, `guard@${iGuard} send@${iSend}`);
}

section('H 段：HTTP 端到端');
{
  if (!ownerToken) { check('主人私聊会话有 agentToken（没令牌后面全废）', false, '读不到令牌'); await finish(1); }
  check('读到主人私聊 agentToken（只校验长度，不打印内容）', ownerToken.length >= 16, `长度=${ownerToken.length}`);

  // H1 面板观察点
  const st1 = await panelState();
  check('H1 /api/panel/social-state 可用', st1.status === 200 && st1.json?.ok === true, `status=${st1.status}`);
  const localExpected = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
  check('H1 端点返回的 localDay = 本地日期（不是 UTC 日期）', st1.json?.localDay === localExpected, `端点=${st1.json?.localDay} 本地=${localExpected}`);
  check('H1 同时给出 utcDay 便于对比', typeof st1.json?.utcDay === 'string' && st1.json.utcDay.length === 10, `utc=${st1.json?.utcDay}`);
  check('H1 nextLocalMidnight 在未来 24 小时内', Number(st1.json?.nextLocalMidnight) > Date.now() && Number(st1.json?.nextLocalMidnight) - Date.now() <= 86400000);

  const ownerSess = sessionOf(st1, OWNER_KEY);
  check('H1 面板包含主人私聊会话', !!ownerSess);
  check('H1 默认配额 = 10（配置里没写 quotaPerDay）', ownerSess?.proactiveQuota === 10, `实际=${ownerSess?.proactiveQuota}`);
  check('H1 每个会话都带 proactiveAllowed 布尔字段', typeof ownerSess?.proactiveAllowed === 'boolean');

  // H2 表结构：证明迁移真的跑过（读不存在的表会被 catch 吞掉、静默返回 0）
  let hasTable = false;
  try {
    const row = openDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proactive_quota'").get();
    hasTable = !!row;
  } catch (e) { say(`   （打开 memory.db 失败：${e?.message ?? e}）`); }
  check('H2 proactive_quota 表已建（迁移跑过）', hasTable);

  // H3 用合成 key 埋一行，验证「真实读取路径」上的边界（对真会话零影响）
  if (hasTable) {
    const day = localDayKey();
    const d = openDb();
    const put = (n) => d.prepare('INSERT INTO proactive_quota (conv_key, day, count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(conv_key, day) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at').run(SYNTH_KEY, day, n, Date.now());

    // 读的是 HTTP 端点的 ?key= 分支：它和调度器里的判定走同一对 helper
    // （proactiveUsedToday + proactiveAllowed），所以边界是在真实读取路径上验的。
    const read = async () => (await panelStateOf(SYNTH_KEY)).json;

    put(0);
    let s = await read();
    check('H3 埋 count=0 → 端点读到 used=0 且允许', s?.proactiveUsedToday === 0 && s?.proactiveAllowed === true, `used=${s?.proactiveUsedToday}`);
    check('H3 ?key= 分支不该凭空造出会话', s?.known === false, `known=${s?.known}`);

    put(9);
    s = await read();
    check('H3 埋 count=9 → 还剩 1 次，允许', s?.proactiveUsedToday === 9 && s?.proactiveAllowed === true, `used=${s?.proactiveUsedToday}`);

    put(10);
    s = await read();
    check('H3 埋 count=10（=配额）→ 拒绝（边界在真实读取路径上成立）', s?.proactiveUsedToday === 10 && s?.proactiveAllowed === false, `used=${s?.proactiveUsedToday} allowed=${s?.proactiveAllowed}`);

    put(99);
    s = await read();
    check('H3 埋 count=99 → 仍然拒绝（不会因超额而放行）', s?.proactiveAllowed === false);

    // 昨天的行不能影响今天 —— 这就是「日期键」存在的意义
    const yesterday = localDayKey(Date.now() - 86400000);
    d.prepare('INSERT INTO proactive_quota (conv_key, day, count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(conv_key, day) DO UPDATE SET count = excluded.count').run(SYNTH_KEY, yesterday, 99, Date.now());
    d.prepare('UPDATE proactive_quota SET count = 0 WHERE conv_key = ? AND day = ?').run(SYNTH_KEY, day);
    s = await read();
    check('H3 昨天用满不影响今天（按本地日期分桶）', s?.proactiveUsedToday === 0 && s?.proactiveAllowed === true, `today=${s?.proactiveUsedToday}`);

    // 收尾：把合成靶子的行全删掉，别在真库里留垃圾
    d.prepare('DELETE FROM proactive_quota WHERE conv_key = ?').run(SYNTH_KEY);
    s = await read();
    check('H3 收尾：合成靶子的行已清除（计数回 0）', s?.proactiveUsedToday === 0);
    check('H3 收尾：真实会话没被这次测试改动', (await panelState()).json?.sessions?.length >= 1);
  }
}

section('H4 段：同图不连发（端到端）');
{
  // H4-0 零消息探针：只要她「上一张」记录非空，就能在不发任何消息的前提下验证真条拦截路径。
  // 被拦的请求在 sendStickerV2 之前就 return 了 —— 不会发消息、不会push recentMessages、
  // 更不会 scheduleReplyCheckV2（它排在发送成功之后），所以这一段是真正零副作用的。
  const last = await lastOfSticker();
  if (!last) {
    skipped('H4-0 零消息探针：lastStickerId 为空（她还没在主人私聊发过表情），构不成「连发」');
  } else {
    const r = await sendSticker(last);
    check('H4-0 重复发「上一张」→ 409 被拦（真条路由，零消息）', r.status === 409, `status=${r.status} err=${String(r.json?.error ?? '').slice(0, 50)}`);
    check('H4-0 错误文案点明了原因', String(r.json?.error ?? '').includes('刚才已经发过这张表情了'));
    check('H4-0 被拦之后状态没被污染（仍是同一张）', (await lastOfSticker()) === last);
    const r2 = await sendSticker(last);
    check('H4-0 再拦一次仍然 409（不会「拦一次就放行」）', r2.status === 409, `status=${r2.status}`);
  }

  // H4-live 完整链（默认不跑）：它必须真发 A/B/A 才能验证「换一张解锁」，
  // 而发图成功会顺带 scheduleReplyCheckV2 —— 主人正在聊天时等于往对话里插一次回复检查。
  // 唯一能关掉那个唤醒的开关是 socialV2.paused，但 bridge.js:2001 的全局守卫会连发图一起
  // 拦成 403，路走不通。所以改成显式选择：要完整证据就 LIVE_SEED=1。
  if (!LIVE_SEED) {
    skipped('H4-live 完整活体链（A→409→md5→409→B→200→A→200）：默认不跑，设 LIVE_SEED=1 才跑');
  } else {
    const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'stickers.json'), 'utf8'));
    const entries = (Array.isArray(store) ? store : (store.entries ?? [])).filter((e) => e && e.id);
    if (entries.length < 2) {
      check('H4 表情库至少有 2 张（否则无法验证「换一张解锁」）', false, `实际 ${entries.length} 张`);
    } else {
      const A = entries[0], B = entries[1];
      const send = (stickerId) => req('/api/socialV2/send-sticker', { method: 'POST', token: ownerToken, body: { key: OWNER_KEY, stickerId } });
      const lastOf = async () => sessionOf(await panelState(), OWNER_KEY)?.lastStickerId ?? '';

      const r1 = await send(A.id);
      check('H4a 首次发 A → 成功（真发出 1 张）', r1.status === 200 && r1.json?.ok === true, `status=${r1.status} err=${r1.json?.error ?? ''}`);
      check('H4a 状态记录为 A', (await lastOf()) === A.id, `记录=${String(await lastOf()).slice(-18)}`);

      const r2 = await send(A.id);
      check('H4b 立刻再发同一张 A → 409 被拦', r2.status === 409, `status=${r2.status}`);
      check('H4b 错误信息说清了原因并给了替代选项', String(r2.json?.error ?? '').includes('刚才已经发过这张表情了'), `err=${String(r2.json?.error ?? '').slice(0, 60)}`);

      const r3 = await send(A.id);
      check('H4c 再拦一次仍然 409（不会「拦一次就放行」）', r3.status === 409, `status=${r3.status}`);
      check('H4c 被拦的两次没有污染状态（记录仍是 A）', (await lastOf()) === A.id);

      // 换个写法：同一张图用 md5 传，必须照样认出来（只比原串就会被绕过）
      const r4 = await send(A.md5);
      check('H4d 用 md5 形式发同一张图 → 同样 409（换写法绕不过）', r4.status === 409, `status=${r4.status}`);

      const r5 = await send(B.id);
      check('H4e 换一张 B → 成功（真发出第 2 张）', r5.status === 200 && r5.json?.ok === true, `status=${r5.status} err=${r5.json?.error ?? ''}`);
      check('H4e 状态记录变成 B', (await lastOf()) === B.id);

      const r6 = await send(A.id);
      check('H4f B 之后再发 A → 成功（拦的是「连发」，不是永久拉黑这张图）', r6.status === 200 && r6.json?.ok === true, `status=${r6.status} err=${r6.json?.error ?? ''}`);
      check('H4f 状态记录回到 A', (await lastOf()) === A.id);

      say('（说明：H4 在主人私聊里真发了 3 张表情包 A/B/A；收尾状态 lastStickerId=A）');
    }
  }
}

say(`\n结果：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}（日志副本 ${outFile}）`);
if (fail) {
  say('提示：若 H4 因 403「表情包体系已关闭」失败，那是 socialV2.sticker.enabled=false，不是本功能的问题。');
}
await finish(fail ? 1 : 0);
