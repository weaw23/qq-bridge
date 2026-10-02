# 鲸鲸 3.0 升级方案（定稿）

> 2026-09-30 调研定案。需求方（主人）确认：方向=语音+表情包/图像+Agent 化+主动时机；交付=一次大版本 3.0；TTS 选 GPT-SoVITS 声音克隆；AI 画图走 API。

## 一、调研结论（全部已实测验证）

| 事项 | 结论 | 依据 |
|---|---|---|
| QQ 语音收发 | **SnowLuma 原生支持**，双向无阻碍 | index.mjs 源码验证：record 段「收」自动带 url 下载；「发」支持 base64:// 与 file:///，经 highway 上传（ELEMENT_CODECS.record 双向，pickMediaSource/isInlineMediaSource/loadBinarySource） |
| silk 编解码 | **silk-wasm 3.7.1**（npm，MIT） | `encode(WAV,0)→{data,duration}`；`decode(silk,sr)→pcm_s16le`；`getDuration/isSilk/isWav`；纯 Node 零依赖 |
| TTS 引擎 | **GPT-SoVITS 本地 HTTP API**（api_v2.py :9880） | `POST /tts {text,text_lang,ref_audio_path,prompt_text,prompt_lang,media_type:"wav",...}` → wav 流；`/control?command=restart`；`/set_gpt_weights` 等 |
| 声音克隆 | 5 秒参考音频零样本 / 1 分钟微调专属音色 | RTX 5060 Laptop 8GB 够推理+微调（v2/v2Pro 约 4-6GB 显存）；Windows 整合包（HF lj1995/GPT-SoVITS-windows-package / 国内镜像 yuque 文档） |
| ASR | **faster-whisper 本地**（small int8 GPU 短语音秒级） | Python 系；备选 SenseVoice。QQ NT 语音为 silk → silk-wasm decode → pcm → whisper |
| 表情包 | **meme-generator**（MemeCrafters，Python FastAPI） | `meme run` → :2233；`POST /memes/{key}/`（multipart: images 列表 + texts 列表 + args JSON 串）→ 返回 PNG/GIF 字节；`GET /memes/keys`、`/memes/{key}/info`、`/preview`；资源下载内置 5 镜像（jsdelivr 国内可达）；`meme_dirs` 可挂外部表情库（contrib/tudou 等）；Rust 版 meme-generator-rs 备选 |
| AI 画图 | **gemai.cc 现有 key 直接可用** | 已实测 gpt-image-2-low 出图 1024x1024 PNG（b64_json 返回）；另有 gpt-image-2.5 全家/gemini-3-pro-image/grok-imagine 共 17 个图像模型。**无 TTS 模型**（TTS 本地方案不受影响） |
| 本机环境 | RTX 5060 8GB / RAM 15.7GB / C 169GB D 143GB 空闲 / git 有 / **Python、ffmpeg、conda 全无** | 需 Phase 0 装机 |
| 桥现状 | 收到语音显示 `[语音]` 占位（bridge.js:779）；发图链路（send_group_msg + base64 段）可直接复用为发语音 | bridge.js 源码 |

## 二、模块设计

### 模块 1 语音（TTS + ASR）
**她说**：新增 MCP 工具 `qq_send_voice(key, token, text)`：
1. 文本 → POST GPT-SoVITS `/tts`（ref_audio_path=鲸鲸参考音色, prompt_text 配套）→ wav
2. wav → silk-wasm `encode(wav, 0)` → silk
3. `send_group_msg`/`send_private_msg` 段 `{type:'record', data:{file:'base64://...'}}`（走现有 sendChain 保序）
- 工具描述强调「想开口说话时用，文字照发但语音更像真人」；加每日配额防刷
**她听**：消息处理序里 record 段不再丢弃：
1. 下载 url → silk-wasm `decode` → pcm
2. 本地 faster-whisper 转写（Python 常驻小服务，或按需 spawn）
3. 转写文本以 `[语音] 内容` 形式入消息流（她读得到）；>60s 语音截断提示

