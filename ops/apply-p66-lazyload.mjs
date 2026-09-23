// P6-6 工具懒加载：描述精简（保留可识别性）+ 全文转存 tool-docs.js + 新增 qq_help 按需查全文
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SAFE = 'D:/qqbot/qq-bridge/src/mcp-snowluma-safe.js';
const DOCS = 'D:/qqbot/qq-bridge/src/tool-docs.js';
let t = fs.readFileSync(SAFE, 'utf8');
if (t.includes('qq_help')) throw new Error('已做过懒加载');

// ── 1) 抽取现有工具描述 ──
const tools = [...t.matchAll(/server\.tool\(\r?\n\s*'([a-z0-9_]+)',\r?\n\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => ({ name: m[1], desc: m[2], raw: m[0] }));
console.log('抽取工具:', tools.length);

// ── 2) 手工精写关键工具的短描述（协议性内容在人格里有，这里只留"是干什么的"） ──
const OVERRIDES = {
  qq_status: '查机器人登录状态（只读）。',
  qq_list_groups: '列出她所在的群（只读）。',
  qq_get_group_members: '列出群成员（只读）。',
  qq_get_group_history: '读群历史消息（只读）。',
  qq_send_group_message: '发群消息（纯文本；引用传 replyToMessageId）。',
  qq_reply: '引用某条消息回复（适合回更早的那条）。',
  qq_send_private_message: '发私聊消息（目标必须命中白名单）。',
  qq_send_message: '统一发送：字符串=一条，数组=多条；可引用/@。优先用它。',
  qq_send_burst: '分多条发（桥接自动拉开间隔）。',
  qq_send_poke: '拍一拍（群聊需 targetUserId）。',
  qq_wait_for_messages: '等群友消息；沉睡前必须用它做满观察窗口。',
  qq_get_prompt: '查看自己的角色/推荐值/可用工具（只读）。',
  qq_get_unread_messages: '看未读消息（只读）。',
  qq_get_recent_messages: '看最近消息，可 offset 前翻（只读）。',
  qq_mark_read: '标记已读（不回复时收尾用）。',
  qq_set_wake_config: '设置唤醒/潜水策略（何时再被叫醒）。',
  qq_social_state: '查看当前会话的仿真状态（只读）。',
  qq_report_feedback: '向管理端反馈问题/困惑。',
  qq_get_my_recent_messages: '看自己刚发过的消息（只读）。',
  qq_get_message_detail: '看单条消息详情（只读）。',
  qq_get_active_members: '看最近活跃成员（只读）。',
  qq_memory_append: '记轻量记忆：进行中话题/想说的话/对某人的印象。',
  qq_memory_query: '查轻量记忆（只读）。',
  qq_memory_remove: '删一条轻量记忆。',
  qq_memory_clear: '清空轻量记忆。',
  qq_slang_query: '查已确认的群黑话（只读）。',
  qq_slang_submit: '提交不认识的词/梗给管理端筛选。',
  qq_get_message_images: '看消息里的图片（视觉理解）。',
  qq_list_stickers: '看/搜收藏表情。',
  qq_get_sticker_image: '看某个表情长什么样。',
  qq_send_sticker: '发一张收藏表情（单独一条，不能带文字）。',
  qq_collect_sticker: '收藏别人发的表情（偶尔，别手贱）。',
  qq_sticker_note: '给表情记本地含义/标签/用法。',
  qq_set_sticker_remark: '改 QQ 官方表情备注（默认禁用）。',
  qq_get_self_image: '看自己的默认形象图。',
  qq_get_forward_msg: '看合并转发/聊天记录内容。',
  qq_get_friend_msg_history: '读好友私聊历史（只读）。',
  qq_friend_list: '看好友清单（只读）。',
  qq_my_group_status: '查自己在群里的状态（名片/角色/是否被禁言）。',
  qq_group_admin: '群管理（禁言/踢人/名片/头衔/精华）：仅主人私聊令牌可用。',
  qq_db_remember: '写长期记忆（跨会话永久保存的事实）。',
  qq_db_recall: '查长期记忆（关键词/最近）。',
  qq_db_forget: '删长期记忆（按 id 或关键词）。',
  qq_set_reminder: '设定时提醒（到点唤醒你主动说话）。',
  qq_list_reminders: '看待触发的提醒。',
  qq_cancel_reminder: '取消提醒。',
  qq_affinity: '好感度与印象：list/get/bump/set。',
  qq_self_note: '写自我演化笔记（风格/自我认知/小习惯）。',
  qq_person_profile: '维护某人的结构化画像（称呼/喜好/雷区/风格/近况）。',
  qq_followup: '待跟进事项：list/add/done/cancel。',
  qq_send_image: '发图片（http 直链/base64/outbox 本地文件）。',
  qq_send_face: '发 QQ 系统小表情（1-3 位数字 id）。',
  pc_sys_info: '查主人电脑状态（CPU/内存/电量/磁盘）。仅主人私聊。',
  pc_screenshot: '截主人电脑全屏并存 outbox，再用 qq_send_image 发。仅主人私聊。',
  pc_volume: '调音量 up/down/mute。仅主人私聊。',
  pc_media: '媒体键 playpause/next/prev/stop。仅主人私聊。',
  pc_open_url: '用默认浏览器开 http(s) 链接。仅主人私聊。',
  pc_open_app: '启动白名单应用。仅主人私聊。',
  pc_lock: '锁屏。仅主人私聊。',
  pc_run_command: '执行 PowerShell 并回传输出（最高权限）。仅主人私聊。',
};

const shortOf = (name, desc) => {
  if (OVERRIDES[name]) return OVERRIDES[name];
  const clean = desc.replace(/\\'/g, "'");
  const first = clean.split(/[。！]/)[0];
  let s = (first.length >= 12 ? first : clean.slice(0, 60)).replace(/\s+/g, ' ').trim();
  if (s.length > 56) s = s.slice(0, 54) + '…';
  return s.endsWith('。') ? s : s + '。';
};

// ── 3) 生成 tool-docs.js（全文） ──
const docsLines = tools.map((x) => `  ${JSON.stringify(x.name)}: ${JSON.stringify(x.desc.replace(/\\'/g, "'"))}`);
const docsContent = `// 工具完整说明（P6-6 懒加载）：工具描述已精简，全文用 qq_help 按需查询。
export const TOOL_DOCS = {
${docsLines.join(',\n')}
};

export function toolCatalog() {
  return Object.keys(TOOL_DOCS);
}
`;
fs.writeFileSync(DOCS, docsContent);
console.log('✅ tool-docs.js 已生成（', docsLines.length, '条全文说明）');

// ── 4) 替换工具描述为短版 ──
let replaced = 0;
for (const x of tools) {
  const short = shortOf(x.name, x.desc);
  const from = `'${x.name}',\n    '${x.desc}'`;
  const fromCrlf = `'${x.name}',\r\n    '${x.desc}'`;
  const to = `'${x.name}',\n    '${short}'`;
  const toCrlf = `'${x.name}',\r\n    '${short}'`;
  if (t.includes(from)) { t = t.replace(from, to); replaced++; }
  else if (t.includes(fromCrlf)) { t = t.replace(fromCrlf, toCrlf); replaced++; }
  else console.log('  ⚠️ 未替换:', x.name);
}
console.log('✅ 已精简', replaced, '个工具描述');

// ── 5) 新增 qq_help（放最后，在 connect 之前） ──
const helpTool = `
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
        return { content: [{ type: 'text', text: '可用工具（' + names.length + '）：\\n' + names.join(', ') }] };
      }
      const exact = TOOL_DOCS[key];
      if (exact) return { content: [{ type: 'text', text: '【' + key + '】\\n' + exact }] };
      const fuzzy = Object.keys(TOOL_DOCS).filter((n) => n.includes(key) || key.includes(n));
      if (fuzzy.length === 1) return { content: [{ type: 'text', text: '【' + fuzzy[0] + '】\\n' + TOOL_DOCS[fuzzy[0]] }] };
      return { content: [{ type: 'text', text: fuzzy.length ? '匹配到多个：' + fuzzy.join(', ') : '没找到工具 ' + key }] };
    }
  );
}
`;
const anchor = 'await server.connect(new StdioServerTransport());';
const i = t.indexOf(anchor);
const lineStart = t.lastIndexOf('\n', i) + 1;
t = t.slice(0, lineStart) + helpTool + '\n' + t.slice(lineStart);

// ── 6) 引入 TOOL_DOCS ──
t = t.replace("import { SENSITIVE_RE } from './sensitive.js';", "import { SENSITIVE_RE } from './sensitive.js';\nimport { TOOL_DOCS } from './tool-docs.js';");

fs.writeFileSync(SAFE, t);
execFileSync('node', ['--check', SAFE], { stdio: 'inherit' });
execFileSync('node', ['--check', DOCS], { stdio: 'inherit' });
console.log('✅ syntax OK');
