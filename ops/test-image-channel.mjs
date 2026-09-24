// 发图通道 / 外部图源收藏 回归测试
// 用法：node ops/test-image-channel.mjs      （桥接需在运行）
//
// 设计要点：全程零副作用。判别「鉴权是否通过」不靠真的发消息，而是故意送空 parts——
// 鉴权没过会在 403 就被拦下，鉴权过了才会走到 400「parts 不能为空」。
// 这样既能证明修复生效，又不会往任何真实会话里发东西。
//
// 背景（2026-09-24）：MCP 侧令牌约定不统一——多数工具 body 与 x-agent-token 头都带，
// 而 qq_send_image / qq_send_face / qq_get_friend_msg_history 只带头；桥接侧这几个端点
// 却只从 body.token 读，于是 reserved2 下必然 403「必须携带 agent token」。
// 修法：桥接侧 pickAgentToken() 两处都接受；MCP 侧补上 body.token 与兄弟工具对齐。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';

let failures = 0;
function check(name, pass, note = '') {
  console.log(`${pass ? '✅' : '❌'} ${name}${note ? '  ' + note : ''}`);
  if (!pass) failures++;
}

// ── 取令牌（绝不打印值）──────────────────────────────────────────────────────
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));

// social-v2.json 的会话条目形态可能随版本变化，这里递归找出所有带 agentToken 的会话键
const sessions = [];
(function walk(node, keyHint) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.agentToken === 'string' && node.agentToken) {
    sessions.push({ key: keyHint, token: node.agentToken });
    return;
  }
  for (const [k, v] of Object.entries(node)) walk(v, /^(group|private):\d+$/.test(k) ? k : keyHint);
})(sv, '');

if (!sessions.length) { console.log('❌ social-v2.json 里找不到任何带 agentToken 的会话，无法测试'); process.exit(1); }
console.log(`（找到 ${sessions.length} 个会话令牌，值不打印）\n`);

const ownerKey = 'private:1918594889';
const sess = sessions.find((s) => s.key === ownerKey) || sessions[0];
const KEY = sess.key;
const TOK = sess.token;
console.log(`测试会话：${KEY}\n`);

async function call(pathname, body, headers = {}) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': consoleToken, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  let json = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ── A) 令牌归一化：只带头（模拟 qq_send_image 的原始行为）────────────────────
console.log('=== A) /api/send/rich 令牌来源归一化 ===');
{
  const r = await call('/api/send/rich', { key: KEY, parts: [] }, { 'x-agent-token': TOK });
  check('只带 x-agent-token 头 → 鉴权应通过（落到 parts 校验）',
    r.status === 400 && String(r.json?.error ?? '').includes('parts'),
    `实得 ${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await call('/api/send/rich', { key: KEY, parts: [], token: TOK }, {});
  check('只带 body.token → 鉴权仍应通过（不回归旧约定）',
    r.status === 400 && String(r.json?.error ?? '').includes('parts'),
    `实得 ${r.status} ${r.json?.error ?? ''}`);
}

// ── B) 安全边界未被放宽 ──────────────────────────────────────────────────────
console.log('\n=== B) 安全边界（必须仍然拦得住）===');
{
  const r = await call('/api/send/rich', { key: KEY, parts: [] }, {});
  check('完全不带令牌 → 必须 403', r.status === 403, `实得 ${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await call('/api/send/rich', { key: KEY, parts: [] }, { 'x-agent-token': 'deadbeef'.repeat(4) });
  check('带错误令牌 → 必须 403 且报「无效」',
    r.status === 403 && String(r.json?.error ?? '').includes('无效'),
    `实得 ${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await call('/api/send/rich', { key: KEY, parts: [] }, { 'x-agent-token': '' });
  check('带空字符串令牌 → 必须 403（不能被当成管理端绕过）', r.status === 403, `实得 ${r.status} ${r.json?.error ?? ''}`);
}
{
  // 拿 A 会话的令牌去开 B 会话：跨会话必须拦下
  const other = sessions.find((s) => s.key !== KEY);
  if (other) {
    const r = await call('/api/send/rich', { key: other.key, parts: [] }, { 'x-agent-token': TOK });
    check('跨会话盗用令牌 → 必须 403', r.status === 403, `实得 ${r.status} ${r.json?.error ?? ''}（目标 ${other.key}）`);
  } else {
    console.log('⚪ 只有一个会话，跳过跨会话盗用测试');
  }
}

// ── C) qq_get_friend_msg_history 的同类故障 ──────────────────────────────────
console.log('\n=== C) /api/socialV2/friend-history（此前同样全废）===');
{
  const r = await call('/api/socialV2/friend-history', { userId: '1918594889', count: 1, messageSeq: null }, { 'x-agent-token': TOK });
  const okAuth = !(r.status === 403 && /agent token/.test(String(r.json?.error ?? '')));
  check('只带头也能通过鉴权（不再报 agent token 无效）', okAuth, `实得 ${r.status} ${r.json?.error ?? r.json?.ok ?? ''}`);
}

// ── D) 外部图源收藏：新通路已接通且校验生效 ──────────────────────────────────
console.log('\n=== D) /api/socialV2/collect-sticker 外部图源 ===');
{
  const r = await call('/api/socialV2/collect-sticker', { key: KEY, remark: '' }, { 'x-agent-token': TOK });
  check('messageId 与 file 都不给 → 400 且提示二选一',
    r.status === 400 && /messageId|file/.test(String(r.json?.error ?? '')),
    `实得 ${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await call('/api/socialV2/collect-sticker', { key: KEY, file: 'ftp://example.com/a.png', remark: '' }, { 'x-agent-token': TOK });
  check('非法图源协议 → 被拒（证明已路由到外部图源分支）',
    String(r.json?.error ?? '').includes('base64://') || String(r.json?.error ?? '').includes('仅支持'),
    `实得 ${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await call('/api/socialV2/collect-sticker', { key: KEY, file: 'file:///D:/qqbot/outbox/../../secret.png', remark: '' }, { 'x-agent-token': TOK });
  check('outbox 路径穿越 → 被拒',
    String(r.json?.error ?? '').includes('仅支持') || String(r.json?.error ?? '').includes('base64://'),
    `实得 ${r.status} ${r.json?.error ?? ''}`);
}
{
  const r = await call('/api/socialV2/collect-sticker', { key: KEY, file: 'base64://' + Buffer.from('not an image at all').toString('base64'), remark: '' }, { 'x-agent-token': TOK });
  check('base64 但不是图片 → 被 looksLikeImageBuffer 拦下',
    String(r.json?.error ?? '').includes('不是有效图片'),
    `实得 ${r.status} ${r.json?.error ?? ''}`);
}

console.log(`\n===== ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} =====`);
process.exit(failures === 0 ? 0 : 1);