### 模块 2 表情包 + AI 画图
- `qq_make_meme(key, token, meme_key, texts?, image_message_id?)`：拿群友头像/图 + 文字 → POST `/memes/{key}/` → 出图（GIF/PNG）→ 复用 qq_send_image 通道发送
- `qq_list_memes(key, token, query?)`：列可用表情+关键词（映射自然语言：「摸摸头」→petpet）
- `qq_generate_image(key, token, prompt, size?)`：POST gemai.cc `/v1/images/generations`（gpt-image-2-low 起步）→ b64 → 发图；**每日配额 + 主人白名单会话限用**（防滥用计费）
- 表情资源 `meme download` 走官方 jsdelivr 镜像

### 模块 3 Agent 化（干实事）
- `qq_job_start/qq_job_status/qq_job_output/qq_job_kill`：受控后台长任务（命令白名单：ffmpeg 转码/文件整理/批量下载等），**首跑命令需主人审批**（复用现有 approval 机制），后续同命令免审
- 长任务完成 → followup 提醒唤醒她报告结果
- 现有 pc_* 工具保持主人私聊专属不动

### 模块 4 主动时机（该说说/不该说别说）
- **冒泡预检**：proactiveCheck 生成话头后、发送前，加一道轻量自评（话题×最近 10 分钟群内动静×她的参与度），分数低于阈值自动收起（一个内部小调用，不打扰人）
- 收敛 2.0 已有的 quota/quietMinutes/heartflow，不改既有机制

### 通用
- 新工具全部走现有 MCP server（mcp-snowluma.js）注册，带 key+token 鉴权、tool-calls.jsonl 审计、throttle 沿用
- 唤醒提示（buildWakePromptV2）补「新能力」说明段；她的人设提示更新（她要知道自己会说话了）

## 三、实施阶段（顺序）

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 装机 | Python 3.11（winget）、ffmpeg（winget）、GPT-SoVITS 整合包（D盘 ~15GB）、meme-generator（pip）、faster-whisper（pip）、参考音频挑选（5-10s 软萌音色样本；主人提供或我从公开素材挑） | 各组件版本自检；GPT-SoVITS api_v2 冒烟出 wav；meme `list` 出表 |
| P1 语音 | silk-wasm 装入桥 → qq_send_voice → record 收发+ASR 管线 → 唤醒提示更新 | 真发一条语音到测试群（1132819177 muted 安全）；她收到语音能复述内容 |
| P2 图 | meme-generator 服务常驻（看门狗纳管）→ qq_make_meme/qq_list_memes → qq_generate_image | petpet 群友头像出图；AI 画图发测试群 |
| P3 Agent | qq_job_* 四件套 + 审批门 + 完成回报 | 跑一个真实小任务（如批量转码）全流程 |
| P4 时机+收尾 | 冒泡预检 gate → 全链路联调 → STATE.md → 测试（ops/ 源码级断言+活体验证）→ git commit+push → 终报 | 主人在主群实测全套 |

## 四、风险与对策
- **gmm 图像计费未知**：实测出图成功但免费档覆盖范围不明 → 每日硬配额（本地计数），超限自动降级为「只发表情包模板」
- **GPT-SoVITS 冷启动慢**（首句 10-30s）→ 服务常驻（开机自启+看门狗）；常用短句缓存
- **8GB VRAM 争用**：GPT-SoVITS 常驻 ~4-5GB；whisper 按需启动用完即退；她的会话走 API 不占显存，无冲突
- **语音被群友恶搞刷配额**：qq_send_voice 走她自己的决策，不加外层限频（信任她+quota 已有）
- **参考音频质量决定音色上限**：P0 时试 2-3 个候选对比，主人耳朵验收
- **amr 老语音**（罕见）非 silk → isSilk() 判假时跳过 ASR 只显示 [语音]（不装 ffmpeg 兜底转码，避免复杂化；ffmpeg 主要服务 meme/job 模块）

## 五、明确不做（本轮）
- 不换 bot 框架（AstrBot/LangBot 仅借鉴插件生态思路）
- 不动她现有 2.0 的心流/记忆/好感度机制（只加不改）
- 不做本地 SD 画图（API 已够用）
- v4-pro 保持 text-only 不开 image（防整轮请求打炸）
