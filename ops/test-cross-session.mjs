// 跨会话主令牌回归测试
// 用法：node ops/test-cross-session.mjs      （桥接需在运行）
//
// 背景（2026-09-25）：一轮唤醒只注入当前会话的令牌，于是主人在私聊里叫她去管群事时，
// 群工具全部 403「agent token 无效」。她查得到自己在某群的状态（qq_my_group_status
// 允许私聊会话 + 显式 groupId），却读不了也发不了那个群的消息——不是权限设计要拦她，
// 是令牌作用域把她锁死在单个会话里。
// 修法：主人私聊令牌升级为主令牌，可跨会话操作（cfg.socialV2.ownerMasterToken=false 可关断）。
//
// 设计要点：
// - 全程零副作用。判别「鉴权是否通过」用空 parts 探测：403=没过，400「parts 不能为空」=过了。
// - 重点不是证明放开了，而是证明**没有放过头**：群令牌不得反向升级成主令牌，
//   主令牌也不得绕过白名单。这两条一旦破了，等于群友一句话就能让她翻主人私聊。
// - 令牌值一律不打印。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:3100';

let failures = 0;
function check(name, pass, note = '') {
  console.log(`${pass ? '✅' : '❌'} ${name}${note ? '  ' + note : ''}`);
  if (!pass) failures++;
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const sv = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));

// social-v2.json 的会话条目形态可能随版本变化，递归找出所有带 agentToken 的会话键
const sessions = [];
(function walk(node, keyHint) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.agentToken === 'string' && node.agentToken) {
    sessions.push({ key: keyHint, token: node.agentToken });
    return;
  }
  for (const [k, v] of Object.entries(node)) walk(v, /^(group|private):\d+$/.test(k) ? k : keyHint);
})(sv, '');

const ownerKey = 'private:' + String(cfg.ownerQQ ?? '').trim();
const owner = sessions.find((s) => s.key === ownerKey);
const groups = sessions.filter((s) => s.key.startsWith('group:'));
if (!owner) { console.log(`❌ 找不到主人私聊会话（${ownerKey}）的令牌，无法测试`); process.exit(1); }
if (!groups.length) { console.log('❌ 没有任何群会话，无法测试跨会话'); process.exit(1); }

const allowGroups = (cfg.allow?.groups ?? []).map(String);
const inWhite = (k) => allowGroups.includes(String(k).split(':')[1] ?? '');
// 主靶子必须是「既存在会话状态、又在白名单里」的群：state 里还留着旧号时代的
// 非白名单会话，拿它当靶子会让失败原因变成白名单而不是令牌，测不出真正要测的东西。
const whitelisted = groups.filter((s) => inWhite(s.key));
const offWhitelist = groups.filter((s) => !inWhite(s.key));
if (!whitelisted.length) {
  console.log(`❌ state 里的群会话都不在白名单 [${allowGroups.join(', ')}] 内，无法测试跨会话：${groups.map((s) => s.key).join(', ')}`);
  process.exit(1);
}
const G = whitelisted[0].key;
const GTOK = whitelisted[0].token;
// 造一个肯定不在白名单里的群号；state 里若有真实的非白名单会话也一并当探针
let probeNum = 123456789;
while (allowGroups.includes(String(probeNum))) probeNum++;
const SYNTHETIC = 'group:' + probeNum;
const OFFWHITE_KEY = offWhitelist[0]?.key ?? null;

console.log(`主人私聊 ${ownerKey}　目标群 ${G}　白名单群 [${allowGroups.join(', ') || '空'}]`);
console.log(`非白名单探针：合成 ${SYNTHETIC}${OFFWHITE_KEY ? '、真实遗留会话 ' + OFFWHITE_KEY : ''}`);
console.log(`（共 ${sessions.length} 个会话令牌，值不打印）\n`);

