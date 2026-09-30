#!/usr/bin/env node
// persona-state（心情/精力/态度状态层）回归测试 —— 全离线，不碰线上、日志、state/、当前时间。
// 运行：node ops/test-persona-state.mjs
import {
  STATE_BASE, STATE_VERSION, STATE_HALF_LIFE_MS, STATE_EVENTS,
  clampState, newState, decayValue, decayState, applyEvents,
  stateTendency, renderStateLine, serializeState, deserializeState, stateStats
} from '../src/persona-state.js';

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
const H = 3600 * 1000;
const T0 = 1759100000000; // 固定基准时刻，不读系统时间

console.log('persona-state 回归测试（离线）');
console.log(`基准：心情 ${STATE_BASE.mood} / 精力 ${STATE_BASE.energy}；事件表 ${Object.keys(STATE_EVENTS).length} 种`);

section('T1 脏数据一律修成合法值（绝不产生 NaN / 越界）');
{
  const cases = [undefined, null, {}, { mood: NaN, energy: NaN }, { mood: -5, energy: 999 }, { mood: '80', energy: '20' }, { mood: Infinity }];
  const all = cases.map(clampState);
  check('T1.1 每种脏输入都产出合法 number', all.every((s) => Number.isFinite(s.mood) && Number.isFinite(s.energy)), JSON.stringify(all[4]));
  check('T1.2 越界值被夹回 0..100', all[4].mood === 0 && all[4].energy === 100, JSON.stringify(all[4]));
  check('T1.3 字符串数字不被采信（回落到基准线，避免 "80"+1="801"）', all[5].mood === STATE_BASE.mood, JSON.stringify(all[5]));
  check('T1.4 Infinity 回落到基准线', all[6].mood === STATE_BASE.mood && all[6].energy === STATE_BASE.energy);
  check('T1.5 newState 用传入的 nowMs', newState(T0).updatedAtMs === T0 && newState(T0).mood === STATE_BASE.mood);
}

section('T2 时间衰减：向基准线回归、单调、半衰期正确');
{
  const low = { mood: 10, energy: 10, updatedAtMs: T0 };
  const half = decayState(low, { fromMs: T0, toMs: T0 + STATE_HALF_LIFE_MS.energy });
  const expectEnergy = STATE_BASE.energy + (10 - STATE_BASE.energy) * 0.5;
  check('T2.1 精力过了一个半衰期正好走完一半路程', Math.abs(half.energy - expectEnergy) < 0.2, `energy=${half.energy} 期望≈${expectEnergy.toFixed(1)}`);
  check('T2.2 心情同样的时间只走一点点（半衰期 12h）', half.mood > 10 && half.mood < 40, `mood=${half.mood}`);
  // 注意指数衰减是"差距"减半，不是"值"减半：心情半衰期 12h，48h 只走 4 个半衰期，
  // 差距还剩 1/16（50 → 3.1），所以 mood≈56.9 是**正确**的。要回到基准线附近得等 8 个半衰期。
  const long = decayState(low, { fromMs: T0, toMs: T0 + 96 * H });
  check('T2.3 八个半衰期后基本回到基准线', Math.abs(long.energy - STATE_BASE.energy) < 1 && Math.abs(long.mood - STATE_BASE.mood) < 1, JSON.stringify(long));
  const four = decayState(low, { fromMs: T0, toMs: T0 + 48 * H });
  check('T2.3b 四个半衰期只走掉 15/16 的差距（差值≈3.1）', Math.abs(four.mood - 56.9) < 0.2, `mood=${four.mood}`);
  const same = decayState(low, { fromMs: T0, toMs: T0 });
  check('T2.4 时间没走 → 状态原样', same.mood === 10 && same.energy === 10);
  const back = decayState({ mood: 95, energy: 95, updatedAtMs: T0 }, { fromMs: T0, toMs: T0 + 12 * H });
  check('T2.5 高于基准线也往下走（不是只涨不跌）', back.mood < 95 && back.energy < 95, JSON.stringify(back));
  const rev = decayState(low, { fromMs: T0 + 5 * H, toMs: T0 }); // 时间倒流
  check('T2.6 时间倒流不炸也不改值', rev.mood === 10 && rev.energy === 10);
  check('T2.7 decayValue 非数值输入不产生 NaN', Number.isFinite(decayValue('x', STATE_BASE.mood, T0, T0 + H, 4 * H)));
}

