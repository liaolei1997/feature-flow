import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { WebSocketServer, WebSocket } from "ws";
import chokidar from "chokidar";
import {
  PLUGIN_ROOT,
  DATA_ROOT,
  REFS_ROOT,
  COMMANDS_FILE,
  OWN_AGENTS_DIR,
  FEATURE_DEV_AGENT_DIRS,
  TMP_UPLOAD_DIR,
  PORT,
} from "./config.js";
import { loadSystemPrompt } from "./promptAssembler.js";
import { intakePrd } from "./prdIntake.js";
import { attachFile } from "./attach.js";
import { loadAllAgents } from "./agentsParser.js";
import {
  listProjects,
  readArtifact,
  resolveArtifactPath,
  readProjectMap,
  latestProjectCwd,
  readTranscript,
  readStudioMeta,
  deleteSession,
  renameSession,
  TRANSCRIPT_FILE,
} from "./sessionStore.js";
import { WorkflowSession, type RunnerEvent } from "./workflowRunner.js";

// ── 启动期组装（fail fast）──────────────────────────────────
const systemPrompt = loadSystemPrompt(COMMANDS_FILE, PLUGIN_ROOT);
const agents = loadAllAgents(OWN_AGENTS_DIR, FEATURE_DEV_AGENT_DIRS);
console.log(`[studio] 已加载 ${Object.keys(agents).length} 个 subagent: ${Object.keys(agents).join(", ")}`);
mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

// ── 全局单会话 + 当前 run 的 transcript ─────────────────────
type ChatItem =
  | { kind: "assistant"; text: string }
  | { kind: "user"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "ask"; id: string; questions: unknown[] }
  | { kind: "system"; text: string };

let current: WorkflowSession | null = null;
let sessionEpoch = 0; // 每换一次 run +1；旧 session 的事件按 epoch 丢弃，防止被收掉的旧会话尾部事件污染新会话
let runSessionDir: string | null = null; // 工作流创建的真实 session 目录（用于落盘 transcript）
let liveSession: { projectId: string; sessionId: string } | null = null; // 探测到的 live 会话身份
let lastUsage: unknown = null; // 最近一次用量快照（供 reattach）
let lastModels: unknown = null; // 最近一次模型列表快照（供 reattach）
let lastModelSel = "";          // 最近选中的模型 value（供 reattach / 下次 start 回填）
let runCwd = "";              // 本次 run 的 cwd（供续聊 resume 用）
let runSdkSessionId: string | null = null; // 本次 run 的 SDK 会话 id（供续聊 resume 用）
let knownSessionDirs = new Set<string>(); // 启动时快照，只认本次新建的目录
const runTranscript: ChatItem[] = [];
const clients = new Set<WebSocket>();

