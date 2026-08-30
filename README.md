# dsh-handoff-button  
# [![dshfind](https://dshfind.com/api/badge/whiteS18/dsh-handoff-button?lang=zh)](https://dshfind.com/zh/plugins/whiteS18/dsh-handoff-button?ref=badge)

DeepSeek Harness 插件：在每条 AI 回复的底部操作行添加一个 Handoff 按钮，
点击后把当前会话压缩成 handoff 文档，写入该会话工作区的 `handoff/` 目录。  


## 功能

- **按钮**：每条已完成的 AI 回复操作组最右侧（复制/反馈按钮之后）的圆形图标按钮
  （Magnific "Write" 图标，独立文件 `assets/write.png`，由 Host 路由同源提供，无外部网络依赖），
  悬停有 Tooltip 提示。**想换图标：直接替换 `assets/write.png` 后重启即可**
- **生成**：点击后调用 LLM（当前默认模型）按原版 [handoff skill](https://www.skills.sh/mattpocock/skills/handoff) 要求
  生成总结式文档：`Status / Goal / Progress / Next Steps / Suggested Skills` 五段结构，
  Progress 为紧凑总结而非对话实录；LLM 不可用时自动降级为启发式摘要
- **状态反馈**：生成中变暗 → 完成显示绿色 ✓（2 秒自动复原）→ 失败显示红色 ⚠（悬停可见原因）
- **打开文件**：完成状态（✓ 期间）再次点击，在新标签页打开生成的文档
- **文件名**：`handoff-{yyyymmddhhmmss}-{会话标题}.md`（非法字符替换为 `-`，最长 60 字符），
  `handoff/` 目录不存在时自动创建
- **脱敏**：API key、token、密码等常见敏感信息在写入前自动打码
- **References**：自动收集会话中实际触碰过的文件路径，**只保留工作区内的文件，统一转换为相对工作区根目录的相对路径**（跨机器/多人协作可读；工作区外的系统路径、临时目录、本机配置等一律不收录）；Suggested Skills 列出会话中实际调用过的技能

## 安装

发布到 npm 后（或本地包目录）：

```sh
dsh plugin --profile <name> add dsh-handoff-button
```

本地开发版：

```sh
dsh plugin --profile <name> add /绝对路径/dsh-handoff-button
```

> [!IMPORTANT]
> **启动顺序决定是否需要重启。** DSH 的插件 bundle 组合发生在进程**启动时**（Loader 读取
> profile 的 `package.json` 生成插件树和 client 模块图），安装命令只改磁盘上的 profile 文件，
> 不会热插进已在运行的进程：
>
> - **先安装 → 再启动**：启动时插件已在列表里，直接生效，无需重启；
> - **先启动 → 再安装**：装完后**必须完全退出并重新启动** `dsh`（⌘Q 退出桌面应用或终止
>   Web UI 进程，不是刷新页面），让进程重新组合 profile。
>
> 安装后可用 `dsh --profile <name> --dump-config | grep handoff` 确认插件已进入 bundle 层。

## 架构

- `index.js` — Host 半部：注册三个路由（`webServer` 服务）：
  `POST /handoff/write`（生成文档）、`GET /handoff/read`（打开文档）、
  `GET /handoff/icon`（提供 `assets/write.png` 图标）。读取会话日志
  （`sessionQuery`）并写文件（`fs`，自动建目录），调用 LLM 总结（`llm` +
  `agentDefaultModel`）。仅依赖 Node 内置模块（`node:fs`/`node:url`/`node:path`），
  无第三方运行时依赖。
- `client.js` — 浏览器半部：通过 client module loader
  （`window.__ModuleLoader__.load`）注册，向 `conversation.chat.assistant-actions`
  槽注入按钮（`order: 100`，最右侧插槽条目），点击后同源 `fetch` 调用 Host 路由；
  图标通过 CSS mask 引用 `/handoff/icon`，颜色跟随主题。
- `assets/write.png` — 按钮图标（Magnific/Freepik "Write" 图标），可自由替换。
- `cordis.patch.yml` — Bundle 补丁层：把本包作为插件行插入组合。

## 卸载

```sh
dsh plugin --profile <name> remove dsh-handoff-button
```

## 验证

- 组合加载：`dsh --profile <name> --dump-config | grep -A2 handoff`
- 浏览器检查：`http://127.0.0.1:3080/plugins/dsh-handoff-button/client.js` 应返回脚本

---

## English

DeepSeek Harness plugin: adds a Handoff button to the action row of every
assistant message. Clicking it compresses the current conversation into a
handoff document and writes it to the `handoff/` directory of that session's
workspace.

### Features

- **Button**: a circular icon button at the far right of the action group on
  every completed assistant message (after the copy/feedback buttons), with a
  hover tooltip. The icon (`assets/write.png`) is served same-origin by a host
  route — no external network dependency. **To change the icon, replace
  `assets/write.png` and restart.**
- **Generation**: on click, the current default LLM model writes a summary
  document in the five-section structure of the original
  [handoff skill](https://www.skills.sh/mattpocock/skills/handoff):
  `Status / Goal / Progress / Next Steps / Suggested Skills`, where Progress
  is a compact summary rather than a raw transcript. Falls back to a
  heuristic digest when the LLM is unavailable.
- **Feedback**: dims while generating → green ✓ on success (auto-reverts
  after 2s) → red ⚠ on failure (hover for the reason).
- **Open file**: while the ✓ state is shown, click again to open the
  generated document in a new tab.
- **Filename**: `handoff-{yyyymmddhhmmss}-{session title}.md` (illegal
  characters replaced with `-`, max 60 chars); `handoff/` is created
  automatically if missing.
- **Redaction**: API keys, tokens, passwords and similar secrets are masked
  before anything is written to disk.
- **References**: collects file paths actually touched in the conversation,
  keeping only workspace-internal files rewritten as paths relative to the
  workspace root (readable across machines and collaborators); Suggested
  Skills lists the skills actually invoked.

### Install

Once published to npm (or from a local package directory):

```sh
dsh plugin --profile <name> add dsh-handoff-button
```

Local development checkout:

```sh
dsh plugin --profile <name> add /absolute/path/dsh-handoff-button
```

> [!IMPORTANT]
> **Startup order decides whether a restart is needed.** DSH composes the
> plugin bundle at process **startup**; the install command only rewrites
> profile files on disk and does not hot-plug a running process:
>
> - **Install → start**: the plugin is already in the list at startup, no
>   restart needed.
> - **Start → install**: you **must fully quit and restart** `dsh` (⌘Q the
>   desktop app or kill the Web UI process — a page refresh is not enough).
>
> After installing, `dsh --profile <name> --dump-config | grep handoff`
> confirms the plugin is in the bundle layer.

### Architecture

- `index.js` — host half: registers three routes (`webServer` service):
  `POST /handoff/write` (generates the document), `GET /handoff/read` (opens
  it), `GET /handoff/icon` (serves `assets/write.png`). Reads the session
  log (`sessionQuery`), writes files (`fs`, creating directories as needed),
  and calls the LLM (`llm` + `agentDefaultModel`). Node builtins only — no
  third-party runtime dependencies.
- `client.js` — browser half: registered via the client module loader
  (`window.__ModuleLoader__.load`), injects the button into the
  `conversation.chat.assistant-actions` slot (`order: 100`, rightmost), and
  calls the host routes with same-origin `fetch`. The icon is applied via a
  CSS mask referencing `/handoff/icon`, so it follows the theme color.
- `assets/write.png` — the button icon (Magnific/Freepik "Write"), freely
  replaceable.
- `cordis.patch.yml` — bundle patch layer: inserts this package as a plugin
  row in the composition.

### Uninstall

```sh
dsh plugin --profile <name> remove dsh-handoff-button
```

### Verify

- Bundle composition: `dsh --profile <name> --dump-config | grep -A2 handoff`
- Browser check: `http://127.0.0.1:3080/plugins/dsh-handoff-button/client.js`
  should return the script

## License / 许可

MIT
