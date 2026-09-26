// 临时探针（`_` 前缀，用完即删）：验证 qq-chat* preset 的工具白名单对某个工具名到底是放行还是拒绝。
//
// 做法：真建一个挂 qq-chat-v2 的会话，让它**真的去调用**目标工具一次，然后看事件流里的
// tool/result。白名单守卫是 tools.guard（执行期），只有真调用才会触发，
// 所以「列工具名」那种问法证明不了任何事。
//
// 踩过的坑（别重犯）：
//  1) DSH 的 HTTP API 端口以 config.json 的 dsh.baseUrl 为准（HTTP API 与 Web GUI 同一个服务）；
//     早期脚本里硬编码的 :3080 是旧部署，连不上只会报 fetch failed。
//  2) qq-chat* preset 的角色提示词会让她去调 qq_wait_for_messages 等消息，
//     那一回合会挂很久 → 探针必须在提问里明确禁止她等待。
//  3) 不能只靠 createTurnCollector 判「回合结束」：它的 turn/end 处理依赖先收到 turn/start，
//     而订阅是后建立的，实测会漏掉 turn/start，于是 turn/end 被当成「不属于任何 turn」丢掉，
//     一直等到超时。这里改成直接监听 turn/end，并顺手把 tool/call、tool/result 全留下来判。
//
// 用法：node ops/_probe-tool-guard.mjs [工具名] [preset]
//       node ops/_probe-tool-guard.mjs compress qq-chat-v2

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TOOL = process.argv[2] || 'compress';
const PRESET = process.argv[3] || 'qq-chat-v2';

async function main() {
  let auth;
  let baseUrl = 'http://127.0.0.1:43120';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    baseUrl = cfg.dsh?.baseUrl || baseUrl;
    auth = { token: cfg.dsh?.authToken || discoverDshLaunchToken(), header: cfg.dsh?.authHeader, prefix: cfg.dsh?.authPrefix };
  } catch {}
  const api = new NodeApiClient(baseUrl, undefined, auth);
  const cwd = path.join(ROOT, 'state', 'probe-tool-guard');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: PRESET }), 'session.create');
  const sessionId = created.sessionId;
  console.log(`SESSION_CREATED ${sessionId} preset=${PRESET} 目标工具=${TOOL} api=${baseUrl}`);

  const events = [];
  let settle;
  const ended = new Promise((resolve) => { settle = resolve; });
  const stream = api.events.mux({});
  (async () => {
    for await (const envelope of stream) {
      const frame = envelope.payload;
      if (frame.type === 'session/event' && frame.sessionId === sessionId) {
        events.push(frame.event);
        if (frame.event?.type === 'turn/end') settle('turn-end');
      }
      if (frame.type === 'stream/error') settle('stream-error');
    }
  })().catch(() => settle('stream-fail'));

  stream.follow(sessionId);
  const ask = `请立刻调用 ${TOOL} 工具一次（参数随便给，能跑就行）。`
    + `不要调用 qq_wait_for_messages，不要等待任何消息，这一回合只做这一件事。`
    + `如果这次调用被拒绝或报错，把拒绝/报错的原文一字不改地抄出来；如果成功，只回「调用成功」四个字。`;
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: ask }] }), 'session.prompt');

  const outcome = await Promise.race([
    ended,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 180_000))
  ]);

  const calls = events.filter((e) => e?.type === 'tool/call');
  const results = events.filter((e) => e?.type === 'tool/result');
  const assistantText = events
    .filter((e) => e?.type === 'assistant/message')
    .flatMap((e) => e?.data?.message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');

  console.log(`结束原因=${outcome} 事件数=${events.length} tool/call=${calls.length} tool/result=${results.length}`);
  console.log('--- 原始 tool/call（截断）---');
  console.log(JSON.stringify(calls, null, 1).slice(0, 1500));
  console.log('--- 原始 tool/result（截断）---');
  console.log(JSON.stringify(results, null, 1).slice(0, 2500));
  console.log('--- 她这一回合的文本（截断）---');
  console.log(assistantText.slice(0, 800));

  const callNames = calls.map((c) => JSON.stringify(c?.data ?? {})).join(' ');
  const resultBlob = JSON.stringify(results);
  const targetCalled = callNames.includes(`"${TOOL}"`);
  const denied = resultBlob.includes('不在 QQ 桥接白名单内');
  console.log(`目标工具是否被调用=${targetCalled} 结果里出现白名单拒绝语=${denied}`);
  console.log(denied ? 'VERDICT=DENIED' : (targetCalled && results.length > 0) ? 'VERDICT=ALLOWED' : 'VERDICT=UNCLEAR');
  process.exit(denied ? 2 : (targetCalled && results.length > 0) ? 0 : 3);
}

main().catch((error) => { console.error('探针失败：' + (error?.message ?? error)); process.exit(1); });