function broadcast(obj: unknown): void {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

/** 落盘一条 transcript（session 目录已知时）。 */
function persistItem(item: ChatItem): void {
  if (!runSessionDir) return;
  try {
    appendFileSync(join(runSessionDir, TRANSCRIPT_FILE), JSON.stringify(item) + "\n", "utf8");
  } catch {
    /* 目录可能尚未就绪，flushTranscript 会补 */
  }
}

function recordChat(item: ChatItem): void {
  runTranscript.push(item);
  persistItem(item);
}

/** session 目录就绪后，把内存里已累积的 transcript 整体补写。 */
function flushTranscript(): void {
  if (!runSessionDir) return;
  try {
    writeFileSync(
      join(runSessionDir, TRANSCRIPT_FILE),
      runTranscript.map((i) => JSON.stringify(i)).join("\n") + (runTranscript.length ? "\n" : ""),
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

/** runner 事件 → 广播 + 转 ChatItem 落盘。 */
/** 写 session 的 .studio 元信息（cwd + sdk_session_id），供续聊 resume。 */
function writeStudioMeta(): void {
  if (!runSessionDir) return;
  try {
    writeFileSync(join(runSessionDir, ".studio"), `cwd: ${runCwd}\nsdk_session_id: ${runSdkSessionId ?? ""}\n`, "utf8");
  } catch { /* ignore */ }
}

function emit(e: RunnerEvent): void {
  broadcast({ channel: "runner", ...e });
  if (e.type === "usage") lastUsage = e; // 快照供 reattach
  if (e.type === "models") { lastModels = e; lastModelSel = e.current; }
  if (e.type === "model_changed") lastModelSel = e.model;
  // SDK 会话 id 首条消息即落盘（等 result 的话，中途停止/断电会丢，导致无法续聊）
  if (e.type === "sdk_session") { runSdkSessionId = e.id; writeStudioMeta(); }
  if (e.type === "result" && e.sdkSessionId) { runSdkSessionId = e.sdkSessionId; writeStudioMeta(); }
  switch (e.type) {
    case "assistant_text":
      recordChat({ kind: "assistant", text: e.text });
      break;
    case "tool_use":
      recordChat({ kind: "tool", name: e.name, summary: e.summary });
      break;
    case "ask":
      recordChat({ kind: "ask", id: e.id, questions: e.questions });
      break;
    case "user_echo":
      recordChat({ kind: "user", text: e.text });
      break;
    case "answer_echo":
      recordChat({ kind: "user", text: e.labels.map((l) => "↳ " + l).join("\n") });
      break;
    case "result":
      recordChat({ kind: "system", text: e.isError ? "本轮以错误结束" : "本轮完成" });
      break;
    case "error":
      recordChat({ kind: "system", text: `错误 · ${e.message}` });
      break;
    case "done":
      recordChat({ kind: "system", text: "会话结束" });
      break;
  }
}

// 新起一条 run：作废旧 epoch 的事件，返回绑定新 epoch 的 emit（旧会话的尾部事件会被丢弃）
function newRunEmit(): (e: RunnerEvent) => void {
  const epoch = ++sessionEpoch;
  return (e: RunnerEvent) => { if (epoch === sessionEpoch) emit(e); };
}

// 切换/新起/刷新前的门禁：真正在生成才拦；空闲（本轮完成/等作答/已结束）的旧会话自动收掉。
// 返回错误对象表示被拦，返回 null 表示可继续。
function freeIdleOrBlock(): { ok: false; error: string } | null {
  if (current?.isBusy()) return { ok: false, error: "当前会话正在生成中，请先点停止再切换。" };
  if (current) { current.stop(); current = null; liveSession = null; sessionEpoch++; } // 收掉空闲旧会话 + 作废其尾部事件
  return null;
}

// ── HTTP ────────────────────────────────────────────────────
const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

app.get("/api/projects", async () => ({ projects: listProjects() }));

app.get("/api/artifact", async (req) => {
  const { projectId, sessionId, name } = req.query as Record<string, string>;
  return { content: readArtifact(projectId, sessionId, name) };
});

app.get("/api/project-map", async (req) => {
  const { projectId } = req.query as Record<string, string>;
  return { content: readProjectMap(projectId) };
});

// 手动发起 project-map 刷新：起一个聚焦的 agent run，扫代码库增量更新/生成地图
const MAP_REFRESH_SYSPROMPT =
  "你是 feature-flow 的「项目地图」维护器。唯一职责是扫描代码库、生成或增量更新 project-map.md（项目的长期记忆）。" +
  "不要执行任何其它开发流程（不读 PRD、不写业务代码、不跑测试）。完成后用一句话总结更新了哪些部分。";

app.post("/api/map-refresh", async (req) => {
  const { projectId, cwd: cwdArg } = req.body as { projectId: string; cwd?: string };
  if (!projectId) return { ok: false, error: "缺少 projectId" };
  const cwd = cwdArg || latestProjectCwd(projectId);
  if (!cwd) return { ok: false, needCwd: true, error: "无法确定该项目的代码根，请选择代码仓库目录" };
  const blocked = freeIdleOrBlock();
  if (blocked) return blocked;
  if (!existsSync(cwd)) return { ok: false, error: `代码根不存在：${cwd}` };

  const projectDir = join(DATA_ROOT, projectId);
  mkdirSync(projectDir, { recursive: true });
  const mapPath = join(projectDir, "project-map.md");
  const tmplPath = join(REFS_ROOT, "project-map-template.md");
  const exists = existsSync(mapPath);

  // 重置 run 状态（地图刷新是瞬时 run，不建 session 目录、不落 transcript）
  runSessionDir = null;
  liveSession = null;
  lastUsage = null;
  lastModels = null;
  lastModelSel = "";
  runCwd = cwd;
  runSdkSessionId = null;
  runTranscript.length = 0;

  const prompt =
    `刷新本项目的「项目地图」。\n\n` +
    `- 代码根：${cwd}\n- 地图文件：${mapPath}（${exists ? "已存在，核对并刷新" : "不存在，新建"}）\n- 模板：${tmplPath}\n\n` +
    `**以当前代码（含工作区未提交改动）为唯一事实来源**——读真实文件，别信旧地图、别只看 git commit。\n\n` +
    `步骤：\n` +
    `1. Read 模板了解骨架${exists ? "与写作原则；Read 现有地图" : ""}。\n` +
    (exists
      ? `2. **分两类处理现有地图**：\n` +
        `   - **结构层**（二业务功能 / 三技术栈 / 四模块地图 / 五领域概念）：以当前代码为准**重新投影**，对每条带文件/符号/"已实现/已落地"的论断 Read 代码核实，过期的改正或删除，别为"保留"而留下失真内容。\n` +
        `   - **经验层**（六关键约定 / 七非显而易见 / 为什么）：代码能印证或不矛盾的**保留**——别因"代码里没明说"就删，那正是 map 的价值；只有被代码明显推翻的才改。\n`
      : ``) +
    `${exists ? "3" : "2"}. 扫描代码根补全/修正结构层：技术栈 / 核心业务功能 / 顶层模块地图 / 领域概念。用 Glob/Grep/Read 读当前文件。\n` +
    `${exists ? "4" : "3"}. **「二、核心业务/功能地图」要写厚**：逐个核心功能写清 ① 是什么 ② **怎么做的**——主流程 3–6 步（触发→关键步骤/机制→产出）+ 用到的关键模型/数据结构/算法（概念级）③ 落在哪些模块。要 Read 相关代码搞懂流程再写。**只写一句话价值不合格**——目标是"不读代码也能讲出这功能大概怎么跑的"。\n` +
    `${exists ? "5" : "4"}. **守骨架级**：写概念级的机制/主流程/为什么（这些有用、稳定），但**不写行号（\`:23-150\`）、不写函数调用链、不贴大段代码**（这些一改就过期，属于 session 文档）。全文 < 250 行。\n` +
    `${exists ? "6" : "5"}. Write 到 ${mapPath}${exists ? "（变动大先 Bash cp 备份为 project-map.md.bak）" : ""}。\n` +
    `${exists ? "7" : "6"}. 把「最近变更」标题行的 last_synced_commit 更新为当前 HEAD（Bash git -C ${cwd} rev-parse --short HEAD）。\n` +
    `${exists ? "8" : "7"}. 一句话总结改了哪些部分、纠正了哪些过期内容。`;

  const runEmit = newRunEmit();
  current = new WorkflowSession({
    systemPrompt: MAP_REFRESH_SYSPROMPT,
    agents: {},
    cwd,
    sessionDir: projectDir,
    allowAll: false,
    emit: runEmit,
  });
  current.start(prompt).catch((e) => runEmit({ type: "error", message: String(e?.message ?? e) }));
  return { ok: true };
});

app.get("/api/transcript", async (req) => {
  const { projectId, sessionId } = req.query as Record<string, string>;
  return { items: readTranscript(projectId, sessionId) };
});

// 弹出 macOS 原生文件夹选择器，返回选中目录的绝对路径（本地工具专用）
app.post("/api/pick-folder", async () => {
  if (process.platform !== "darwin") {
    return { ok: false, error: "原生文件夹选择仅支持 macOS，请手动输入路径" };
  }
  const script = 'POSIX path of (choose folder with prompt "选择项目根目录")';
  const path = await new Promise<string | null>((resolve) => {
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) return resolve(null); // 用户取消或出错
      resolve(stdout.trim().replace(/\/$/, ""));
    });
  });
  if (!path) return { ok: false, cancelled: true };
  return { ok: true, path };
});

// 对话框附件：图片→base64 image part；其余（文本/代码/pdf/Word）→存盘返回路径供 Read
app.post("/api/attach", async (req) => {
  const file = await (req as any).file();
  if (!file) return { ok: false, error: "无上传文件" };
  return attachFile(String(file.filename), await file.toBuffer(), TMP_UPLOAD_DIR);
});

// 在系统默认浏览器中打开 artifact（html 走这里：mermaid/脚本/CDN 全原生渲染）
app.post("/api/open-artifact", async (req) => {
  const { projectId, sessionId, name } = req.body as Record<string, string>;
  let path: string;
  try {
    path = resolveArtifactPath(projectId, sessionId, name);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "非法路径" };
  }
  if (!existsSync(path)) return { ok: false, error: "文件不存在" };
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  return await new Promise((resolve) =>
    execFile(opener, [path], (err) => resolve(err ? { ok: false, error: "无法打开：" + err.message } : { ok: true }))
  );
});

