// 用量记账回归测试（m14912）。
//
// 背景：账本原本只记「谁跑了一回合」，注释里写着「DSH 2.0.5 事件流不暴露 token」。
// 这个判断是错的：usage 块藏在 assistant/chunk 里。代价很实在——主人接了个
// 「便宜一半」的 gemini-3.8-flash 中转，25 个回合就把余额烧掉一半，而账本
// 只显示「25 回合」，完全看不出钱花在哪。修好后再回头看才发现：
// 该中转不返回 finish_reason → DSH 对同一个 step 重试 6 次 → 每次全额重发
// ~141K 上下文，且该中转没有 prompt 缓存。
//
// 本测试全部用假事件驱动，不需要真实 DSH、不发任何网络请求。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createTurnCollector } = await import(pathToFileURL(path.join(ROOT, 'src/dsh-client.js')).href);

let failed = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

const chunk = (turn, step, usage) => ({
  type: 'assistant/chunk',
  data: { turn, step, chunk: { type: 'usage', usage } },
});
const textChunk = (turn, step, text) => ({
  type: 'assistant/chunk',
  data: { turn, step, chunk: { type: 'text', text } },
});

// ── 用例 1：正常多 step 回合，token 累加、step 去重 ──
{
  const c = createTurnCollector();
  check('turn/start 不终结回合', c.push({ type: 'turn/start', data: { turn: 1 } }) === null);
  c.push(chunk(1, 1, { inputTokens: 36991, cacheReadTokens: 384, outputTokens: 151 }));
  c.push(chunk(1, 2, { inputTokens: 400, cacheReadTokens: 37200, outputTokens: 90 }));
  c.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '在的' }] } } });
  const ended = c.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  check('turn/end 返回结果', !!ended);
  check('文本只算一次（不因流式分块翻倍）', ended.text === '在的', `text=${JSON.stringify(ended.text)}`);
  check('inputTokens 跨 step 累加', ended.usage?.inputTokens === 37391, `got ${ended.usage?.inputTokens}`);
  check('cacheReadTokens 跨 step 累加', ended.usage?.cacheReadTokens === 37584, `got ${ended.usage?.cacheReadTokens}`);
  check('outputTokens 跨 step 累加', ended.usage?.outputTokens === 241, `got ${ended.usage?.outputTokens}`);
  check('requests = 2 个不同 step', ended.usage?.requests === 2, `got ${ended.usage?.requests}`);
  check('无重试时 attempts 与 requests 相等', ended.usage?.attempts === 2, `got ${ended.usage?.attempts}`);
  check('maxContext 取单步最大上下文（in+cache）', ended.usage?.maxContext === 37600, `got ${ended.usage?.maxContext}`);
}

// ── 用例 2：重试风暴——同一个 step 报 6 次 usage，必须被看见 ──
{
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 7 } });
  // 真实数据原型：mem196a turn 85 step 1，6 次重试，sumIn=868530、wasted=723775。
  for (let i = 0; i < 6; i += 1) c.push(chunk(7, 1, { inputTokens: 144755, cacheReadTokens: 0, outputTokens: 87 }));
  const ended = c.push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'Stream ended without finish_reason' } } } });
  check('重试被计入 attempts', ended.usage?.attempts === 6, `got ${ended.usage?.attempts}`);
  check('重试不虚增 step 数（仍是同一个 step）', ended.usage?.requests === 1, `got ${ended.usage?.requests}`);
  check('重试的代价被如实累计到 inputTokens', ended.usage?.inputTokens === 868530, `got ${ended.usage?.inputTokens}`);
  check('重试全无缓存时命中率为 0', ended.usage?.cacheReadTokens === 0, `got ${ended.usage?.cacheReadTokens}`);
  check('失败原因保留（用于定位中转缺 finish_reason）',
    ended.reason?.error?.message === 'Stream ended without finish_reason', JSON.stringify(ended.reason));
}

// ── 用例 3：完全没有 usage 块时给 null，而不是假的 0 ──
{
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 3 } });
  const ended = c.push({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
  check('没有 usage 块时 usage === null（不假装是 0）', ended.usage === null, `got ${JSON.stringify(ended.usage)}`);
}

// ── 用例 4：流式文本块不参与拼装（历史缺陷：回复变「收到收到」）──
{
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 4 } });
  c.push(textChunk(4, 1, '收到'));
  c.push({ type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '收到' }] } } });
  const ended = c.push({ type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });
  check('流式分块不与组装文本重复累加', ended.text === '收到', `text=${JSON.stringify(ended.text)}`);
  check('无 usage 的纯文本回合不会崩', ended.usage === null);
}

// ── 用例 5：多回合并行（不同 turn 各自独立）──
{
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 10 } });
  c.push({ type: 'turn/start', data: { turn: 11 } });
  c.push(chunk(10, 1, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 }));
  c.push(chunk(11, 1, { inputTokens: 5000, cacheReadTokens: 0, outputTokens: 20 }));
  const e10 = c.push({ type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } });
  const e11 = c.push({ type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } });
  check('turn 10 的账不被 turn 11 污染', e10.usage?.inputTokens === 100 && e10.usage?.cacheReadTokens === 900,
    `got in=${e10.usage?.inputTokens} cache=${e10.usage?.cacheReadTokens}`);
  check('turn 11 的账独立', e11.usage?.inputTokens === 5000 && e11.usage?.cacheReadTokens === 0,
    `got in=${e11.usage?.inputTokens} cache=${e11.usage?.cacheReadTokens}`);
  check('turn/end 后该 turn 被清理', c.has(10) === false && c.has(11) === false);
}

// ── 用例 6：没有 turn/start 的野 usage 块不应崩 ──
{
  const c = createTurnCollector();
  c.push(chunk(99, 1, { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1 }));
  const ended = c.push({ type: 'turn/end', data: { turn: 99, reason: { kind: 'completed' } } });
  check('未知 turn 的 usage 被安全忽略', ended === null, `got ${JSON.stringify(ended)}`);
}

console.log(failed === 0 ? '\n✅ 用量记账回归测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
