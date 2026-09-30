# 鲸鲸 2.0 升级方案：记忆引擎 + 自主心核（2026-10）

> 需求线：主人 m05600「准备下一步升级方案，更加智能，更加似人，主动性，自主性，先问清楚我需求，再定案，多上 Git 查阅有没有现成的方案」。
> 需求问答批复（同日）：主攻 **记忆升级 + 自主性**；主动胆量 **大胆放开**（话多话密都接受）；记忆范围 **私聊+群聊都要**；成本 **不在乎**（全强模型）；节奏 **一次大版本**。

---

## 一、Git 调研结论（借鉴对象与判定）

| 方案 | 领域 | 可借鉴 | 不可套用原因 |
|---|---|---|---|
| **MaiBot A-Memorix 记忆引擎**（Mai-with-u/MaiBot，4300★，QQ 群聊同领域） | 分层记忆（段落/关系/Episode/画像/事实账本）+ 向量&稀疏双路检索 + RRF 融合 + PPR 图加权 + 启发式拉起 + 记忆演化/纠错 | 设计蓝图：写回触发阈值、事实账本、画像消费事实刷新、启发式记忆注入、记忆修正流程 | Python/SQLModel/faiss 全家桶；我们是 Node/DSH 单体桥接，无向量库基建 |
| **MaiBot HeartFlow 心流系统** | MaiState 全局状态（离线/瞥一眼/正常/专注）+ 每聊天流三态（ABSENT/CHAT/FOCUSED）+ think-plan-execute 循环（内心独白→行动决策→执行）+ LLM 判断「想不想在这个群聊」 | 三态状态机、意愿/兴趣驱动、no_reply 连续降级、名额上限 | 同上；且其子心流为独立协程树，我们用桥接内调度器实现 |
| **Generative Agents（斯坦福小镇）** | 记忆流检索三因子（recency×importance×relevance）、反思（合成高阶洞见）、每日自规划→逐时执行 | 三因子评分公式、反思触发条件、每日计划/日终复盘循环 | 论文原型（沙盒小镇），非聊天机器人工程 |
| **mem0** | 记忆操作语义 ADD/UPDATE/DELETE/NOOP + 冲突消解 | 事实提取的操作化语义（新事实与旧事实矛盾时的处理） | SaaS/库形态，依赖其基础设施 |
| **Letta(MemGPT) sleep-time compute** | 空闲期后台整理记忆（自我编辑记忆块） | 「闲时整理」调度思想（我们挂在深夜/低活跃时段） | 完整 agent OS，架构不同 |

**判定：无整装可直接套用的方案**（最接近的 MaiBot 是 Python 异构全家桶）→ **借鉴设计、自建轻量版**，按我们 Node/DSH 单体桥接的规模裁剪。所有生成任务走 LLM（主人裁定成本不在乎），存储沿用现有 state\ JSONL/JSON 体系，不引入 SQLite/faiss 重依赖。

---

## 二、总体架构

