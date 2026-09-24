// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as pc from './pc-actions.js';
import { SENSITIVE_RE } from './sensitive.js';
import { TOOL_DOCS } from './tool-docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 构造可选的“引用/回复”消息段：
// - 传了 replyToMessageId 时，在文本前追加 reply 段，让 QQ 显示“引用了某条消息”；
// - 使用结构化消息段而不是 CQ 码，避免注入；
// - replyToMessageId 必须是非零整数（字符串数字也接受；QQ 消息 id 可能为负数）。
function messageSegments(message, replyToMessageId) {
  const segments = [];
  const replyId = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== ''
    ? String(replyToMessageId).trim()
    : null;
  if (replyId !== null) {
    if (!/^-?[1-9]\d*$/.test(replyId)) {
      throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    }
    segments.push({ type: 'reply', data: { id: replyId } });
  }
  segments.push({ type: 'text', data: { text: escapeCqText(String(message ?? '')) } });
  return segments;
}

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  return body;
}


// 长轮询专用：node:http 直连，绕过 undici 默认 300s headersTimeout。
// 背景：qq_wait_for_messages 最长要挂 600s（沉睡前观察固定 300s），
// 用全局 fetch 会在整 300s 处被掐断并抛 "fetch failed" —— 这正是「等消息一直炸」的根因。
function agentApiLong(path, init = {}) {
  const { timeoutMs: _omit, ...rest } = init;
  const waitMs = Number(_omit) || 15000;
  const consoleToken = readConsoleToken();
  return new Promise((resolve, reject) => {
    const u = new URL(agentApiBase() + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: rest.method || 'POST',
        headers: {
          'content-type': 'application/json',
          ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
          ...(rest.headers ?? {})
        }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(data); } catch { body = null; }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(body?.error || `桥接 API HTTP ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.setTimeout(waitMs + 30000, () => req.destroy(new Error('桥接请求超时（' + Math.round((waitMs + 30000) / 1000) + 's）')));
    req.on('error', (e) => reject(e));
    if (rest.body) req.write(rest.body);
    req.end();
  });
}

async function authorizeRead(key, token) {
  await agentApi('/api/authorize/read', { method: 'POST', body: JSON.stringify({ key, token: token || undefined }) });
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.1.5' });

server.tool(
  'qq_status',
  '查机器人登录状态（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: JSON.stringify({ ...login, online: status.online, good: status.good }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出她所在的群（只读）。',
  {},
  async () => {
    // 旧只读工具没有 agent token；reserved2 模式下通过桥接 /api/status 直接拒绝，
    // 避免绕过二代仿真模式的令牌隔离。
    try {
      const status = await agentApi('/api/status');
      if (status?.mode === 'reserved2') {
        return { content: [{ type: 'text', text: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出群成员（只读）。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '读群历史消息（只读）。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '发群消息（纯文本；引用传 replyToMessageId）。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '引用某条消息回复（适合回更早的那条）。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '发私聊消息（目标必须命中白名单）。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看自己的角色/推荐值/可用工具（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '看未读消息（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'), limit: z.number().optional().describe('最多返回条数，默认 30，最大 100') },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '看最近消息，可 offset 前翻（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看当前会话的仿真状态（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '标记已读（不回复时收尾用）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置唤醒/潜水策略（何时再被叫醒）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '分多条发（桥接自动拉开间隔）。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送：字符串=一条，数组=多条；可引用/@。优先用它。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '拍一拍（群聊需 targetUserId）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等群友消息；沉睡前必须用它做满观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    timeoutMs: z.number().optional().describe('总等待毫秒数；普通等待默认 30000，沉睡前观察请传 300000（最大 600000）'),
    minNewMessages: z.number().optional().describe('至少等到多少条新消息才提前返回，默认 1'),
    quietMs: z.number().optional().describe('检测到新消息后继续等待的静默窗口（毫秒），用于判断对方是否说完了')
  },
  async ({ key, token, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApiLong('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向管理端反馈问题/困惑。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '看自己刚发过的消息（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '看单条消息详情（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '看最近活跃成员（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记轻量记忆：进行中话题/想说的话/对某人的印象。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查轻量记忆（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删一条轻量记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查已确认的群黑话（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '提交不认识的词/梗给管理端筛选。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '看消息里的图片（视觉理解）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '看/搜收藏表情。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约…'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        if (refresh) q.set('refresh', '1');
        const data = await agentApi(`/api/socialV2/sticker-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '看某个表情长什么样。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '发一张收藏表情（单独一条，不能带文字）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏表情：聊天里别人发的图，或你在网上找到/自己生成的图（偶尔，别手贱）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().optional().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages）；收聊天里的图时填这个'),
      file: z.string().optional().describe('外部图源：https://直链 或 base64://数据 或 file:///D:/qqbot/outbox/文件名；收网上搜到的图或自己生成的图时填这个。与 messageId 二选一，两个都给则以 file 为准'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, file, remark }) => {
      try {
        const f = String(file ?? '').trim();
        const mid = String(messageId ?? '').trim();
        if (!f && !mid) {
          return { content: [{ type: 'text', text: 'messageId 和 file 至少要给一个：收聊天里的图填 messageId，收网上/本地的图填 file' }], isError: true };
        }
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, ...(f ? { file: f } : { messageId: mid }), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '看自己的默认形象图。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给表情记本地含义/标签/用法。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '改 QQ 官方表情备注（默认禁用）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '看合并转发/聊天记录内容。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}


if (cfg.socialV2?.tools?.getFriendHistory !== false) {
  server.tool(
    'qq_get_friend_msg_history',
    '读好友私聊历史（只读）。',
    {
      key: z.string().describe('会话 key，private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      count: z.number().optional().describe('条数 1-30，默认 20'),
      messageSeq: z.number().optional().describe('起始消息序号，从该序号往前取（可选）')
    },
    async ({ key, token, count, messageSeq }) => {
      try {
        const m = /^private:(\d+)$/.exec(String(key ?? '').trim());
        if (!m) return { content: [{ type: 'text', text: 'key 必须是 private:QQ号（本工具只读好友私聊历史）' }], isError: true };
        const data = await agentApi('/api/socialV2/friend-history', {
          method: 'POST',
          body: JSON.stringify({ userId: m[1], count, messageSeq: messageSeq ?? null, token }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '读取私聊历史失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_send_image',
    '向指定会话发送一张图片，可附带一句说明文字。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      file: z.string().describe('图片来源：https://直链 或 base64://数据 或 file:///D:/qqbot/outbox/文件名'),
      caption: z.string().optional().describe('随图说明文字（可选，纯文本）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（可选，非零整数）')
    },
    async ({ key, token, file, caption, replyToMessageId }) => {
      try {
        const parts = [{ type: 'image', file: String(file ?? '').trim() }];
        const cap = String(caption ?? '').trim();
        if (cap) parts.push({ type: 'text', text: cap });
        const body = { key, parts, token };
        if (replyToMessageId != null && String(replyToMessageId).trim() !== '') body.replyToMessageId = replyToMessageId;
        const data = await agentApi('/api/send/rich', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '发送图片失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.sendFace !== false) {
  server.tool(
    'qq_send_face',
    '发 QQ 系统小表情（1-3 位数字 id）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      faceId: z.union([z.number(), z.string()]).describe('QQ 系统表情数字 id（1-3 位数字）'),
      caption: z.string().optional().describe('随表情文字（可选，纯文本）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（可选，非零整数）')
    },
    async ({ key, token, faceId, caption, replyToMessageId }) => {
      try {
        const parts = [{ type: 'face', id: String(faceId ?? '').trim() }];
        const cap = String(caption ?? '').trim();
        if (cap) parts.push({ type: 'text', text: cap });
        const body = { key, parts, token };
        if (replyToMessageId != null && String(replyToMessageId).trim() !== '') body.replyToMessageId = replyToMessageId;
        const data = await agentApi('/api/send/rich', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '发送系统表情失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}


if (cfg.socialV2?.tools?.adminOps !== false) {
  server.tool(
    'qq_group_admin',
    '群管理（禁言/踢人/名片/头衔/精华）：仅主人私聊令牌可用。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().describe('ban|unban|wholeBan|wholeUnban|kick|setCard|setAdmin|unsetAdmin|setTitle|essence'),
      groupId: z.union([z.number(), z.string()]).describe('目标群号'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('目标群成员 QQ 号（ban/unban/kick/setCard/setAdmin/unsetAd…'),
      duration: z.number().optional().describe('禁言秒数（action=ban 时有效，默认 600，最长 2592000）'),
      card: z.string().optional().describe('新群名片（action=setCard）'),
      title: z.string().optional().describe('新专属头衔（action=setTitle）'),
      messageId: z.union([z.number(), z.string()]).optional().describe('消息 id（action=essence）')
    },
    async ({ key, token, action, groupId, targetUserId, duration, card, title, messageId }) => {
      try {
        const body = { key, token, action, groupId };
        if (targetUserId != null) body.targetUserId = String(targetUserId);
        if (duration != null) body.duration = duration;
        if (card != null) body.card = card;
        if (title != null) body.title = title;
        if (messageId != null) body.messageId = messageId;
        const data = await agentApi('/api/socialV2/admin', { method: 'POST', body: JSON.stringify(body), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '管理操作失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.memoryDb !== false) {
  server.tool(
    'qq_db_remember',
    '写长期记忆（跨会话永久保存的事实）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      content: z.string().describe('要记住的事实，一句话说清（最长 500 字）'),
      category: z.string().optional().describe('分类标签：fact/habit/promise/person/joke 等（默认 fact）'),
      importance: z.number().optional().describe('重要度 1-5，默认 1')
    },
    async ({ key, token, content, category, importance }) => {
      try {
        const data = await agentApi('/api/socialV2/memory/remember', { method: 'POST', body: JSON.stringify({ key, token, content, category, importance }), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '写入记忆失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_db_recall',
    '查长期记忆（关键词/最近）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('关键词（模糊匹配，可省略=看最近）'),
      limit: z.number().optional().describe('返回条数 1-50，默认 10')
    },
    async ({ key, token, query, limit }) => {
      try {
        const data = await agentApi('/api/socialV2/memory/recall', { method: 'POST', body: JSON.stringify({ key, token, query, limit }), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '检索记忆失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_db_forget',
    '删长期记忆（按 id 或关键词）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.number().optional().describe('要删除的记忆 id'),
      query: z.string().optional().describe('或按关键词模糊删除（可删多条，慎用）')
    },
    async ({ key, token, id, query }) => {
      try {
        const data = await agentApi('/api/socialV2/memory/forget', { method: 'POST', body: JSON.stringify({ key, token, id, query }), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '删除记忆失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.reminder !== false) {
  server.tool(
    'qq_set_reminder',
    '设定时提醒（到点唤醒你主动说话）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号（提醒到点在此会话触发）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('提醒内容：到点说什么事、要做什么'),
      delayMinutes: z.number().optional().describe('多少分钟后提醒（支持小数，如 0.5=30 秒）'),
      fireAt: z.union([z.string(), z.number()]).optional().describe('或指定时间点：ISO 8601 串（如 2026-09-23T08:00:00+08:00）或毫秒时间戳')
    },
    async ({ key, token, text, delayMinutes, fireAt }) => {
      try {
        const data = await agentApi('/api/socialV2/reminder/set', { method: 'POST', body: JSON.stringify({ key, token, text, delayMinutes, fireAt }), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '设置提醒失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_reminders',
    '看待触发的提醒。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      status: z.string().optional().describe('筛选状态：pending（默认）/fired/cancelled')
    },
    async ({ key, token, status }) => {
      try {
        const data = await agentApi('/api/socialV2/reminder/list', { method: 'POST', body: JSON.stringify({ key, token, status }), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '查询提醒失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_cancel_reminder',
    '取消提醒。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.number().describe('要取消的提醒 id（来自 qq_set_reminder 或 qq_list_reminders）')
    },
    async ({ key, token, id }) => {
      try {
        const data = await agentApi('/api/socialV2/reminder/cancel', { method: 'POST', body: JSON.stringify({ key, token, id }), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '取消提醒失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}


// ════ P3：PC 控制工具段（T1/T2） ══════════════════════════════════════
// 安全模型：每个工具先过 ownerGate —— key 必须是主人私聊，令牌经桥接校验。
// 群会话/无效令牌一律拒绝；执行细节见 pc-actions.js。cfg.pcControl.enabled 可全局关断。

if (getConfig().pcControl?.enabled !== false) {
  async function pcGate(key, token) {
    const ownerKey = 'private:' + String(getConfig().ownerQQ ?? '');
    if (String(key ?? '').trim() !== ownerKey) {
      return 'PC 工具仅限主人私聊会话（' + ownerKey + '）调用；群聊里谁要求都拒绝';
    }
    try {
      await authorizeRead(String(key).trim(), String(token ?? '').trim());
      return null;
    } catch (error) {
      return '主人令牌校验失败：' + (error?.message ?? error);
    }
  }

  server.tool(
    'pc_sys_info',
    '查主人电脑状态（CPU/内存/电量/磁盘）。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.sysInfo();
      return r.ok
        ? { content: [{ type: 'text', text: r.output }] }
        : { content: [{ type: 'text', text: '查询失败：' + r.error }], isError: true };
    }
  );

  server.tool(
    'pc_screenshot',
    '截主人电脑全屏并存 outbox，再用 qq_send_image 发。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.screenshot();
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r.ok === false };
    }
  );

  server.tool(
    'pc_volume',
    '调音量 up/down/mute。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().describe('up | down | mute'),
      steps: z.number().optional().describe('按键次数 1-50，默认 5')
    },
    async ({ key, token, action, steps }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.volume(action, steps ?? 5);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r.ok === false };
    }
  );

  server.tool(
    'pc_media',
    '媒体键 playpause/next/prev/stop。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().describe('playpause | next | prev | stop')
    },
    async ({ key, token, action }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.media(action);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r.ok === false };
    }
  );

  server.tool(
    'pc_open_url',
    '用默认浏览器开 http(s) 链接。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      url: z.string().describe('要打开的 http(s) 链接')
    },
    async ({ key, token, url }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.openUrl(url);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r.ok === false };
    }
  );

  server.tool(
    'pc_open_app',
    '启动白名单应用。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      name: z.string().describe('白名单应用名')
    },
    async ({ key, token, name }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.openApp(name);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r.ok === false };
    }
  );

  server.tool(
    'pc_lock',
    '锁屏。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.lockScreen();
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r.ok === false };
    }
  );

  server.tool(
    'pc_run_command',
    '执行 PowerShell 并回传输出（最高权限）。仅主人私聊。',
    {
      key: z.string().describe('必须为 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      command: z.string().describe('要执行的 PowerShell 命令'),
      timeoutSec: z.number().optional().describe('超时秒数 1-120，默认 30')
    },
    async ({ key, token, command, timeoutSec }) => {
      const deny = await pcGate(key, token);
      if (deny) return { content: [{ type: 'text', text: deny }], isError: true };
      const r = await pc.runCommand(command, timeoutSec);
      return { content: [{ type: 'text', text: r.ok ? r.output : '执行失败：' + r.error }], isError: r.ok === false };
    }
  );
}


if (cfg.socialV2?.tools?.myStatus !== false) {
  server.tool(
    'qq_my_group_status',
    '查自己在群里的状态（名片/角色/是否被禁言）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:1918594889（主人私聊）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      groupId: z.union([z.number(), z.string()]).optional().describe('要查询的群号（主人私聊会话可指定；群会话默认查当前群）')
    },
    async ({ key, token, groupId }) => {
      try {
        const body = { key, token };
        if (groupId != null && String(groupId).trim() !== '') body.groupId = String(groupId).trim();
        const data = await agentApi('/api/socialV2/my-status', { method: 'POST', body: JSON.stringify(body), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '查询群状态失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_friend_list',
    '看好友清单（只读）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/friend-list', { method: 'POST', body: JSON.stringify({ key, token }), timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '查询好友列表失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}


if (cfg.socialV2?.tools?.affinity !== false) {
  server.tool(
    'qq_affinity',
    '好感度与印象：list/get/bump/set。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().describe('list | get | bump | set'),
      memberId: z.union([z.number(), z.string()]).optional().describe('群友 QQ 号（get/bump/set 必填）'),
      name: z.string().optional().describe('对方当前称呼/群名片（可选，会更新显示名）'),
      delta: z.number().optional().describe('action=bump 时的变化量（-20~+20）'),
      score: z.number().optional().describe('action=set 时的目标分数（-100~100）'),
      note: z.string().optional().describe('一句话印象/最新观感（可选，覆盖旧备注）'),
      limit: z.number().optional().describe('action=list 返回条数，默认 20')
    },
    async ({ key, token, action, memberId, name, delta, score, note, limit }) => {
      try {
        const body = { key, token, action };
        if (memberId != null) body.memberId = String(memberId);
        if (name != null) body.name = name;
        if (delta != null) body.delta = delta;
        if (score != null) body.score = score;
        if (note != null) body.note = note;
        if (limit != null) body.limit = limit;
        const data = await agentApi('/api/socialV2/affinity', { method: 'POST', body: JSON.stringify(body), headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '好感度操作失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_self_note',
    '写自我演化笔记（风格/自我认知/小习惯）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().describe('add | list'),
      kind: z.string().optional().describe('style | self | quirk（默认 style）'),
      content: z.string().optional().describe('笔记内容，一句话（action=add 必填，最长 200 字）'),
      limit: z.number().optional().describe('action=list 返回条数，默认 5')
    },
    async ({ key, token, action, kind, content, limit }) => {
      try {
        const body = { key, token, action };
        if (kind != null) body.kind = kind;
        if (content != null) body.content = content;
        if (limit != null) body.limit = limit;
        const data = await agentApi('/api/socialV2/self-note', { method: 'POST', body: JSON.stringify(body), headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '自我笔记操作失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}


if (cfg.socialV2?.tools?.personProfile !== false) {
  server.tool(
    'qq_person_profile',
    '维护某人的结构化画像（称呼/喜好/雷区/风格/近况）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().describe('get | set'),
      memberId: z.union([z.number(), z.string()]).describe('对方的 QQ 号（必填）'),
      name: z.string().optional().describe('对方当前称呼/群名片（可选）'),
      callName: z.string().optional().describe('你以后怎么称呼他（如"柚子主人""枭鸟哥哥"）'),
      likes: z.string().optional().describe('喜欢什么（话题/食物/游戏/被怎么对待）'),
      dislikes: z.string().optional().describe('雷区：不喜欢什么、讨厌被怎么对待'),
      style: z.string().optional().describe('说话风格（话少直接/爱发梗/爱吐槽…）'),
      status: z.string().optional().describe('最近状态（在忙什么、心情如何）'),
      note: z.string().optional().describe('一句话总印象（会覆盖旧备注）')
    },
    async ({ key, token, action, memberId, name, callName, likes, dislikes, style, status, note }) => {
      try {
        const body = { key, token, action, memberId: String(memberId) };
        for (const [k, v] of Object.entries({ name, callName, likes, dislikes, style, status, note })) if (v != null) body[k] = v;
        const data = await agentApi('/api/socialV2/person-profile', { method: 'POST', body: JSON.stringify(body), headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '画像操作失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );

  server.tool(
    'qq_followup',
    '待跟进事项：list/add/done/cancel。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      action: z.string().describe('list | add | done | cancel'),
      topic: z.string().optional().describe('action=add 时：要跟进什么事（一句话）'),
      name: z.string().optional().describe('action=add 时：谁的事（对方称呼）'),
      dueInHours: z.number().optional().describe('action=add 时：几小时后提醒（默认 6，最小 0.05=3 分钟）'),
      id: z.number().optional().describe('action=done/cancel 时：条目 id'),
      status: z.string().optional().describe('action=list 时：pending（默认）/fired/done/cancelled/all')
    },
    async ({ key, token, action, topic, name, dueInHours, id, status }) => {
      try {
        const body = { key, token, action };
        if (topic != null) body.topic = topic;
        if (name != null) body.name = name;
        if (dueInHours != null) body.dueInHours = dueInHours;
        if (id != null) body.id = id;
        if (status != null) body.status = status;
        const data = await agentApi('/api/socialV2/followup', { method: 'POST', body: JSON.stringify(body), headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '待跟进操作失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}


if (cfg.socialV2?.tools?.help !== false) {
  server.tool(
    'qq_help',
    '查工具的完整说明（工具列表里的描述是精简版；不确定怎么用就来这查）。',
    {
      name: z.string().optional().describe('工具名，如 qq_wait_for_messages；不传则返回全部工具名')
    },
    async ({ name: toolName }) => {
      const key = String(toolName ?? '').trim();
      if (!key) {
        const names = Object.keys(TOOL_DOCS);
        return { content: [{ type: 'text', text: '可用工具（' + names.length + '）：\n' + names.join(', ') }] };
      }
      const exact = TOOL_DOCS[key];
      if (exact) return { content: [{ type: 'text', text: '【' + key + '】\n' + exact }] };
      const fuzzy = Object.keys(TOOL_DOCS).filter((n) => n.includes(key) || key.includes(n));
      if (fuzzy.length === 1) return { content: [{ type: 'text', text: '【' + fuzzy[0] + '】\n' + TOOL_DOCS[fuzzy[0]] }] };
      return { content: [{ type: 'text', text: fuzzy.length ? '匹配到多个：' + fuzzy.join(', ') : '没找到工具 ' + key }] };
    }
  );
}

await server.connect(new StdioServerTransport());