async function req(method, pathname, body, token) {
  const headers = { 'x-console-token': consoleToken };
  // token === null 表示完全不带这个头；空串/空白串仍要带上，用来验证不会被当成「管理端」绕过
  if (token !== null) headers['x-agent-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  let json = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const errOf = (r) => String(r.json?.error ?? '');
// 令牌被判无效（这正是本次要修的那句话）
const tokenRejected = (r) => r.status === 403 && /agent token/.test(errOf(r));
// 鉴权通过判据：走到 400「parts 不能为空」说明令牌和白名单都过了
const authPassed = (r) => r.status === 400 && errOf(r).includes('parts 不能为空');
const recent = (key, token) => req('GET', `/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=1`, undefined, token);
const unread = (key, token) => req('GET', `/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=1`, undefined, token);

// ── A) 主令牌跨会话读 ────────────────────────────────────────────────────────
console.log('=== A) 主令牌跨会话读群消息 ===');
{
  const r = await recent(G, owner.token);
  check('主人私聊令牌能读群消息（原先必然 403「agent token 无效」）', r.status === 200 && r.json?.ok === true, `${r.status} ${errOf(r)}`);
}
{
  const r = await unread(G, owner.token);
  check('主人私聊令牌能读群未读', r.status === 200 && r.json?.ok === true, `${r.status} ${errOf(r)}`);
}
{
  const r = await recent(G, GTOK);
  check('群自己的令牌仍然可用（没把原有行为改坏）', r.status === 200 && r.json?.ok === true, `${r.status} ${errOf(r)}`);
}
{
  const r = await recent(ownerKey, owner.token);
  check('主人私聊令牌读自己那个会话照常', r.status === 200 && r.json?.ok === true, `${r.status} ${errOf(r)}`);
}

// ── B) 主令牌跨会话发送 ──────────────────────────────────────────────────────
console.log('\n=== B) 主令牌跨会话发送 ===');
// 全程零副作用，靠两种探针：
//  1) 白名单群 + 空 parts → 走到 400「parts 不能为空」，说明令牌与白名单都过了；
//  2) 非白名单 key + 真实 message → 令牌检查排在白名单检查之前，所以错误若是「允许范围」
//     就证明令牌那关过了，而白名单会在真正发送之前把它挡住，一个字都发不出去。
{
  const r = await req('POST', '/api/send/rich', { key: G, parts: [] }, owner.token);
  check('send/rich：主令牌过鉴权（令牌走头）', authPassed(r), `${r.status} ${errOf(r)}`);
}
{
  const r = await req('POST', '/api/send/rich', { key: G, parts: [], token: owner.token }, null);
  check('send/rich：主令牌放 body 里同样有效（pickAgentToken 归一化）', authPassed(r), `${r.status} ${errOf(r)}`);
}
{
  const r = await req('POST', '/api/send/group', { groupId: String(SYNTHETIC.split(':')[1]), message: '探针，不应被发出' }, owner.token);
  check('send/group：主令牌被接受（错误来自白名单而非令牌，且未发送）', r.status === 403 && errOf(r).includes('允许范围'), `${r.status} ${errOf(r)}`);
}
{
  const r = await req('POST', '/api/socialV2/send-message', { key: SYNTHETIC, messages: ['探针，不应被发出'] }, owner.token);
  check('send-message：主令牌被接受（错误来自白名单而非令牌，且未发送）', r.status === 403 && errOf(r).includes('允许范围'), `${r.status} ${errOf(r)}`);
}
{
  // 反向：带上真实 message，必须在「发送之前」就被令牌检查拦下
  const r = await req('POST', '/api/send/private', { userId: String(cfg.ownerQQ), message: '跨会话越权探针，不应被发出' }, GTOK);
  check('send/private：群令牌发不进主人私聊（403 发生在发送前）', tokenRejected(r), `${r.status} ${errOf(r)}`);
}
{
  const r = await req('POST', '/api/socialV2/send-message', { key: ownerKey, messages: ['跨会话越权探针，不应被发出'] }, GTOK);
  check('send-message：群令牌发不进主人私聊（403 发生在发送前）', tokenRejected(r), `${r.status} ${errOf(r)}`);
}

// ── C) 群令牌不得反向升级（核心安全不变式）───────────────────────────────────
console.log('\n=== C) 群令牌不得反向升级成主令牌 ===');
{
  const r = await recent(ownerKey, GTOK);
  check('群令牌读不了主人私聊（否则群友一句话就能让她翻主人私聊）', tokenRejected(r), `${r.status} ${errOf(r)}`);
}
{
  const r = await req('POST', '/api/send/rich', { key: ownerKey, parts: [] }, GTOK);
  check('群令牌发不了主人私聊', tokenRejected(r), `${r.status} ${errOf(r)}`);
}
{
  const r = await req('POST', '/api/socialV2/admin', { action: '__probe__', groupId: G.split(':')[1] }, GTOK);
  check('群令牌调不动管理端点（403 发生在 action 校验之前，零副作用）', r.status === 403, `${r.status} ${errOf(r)}`);
}
{
  const other = whitelisted.find((s) => s.key !== G) ?? groups.find((s) => s.key !== G);
  if (other) {
    const r = await recent(other.key, GTOK);
    check(`群令牌也跨不到别的群（${other.key}）`, tokenRejected(r), `${r.status} ${errOf(r)}`);
  } else {
    console.log('（只有一个群会话，跳过「跨到别的群」这项）');
  }
}

// ── D) 主令牌不得绕过白名单 ──────────────────────────────────────────────────
console.log('\n=== D) 主令牌不得绕过白名单 ===');
// 令牌检查在白名单检查之前，所以「令牌被接受、但白名单拦住」才是主令牌没变成后门的证据：
// 返回「agent token 无效」说明主令牌压根没生效；返回 200 说明白名单被绕过了。两种都是 bug。
for (const [label, k] of [['合成群号', SYNTHETIC], ...(OFFWHITE_KEY ? [['真实遗留会话', OFFWHITE_KEY]] : [])]) {
  const r1 = await recent(k, owner.token);
  check(`${label} ${k}：主令牌也读不到`, r1.status === 403 && errOf(r1).includes('允许范围'), `${r1.status} ${errOf(r1)}`);
  const r2 = await req('POST', '/api/send/rich', { key: k, parts: [] }, owner.token);
  check(`${label} ${k}：主令牌也发不出`, r2.status === 403 && errOf(r2).includes('允许范围'), `${r2.status} ${errOf(r2)}`);
}

// ── E) 无效令牌仍然被拒 ──────────────────────────────────────────────────────
console.log('\n=== E) 无效/空白令牌仍然被拒 ===');
{
  const r = await recent(G, 'deadbeef'.repeat(6));
  check('乱填的令牌被拒', tokenRejected(r), `${r.status} ${errOf(r)}`);
}
{
  // 空白串：全局守卫只拦 === '' 的头，空白串会走到 agentTokenOk，必须在那里被 trim 掉
  const r = await recent(G, ' ');
  check('空白令牌被拒（不能被当成「管理端无 token」绕过）', r.status === 403, `${r.status} ${errOf(r)}`);
}
{
  const r = await req('POST', '/api/send/rich', { key: G, parts: [] }, '');
  check('空串令牌被拒', r.status === 403, `${r.status} ${errOf(r)}`);
}

// ── F) 主令牌机制可关断 ──────────────────────────────────────────────────────
console.log('\n=== F) 配置开关 ===');
{
  const flag = cfg.socialV2?.ownerMasterToken;
  check('开关未被误设为 false（设为 false 即恢复「一轮一会话」）', flag !== false, `socialV2.ownerMasterToken = ${flag === undefined ? '(未设，默认开)' : flag}`);
}

console.log(`\n===== ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} =====`);
process.exit(failures === 0 ? 0 : 1);
