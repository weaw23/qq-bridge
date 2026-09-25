// 定时提醒 repeat + mode=ai 回归测试（P0-1）
// 用法：node ops/test-repeat-reminders.mjs      （H 段需桥接在运行，且已加载新 schema）
//
// 背景（2026-09-25）：reminders 表只能一次性、最远 15 天，没有 repeat、没有 mode；
// 而且 reason='reminder' 在 buildWakePromptV2 里根本没有专属分支，会落到默认分支问
// 「群里在聊什么？热闹还是冷清？」——提醒到点时她被这么问，措辞完全是错位的。
//
// 设计要点：
// - U 段是纯函数单测，全部喂固定 now：不喂固定时间的话，测试会随「跑的时刻」时红时绿。
// - H 段用**非白名单合成会话键** group:123456789：白名单检查在扫描器里，
//   所以提醒会真的到期、真的被重排，但唤醒那一步会被跳过 —— 端到端验证且零副作用
//   （一个字都不会发到任何群/任何人）。
// - 保留一条一次性提醒的回归：重复提醒的重排逻辑不能把旧行为带坏。
import fs from 'node:fs';
import path from 'node:path';
import {
  parseHmString, normalizeRepeatSpec, nextRepeatFireMs, repeatFromRow, repeatColumnsFor, describeRepeat
} from '../src/repeat-schedule.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';
const LOG_FILE = path.join(ROOT, 'state', 'bridge.log');

// 自tee：WMI/后台方式跑时 stdout 会被丢掉，落一份到 outbox 便于事后核对
const outFile = path.join(ROOT, '..', 'outbox', 'pc-jobs', 'test-repeat.log');
try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch {}
try { fs.writeFileSync(outFile, ''); } catch {}
function say(line) {
  console.log(line);
  try { fs.appendFileSync(outFile, line + '\n'); } catch {}
}