section('T3 事件叠加');
{
  const s = applyEvents(newState(T0), [{ type: 'praise', at: T0 }, { type: 'praise', at: T0 }]);
  check('T3.1 被夸两次：心情 +16、精力 +8', s.mood === STATE_BASE.mood + 16 && s.energy === STATE_BASE.energy + 8, JSON.stringify(s));
  const bad = applyEvents(newState(T0), [{ type: 'insult', at: T0 }, { type: 'ignored', at: T0 }, { type: 'scolded', at: T0 }]);
  check('T3.2 被骂+被无视+被凶 → 心情明显掉下来', bad.mood <= 33, `mood=${bad.mood}`);
  const clamped = applyEvents({ mood: 5, energy: 5, updatedAtMs: T0 }, [{ type: 'insult', at: T0 }]);
  check('T3.3 掉到 0 以下会被夹住，不会变负数', clamped.mood === 0, JSON.stringify(clamped));
  const unknown = applyEvents(newState(T0), [{ type: '不存在的怪事件', at: T0 }, { type: 'praise', at: T0 }]);
  check('T3.4 未知事件被忽略、不抛错，后面的正常事件照算', unknown.mood === STATE_BASE.mood + 8, JSON.stringify(unknown));
  const weighted = applyEvents(newState(T0), [{ type: 'praise', at: T0, weight: 2 }]);
  check('T3.5 weight 生效（倍数）', weighted.mood === STATE_BASE.mood + 16, `mood=${weighted.mood}`);
  const gap = applyEvents({ mood: 20, energy: 20, updatedAtMs: T0 }, [{ type: 'praise', at: T0 + 24 * H }]);
  // 24h = 心情的两个半衰期：20 → 60-40*0.25 = 50，再 +8 = 58。断言"先衰减再叠加"而不是"回到 60 以上"。
  check('T3.6 事件之间先衰减再叠加（24h 后差距只剩 1/4，再 +8）', gap.mood >= 56 && gap.mood <= 60 && gap.mood > 20, `mood=${gap.mood}`);
  const noEv = applyEvents(newState(T0), [], { nowMs: T0 + 8 * H });
  check('T3.7 没有事件但时间在走 → 也会按 nowMs 衰减', noEv.updatedAtMs === T0 + 8 * H, JSON.stringify(noEv));
  check('T3.8 非数组 events 不炸', applyEvents(newState(T0), null).mood === STATE_BASE.mood);
  const dirty = applyEvents({ mood: NaN, energy: 500 }, [{ type: 'chat', at: T0 }]);
  check('T3.9 脏起点先修再算', Number.isFinite(dirty.mood) && dirty.energy <= 100, JSON.stringify(dirty));
}

section('T4 倾向与建议（阶段 2 的验收口径）');
{
  const tired = stateTendency({ mood: 55, energy: 15, updatedAtMs: T0 });
  check('T4.1 精力极低 → 尽量只说一句', tired.lengthHint === 'minimal', tired.lengthHint);
  check('T4.2 精力极低 → 主动性 off（除被 @ 不开口）', tired.initiativeHint === 'off', tired.initiativeHint);
  check('T4.3 精力极低 → 很困', tired.sleepyHard === true);
  const low = stateTendency({ mood: 30, energy: 45, updatedAtMs: T0 });
  check('T4.4 心情低 → 语气低、可以有点蔫', low.toneHint === 'low' && low.canBeGrumpy === true, `${low.toneHint}/${low.canBeGrumpy}`);
  check('T4.5 心情低 → 建议说短一点', low.lengthHint === 'short', low.lengthHint);
  const happy = stateTendency({ mood: 85, energy: 80, updatedAtMs: T0 });
  check('T4.6 心情好+精力足 → 可以多说两句、可以主动找话头', happy.lengthHint === 'long' && happy.initiativeHint === 'high', `${happy.lengthHint}/${happy.initiativeHint}`);
  check('T4.7 心情很好 → 语气明亮', happy.toneHint === 'bright', happy.toneHint);
  const night = stateTendency({ mood: 70, energy: 80, updatedAtMs: T0 }, { hour: 3 });
  check('T4.8 凌晨三点 → 困（哪怕精力满）', night.sleepyHard === true && night.sleepy === true);
  const noon = stateTendency({ mood: 70, energy: 80, updatedAtMs: T0 }, { hour: 14 });
  check('T4.9 下午不困', noon.sleepy === false);
  check('T4.10 每种 lengthHint 都有中文建议', ['long', 'mid', 'short', 'minimal'].every((k) => stateTendency({ mood: k === 'long' ? 90 : 50, energy: k === 'minimal' ? 5 : k === 'short' ? 35 : 70 }).advice.length > 4));
  check('T4.11 脏状态不炸', typeof stateTendency(null).advice === 'string');
}

