# qq-bridge 升级方案（2026-09-25 同类项目调研）

> 调研方法：按主人要求「多使用 Git 去找插件，参考学习」，在 GitHub / npm 上系统搜了四类项目——
> ① DSH 原生 QQ 插件（与我们同宿主，最可直接对照）② 通用 LLM-IM 框架 ③ 好感度/记忆/角色卡类插件
> ④ 记忆架构文章。下面每条升级都注明**借鉴来源**与**我们代码的落点**，不做无出处的空想。
> 本仓库是公开参考仓库，这份文档同时写给以后的 AI 会话看：先读这里，别重复造轮子。

---

## 1. 同类项目一览

| 项目 | 架构 | 与我们的关系 | 最值得借的 |
|---|---|---|---|
| [gcry13067381632-jpg/dsh-qqbot](https://github.com/gcry13067381632-jpg/dsh-qqbot)（npm `@zaofan/dsh-qqbot` v1.5.9，fork 自 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)） | **DSH Cordis 插件**，QQ 官方 bot WebSocket | 同宿主不同接入（官方 bot API vs 我们的 OneBot 钩子客户端） | 好感度**双维度**模型、表情图库三态、回复闸门、悬浮球 dock、DSH 版本坑清单 |
| [master1Sun/dsh-QQbot](https://github.com/master1Sun/dsh-QQbot) | DSH 插件，`ctx.webhookRuntime` | 同宿主 | 群消息**价值评分**过滤、定时消息 `mode=ai`、**发送失败出箱重投**、主动消息**每日配额**、语音转写五档 |
| [Chenlong-Tao/AstrBot](https://github.com/Chenlong-Tao/AstrBot) | 独立多平台框架 + WebUI | 生态参照 | 插件市场形态、人格/知识库组织方式 |
| [langbot-app/LangBot](https://github.com/langbot-app/LangBot)（[特性规格](https://docs.langbot.app/zh/insight/features)） | 生产级 LLM-IM 平台 | 生态参照 | Pipeline 抽象、RAG 知识库、技能(Skills)、代码沙箱、Rerank |
| [zhenxun-org/zhenxun_bot](https://github.com/zhenxun-org/zhenxun_bot) | NoneBot2 + PostgreSQL | 功能广度参照 | 群功能全家桶形态（签到/好感度/抽卡…） |
| [MerCuJerry/nonebot-plugin-likeabi](https://github.com/MerCuJerry/nonebot-plugin-likeabi) | NoneBot2 插件 | 好感度入门参照 | 关键词回复 + 好感点数（`point`/`limit`/黑白名单）——**偏简单，双维度模型以 zaofan 为准** |
| [LingyeSoul/dsh-tavern](https://github.com/LingyeSoul/dsh-tavern/blob/main/docs/exploration/2026-08-14-st-formats.md) | DSH + SillyTavern 互操作探索 | **规范宝库** | 角色卡 CCv2/V3 字段全表、世界书（lorebook）条目字段与**触发算法**、宏体系、preset 装配顺序 |
| [mem0 长期记忆](https://mem0.ai/blog/long-term-memory-ai-agents) / [Dream 后台固化](https://mem0.ai/blog/dream-background-memory-consolidation-for-ai-agents) | 记忆层产品 | 架构参照 | 抽取→固化管线；我们 P8 夜间维护已是同思路的简化版 |
| [zhayujie/chatgpt-on-wechat](https://github.com/zhayujie/chatgpt-on-wechat) | 微信系多平台 | 生态参照 | 拟人化改造实战经验（linkai/记忆/角色） |

**关键结论**：DSH 生态里已经有两个成熟的 QQ 接入插件（zaofan / master1Sun），它们走**官方 bot API**
（需 AppID/AppSecret、群消息范围审核、被动回复窗口 5 分钟/5 次）；我们走 **SnowLuma/OneBot 钩子真实客户端**
（无窗口限制、能收全量群消息、能用真实账号身份），路线不同但**上层玩法完全可以互相借鉴**。
我们不迁架构，只搬能力。

---

## 2. 逐项对照：他们有什么、我们有什么

| 能力 | zaofan | master1Sun | 我们（qq-bridge） | 差距 |
|---|---|---|---|---|
| 好感度 | **熟识度+好感度双维度**；小模型读「思考vs正文」判让步；价值×好感加权防钓 | — | 单维度 `affinity(score,note)`；`affinityBoostFor`（bridge.js:9161）已把好感折算成主动概率加成（上限+40%，只算正分） | 缺熟识度维度、缺内心/正文一致性判定 |
| 表情包 | 自动去重、**待整理/收藏/回收站三态**、语义搜库（"发个开心点的图"）、场合判断（冷场不发/刷屏限量/同图不连发） | — | collect（聊天图+外部图源）/list/send/note/tags；库里有 md5 字段（bridge.js:3668） | 三态生命周期、按情绪搜库、发送节流待补 |
| 定时消息 | "每天早9点说早安"、"30秒后提醒喝水" | `/定时 每天/间隔/查看/取消`，**`mode=ai` 到点现场生成** | `qq_set_reminder` 一次性（delayMinutes/fireAt，最远15天，SQLite `reminders` 表，bridge.js:4761）+ followup（dueInHours） | **无重复、无 mode=ai** |
| 群消息过滤 | 回复闸门 reply_gate（AI 自主判断开口/静默） | **价值评分**过滤后才插话 | 规则触发（@/名字/关键词/提问/拍/概率/指定成员）+ 唤醒后自决 + 沉睡前强制观察窗 | 缺独立价值评分层（规则触发已覆盖大部分） |
| 主动消息 | 每日配额隐含在闸门里 | **quotaPerDay=50 硬配额** | 精力曲线（深夜趋零）+ 好感加权 + 近1h发言≥5条×0.3 + 发送受阻冷却 + idle≥15min + 会话繁忙检查（bridge.js:9178） | 缺每日硬配额（软限制已较全） |
| 发送可靠性 | — | **出箱每60s重投** | 失败诊断（`diagnoseGroupSendFailure`）+ group-health 三振 + send-block 日志；失败即弃 | 缺重投 |
| 语音 | silk-wasm+lamejs（SILK↔mp3）、语音条收发 | 转写五档、TTS 回复、正在输入 | 无 | 全缺 |
| 角色卡/世界书 | 预设人格编辑器（网页改性格文件） | — | `roleState.role` 字符串 + `qq_get_prompt` 完整卡；黑话表/表情策略按关键词注入（简化版 lorebook） | 无结构化卡、无通用世界书 |
| 记忆 | — | 长期记忆跨会话（`/记忆`） | 长期库（importance 1-5/category/recall）+ 轻量记忆（activeTopics/pendingThoughts/memberImpressions）+ **P8 夜间维护**（近似合并/低价值衰减/过期归档）+ 每日复盘 | 已领先；可补检索排序（相关×新近×重要） |
| 多实例/多平台 | N 条鲸鱼同机 | 多机器人 bots.json | 单实例 | **不需要**（见 §4） |
| PC 控制 | — | — | **17 个 pc_* 工具**（命令/长任务/打字/组合键/窗口/剪贴板/截图/音量/媒体/应用/锁屏） | 我们独有 |
| 管理/审批 | 入群审批、禁言、敏感操作按钮审批 | 敏感操作按钮审批 | 群管八件套（ban/kick/名片/头衔/精华…，主人令牌门禁）+ APPROVE_WORDS/REJECT_WORDS 审批词（bridge.js:707） | 按钮交互审批可补，优先级低 |

---

## 3. 升级方案

### P0 —— 小改动、立刻能感知（建议先做）

#### P0-1 定时任务：重复 + `mode=ai`（借 master1Sun `/定时`、zaofan「到点自己开口」）
- **现状**：`reminders(conv_key,text,fire_at,created_at,status)` 一次性、念固定稿。
- **改法**：
  - `reminder/set` 增 `repeat:{kind:'daily'|'weekly'|'interval', at:'09:00'|weekday, everyMs}` 与 `mode:'text'|'ai'`；
    触发后若 repeat 非空则**重排下一次**而不是置 fired（注意夏令时/跨天，统一用本地时区算锚点，
    参考 P8 复盘锚点的写法，别再用 `toISOString()` 那种 UTC/本地混用的坑）。
  - `mode='ai'`：到点不念稿，改为 `sendWakePromptV2(key,'schedule')`，`buildWakePromptV2`（bridge.js:8804）
    加一个 `reason==='schedule'` 分支，提示词带上原 text 作为「话头」让她现场发挥——**完全复用现有唤醒管线，零新依赖**。
  - MCP `qq_set_reminder` 参数同步扩展；`qq_list_reminders` 返回 repeat/mode。
- **落点**：bridge.js reminder 三端点（4761）+ reminders 表加列（`ALTER TABLE` 兼容旧行）+ 触发器 + MCP 参数。
- **工作量**：小-中。**风险**：低（新列默认 NULL，旧提醒行为不变）。

#### P0-2 主动消息每日硬配额 + 同图不连发（借 master1Sun `quotaPerDay`、zaofan 刷屏限量）
- **现状**：软限制已多（精力曲线/好感加权/近1h≥5条×0.3/冷却），但**没有每日硬上限**；表情发送无节流。
- **改法**：
  - 会话状态加 `proactiveToday{date,count}`，`scheduleProactiveCheckV2`（9178）触发前检查，
    超配额（默认 12/会话/日，config 可调）则跳过并记一行日志；跨日重置。
  - 表情：会话状态加 `lastStickerSent{stickerId,at}`，同图 N 分钟（默认 30）内不重发；
    收藏时按 md5 去重（**库结构已有 md5，收藏路径是否查重待实现时确认**）。
- **工作量**：小。**风险**：低。

#### P0-3 发送失败出箱重投（借 master1Sun outbox 60s 重投）
- **现状**：失败只诊断+记三振，消息即弃。
- **改法**：`diagnoseGroupSendFailure` 已能分类——**可重试类**（网络抖动/临时风控）写入
  `state/send-outbox.json`，60s 周期重投，最多 3 次；**不可重试类**（被踢/群解散/禁言中）直接弃并记日志。
  重投必须尊重 P8-3b 的 sendBlock 冷却（`sendBlockActive`），**禁言期重投=空烧+风险**。
- **工作量**：中。**风险**：中（与冷却/三振的交互要测清楚；重投成功要清三振计数）。

### P1 —— 陪伴感跃升

#### P1-4 好感度双维度：熟识度 + 好感度（几乎照搬 zaofan v1.5.1 模型）
- **借鉴**（zaofan README 原文要点）：
  - **熟识度**=她把你记得多牢（来过几天、说过多少、被点名、接话）——**慢变量，自动算**；
  - **好感度**=她对你什么态度——随互动可升可降；
  - 判定读「**思考（内心）**」与「**正文（说出口）**」：心里不肯但话仍照顾=让步；心里亲近嘴上冷淡=不算数；
  - **好感只影响「她愿不愿意自己开口」的松紧：负好感也只是少主动，绝不冷落、阴阳、攻击**；
  - 群消息聚合按「价值×好感」加权平均，不会被一句话钓走。
- **我们的独特优势**：reserved2 下她的文本**本来就不自动转发**，桥接完整看得到「AI 内部输出」
  （日志里的 `AI 内部输出（不自动转发）`）——**「思考」通道天然存在**，zaofan 要专门接小模型读的东西我们白捡。
- **改法**：
  - `affinity` 表加 `familiarity`（熟识度）与统计列（first_seen/interactions/mentions/replies），
    由桥接在消息入站时自动累计，**不靠 AI 手填**（AI 只动 score/note，熟识度是客观量）；
  - 每轮结束后做一次**轻量一致性判定**（先用规则：内部输出含明显负面/抗拒词而正文友好 → 记一次「让步」事件，
    好感小幅下调但熟识度不动；后续可换小模型）；
  - `affinityBoostFor`（9161）改为读双维度：熟识度影响**记忆召回权重与称呼亲密度**，好感度维持只影响主动概率；
  - 唤醒提示词注入熟识度（"你们认识 N 天、说过 M 句"），让她演得有据。
- **红线（照搬 zaofan）**：好感低**只降主动频率**，禁止改变语气/冷落/阴阳。这条要写进提示词与代码注释。
- **工作量**：中。**风险**：中（一致性判定误判会伤关系，规则要保守、可关断）。

#### P1-5 表情图库三态 + 语义搜库 + 场合判断（借 zaofan）
- 三态：`待整理/收藏/回收站`（新收的图默认待整理，她或主人整理进收藏；删除进回收站可恢复）；
- 搜库：按 note/tags 模糊搜「开心/无语/怼人」，`qq_list_stickers(query)` 已有雏形，补情绪标签体系；
- 场合判断：冷场不发（idle 超阈值）、刷屏限量（每会话每小时 N 张）、同图不连发（并入 P0-2）。
- **工作量**：中。**风险**：低。

#### P1-6 语音收发（借 zaofan silk-wasm/lamejs、master1Sun 转写五档）
- **收**：SnowLuma 的 record 段（SILK）→ 解码 → 转写（先验证 SnowLuma 是否自带转写；不自送则 DSH/外部 ASR）；
- **发**：TTS（Edge-TTS 免费方案或硅基流动）→ mp3 → **silk-wasm** 编码 → record 段发出。
  zaofan 的依赖 `silk-wasm` + `lamejs-fixed` 就是这条链，**直接参考其实现**；
- **前置验证**：SnowLuma 对 record 段的支持度、钩子客户端发语音的风控风险（先私聊主人试，别直接群里发）。
- **工作量**：大。**风险**：中-高（编码链 + 风控未知）。**价值**：陪伴感大杀器，她能发语音条。

### P2 —— 架构与长期

#### P2-7 角色卡结构化 + 世界书 lorebook（规范直接抄 dsh-tavern 的 ST 格式参考）
- **角色卡**：内部格式对齐 [CCv2](https://github.com/malfoyslastname/character-card-spec-v2) 子集
  （`description/personality/scenario/mes_example/system_prompt/post_history_instructions/alternate_greetings`），
  支持导入/导出 ST 卡（PNG tEXt `chara` chunk）——**打通 ST 生态，主人可以直接下载现成角色卡给她换人格**；
- **世界书**：把现有「黑话表注入」「表情策略注入」泛化成通用条目
  `{keys[], content, constant, selective, secondary_keys, order, probability, budget}`，
  触发算法按 dsh-tavern 文档 §2.4 实现**简化版**（扫描最近 N 条、主键 includes、constant 优先、token 预算截断；
  递归/inclusion group/timed effects 先不做）。主人可在面板加条目（如「考试周」→ 注入她的复习状态）；
- **宏**：`{{time}}/{{date}}/{{weekday}}/{{idleDuration}}/{{random::a::b}}` 等（dsh-tavern §4），
  替换现在手拼的状态行。
- **工作量**：大。**风险**：中（prompt 装配顺序一变，现有行为全受影响，必须 A/B 对照）。

#### P2-8 价值评分唤醒层（借 master1Sun 价值评分、zaofan reply_gate）
- 非触发类群消息先过轻量评分（规则起步：长度/问号/是否提及她/话题延续性；或复用 DSH flash 打 0-10 分），
  过阈值才唤醒。**目的：省 token + 防被无关消息钓起**。
- 我们已有「唤醒后自决 + 沉睡前强制观察窗」，这层是**前置过滤**，与现有机制互补不冲突。
- **工作量**：中。**风险**：中（评分太严会漏接该接的话；先只记日志不拦截，观察一周再启用）。

#### P2-9 生图 API 工具（兑现主人承诺，记忆库 fact id=22）
- 接一个生图 API（硅基流动 Kolors / 即梦 / liblib，**需要主人提供 key**），
  MCP 工具 `qq_generate_image(prompt)` → 落 `D:\qqbot\outbox` → 直接走已修好的 `qq_send_image file://` 通道发出；
- 与 P1-5 联动：生成的图可入表情库（外部图源收藏通道已支持）。
- **工作量**：小-中。**风险**：低。

#### P2-10 DSH 升级 runbook（从 zaofan FAQ 提炼的血泪坑，升级前必读）
zaofan 在 dsh 0.1.6→0.1.7 升级中踩的坑（我们 Desktop 2.0.5 版本线不同，但教训通用）：
1. **升级前备份整个 `~/.dsh`**；会话日志可能升级为不可回退的新版本（V4）；
2. **preset 声明方式会随版本变**（目录 yml → profile 声明行），旧预设不迁移则**恢复会话直接被拒**；
3. 插件改名不保留别名（`dsh-workflow-worker-thread`→`dsh-workflow-ptc`），从官方预设**复制**出来的自定义预设不会跟着升级走；
4. `@deepseek-ai/dsh-mcp-client` 的 **`latest` 标签可能停在旧版，`next` 才是新版**；
5. 新版本会按 `peerDependencies` 做**插件兼容检查**，钉死旧次版本的行会被**静默禁用/跳过**（日志 `disabling profile plugin row`）；
6. 插件设置**不要写回 `cordis.patch.yml`**——会触发热更新→重新 apply→再写配置**死循环**（实测刷死启动）；存插件自有存储；
7. 配置合并**空对象 `{}` 会浅合并顶掉整块配置**（真实案例：`sticker:{}` 让图片自动下载停摆）→ 用递归合并，手动编辑时「想恢复默认就删字段，别写 `{}`」。
- **落点**：写进 `STATE.md`，升级 DSH 前逐条过。

---

## 4. 明确不做（过度工程清单）

| 项 | 出处 | 不做的原因 |
|---|---|---|
| 多实例人格（一机 N 鲸） | zaofan | 单主人单 bot，无需求 |
| 多平台（微信/TG/Discord…） | AstrBot/LangBot | QQ 足够；SnowLuma 钩子路线与官方 bot API 不通用 |
| RAG 知识库 | LangBot | 陪伴型价值低，长期记忆库已覆盖；真要喂资料再议 |
| CHARX/V3 资产包 | ST 规范 | PNG 卡 V2 子集够用，V3 资产链复杂 |
| 悬浮球 dock 聊天回放 UI | zaofan | 面板 :3100 已有状态/会话/日志；UI 投入产出比低 |
| 代码沙箱/技能市场 | LangBot | 我们的「技能」就是 MCP 工具 + PC 控制，已够用 |

---

## 5. 建议的第一步

**P0-1（定时任务 repeat + mode=ai）**。理由：
1. 改动集中：reminders 表加列 + 触发器重排 + `buildWakePromptV2` 加一个 reason 分支 + MCP 参数，**全在桥接侧，不用等 DSH 重启**（MCP 参数变更除外，可分两步走）；
2. 向后兼容：旧提醒 repeat=NULL 行为不变；
3. **主人立刻能感知**：「每天早 9 点去群里说早安」「每周五晚上提醒我交作业」这种她说到做到的事，
   是陪伴感最直接的升级；`mode=ai` 让她到点**现场发挥**而不是念稿，复用现有唤醒管线零新依赖。

其次 P0-2（配额+节流，半天量级）→ P0-3（出箱重投）→ P1-4（好感度双维度，本方案里陪伴感收益最大的一项）。

---

## 附：本次调研全部来源

- https://github.com/gcry13067381632-jpg/dsh-qqbot （@zaofan/dsh-qqbot，README 功能与 FAQ 坑清单）
- https://github.com/master1Sun/dsh-QQbot （README 核心能力与已知边界）
- https://github.com/Chenlong-Tao/AstrBot
- https://docs.langbot.app/zh/insight/features （已迁移至 langbot.app/docs）
- https://github.com/langbot-app/LangBot
- https://github.com/zhenxun-org/zhenxun_bot
- https://github.com/MerCuJerry/nonebot-plugin-likeabi
- https://github.com/LingyeSoul/dsh-tavern/blob/main/docs/exploration/2026-08-14-st-formats.md （ST 角色卡/世界书/宏/preset 全规范）
- https://github.com/malfoyslastname/character-card-spec-v2 、 https://github.com/kwaroran/character-card-spec-v3
- https://mem0.ai/blog/long-term-memory-ai-agents 、 https://mem0.ai/blog/dream-background-memory-consolidation-for-ai-agents
- https://github.com/zhayujie/chatgpt-on-wechat