app.delete("/api/session", async (req) => {
  const { projectId, sessionId } = req.query as Record<string, string>;
  deleteSession(projectId, sessionId);
  return { ok: true };
});

app.post("/api/session/rename", async (req) => {
  const { projectId, sessionId, newName } = req.body as Record<string, string>;
  try {
    const newId = renameSession(projectId, sessionId, newName);
    return { ok: true, newId };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

// 上传 PRD：按格式归一成工作流 Read 可直读的文件（详见 prdIntake.ts）
app.post("/api/upload", async (req) => {
  const file = await (req as any).file();
  if (!file) return { ok: false, error: "无上传文件" };
  return intakePrd(String(file.filename), await file.toBuffer(), TMP_UPLOAD_DIR);
});

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
function looksLikeProjectRoot(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)));
}

/** 启动前快照所有已存在的 session 目录，用于探测「本次新建」的那个。 */
function snapshotSessionDirs(): Set<string> {
  const set = new Set<string>();
  if (!existsSync(DATA_ROOT)) return set;
  for (const proj of readdirSync(DATA_ROOT)) {
    const sdir = join(DATA_ROOT, proj, "sessions");
    if (!existsSync(sdir)) continue;
    for (const s of readdirSync(sdir)) set.add(join(sdir, s));
  }
  return set;
}