section('T5 注入提示词的那一行（硬上限 90 字）');
{
  const line = renderStateLine({ mood: 42, energy: 28, updatedAtMs: T0 });
  check('T5.1 长度 ≤ 90 字', line.length <= 90, `${line.length} 字`);
  check('T5.2 含三个数字（心情/精力），方便她感知量级', /心情 \d+/.test(line) && /精力 \d+/.test(line), JSON.stringify(line));
  check('T5.3 含"建议"而不是成句台词（状态机不许写模板句）', line.includes('建议：') && !line.includes('鲸鲸说'));
  const sleepyLine = renderStateLine({ mood: 30, energy: 12, updatedAtMs: T0 });
  check('T5.4 蔫的时候那一行也读得出来', /蔫|困|不想/.test(sleepyLine), JSON.stringify(sleepyLine));
  say(`精力充沛：${renderStateLine({ mood: 85, energy: 80, updatedAtMs: T0 })}`);
  say(`有点蔫　：${sleepyLine}`);
  const dirtyLine = renderStateLine({ mood: NaN, energy: 'x' });
  check('T5.5 脏状态渲染不炸且仍在 90 字内', typeof dirtyLine === 'string' && dirtyLine.length <= 90);
}

section('T6 序列化（要能落盘进 state/social-v2.json 并在重启后还原）');
{
  const s = { mood: 33.4, energy: 71.2, updatedAtMs: T0 };
  const ser = serializeState(s, T0);
  check('T6.1 带版本号 v', ser.v === STATE_VERSION, JSON.stringify(ser));
  const back = deserializeState(ser, T0);
  check('T6.2 序列化→反序列化 无损', back.mood === 33.4 && back.energy === 71.2 && back.updatedAtMs === T0, JSON.stringify(back));
  check('T6.3 版本号不符 → 回落成新状态（旧结构不会污染）', deserializeState({ v: 99, mood: 10 }).mood === STATE_BASE.mood);
  check('T6.4 垃圾输入（null/字符串/数字）不炸', [null, 'x', 7, [], undefined].every((x) => Number.isFinite(deserializeState(x, T0).mood)));
  check('T6.5 只丢了 updatedAtMs 也能读（其余字段保留）', deserializeState({ v: 1, mood: 20, energy: 30 }, T0).mood === 20);
  check('T6.6 落盘值不带 NaN / 不带多余字段', Object.keys(ser).sort().join(',') === 'energy,mood,updatedAtMs,v');
  // T6.7~T6.9：回归 2026-09-29 线上自检发现的真 bug —— bridge 调 serializeState(s) 不带 nowMs，
  // 默认 0 被 num(0, x) 当成有效值，每次落盘都把 updatedAtMs 写成 0；重启读回后
  // decayState 的 dt ≈ 1.79e12ms，一步把心情/精力打回 60/70。
  const stamped = serializeState({ mood: 33, energy: 71, updatedAtMs: T0 });
  check('T6.7 不传 nowMs 时保留状态自己的 updatedAtMs（不再写成 0）', stamped.updatedAtMs === T0, JSON.stringify(stamped));
  const bad = deserializeState({ v: 1, mood: 20, energy: 30, updatedAtMs: 0 }, T0);
  check('T6.8 读回 updatedAtMs=0 的历史脏数据 → 补成 nowMs 而不是留 0', bad.updatedAtMs === T0, JSON.stringify(bad));
  const roundTrip = deserializeState(serializeState(applyEvents(newState(T0), [{ type: 'error' }], { nowMs: T0 + 60000 })), T0 + 60000);
  check('T6.9 落盘→重启读回：衰减不跳变（心情还是 54，不是被打回 60）',
    Math.abs(roundTrip.mood - 54) < 0.5, JSON.stringify(roundTrip));
}

