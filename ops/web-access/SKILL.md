---
name: web-access
description: 通过 CDP 直接操作用户现有的浏览器（Edge/Chrome）——打开网页、读页面内容、截图、点击、输入、执行 JS。需要浏览器以调试端口启动（start-edge-debug.cmd）。适用于查资料、登录态网页操作、把网页内容/截图发给用户。
---

# Web Access（CDP 浏览器操作）

零依赖、跨框架：只要能用 shell 跑 `node`，就能用这个技能。不需要装任何 npm 包、不需要 MCP 服务器。

## 前置：让浏览器开调试端口

浏览器必须带 `--remote-debugging-port=9222` 启动，**现有的登录态和标签页都能继续用**。

- 一键（会重启 Edge，标签页自动恢复）：
  ```
  D:\qqbot\web-access\start-edge-debug.cmd
  ```
- 手动：
  ```
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --restore-last-session
  ```
- 检查是否就绪：
  ```
  node "C:\Users\HCK\.dsh\skills\web-access\cdp.mjs" status
  ```

## 常用命令

```bash
CDP="C:\Users\HCK\.dsh\skills\web-access\cdp.mjs"

node "$CDP" status                    # 连接自检 + 列出标签页
node "$CDP" tabs                      # 标签页清单（JSON，含 index/id/url/title）
node "$CDP" new "https://example.com" # 新标签页打开
node "$CDP" goto "https://example.com" --tab 0
node "$CDP" text --tab 0 --max 6000   # 读页面可见文本（最常用）
node "$CDP" html --tab 0               # 读 HTML
node "$CDP" shot web.png               # 截图 → D:\qqbot\outbox\web.png（可用 qq_send_image 发出）
node "$CDP" shot web.png --full        # 整页截图
node "$CDP" eval "document.title"      # 执行 JS（--await 等待 Promise）
node "$CDP" click "#submit"            # 点击
node "$CDP" type "#q" "关键词"          # 输入（带 input/change 事件）
node "$CDP" keys Enter                 # 发按键
node "$CDP" wait "#result" --timeout 8000   # 等元素出现
node "$CDP" close <tabId>              # 关标签
```

通用参数：`--tab N|id`（默认第 0 个）、`--json`（机器可读）、`--port 9222`。

## 典型工作流

1. **查东西**：`goto` 搜索页 → `text` 读结果 → 需要时 `eval` 提取结构（例如
   `eval "Array.from(document.querySelectorAll('h3')).map(e=>e.innerText).slice(0,10)"`）。
2. **看页面长什么样**：`shot` 截图 → 图片落在 `D:\qqbot\outbox\`，可直接用 `qq_send_image`
   的 `file` 参数（`file:///D:/qqbot/outbox/web-xxx.png`）发给用户。
3. **操作网页**（有登录态也行）：`goto` → `wait` 等元素 → `type` 填表 → `click` 提交 →
   `text` 确认结果。
4. **多标签**：`tabs` 看清单，用 `--tab N` 指定；`new` 开新页，`close` 收尾（别乱关用户的标签）。

## 注意

- **别关用户正在用的标签页**，除非用户明确要求；`close` 只用于自己 `new` 出来的。
- 截图可能包含隐私内容：只有用户要求时才截，发给谁要听用户的（机器人场景：只发主人私聊）。
- 页面文本可能很长：用 `--max` 限制，先看开头再决定要不要细读。
- 遇到"连不上调试端口"就是浏览器没开调试模式（见前置），不是技能坏了。