// 启动一个工作流会话
app.post("/api/start", async (req) => {
  const body = req.body as { cwd: string; initialPrompt: string; mode?: "full" | "light"; allowAll?: boolean; force?: boolean; model?: string };
  if (!existsSync(body.cwd)) return { ok: false, error: `项目根不存在: ${body.cwd}` };

  // #5 预检：cwd 不像项目根时要求确认（防 bypassPermissions 在错目录无确认写代码/跑命令）
  if (!body.force && !looksLikeProjectRoot(body.cwd)) {
    return {
      ok: false,
      needConfirm: true,
      warn: `「${body.cwd}」看起来不像项目根（无 .git / package.json / pyproject.toml 等标志）。\nstudio 将在此目录无确认地读写文件、执行命令。确认要在这里启动吗？`,
    };
  }

  // 门禁：正在生成才拦；空闲旧会话自动收掉（放在预检之后，避免因确认弹窗白收会话）
  const blocked = freeIdleOrBlock();
  if (blocked) return blocked;

  // 重置 transcript；快照现有 session 目录，只认本次新建的那个（防认错/认到 resume 的旧目录）
  runSessionDir = null;
  liveSession = null;
  lastUsage = null;
  runCwd = body.cwd;
  runSdkSessionId = null;
  runTranscript.length = 0;
  lastModels = null;
  lastModelSel = body.model || "";
  knownSessionDirs = snapshotSessionDirs();

  // 预声明模式，工作流 P1.0 读到即不再问
  const modeTag = body.mode === "light" ? "【模式：轻量】\n" : "【模式：完整】\n";

  const runEmit = newRunEmit();
  current = new WorkflowSession({
    systemPrompt,
    agents,
    cwd: body.cwd,
    sessionDir: body.cwd, // 占位，真实目录探测到后切换
    allowAll: !!body.allowAll,
    model: body.model || undefined,
    emit: runEmit,
  });
  current.start(modeTag + body.initialPrompt).catch((e) =>
    runEmit({ type: "error", message: String(e?.message ?? e) })
  );
  return { ok: true };
});

// 续聊：基于已有会话的 SDK session 继续对话（保留完整上下文）
app.post("/api/resume", async (req) => {
  const { projectId, sessionId, message, images, model } = req.body as { projectId: string; sessionId: string; message: string; images?: { mediaType: string; data: string }[]; model?: string };
  const meta = readStudioMeta(projectId, sessionId);
  if (!meta.sdkSessionId) return { ok: false, error: "此会话没有 SDK 会话记录（可能是加此功能前、或终端跑的），无法在 studio 续聊。可在终端用 /feature-flow 续 " + sessionId };
  if (!meta.cwd || !existsSync(meta.cwd)) return { ok: false, error: `项目根不存在或未记录：${meta.cwd ?? "（无）"}` };

  // 门禁：正在生成才拦；空闲旧会话自动收掉
  const blocked = freeIdleOrBlock();
  if (blocked) return blocked;

  const dir = join(DATA_ROOT, projectId, "sessions", sessionId);
  // 续到已有 session：transcript 追加到现有 .studio-chat.jsonl，不快照、不探测新目录
  runSessionDir = dir;
  runCwd = meta.cwd;
  runSdkSessionId = meta.sdkSessionId;
  liveSession = { projectId, sessionId };
  lastUsage = null;
  lastModels = null;
  lastModelSel = model || "";
  // 载入已落盘的完整对话（studio 自己的或 CC 原生的）——续聊视图与刷新重连都能看到全程历史
  runTranscript.length = 0;
  runTranscript.push(...(readTranscript(projectId, sessionId) as ChatItem[]));
  flushTranscript(); // 把载入的历史（含终端会话的原生 transcript）固化进 .studio-chat.jsonl，后续追加才不丢史

  const runEmit = newRunEmit();
  current = new WorkflowSession({
    systemPrompt,
    agents,
    cwd: meta.cwd,
    sessionDir: dir,
    resumeSdkSessionId: meta.sdkSessionId,
    allowAll: false,
    model: model || undefined,
    emit: runEmit,
  });
  current.start(message || "（继续）", images).catch((e) => runEmit({ type: "error", message: String(e?.message ?? e) }));
  // 前端已乐观渲染续聊首条消息；这里只落盘（图片仅标记，不存 base64）
  const n = images?.length ?? 0;
  recordChat({ kind: "user", text: (message || "（继续）") + (n ? `  [图片 ${n} 张]` : "") });
  broadcast({ channel: "runner", type: "live_session", projectId, sessionId });
  return { ok: true };
});