section('T7 随机游走压力测试（500 步，固定种子）');
{
  const walk = (seed) => {
    const rand = mulberry32(seed);
    const kinds = Object.keys(STATE_EVENTS);
    let s = newState(T0); let t = T0; let bad = 0;
    const moods = []; const states = [];
    for (let i = 0; i < 500; i += 1) {
      t += Math.floor(rand() * 3 * H);
      if (rand() < 0.35) {
        const k = kinds[Math.floor(rand() * kinds.length)];
        s = applyEvents(s, [{ type: k, at: t }]);
      } else {
        s = decayState(s, { fromMs: s.updatedAtMs, toMs: t });
      }
      if (!Number.isFinite(s.mood) || !Number.isFinite(s.energy) || s.mood < 0 || s.mood > 100 || s.energy < 0 || s.energy > 100) bad += 1;
      moods.push(s.mood); states.push(s);
    }
    return { moods, states, bad, json: JSON.stringify(moods) };
  };
  const a = walk(20260929);
  check('T7.1 500 步无一步非法', a.bad === 0, `非法 ${a.bad} 步`);
  const range = Math.max(...a.moods) - Math.min(...a.moods);
  // ★ 第一版这里把 moods（一串数字）直接喂给 stateStats，而 stateStats 只认状态对象，
  //   数字被 clampState 当成脏数据回落成基准线 → 极差恒为 0、看起来像"状态根本没动"。
  //   是**测试写错**，不是模块错：要喂 states（对象数组）。
  const stats = stateStats(a.states);
  check('T7.2 心情确实在动（极差 > 15，不是恒定值）', range > 15, `极差=${range.toFixed(1)} ${JSON.stringify(stats)}`);
  check('T7.3 落在一段可读区间里（4~100）', Math.min(...a.moods) >= 4 && Math.max(...a.moods) <= 100, `min=${Math.min(...a.moods)} max=${Math.max(...a.moods)}`);
  check('T7.4 有低谷：至少 5 步心情 < 45', a.moods.filter((v) => v < 45).length >= 5, `低谷 ${a.moods.filter((v) => v < 45).length} 步`);
  check('T7.4b 也有高点：至少 5 步心情 > 70', a.moods.filter((v) => v > 70).length >= 5, `高点 ${a.moods.filter((v) => v > 70).length} 步`);
  check('T7.5 同种子两次运行完全一致（可复现）', walk(20260929).json === a.json);
}

