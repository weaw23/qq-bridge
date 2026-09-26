// QQ agent preset 工具白名单回归测试（qq-chat / qq-chat-v2 各一份，两份必须同行为）。
//
// 这个白名单是**安全硬边界**：QQ 群里的任何人都能给她发消息，所以她的工具面里绝不能出现
// 本地工具（读写文件、跑命令、读写记忆库）。同时它也不能把**上下文管理**这类纯模型侧工具
// 一起拦掉 —— 拦掉的后果是 ACP 上下文压缩失败（线上真实报错：
// `工具 "compress" 不在 QQ 桥接白名单内，已拒绝`），她的上下文一旦涨满就没法自救。
//
// 判据（与 qq-tool-restrict.mjs 的 isToolAllowed 是同一份实现，不是复制的第二份规则）：
//   放行：mcp__snowluma__* / mcp__snowluma-host__* / mcp__web-search-safe__*
//         ask_user_question、todo_write，以及 ACP 上下文管理五件套
//   拒绝：其它一切（含 read/write/edit/pwsh/glob/grep 等本地工具、subagent/send_message 等
//         能扩大权限或对外发声的工具、dev_* 开发注入器）
//
// 证据强度：T 段是**纯函数行为验证**（离线、不需要 DSH 在跑）。
//          S 段只证明「两份 preset 的接线都指向同一个判据、守卫还在」，不是行为验证。
//
// 基线说明：本文件用命名空间导入（`import * as P`），所以改之前是干净的红
// （`P.isToolAllowed` 是 undefined），而不是「具名导入不存在的导出导致整个文件加载失败」。
//
// 跑：node ops/test-preset-tools.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V2 from '../dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs';
import * as V1 from '../dsh/agent-presets/qq-chat/qq-tool-restrict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = ['qq-chat', 'qq-chat-v2'];

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? '  ' + extra : ''}`); }
}

const allow = (mod, name) => (typeof mod.isToolAllowed === 'function' ? mod.isToolAllowed(name) === true : false);
const deny = (mod, name) => (typeof mod.isToolAllowed === 'function' ? mod.isToolAllowed(name) === false : false);

console.log('── T 段 纯函数：放行集与拒绝集 ──');

for (const [label, mod] of [['v2', V2], ['v1', V1]]) {
  ok(`T1[${label}] ACP 上下文管理工具放行（compress 曾因被拦导致上下文压缩失败）`,
    allow(mod, 'compress') && allow(mod, 'decompress') && allow(mod, 'search_context')
    && allow(mod, 'acp_status') && allow(mod, 'acp_cache'));
}
for (const [label, mod] of [['v2', V2], ['v1', V1]]) {
  ok(`T2[${label}] 本地工具一个都不许有（群聊安全硬边界）`,
    deny(mod, 'read') && deny(mod, 'write') && deny(mod, 'edit') && deny(mod, 'pwsh')
    && deny(mod, 'glob') && deny(mod, 'grep') && deny(mod, 'read_image'));
}
for (const [label, mod] of [['v2', V2], ['v1', V1]]) {
  ok(`T3[${label}] 能扩大权限或对外发声的工具不许有（subagent / send_message / workflow / goal）`,
    deny(mod, 'subagent') && deny(mod, 'subagent_fork') && deny(mod, 'send_message')
    && deny(mod, 'interrupt_agent') && deny(mod, 'workflow') && deny(mod, 'ralph')
    && deny(mod, 'list_agents') && deny(mod, 'create_goal') && deny(mod, 'update_goal')
    && deny(mod, 'get_goal') && deny(mod, 'exit_plan_mode') && deny(mod, 'skill')
    && deny(mod, 'job_list') && deny(mod, 'job_output') && deny(mod, 'job_kill'));
}
for (const [label, mod] of [['v2', V2], ['v1', V1]]) {
  ok(`T4[${label}] QQ MCP 与搜索白名单前缀仍然放行`,
    allow(mod, 'mcp__snowluma__qq_send_group_message')
    && allow(mod, 'mcp__snowluma-host__snowluma_status')
    && allow(mod, 'mcp__web-search-safe__web_search'));
}
for (const [label, mod] of [['v2', V2], ['v1', V1]]) {
  ok(`T5[${label}] 无害模型侧工具（ask_user_question / todo_write）仍然放行`,
    allow(mod, 'ask_user_question') && allow(mod, 'todo_write'));
}
for (const [label, mod] of [['v2', V2], ['v1', V1]]) {
  ok(`T6[${label}] dev_* 开发注入器一律拒绝`,
    deny(mod, 'dev_inject_plugin') && deny(mod, 'dev_stage_call') && deny(mod, 'dev_build_plugin'));
}
for (const [label, mod] of [['v2', V2], ['v1', V1]]) {
  ok(`T7[${label}] 空名 / 非字符串 / 前后空格不放行（大小写与空白不做宽容处理）`,
    deny(mod, '') && deny(mod, '   ') && deny(mod, ' compress') && deny(mod, 'COMPRESS')
    && deny(mod, null) && deny(mod, undefined) && deny(mod, 123));
}
{
  ok('T8 两份 preset 的判据是同一次导入（不是各写一份规则，不会漂移）',
    typeof V2.isToolAllowed === 'function' && V2.isToolAllowed.toString() === V1.isToolAllowed.toString());
}

console.log('\n── S 段 源码接线 ──');

for (const preset of PRESETS) {
  const src = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', preset, 'qq-tool-restrict.mjs'), 'utf8');
  ok(`S1[${preset}] 守卫仍然在：tools.guard 存在，且用的是 isToolAllowed 判据`,
    /ctx\.tools\.guard\(/.test(src) && /isToolAllowed\(name\)/.test(src));
  ok(`S2[${preset}] 危险工具仍然被 tools.restrict 从 schema 隐藏`,
    /ctx\.tools\.restrict\(\{ deny: \[name\] \}\)/.test(src) && /KNOWN_DANGEROUS_GLOBAL_TOOLS/.test(src));
  ok(`S3[${preset}] 白名单里没有混进本地工具名（read/write/edit/pwsh/glob/grep）`,
    !/'(read|write|edit|pwsh|glob|grep)'/.test(src));
}

console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} ═══`);
await new Promise((r) => setTimeout(r, 300)); // 避开 libuv UV_HANDLE_CLOSING 断言
process.exit(fail === 0 ? 0 : 1);
