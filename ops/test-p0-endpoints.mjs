// P0 端点实测：rich 发送（face+本地图+文字） + 私聊历史 + 防线
//
// ⚠️ 副作用警示（2026-10-04 补）：[1] 段的 /api/send/rich 走的是**真条路由**，
// 会往主人私聊灌一条「P0 新链路实测…」。跑在自检巡检里 = 每轮都骚扰主人一次。
// 所以真发那一段改为显式开关：只有 P0_LIVE_SEND=1 时才跑；默认只做只读的 [2] 段
// 与不产生消息的 [3] 段（防线测试期望被拒，本来就不该发出去）。
// 同款约定见 test-proactive-quota.mjs 的 LIVE_SEED=1、test-sticker-guard-live.mjs 的零可见影响靶子。
import fs from 'node:fs';
const LIVE = process.env.P0_LIVE_SEND === '1';
const j = JSON.parse(fs.readFileSync('D:/qqbot/qq-bridge/state/social-v2.json', 'utf8'));
const token = j.conversations['private:1918594889'].agentToken;
const consoleToken = fs.readFileSync('D:/qqbot/qq-bridge/state/console-token', 'utf8').trim();
const AUTH = { 'Content-Type': 'application/json', 'x-agent-token': token, 'x-console-token': consoleToken };

if (!LIVE) {
  console.log('[1] /api/send/rich face+image+text —— ⏭️  跳过（会真发一条 QQ 消息给主人；要看就设 P0_LIVE_SEND=1）');
} else {
  console.log('[1] /api/send/rich face+image+text');
  let res = await fetch('http://127.0.0.1:3100/api/send/rich', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      key: 'private:1918594889',
      token,
      parts: [
        { type: 'face', id: '66' },
        { type: 'image', file: 'file:///D:/qqbot/outbox/test-image.png' },
        { type: 'text', text: 'P0 新链路实测：系统表情+本地图片+文字混排，一条消息' },
      ],
    }),
  });
  console.log('   ', res.status, JSON.stringify(await res.json()).slice(0, 160));
}

console.log('[2] /api/socialV2/friend-history 最近 5 条');
let res = await fetch('http://127.0.0.1:3100/api/socialV2/friend-history', {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ userId: '1918594889', count: 5, token }),
});
const jj = await res.json();
console.log('   ', res.status, 'ok=' + jj.ok, 'count=' + (jj.messages?.length ?? 0));
for (const m of (jj.messages ?? []).slice(-3)) {
  console.log('    [' + (m.isSelf ? '鲸' : '人') + '] ' + String(m.text).slice(0, 40));
}

console.log('[3] 防线测试：非法图片路径应被拒');
res = await fetch('http://127.0.0.1:3100/api/send/rich', {
  method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ key: 'private:1918594889', token, parts: [{ type: 'image', file: 'file:///C:/Users/HCK/secret.txt' }] }),
});
console.log('   ', res.status, JSON.stringify(await res.json()).slice(0, 160));

// Bug #22：fetch 的 keep-alive socket 正在关闭时立刻 process.exit() 会触发 libuv 的
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
// 进程以 0xC0000409 abort（exit=-1073740791），自检脚本看到的是「崩掉的测试」而不是「通过」，
// 而且 abort 会连 stdout 一起丢——这一轮的输出一个字都没留下。
// 与 test-repeat-reminders.mjs（await sleep(500)）/ test-affinity.mjs（setTimeout 500）同源。
// 这里用 exitCode + unref 兜底定时器：socket 干净关掉就自然退出，还吊着就 500ms 后强退。
process.exitCode = 0;
setTimeout(() => process.exit(0), 500).unref();