section('T8 日内方差（阶段 2 的线上验收口径可以离线模拟）');
{
  // 模拟：一天里给她 8 次"判定时刻"，用状态决定她是否愿意主动开口，统计每天的开口数。
  // 第一版写成"纯随机事件池 + 断言至少有一天 ≤ 均值一半"，结果均值 3.93、最低 2，
  // 差一点点就假红 —— 那是**在赌统计涨落**，不是断言行为。改成直接对比"好日子 vs 坏日子"。
  const day = (seed, mode) => {
    const rand = mulberry32(seed);
    let s = newState(T0); let count = 0; let t = T0;
    const GOOD = ['goodTalk', 'praise', 'care'];
    const BAD = ['burst', 'insult', 'lateNight', 'longSilence'];
    for (let i = 0; i < 8; i += 1) {
      t += 3 * H;
      const pool = mode === 'good' ? GOOD : mode === 'bad' ? BAD : (rand() < 0.5 ? GOOD : BAD);
      s = applyEvents(s, [{ type: pool[Math.floor(rand() * pool.length)], at: t }]);
      const tend = stateTendency(s, { hour: 10 + i });
      if (tend.initiativeHint === 'high' || (tend.initiativeHint === 'normal' && rand() < 0.5)) count += 1;
    }
    return { count, mood: s.mood, energy: s.energy };
  };
  const days = Array.from({ length: 14 }, (_, i) => day(1000 + i).count);
  const avg = days.reduce((x, y) => x + y, 0) / days.length;
  const sd = Math.sqrt(days.reduce((x, y) => x + (y - avg) ** 2, 0) / days.length);
  check('T8.1 14 天里每天的开口数不是恒定值（标准差 > 0）', sd > 0, `days=${JSON.stringify(days)} 均值=${avg.toFixed(2)} 标准差=${sd.toFixed(2)}`);
  check('T8.2 存在明显低频日（至少一天比均值低 30%）', days.some((d) => d <= avg * 0.7), `min=${Math.min(...days)} avg=${avg.toFixed(2)}`);
  const goodDay = day(77, 'good');
  const badDay = day(77, 'bad');
  check('T8.3 被连着凶/熬夜那天的开口数严格少于被夸被关心那天', badDay.count < goodDay.count, `好日子=${goodDay.count} 坏日子=${badDay.count}`);
  check('T8.4 坏日子那天状态确实更差（心情或精力更低）', badDay.mood < goodDay.mood || badDay.energy < goodDay.energy, `好=${JSON.stringify(goodDay)} 坏=${JSON.stringify(badDay)}`);
}

section('T9 与其它模块的契合（别互相打架）');
{
  check('T9.1 initiativeHint 的四个取值有完整建议文案', ['high', 'normal', 'low', 'off'].every((k) => {
    const t = k === 'high' ? { mood: 80, energy: 80 } : k === 'normal' ? { mood: 55, energy: 55 } : k === 'low' ? { mood: 34, energy: 34 } : { mood: 60, energy: 5 };
    return stateTendency(t).initiativeHint === k && stateTendency(t).initiativeAdvice.length > 4;
  }));
  check('T9.2 状态只给建议、不含任何硬编码台词（renderStateLine 里没有引号对话）', !/「.*」/.test(renderStateLine({ mood: 40, energy: 30 })));
  check('T9.3 状态层的输出不含出站审计相关字样（不会绕过 sensitive/guard）', !/令牌|token|白名单/.test(renderStateLine({ mood: 40, energy: 30 })));
}

section('T10 睡醒恢复 wakeRest（2026-09-30 自检：精力半衰期 4h，被 drain 到 ~0 要一上午才回 20，补上「睡一觉就回来了」）');
{
  check('T10.1 事件表里有 wakeRest 且大幅回精力', (STATE_EVENTS.wakeRest?.energy ?? 0) >= 40, JSON.stringify(STATE_EVENTS.wakeRest));
  const justDrained = applyEvents({ mood: 30, energy: 0.5, updatedAtMs: T0 }, [{ type: 'wakeRest', at: T0 + 5 * 60000 }]);
  check('T10.2 刚被 drain 完就睡醒（5 分钟后）→ 精力过 50（远超 20 的开口闸门）', justDrained.energy >= 50, `energy=${justDrained.energy}`);
  check('T10.3 心情小幅回升', justDrained.mood >= 34, `mood=${justDrained.mood}`);
  const slept = applyEvents({ mood: 20, energy: 2, updatedAtMs: T0 }, [{ type: 'wakeRest', at: T0 + 6 * H }]);
  check('T10.4 整夜 6h 后 wakeRest → 精力接近满（先衰减再 +50，封顶 100）', slept.energy >= 90 && slept.energy <= 100, `energy=${slept.energy}`);
  check('T10.5 updatedAtMs 前移（自锁存，不会重复触发）', slept.updatedAtMs === T0 + 6 * H);
  check('T10.6 已是高精力时 wakeRest 不越界（夹到 100）', applyEvents({ mood: 90, energy: 95, updatedAtMs: T0 }, [{ type: 'wakeRest', at: T0 }]).energy === 100);
}

console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 跳过 ${skip} ═══`);
if (fail > 0) process.exitCode = 1;