```
                     ┌─────────────── 自主心核（B）───────────────┐
                     │ 生活状态机(睡眠/摸鱼/正常/专注) ← 作息表+驱动 │
                     │ 每日自规划(晨) → 目标/驱动队列 → 日终复盘(夜) │
                     │ 每聊天流三态: absent / watering / focused   │
                     └──────┬───────────────────────┬─────────────┘
                            │ 时机/意愿              │ 计划、目标
                   ┌────────▼────────┐    ┌─────────▼──────────┐
                   │  主动性引擎(升级) │    │  行动执行(回复/主动)  │
                   │ 大胆放开+智能时机 │    │  think→plan→execute │
                   └────────┬────────┘    └─────────┬──────────┘
                            │ 写入                    │ 读取（检索注入）
┌───────────────────────────▼───────────────────────▼──────────────────────┐
│                       记忆引擎（A）分层记忆库                                │
│ L0 消息流(每聊天流 JSONL) → L1 Episode 情景卡(窗口总结) → L2 事实账本(人物事实)│
│ → L3 人物画像(消费事实刷新) · 高阶反思笔记(日终) · 演化:衰减/强化/归档      │
│ 检索: 三因子(时间衰减×重要度×相关度)+同流优先+可选共享组 → 注入【回忆】     │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 三、模块清单

### A. 记忆引擎

| # | 模块 | 设计（借鉴源） | 落点 |
|---|---|---|---|
| A1 | **消息流落盘**：每聊天流（群/私聊）消息按 JSONL 落盘（含说话人/时间/原文/图片占位），聊天流隔离（A-Memorix 惊群隔离教训：默认不串流） | A-Memorix storage | `state\memory-v2\streams\<key>.jsonl` |
| A2 | **Episode 情景记忆**：每流新增 N 条消息（群 30 / 私聊 12）触发后台总结成「事件卡」：谁、何时、发生了什么、她的感受、重要度 1-10（Generative Agents importance 打分）。不阻塞回复链路，失败静默重试 | A-Memorix chat_summary_writeback(36 条阈值) | `state\memory-v2\episodes.jsonl` + 生成器 `src\memory-engine.mjs`（新文件，从 bridge.js 拆出管线） |
| A3 | **事实账本升级**：回复后异步提取人物事实（操作语义 ADD/UPDATE/DELETE/NOOP，与旧事实矛盾→标 invalidated 而非物理删，mem0 语义）；字段 {id, streamKey, person, fact, confidence, importance, source, createdAt, lastHitAt, invalidated}。现有 qq_db_reremember 存量导入 | mem0 + A-Memorix person_fact ledger | `state\memory-v2\facts.jsonl` |
| A4 | **三因子检索**：score = α·e^(-λ·Δt)（时间指数衰减）× importance × relevance（关键词/分词重叠，纯 JS）；同流记忆优先；跨流检索仅限「共享组」（默认：主人私聊 ↔ 白名单群一组，学 shared_memory_groups，面板可改）。每次注入 top-k≤6、≤900 字符（A-Memorix 注入预算） | Generative Agents + A-Memorix retrieval | `src\memory-engine.mjs` 检索器 |
| A5 | **启发式回忆注入**：回复前用最近 20 条消息生成「聊天印象」→ 检索 → 以【回忆-内部参考】注入会话上下文；节流（每流最小间隔 180s / 最小新增 20 条 / 结果缓存 300s）——学 A-Memorix 启发式拉起，避免每轮都多一次 LLM | A-Memorix heuristic recall | 注入钩子挂现有 ensureChatModel 前的 prompt 组装处 |
| A6 | **演化与遗忘**：每日深夜任务：衰减分 < 阈值 → 归档（软删）；被检索命中/被回忆 → lastHitAt 更新+权重回血；90 天未命中且低分 → 归档区（可恢复） | A-Memorix memory 演化 | 深夜 cron |
| A7 | **人物画像刷新**：消费事实账本定期（每晚）重刷 person_profile（现有 MCP qq_person_profile 的底层 store），画像注入不受聊天流隔离影响（按人维护） | A-Memorix person_profile | 复用现有 store |
| A8 | **反思（高阶记忆）**：日终复盘升级：当天 Episode 汇总 → 合成 2-4 条高阶洞见（「我注意到…」「原来他…」）写入反思笔记（self notes 同库），并参与检索 | Generative Agents reflection | 每日复盘 cron 扩展 |
| A9 | **记忆修正**：主人自然语言纠错（面板「记忆检修」输入「XX 不喜欢吃辣」→ LLM 生成修正方案（命中旧事实→标失效+写新）→ 面板确认执行 → 可回滚）；自动执行阈值 0.85 但默认须确认 | A-Memorix fuzzy_modify | 面板路由 + 工具 |
| A10 | **模型分工**：记忆任务（Episode/事实/画像/反思）独立 profile，默认与主聊天同档强模型（成本不在乎），面板「API 与模型」卡扩展任务模型选择 | 复用已上线的档案机制 | cfg.dsh.taskProfiles |

### B. 自主心核

| # | 模块 | 设计（借鉴源） | 落点 |
|---|---|---|---|
| B1 | **生活状态机**：现有精力/情绪曲线升级为四态作息（睡眠 01-08 / 摸鱼 / 正常 / 专注时段），状态影响主动频率与回复深度；作息表面板可调 | MaiState(OFFLINE/PEEKING/NORMAL/FOCUSED) | 调度器 `src\heart-core.mjs`（新文件） |
| B2 | **每日自规划**：晨间（醒时）LLM 生成「今日计划」：想跟进谁（从记忆/目标）、想聊什么话题、想学什么梗、想整理什么；存 self-plan；主人可在面板看她今天的计划 | Generative Agents daily plan | `state\memory-v2\plans.jsonl` |
| B3 | **驱动与目标队列**：pendingThought 升级为三驱动（好奇/社交/关怀）加权轮盘，驱动产生「想做的事」进目标队列；目标跨天跟踪，完成/放弃由她决定并写日记（自我演化）；面板可视化 | 0.6Bing roadmap + 内驱力设计 | `state\memory-v2\goals.jsonl` |
| B4 | **聊天流三态心流**：每聊天流 absent(不看)→watering(随便看看，低频轻回复)→focused(专注，think-plan-execute：内心独白→行动决策 text/emoji/no_reply→执行)；进入由「兴趣评估」LLM 判断（读该流最近内容+她的人格+当前状态：想不想聊？）；连续 no_reply×5 → 降 absent；focused 名额上限默认 2 | HeartFlow CHAT/FOCUSED + sbhf_absent_into_chat | heart-core 调度器 |
| B5 | **元工具（自我调节）**：给她新增 MCP 工具：qq_goal_add/done/abandon（目标管理）、qq_self_adjust（她觉得话多了自己调低某流参数）、qq_request_state（申请切换生活状态）；扩展 qq_self_note | MaiBot 元工具 roadmap | snowluma MCP 工具面 |
| B6 | **日终复盘**：对照晨间计划逐项核对（做了/没做/感受）→ 写日记 + 触发 A8 反思 + 自演化笔记 | Generative Agents 日终 | 每日 cron 扩展 |

### C. 主动性放开（大胆档）

| 项 | 现状 | 新默认（面板可调） |
|---|---|---|
| 每日主动消息硬配额 | 保守 | 群 40/天、私聊 30/天（大胆档） |
| 冷却 | 长 | 群 8 分钟、私聊 5 分钟 |
| 时机 | 固定随机+提醒 | 心流兴趣评估 + 群活跃度信号（最近 10 分钟消息数）+ 话题匹配（今日计划话题/目标触发） |
| 主动内容 | 提醒/跟进 | 计划话题 + 记忆联想（「突然想起你上次说…」）+ 目标驱动 |

**铁律不动**：group:471975044 的 wake 配置（diving/infinite、throttle 2/30/120000、speakerIds、keywords）一律不碰——主动性全部走桥接侧主动引擎（发消息），不碰 wake 唤醒路径；主人裁定「群里不降档」继续有效。

### D. 面板扩展（/panel）

| 页/卡 | 内容 |
|---|---|
| 记忆管理 | 检索/浏览 Episode、事实账本、画像、反思笔记；记忆检修（A9 修正流）；演化状态（各层条数/最近整理时间） |
| 心核仪表盘 | 当前生活状态、各聊天流三态、今日计划、目标队列、驱动权重、今日主动配额消耗 |
| 主动性参数 | C 表所有参数可调 + 大胆/标准/保守三档预设 |

### E. 测试与验收

- 单测：memory-engine 纯函数（三因子评分、衰减、共享组过滤、ADD/UPDATE 冲突消解）`scripts\test-memory-engine.mjs`
- 集成：test-console 增记忆/心核/面板新路由用例；心流三态转移用假时钟测试
- 回归电池：现有 10 套件全绿（2 个已知环境红不变）
- 验收口径：①问她「上周我们聊过什么」能命中 Episode；②主人说错记忆→面板修正生效；③晨间计划/日终复盘连续 3 天自动运转；④主动消息按大胆档发且不刷屏（冷却兜底）；⑤旧记忆工具（qq_db_remember 等）继续可用

---

## 四、实施顺序（一次大版本，内部 6 步）

1. **记忆数据层**：A1 落盘 + A2 Episode 管线 + A3 事实账本（含存量导入）
2. **检索与注入**：A4 三因子 + A5 启发式回忆 + A10 任务模型
3. **心核**：B1 状态机 + B4 三态心流 + C 主动性接线
4. **自主闭环**：B2 每日规划 + B3 目标驱动 + B6 复盘反思（A6/A7/A8 演化夜任务）
5. **面板**：D 记忆管理 + 心核仪表盘 + A9 记忆检修 + 元工具 B5
6. **测试回归 + 文档 + STATE.md**

## 五、风险与边界

- 回滚：memory-v2 总开关（cfg.memoryV2.enabled=false 走旧链路）；旧 stores 原样保留不迁移删除
- 生成任务全部异步后台，失败静默重试，绝不阻塞回复链路
- 隐私：跨聊天流检索默认只开「主人私聊↔白名单群」共享组；群↔群默认隔离（A-Memorix 串群事故教训）
- 成本：不在乎 = 全强模型；模型用量仍进 model-usage 日志可观测
- 心流决策 LLM 调用有节流（每流 5 分钟最多 1 次兴趣评估），防止每条消息都跑模型

## 六、参考来源

- MaiBot 文档（A-Memorix 配置/结构）：docs.mai-mai.org/manual/configuration/amemorix-config
- MaiBot HeartFlow 源码 README/路线图：gitlab.mikumikumi.xyz/maibot/maibot src/heart_flow（镜像 c7533a8）
- Generative Agents: Park et al. 2023（记忆流检索三因子/反思/每日规划）
- mem0: docs.mem0.ai（记忆操作语义/评估）
- Letta(MemGPT)：sleep-time compute（空闲期记忆整理）