// #2 reattach：页面刷新后用它恢复正在跑的会话视图
app.get("/api/live", async () => ({
  running: !!current?.isRunning(),
  transcript: runTranscript,
  liveSession,
  usage: lastUsage,
  models: lastModels,
  modelSel: lastModelSel,
}));

app.post("/api/stop", async () => {
  current?.stop();
  current = null;
  liveSession = null;
  sessionEpoch++; // 作废被停会话的尾部事件
  return { ok: true };
});

// ── WebSocket ───────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
app.server.on("upgrade", (request, socket, head) => {
  if (request.url?.startsWith("/ws")) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!current) return;
    if (msg.type === "message" && typeof msg.text === "string") {
      const images = Array.isArray(msg.images) ? msg.images : undefined;
      current.sendMessage(msg.text, images);
      // 前端已乐观渲染该消息（含缩略图），这里只落盘 transcript（图片不存 base64，仅标记）
      const n = images?.length ?? 0;
      recordChat({ kind: "user", text: (msg.text || "") + (n ? `  [图片 ${n} 张]` : "") });
    } else if (msg.type === "answer" && msg.id) {
      current.answerAsk(msg.id, msg.answers ?? {});
      // 每个问题的答案各成一行（含自由输入），不要 flat 成一串
      const lines = Object.values(msg.answers ?? {})
        .map((v) => (v as string[]).join(" / "))
        .filter((s) => s.trim());
      emit({ type: "answer_echo", id: msg.id, labels: lines });
    } else if (msg.type === "perm" && msg.id) {
      current.resolvePerm(msg.id, msg.decision);
      const verb = msg.decision === "deny" ? "拒绝" : msg.decision === "always" ? "允许（本会话不再问 Bash）" : "允许";
      recordChat({ kind: "system", text: `权限：你${verb}了一条命令` });
      broadcast({ channel: "runner", type: "permission_resolved", id: msg.id, decision: msg.decision });
    } else if (msg.type === "setPerm") {
      current.setAllowAll(!!msg.allowAll); // 内部会 emit perm_mode 广播同步各客户端
    } else if (msg.type === "setModel" && typeof msg.model === "string") {
      current.setModel(msg.model); // 内部会 emit model_changed 广播同步各客户端
    }
  });
});

// ── 文件监听 → 前端刷新 + 探测新 session 目录 ───────────────
chokidar
  .watch(DATA_ROOT, { ignoreInitial: true, depth: 5 })
  .on("addDir", (path) => {
    // 运行中且尚未锁定时，认本次「新建」的 sessions/<slug>（不在启动快照里），避免认错或认到 resume 的旧目录
    if (
      current?.isRunning() &&
      !runSessionDir &&
      basename(dirname(path)) === "sessions" &&
      !knownSessionDirs.has(path)
    ) {
      runSessionDir = path;
      flushTranscript();
      writeStudioMeta(); // 落盘 cwd + sdk_session_id，供日后续聊
      // 广播 live 会话身份，让前端把列表里这条标成 running、不再单独显示占位
      liveSession = { projectId: basename(dirname(dirname(path))), sessionId: basename(path) };
      broadcast({ channel: "runner", type: "live_session", ...liveSession });
      console.log(`[studio] transcript 目录锁定: ${path}`);
    }
  })
  .on("all", () => broadcast({ channel: "fs", type: "change" }));

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`[studio] server on http://127.0.0.1:${PORT}`);
