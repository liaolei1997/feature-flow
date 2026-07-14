# feature-flow studio

feature-flow 的伴生 Web 工作台。浏览历史 session 与 md 产物、网页上传 PRD、聊天框走完整 8-phase 流程（拷问 Q&A 渲染成可点选卡片）。CLI 与 studio 共用同一份 `data/`，可互相 resume。

设计文档：`../docs/superpowers/specs/2026-06-05-feature-flow-studio-design.md`

## 运行

```bash
npm run install:all   # 首次：装 server + web 依赖
npm run dev           # 同时起 server(4317) + web(4316) 并开浏览器
```

或在 Claude Code 里 `/feature-flow:studio`。

需要 Agent SDK 鉴权（`ANTHROPIC_API_KEY` 或已登录 Claude 凭证，与 CLI 同源）。

## 结构

```
server/   Node + TS + Fastify + ws + Agent SDK
  src/promptAssembler.ts  command md → systemPrompt（替换 ${CLAUDE_PLUGIN_ROOT}）
  src/agentsParser.ts     agent md frontmatter → AgentDefinition
  src/sessionStore.ts     扫 data/projects，读 .state / 产物
  src/askBridge.ts        人在回路桥（MCP ask_user handler 挂起等网页作答）
  src/workflowRunner.ts   一个 query() 会话；streaming input + MCP ask_user
  src/server.ts           HTTP + WebSocket + chokidar 文件监听
web/      Vite + React 三栏（项目树 / 产物渲染 / 聊天框）
```

## 关键设计决策

- **不直接加载插件**：Agent SDK 不支持加载 Claude Code 插件，故把 command md 作为 systemPrompt 注入，agents/ 手动解析为 AgentDefinition。
- **交互用自定义 MCP 工具而非 AskUserQuestion**：headless 环境下 AskUserQuestion 的回传行为无官方文档背书。改为注入 MCP 工具 `mcp__studio__ask_user`，systemPrompt 里告知 Claude 用它替代——答案完全由我们的 handler 控制，确定性强。见 `askBridge.ts` 顶部注释。
- **文件系统是唯一真相源**：无数据库；`.state` + md 即状态，SDK session jsonl 存聊天历史。

## 已验证 / 待实测（初版）

- ✅ server 启动、agents 加载、`/api/projects` 列真实 session、web 构建、proxy 联通、单测（promptAssembler / agentsParser）
- ⏳ **端到端真实跑一个 PRD**（ask_user MCP 往返 + 工作流落盘 + CLI resume 互操作）尚未实测——需消耗 token 且要人工交互。这是初版后第一件该做的验证。
- ⚠️ `workflowRunner` 里 SDK 消息字段名（assistant content blocks / result.session_id / system init session_id）按 SDK v0.1.77 文档约定写，实跑时若字段名不符按 `handleMessage` 调整。