let pass = 0;
let fail = 0;
function check(name, cond, note = '') {
  if (cond) { pass++; say(`✅ ${name}${note ? '  ' + note : ''}`); }
  else { fail++; say(`❌ ${name}${note ? '  ' + note : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 统一收尾：fetch 的 keep-alive socket 正在关闭时立刻 process.exit() 会触发
// libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（stderr 里像测试崩了），
// 所以先给事件循环一点时间把 socket 关干净。
async function finish(code) {
  say('');
  say(`结果：${pass} 通过 / ${fail} 失败（日志副本 ${outFile}）`);
  await sleep(500);
  process.exit(code);
}

// ── U 段：repeat-schedule.js 纯函数 ────────────────────────────────────────
say('── U 段：时间计算单测（固定 now，不依赖真实时刻）──');
{
  check('parseHmString: 09:00', JSON.stringify(parseHmString('09:00')) === '{"h":9,"min":0}');
  check('parseHmString: 9:05（单位数小时也接）', JSON.stringify(parseHmString('9:05')) === '{"h":9,"min":5}');
  check('parseHmString: 00:00', JSON.stringify(parseHmString('00:00')) === '{"h":0,"min":0}');
  check('parseHmString: 23:59', JSON.stringify(parseHmString('23:59')) === '{"h":23,"min":59}');
  check('parseHmString: 24:00 → null', parseHmString('24:00') === null);
  check('parseHmString: 09:60 → null', parseHmString('09:60') === null);
  check('parseHmString: 9:5 → null（分钟必须两位）', parseHmString('9:5') === null);
  check('parseHmString: 空/乱填 → null', parseHmString('') === null && parseHmString('abc') === null && parseHmString(null) === null);

  const bad = (raw) => Boolean(normalizeRepeatSpec(raw).error);
  check('repeat: null/空 → 不重复（repeat=null、无 error）', normalizeRepeatSpec(null).repeat === null && !normalizeRepeatSpec(null).error && normalizeRepeatSpec('').repeat === null);
  check('repeat: 字符串 → 报错', bad('daily'));
  check('repeat: 数组 → 报错', bad([1, 2]));
  check('repeat: kind 不认识 → 报错', bad({ kind: 'hourly', at: '09:00' }));
  check('repeat: daily 缺 at → 报错', bad({ kind: 'daily' }));
  check('repeat: daily at 非法 → 报错', bad({ kind: 'daily', at: '25:00' }));
  check('repeat: daily 合法', JSON.stringify(normalizeRepeatSpec({ kind: 'daily', at: '9:00' }).repeat) === '{"kind":"daily","at":"09:00"}');
  check('repeat: weekly 缺 days → 报错', bad({ kind: 'weekly', at: '09:00' }));
  check('repeat: weekly days 全非法 → 报错', bad({ kind: 'weekly', at: '09:00', days: [0, 8, 'x'] }));
  check('repeat: weekly days 去重排序（1,3,3,9 → 1,3；9 被丢）', JSON.stringify(normalizeRepeatSpec({ kind: 'weekly', at: '09:00', days: [3, 1, 3, 9] }).repeat) === '{"kind":"weekly","at":"09:00","days":[1,3]}');
  check('repeat: interval 0 分钟 → 报错', bad({ kind: 'interval', everyMinutes: 0 }));
  check('repeat: interval 负 → 报错', bad({ kind: 'interval', everyMinutes: -5 }));
  check('repeat: interval 超 15 天 → 报错', bad({ kind: 'interval', everyMinutes: 21601 }));
  check('repeat: interval 21600（=15天）合法', normalizeRepeatSpec({ kind: 'interval', everyMinutes: 21600 }).repeat?.everyMinutes === 21600);
  check('repeat: interval 小数取整', normalizeRepeatSpec({ kind: 'interval', everyMinutes: 30.6 }).repeat?.everyMinutes === 31);

  // 固定基准：2026-01-15(周四, ISO=4) 08:00 本地
  const T = (h, m = 0, day = 15) => new Date(2026, 0, day, h, m, 0, 0).getTime();
  check('基准日期是周四（ISO 4）', new Date(T(8)).getDay() === 4);

  const daily = { kind: 'daily', at: '09:00' };
  check('daily: 08:00 问 → 今天 09:00', nextRepeatFireMs(daily, T(8)) === T(9));
  check('daily: 10:00 问 → 明天 09:00', nextRepeatFireMs(daily, T(10)) === T(9, 0, 16));
  check('daily: 09:00:00 整点问 → 明天（躲开扫描窗口，不连环自触发）', nextRepeatFireMs(daily, T(9)) === T(9, 0, 16));
  check('daily: 08:59:55 问 → 明天（10 秒 epsilon 内也算已过）', nextRepeatFireMs(daily, T(8, 59) + 55000) === T(9, 0, 16));
  check('daily: 08:59:45 问 → 今天 09:00（刚好在 epsilon 外，仍赶得上）', nextRepeatFireMs(daily, T(8, 59) + 45000) === T(9));
  check('daily: 跨月正确（1-31 10:00 → 2-1 09:00）', nextRepeatFireMs(daily, new Date(2026, 0, 31, 10, 0, 0).getTime()) === new Date(2026, 1, 1, 9, 0, 0, 0).getTime());

  const wk = (days) => ({ kind: 'weekly', at: '09:00', days });
  check('weekly: 含今天(周四)且未到点 → 今天', nextRepeatFireMs(wk([4]), T(8)) === T(9));
  check('weekly: 含今天(周四)但已过点 → 下周四', nextRepeatFireMs(wk([4]), T(10)) === T(9, 0, 22));
  check('weekly: 周五 → 明天（1-16）', nextRepeatFireMs(wk([5]), T(8)) === T(9, 0, 16));
  check('weekly: 周日 → 1-18（ISO 7 映射正确）', nextRepeatFireMs(wk([7]), T(8)) === T(9, 0, 18));
  check('weekly: 周一 → 1-19', nextRepeatFireMs(wk([1]), T(8)) === T(9, 0, 19));
  check('weekly: 多天取最近的那个（[1,5,4] → 今天周四）', nextRepeatFireMs(wk([1, 5, 4]), T(8)) === T(9));
  check('weekly: 空 days → 0', nextRepeatFireMs(wk([]), T(8)) === 0);

  check('interval: now + N 分钟', nextRepeatFireMs({ kind: 'interval', everyMinutes: 30 }, T(8)) === T(8) + 1800000);
  check('interval: 超限被夹到 15 天', nextRepeatFireMs({ kind: 'interval', everyMinutes: 999999 }, T(8)) === T(8) + 21600 * 60000);
  // 相位锁定（第三个参数 fromMs = 上一次的触发时刻）。这是修复「每 1 分钟实际 60~90 秒、
  // 每触发一次漂一点」的核心断言：早先只有 <20000 的宽区间，宽到能盖住 70s 的真实缺陷。
  check('interval: 给了 fromMs → 以上次触发为基准，相位不漂',
    nextRepeatFireMs({ kind: 'interval', everyMinutes: 30 }, T(8, 1), T(8)) === T(8, 30));
  check('interval: fromMs 在过去很久（停机）→ 一步跳到第一个未来周期且相位仍对齐', (() => {
    const base = T(8) - 3 * 86400000;                        // 三天前触发过一次
    const n = nextRepeatFireMs({ kind: 'interval', everyMinutes: 30 }, T(8), base);
    return n > T(8) + 10000 && (n - base) % 1800000 === 0;   // 落在未来，且正好是基线的整数个周期
  })());
  check('interval: fromMs 为 0/缺省 → 退回 now + N（向后兼容，不传就是老行为）',
    nextRepeatFireMs({ kind: 'interval', everyMinutes: 30 }, T(8), 0) === T(8) + 1800000);
  check('daily/weekly 不受 fromMs 影响（绝对时刻）',
    nextRepeatFireMs(daily, T(8), T(8) - 5 * 86400000) === T(9));
  check('nextRepeatFireMs: 坏输入 → 0', nextRepeatFireMs(null, T(8)) === 0 && nextRepeatFireMs({ kind: 'nope' }, T(8)) === 0 && nextRepeatFireMs({ kind: 'daily', at: 'zz' }, T(8)) === 0);

  check('repeatFromRow: 无 repeat_kind → null', repeatFromRow({ repeat_kind: '', repeat_at: '', every_ms: 0 }) === null);
  check('repeatFromRow: daily 还原', JSON.stringify(repeatFromRow({ repeat_kind: 'daily', repeat_at: '09:00' })) === '{"kind":"daily","at":"09:00"}');
  check('repeatFromRow: weekly 还原', JSON.stringify(repeatFromRow({ repeat_kind: 'weekly', repeat_at: '09:00', repeat_days: '[1,3]' })) === '{"kind":"weekly","at":"09:00","days":[1,3]}');
  check('repeatFromRow: weekly repeat_days 烂 JSON → null（坏行兜底置 fired）', repeatFromRow({ repeat_kind: 'weekly', repeat_at: '09:00', repeat_days: '{oops' }) === null);
  check('repeatFromRow: weekly at 非法 → null', repeatFromRow({ repeat_kind: 'weekly', repeat_at: 'nope', repeat_days: '[1]' }) === null);
  check('repeatFromRow: interval 还原（30 分钟）', JSON.stringify(repeatFromRow({ repeat_kind: 'interval', every_ms: 1800000 })) === '{"kind":"interval","everyMinutes":30}');
  check('repeatFromRow: interval every_ms=0 → null', repeatFromRow({ repeat_kind: 'interval', every_ms: 0 }) === null);

  // 列往返：normalize → 存列 → 从行还原，必须与原始规格一致
  for (const spec of [daily, { kind: 'weekly', at: '07:30', days: [2, 4, 6] }, { kind: 'interval', everyMinutes: 45 }]) {
    const norm = normalizeRepeatSpec(spec).repeat;
    const cols = repeatColumnsFor(norm);
    const back = repeatFromRow({ repeat_kind: cols.repeat_kind, repeat_at: cols.repeat_at, repeat_days: cols.repeat_days, every_ms: cols.every_ms });
    check(`列往返一致：${describeRepeat(norm)}`, JSON.stringify(back) === JSON.stringify(norm));
  }
  check('repeatColumnsFor: 无 repeat → 全空/0', JSON.stringify(repeatColumnsFor(null)) === '{"repeat_kind":"","repeat_at":"","repeat_days":"","every_ms":0}');

  check('describeRepeat: daily → 每天 09:00', describeRepeat(daily) === '每天 09:00');
  check('describeRepeat: weekly [1,3] → 每周一/三 09:00', describeRepeat({ kind: 'weekly', at: '09:00', days: [1, 3] }) === '每周一/三 09:00');
  check('describeRepeat: weekly [7] → 每周日（ISO 7 映射）', describeRepeat({ kind: 'weekly', at: '09:00', days: [7] }) === '每周日 09:00');
  check('describeRepeat: interval → 每 30 分钟', describeRepeat({ kind: 'interval', everyMinutes: 30 }) === '每 30 分钟');
  check('describeRepeat: null → 空串', describeRepeat(null) === '');

  // 接线检查（源码级）：这两个分支一旦被误删，提示词就退回默认的「群里在聊什么」，
  // 而那是运行时才看得出来的错位。这里只是防止被悄悄删掉，不等于验证了行为。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  check('接线：buildWakePromptV2 有 reminder 分支', src.includes("if (reason === 'reminder')"));
  check('接线：buildWakePromptV2 有 schedule 分支', src.includes("if (reason === 'schedule')"));
  check("接线：扫描器按 mode 分派 schedule/reminder", src.includes("isAi ? 'schedule' : 'reminder'"));
  check('接线：重复提醒触发后原地重排（不置 fired）', src.includes('UPDATE reminders SET fire_at = ? WHERE id = ? AND status = ?'));
}

// ── H 段：HTTP 端到端 ──────────────────────────────────────────────────────
say('');
say('── H 段：HTTP 端到端（合成非白名单会话键，零副作用）──');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const sessions = [];
(function walk(node, keyHint) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.agentToken === 'string' && node.agentToken) { sessions.push({ key: keyHint, token: node.agentToken }); return; }
  for (const [k, v] of Object.entries(node)) walk(v, /^(group|private):\d+$/.test(k) ? k : keyHint);
})(sv, '');
const owner = sessions.find((s) => s.key === 'private:' + String(cfg.ownerQQ ?? '').trim());
if (!owner) { say('❌ 找不到主人私聊会话令牌，无法跑 H 段'); process.exit(1); }
const TOKEN = owner.token; // 绝不打印

// 合成一个肯定不在白名单里的群号；白名单检查在扫描器里，所以这里能建、能到期、能重排，
// 但唤醒会被跳过 —— 正是我们要的「端到端但不打扰任何人」。
const allowGroups = (cfg.allow?.groups ?? []).map(String);
let SYNTH = '123456789';
while (allowGroups.includes(SYNTH)) SYNTH = String(Number(SYNTH) + 1);
const KEY = `group:${SYNTH}`;

async function api(p, body) {
  // 调用约定（照 test-cross-session.mjs）：x-console-token 是总闸（漏了会 401
  // 「未授权：请提供控制台访问令牌」），x-agent-token 才是会话令牌；两者都要带。
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, 'x-agent-token': TOKEN },
    body: JSON.stringify({ key: KEY, ...body }),
    signal: AbortSignal.timeout(20000)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const health = await fetch(BASE + '/api/panel/overview', { headers: { 'x-console-token': consoleToken } })
  .then((r) => r.json()).catch(() => null);
if (!health?.qq) { say('❌ 桥接不可达或面板异常，H 段无法进行'); process.exit(1); }
const bridgePid = health.pid;
say(`（桥接 pid=${bridgePid}，合成靶子 ${KEY}，白名单 ${allowGroups.join('/')}）`);

// H1 建重复提醒（interval 1 分钟 → 很快就能观察到真实触发）
const h1 = await api('/api/socialV2/reminder/set', { text: '自检：重复提醒端到端（非白名单靶子，不会发出去）', repeat: { kind: 'interval', everyMinutes: 1 }, mode: 'ai' });
check('H1 interval 重复提醒建成功', h1.status === 200 && h1.json?.ok === true, `status=${h1.status} err=${h1.json?.error ?? ''}`);
check('H1 回执带回 repeat 规格与 mode', h1.json?.repeat?.kind === 'interval' && h1.json?.repeat?.everyMinutes === 1 && h1.json?.mode === 'ai');
check('H1 回执 id 是正整数', Number.isInteger(h1.json?.id) && h1.json.id > 0);
// 早退闸：桥接还没加载新代码时（/set 不认识 repeat），H 段后面全靠等真实触发，
// 空等 170 秒毫无信息量。这里直接中止，把「测试本身不是空断言」这件事摆明。
if (!h1.json?.repeat) {
  say('⚠️ 桥接未返回 repeat 字段 —— 说明运行中的桥接还是旧代码（或旧 schema）。');
  say('   H 段中止；先重启桥接再跑。');
  await finish(1);
}
const idInterval = h1.json?.id;
const fireAt0 = h1.json?.fireAt;
check('H1 首次触发 ≈ 1 分钟后', Math.abs(fireAt0 - (Date.now() + 60000)) < 15000, `Δ=${Math.round((fireAt0 - Date.now()) / 1000)}s`);

// H2 列表回读
const h2 = await api('/api/socialV2/reminder/list', {});
const row2 = (h2.json?.reminders ?? []).find((r) => r.id === idInterval);
check('H2 列表里能读到这条重复提醒', Boolean(row2));
check("H2 mode='ai' 已落库", row2?.mode === 'ai');
check('H2 repeat 对象可还原', row2?.repeat?.kind === 'interval' && row2?.repeat?.everyMinutes === 1);
check('H2 repeatLabel 可读', row2?.repeatLabel === '每 1 分钟', `实际=${row2?.repeatLabel}`);

// H3/H4 参数校验
const h3 = await api('/api/socialV2/reminder/set', { text: 'x', repeat: { kind: 'daily' } });
check('H3 repeat 缺 at → 400 且带原因', h3.status === 400 && String(h3.json?.error ?? '').includes('repeat.at'), `status=${h3.status} err=${h3.json?.error ?? ''}`);
const h3b = await api('/api/socialV2/reminder/set', { text: 'x', repeat: { kind: 'weekly', at: '09:00' } });
check('H3 weekly 缺 days → 400', h3b.status === 400 && String(h3b.json?.error ?? '').includes('repeat.days'));
const h3c = await api('/api/socialV2/reminder/set', { text: 'x', repeat: { kind: 'interval', everyMinutes: 0 } });
check('H3 interval 0 分钟 → 400', h3c.status === 400);
const h4 = await api('/api/socialV2/reminder/set', { text: 'x', mode: 'shout' });
check("H4 mode 非法 → 400（只能 text/ai）", h4.status === 400 && String(h4.json?.error ?? '').includes('mode'), `err=${h4.json?.error ?? ''}`);

// H5 daily / weekly 回执与列表标签
const h5a = await api('/api/socialV2/reminder/set', { text: 'x', repeat: { kind: 'daily', at: '09:07' } });
check('H5 daily 建成功且标签正确', h5a.json?.repeatLabel === '每天 09:07', `实际=${h5a.json?.repeatLabel}`);
const h5b = await api('/api/socialV2/reminder/set', { text: 'x', repeat: { kind: 'weekly', at: '20:30', days: [3, 1, 3] } });
check('H5 weekly 去重排序且标签正确', h5b.json?.repeatLabel === '每周一/三 20:30', `实际=${h5b.json?.repeatLabel}`);
check('H5 weekly 默认 mode 是 text', h5b.json?.mode === 'text');

// H6 取消重复提醒
const h6 = await api('/api/socialV2/reminder/cancel', { id: h5a.json?.id });
const h6list = await api('/api/socialV2/reminder/list', {});
check('H6 取消重复提醒成功', h6.json?.cancelled === 1, `cancelled=${h6.json?.cancelled}`);
check('H6 取消后不再出现在 pending 列表', !(h6list.json?.reminders ?? []).some((r) => r.id === h5a.json?.id));
await api('/api/socialV2/reminder/cancel', { id: h5b.json?.id });

// H7 一次性提醒回归：不能被重复逻辑带坏
const h7 = await api('/api/socialV2/reminder/set', { text: '自检：一次性提醒回归', delayMinutes: 0.5 });
check('H7 一次性提醒建成功（repeat=null）', h7.status === 200 && h7.json?.ok === true && h7.json?.repeat === null);
const idOneShot = h7.json?.id;

// H8 等真实触发：重复的重排、一次性的置 fired
say('（等待真实触发，最多 170 秒…）');
let intervalRescheduled = false;
let oneShotFired = false;
let fireAtNew = 0;
const deadline = Date.now() + 170000;
while (Date.now() < deadline && !(intervalRescheduled && oneShotFired)) {
  await sleep(5000);
  const st = await api('/api/socialV2/reminder/list', {});
  const ri = (st.json?.reminders ?? []).find((r) => r.id === idInterval);
  if (ri && ri.fireAt > fireAt0) { intervalRescheduled = true; fireAtNew = ri.fireAt; }
  if (!(st.json?.reminders ?? []).some((r) => r.id === idOneShot)) oneShotFired = true;
}
check('H8 重复提醒触发后仍 pending（没被置 fired）', intervalRescheduled, intervalRescheduled ? `下次 ${new Date(fireAtNew).toLocaleString('zh-CN')}` : '未观察到重排');
// 相位锁定：下次 = 上次 fire_at + 1 个周期，Δ 必须就是 60s（±5s 容差只留给取整）。
// 早先断言写成 < 20000，宽到能盖住「以扫描时刻为基准」的漂移缺陷（实测 70s 也算过）——那是个假绿。
check('H8 重排后的时间正好推后 1 个周期（相位不漂）', intervalRescheduled && Math.abs((fireAtNew - fireAt0) - 60000) < 5000, `Δ=${((fireAtNew - fireAt0) / 1000).toFixed(1)}s`);
check('H8 一次性提醒触发后离开 pending（旧行为未回归）', oneShotFired);

// 日志取证：重排与「不在白名单→跳过唤醒」两行都要有，证明真的走到扫描器且没打扰任何人
const logText = fs.readFileSync(LOG_FILE, 'utf8');
const logLines = logText.split('\n');
check(`H8 日志有「重复 #${idInterval} 已重排」`, logLines.some((l) => l.includes(`重复 #${idInterval} 已重排`)));
check(`H8 日志有「跳过 #${idInterval}（不在白名单）」`, logLines.some((l) => l.includes(`跳过 #${idInterval}`) && l.includes('不在白名单')));
// 「已触发 #N」那行 log 在扫描器里位于白名单检查之后 —— 非白名单靶子会先 continue，
// 所以这里只能断言「被捞出来并跳过」。这本身就是零副作用的证据：唤醒路径根本没走到。
// （白名单路径上的「已触发」「注入唤醒 schedule」需要真靶子才会出现，见下方 finish 后的说明。）
check(`H8 日志有「跳过 #${idOneShot}（不在白名单）」（一次性提醒也被扫描器捞到了）`, logLines.some((l) => l.includes(`跳过 #${idOneShot}`) && l.includes('不在白名单')));
check('H8 未对该靶子注入唤醒（零副作用）', !logLines.some((l) => l.includes(`唤醒 ${KEY}`)));

// 收尾：清掉自检留下的重复提醒
const cleanup = await api('/api/socialV2/reminder/cancel', { id: idInterval });
check('收尾：自检用的重复提醒已取消', cleanup.json?.cancelled === 1);

await finish(fail ? 1 : 0);
