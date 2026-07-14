# feature-flow studio — 设计文档

日期：2026-06-05
状态：待评审

## 一句话定位

feature-flow 的伴生 Web 工作台：浏览/管理历史 session 与 md 产物，网页上传 PRD，聊天框走完 8-phase 全流程（拷问 Q&A 渲染成网页交互卡片）。CLI 与 studio 是同一份数据的两个平行入口。

## 为什么成立（价值判据）

- session 数据（`data/projects/**`）是随时间沉淀的资产，浏览/检索/管理体验是 vanilla Claude 会话给不了的
- AskUserQuestion → 网页表单的交互升级，把终端里最高频的拷问 Q&A 变成可点选的卡片
- 不重造流程：studio 只是 feature-flow 工作流的另一个 harness，编排逻辑仍由 command md 唯一定义

## 已核实的技术依赖（2026-06-05，官方文档）

| 依赖 | 结论 |
|---|---|
| Agent SDK 直接加载 Claude Code 插件 | ❌ 不支持；command md 作 systemPrompt 注入是标准做法 |
| AskUserQuestion 在 SDK headless 可用 | ✅；`canUseTool` 回调拦截并代答是官方推荐模式 |
| 双向流式（长会话中途注入用户消息） | ✅ streaming input mode（async generator） |
| session resume（跨进程） | ✅ `resume` + session_id |
| 自定义 subagent | ✅ `agents` option 传 `AgentDefinition`；插件 agents/ 目录需手动解析转换 |

## 架构

```
┌─ 浏览器（Vite + React）────────────────────────────┐
│ 左栏：项目 → session 树（.state 徽章 P3/P8）       │
│ 中栏：artifact 查看器（md tab 渲染 + project-map） │
│ 右栏：聊天框（流式输出 / 问答卡片 / PRD 上传）     │
└────────────────┬───────────────────────────────────┘
                 │ WebSocket + HTTP
┌─ server（Node + TS + Fastify + Agent SDK）─────────┐
│ prompt 组装器 │ agents 解析器 │ workflow runner    │
│ canUseTool 拦截 │ chokidar 文件监听                │
└────────────────┬───────────────────────────────────┘
                 │ 读写
   ~/plugins/feature-flow/data/projects/**（唯一真相源）
```

## 形态与启动

- **monorepo 子目录**：`~/plugins/feature-flow/studio/`，内分 `server/`、`web/`。studio 强依赖插件的 commands/references/agents/data，同仓保证版本同步
- 单用户本地应用，无鉴权，默认端口 4317
- 启动：`npm run studio`；另提供 `/feature-flow:studio` command（Bash 后台起进程 + open 浏览器）

## 后端组件

### 1. prompt 组装器（纯函数）
- 读 `commands/feature-flow.md`，将 `${CLAUDE_PLUGIN_ROOT}` 替换为插件根绝对路径
- 作为 systemPrompt append（preset `claude_code`）
- 初始 user prompt = `$ARGUMENTS`（上传 PRD 的暂存绝对路径）

### 2. agents 解析器（纯函数）
- 来源一：本插件 `agents/prd-check-verifier.md`
- 来源二：feature-dev 插件缓存目录 `agents/` 下的 `code-explorer` / `code-architect` / `code-reviewer`
- frontmatter + 正文 → `AgentDefinition{description, prompt, tools, model}`
- feature-dev 缓存路径不存在时启动报错（fail fast，不静默降级）

### 3. workflow runner
- 每个运行中 session 一个 `query()`，streaming input mode
- **cwd 时序**：SDK 启动时就需要 cwd，但工作流的项目确认在 P0 内部——因此 UI 在上传 PRD 时先让用户选项目（下拉：`data/projects` 已有项目 + 新项目填根路径），cwd 即定；P0 的确认卡片照常弹出，用户作答与之一致即可
- SDK session_id 持久化到 session 目录（`.studio` 文件），UI 重启后 resume
- **v1 并发约束：同时只允许 1 个 session 处于运行态**，其余只读浏览
- 权限：`canUseTool` 全部放行（本地信任，等效 bypass），唯独 AskUserQuestion 走拦截

### 4. AskUserQuestion 拦截
- `canUseTool` 命中 AskUserQuestion → 通过 WS 推 question payload 到前端 → await 用户点选/自由输入 → 以代答形式返回 SDK
- 前端渲染为选项卡片，始终附"其他（自由输入）"

### 5. 文件监听
- chokidar watch `data/projects/**` → WS 增量事件 → 前端刷新对应节点
- `.state` 变化驱动左栏进度徽章实时更新

## 前端结构（三栏）

| 栏 | 内容 | 数据源 |
|---|---|---|
| 左 | 项目树 → session 列表，phase 进度徽章、运行态标记 | `.state` 扫描 + WS 事件 |
| 中 | requirement / code-facts / prd-check / tech-design / api-test / review-doc 按 tab 渲染；project-map 单独入口 | session 目录 md |
| 右 | 聊天框：assistant 流式输出、AskUserQuestion 卡片、文本输入、PRD 上传按钮 | WS 双向流 |

- 上传 PRD：先选目标项目（定 cwd）→ 文件暂存到服务端 tmp，绝对路径作为 `$ARGUMENTS` 启动 workflow——session 命名、目录创建、requirement.md 落盘全部由 workflow 自身完成，studio 不复制这些逻辑
- session 管理写操作仅一个：删除 session（带二次确认）；产物 md 一律只读展示

## 状态同步原则

- **文件系统是唯一真相源**，不建数据库
- 流程状态 = `.state`；产物 = md 文件；聊天历史 = SDK session jsonl
- 推论（必须保持）：**CLI 与 studio 完全互操作**——studio 跑一半的 session，终端 `/feature-flow` 可 resume；反之亦然

## 错误处理

- SDK 异常/中断：聊天框展示错误；`.state` 保持 workflow 自己写入的状态（沿用"失败即停"原则）；UI 提供 resume 重试
- 文件写冲突：v1 不做锁，靠"单 session 运行"规避
- agents/插件路径缺失：启动期 fail fast，明确报错

## 验收标准

1. **端到端**：网页上传一份真实 PRD → 聊天框走完 P0–P3、在卡片上答完拷问 → `data/` 落盘结构与终端跑出的一致
2. **互操作**：studio 跑到 P3 的 session，终端 `/feature-flow` 能识别并 resume 继续 P4+
3. **单测**：prompt 组装器（变量替换）、agents 解析器（frontmatter → AgentDefinition）两个纯函数

## 已拍板的决策（评审时可推翻）

1. 同仓 monorepo（`studio/` 子目录），非独立 repo
2. v1 单 session 运行，不做并发
3. 不建数据库，文件系统为唯一真相源
4. 上传 PRD 走 `$ARGUMENTS` 注入，session 创建逻辑不在 studio 重造
5. 技术栈：Node + TS + Fastify + ws + Agent SDK（TS 版）；前端 Vite + React

## 明确不做（v1）

- 多用户 / 鉴权 / 远程部署
- 产物 md 的在线编辑（只读展示；改产物回终端/编辑器）
- 并发 session 执行
- 自由聊天模式（聊天框只服务 feature-flow 工作流会话）
