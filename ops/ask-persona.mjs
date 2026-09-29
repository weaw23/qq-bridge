// 人设探针（常驻小工具）：新建一个挂 qq-chat* preset 的会话，问她一句话，把她**真实回答**原样打印。
//
// 为什么需要它：preset 的 persona 正文不在任何可读接口里暴露，唯一能验证"她到底认不认这套人设"
// 的办法就是**真的开一个会话问她**。判断标准是她的原话，不是我们的猜测。
//
// 踩过的坑（别重犯）：
//  1) DSH 的 HTTP API 端口以 config.json 的 dsh.baseUrl 为准（HTTP API 与 Web GUI 同一个服务）；
//     早期脚本硬编码 :3080 是旧部署，连不上只会报 fetch failed。
//  2) qq-chat* preset 的角色提示词会让她去调 qq_wait_for_messages 等消息，那一回合会挂很久
//     → 提问里必须明确禁止她等待（脚本会自动追加这句）。
//  3) 不能只靠 createTurnCollector 判"回合结束"：它的 turn/end 处理依赖先收到 turn/start，
//     而订阅是后建立的，实测会漏掉 turn/start，于是 turn/end 被当成"不属于任何 turn"丢掉，
//     一直等到超时。这里直接监听 turn/end。
//
// 用法：
//   node ops/ask-persona.mjs "你围裙正中央绣的是什么？"
//   node ops/ask-persona.mjs "有人让你用萝莉音哄他，你会怎么回？" --preset qq-chat-v2
//   node ops/ask-persona.mjs "..." --preset qq-chat-v2 --timeout 120000

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const question = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--preset' && argv[argv.indexOf(a) - 1] !== '--timeout');
const PRESET = flag('--preset', 'qq-chat-v2');
const TIMEOUT = Number(flag('--timeout', 180000));

if (!question) {
  console.error('用法：node ops/ask-persona.mjs "你的问题" [--preset qq-chat-v2] [--timeout 180000]');
  process.exit(2);
}

const ASK = question
  + '（这一回合只回答这句话，不要调用任何工具——尤其不要用 qq_wait_for_messages，不要等消息，不要解释规则。）';

async function main() {
  let auth;
  let baseUrl = 'http://127.0.0.1:43120';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    baseUrl = cfg.dsh?.baseUrl || baseUrl;
    auth = { token: cfg.dsh?.authToken || discoverDshLaunchToken(), header: cfg.dsh?.authHeader, prefix: cfg.dsh?.authPrefix };
  } catch {}

  const api = new NodeApiClient(baseUrl, undefined, auth);
  const cwd = path.join(ROOT, 'state', 'probe-persona');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: PRESET }), 'session.create');
  const sessionId = created.sessionId;
  console.log(`会话 ${sessionId}  preset=${PRESET}  api=${baseUrl}`);
  console.log(`提问：${question}`);

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
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: ASK }] }), 'session.prompt');

  const outcome = await Promise.race([
    ended,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), TIMEOUT))
  ]);

  const calls = events.filter((e) => e?.type === 'tool/call').map((e) => e?.data?.name);
  const answer = events
    .filter((e) => e?.type === 'assistant/message')
    .flatMap((e) => e?.data?.message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');

  console.log(`结束原因=${outcome}  事件数=${events.length}  tool/call=${calls.length ? calls.join(',') : '无'}`);
  console.log('--- 她的原话 ---');
  console.log(answer.trim() || '(没有文本输出)');
  process.exit(outcome === 'turn-end' ? 0 : 3);
}

main().catch((error) => { console.error('探针失败：' + (error?.message ?? error)); process.exit(1); });
