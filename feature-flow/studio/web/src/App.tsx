import React, { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ProjectMeta, SessionMeta, ChatItem, AskQuestion, ModelInfo } from "./types.js";

const MD_PLUGINS = [remarkGfm];
function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={MD_PLUGINS}>{children}</ReactMarkdown>;
}

const WS_URL = `ws://${location.host}/ws`;

const PHASES = [
  { code: "P0", zh: "识别" }, { code: "P1", zh: "接入" }, { code: "P2", zh: "探索" },
  { code: "P3", zh: "拷问" }, { code: "P4", zh: "架构" }, { code: "P5", zh: "评审" },
  { code: "P6", zh: "实现" }, { code: "P7", zh: "质检" }, { code: "P8", zh: "交付" },
];
function phaseIndex(p: string | null): number {
  if (!p) return -1;
  return PHASES.findIndex((x) => x.code === p.split(".")[0]);
}

type View =
  | { mode: "empty" }
  | { mode: "new" }
  | { mode: "map"; content: string }
  | { mode: "artifact"; sessionId: string; name: string; content: string }
  | { mode: "conversation"; sessionId: string; live: boolean; items: ChatItem[] };

// 全局图片放大：任意 <img> onClick={() => zoomImage(src)}，由根部 <Lightbox/> 接收
let _setZoom: ((src: string | null) => void) | null = null;
function zoomImage(src: string) { _setZoom?.(src); }
function Lightbox() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { _setZoom = setSrc; return () => { _setZoom = null; }; }, []);
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSrc(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src]);
  if (!src) return null;
  return (
    <div className="lightbox" onClick={() => setSrc(null)}>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-x" onClick={() => setSrc(null)} title="关闭 (Esc)">✕</button>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [expandedProject, setExpandedProject] = useState<string | null>(null); // 侧栏展开的项目节点（手风琴）
  const [expanded, setExpanded] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "empty" });
  const [mapRefreshing, setMapRefreshing] = useState(false); // 当前 live run 是否是「更新项目记忆」（用于标题）
  const mapRefreshingRef = useRef(false);                    // 同上，供被闭包捕获的 handleRunner 读最新值
  const projectIdRef = useRef<string | null>(null);          // 同步当前 projectId，供 handleRunner 读
  const [liveChat, setLiveChat] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState(false); // 连接开着（含空闲等输入）
  const [busy, setBusy] = useState(false);        // 正在生成本轮（区分"生成中"vs"在线空闲"）
  const [showDocs, setShowDocs] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [allowAll, setAllowAll] = useState(false); // 权限模式：false=受控（默认），true=全部允许
  const [liveSession, setLiveSession] = useState<{ projectId: string; sessionId: string } | null>(null);
  const [usage, setUsage] = useState<{ model: string; contextTokens: number; outputTokens: number; costUsd: number } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]); // SDK 真实可选模型列表
  const [modelSel, setModelSel] = useState<string>(() => localStorage.getItem("ff_model") || ""); // 选中的 model value，跨会话记忆
  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<View>(view);
  viewRef.current = view;

  const refresh = useCallback(async () => {
    const r = await fetch("/api/projects").then((x) => x.json());
    setProjects(r.projects);
    const first = r.projects[0]?.projectId ?? null;
    setProjectId((cur) => cur ?? first);
    setExpandedProject((cur) => cur ?? first); // 首个项目默认展开，进来就能看到它的记忆+会话
  }, []);

  // 点项目：已展开则收起；否则展开并设为当前项目
  function toggleProject(id: string) {
    if (expandedProject === id) { setExpandedProject(null); return; }
    setProjectId(id);
    setExpandedProject(id);
    setExpanded(null);
    setView({ mode: "empty" });
  }

  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  useEffect(() => {
    refresh();
    let closed = false;
    let ws: WebSocket | null = null;

    // 与后端对齐 running / 已累积消息：首次加载 + 每次 WS (重)连后调用，
    // 修复断网/休眠后漏事件导致的 running 卡死、ask 状态错乱
    const syncLive = () => {
      fetch("/api/live").then((x) => x.json()).then((live) => {
        if (live.running) {
          setLiveChat(live.transcript ?? []);
          setRunning(true);
          setLiveSession(live.liveSession ?? null);
          setUsage(live.usage ?? null);
          if (live.models?.models) setModels(live.models.models);
          if (live.modelSel) setModelSel(live.modelSel);
          setView((v) => (v.mode === "empty" ? { mode: "conversation", sessionId: "__live__", live: true, items: [] } : v));
        } else {
          setRunning(false); // 后端已结束 → 清掉卡住的运行态
          setLiveSession(null);
        }
      }).catch(() => {});
    };

    const connect = () => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => syncLive();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.channel === "fs") return refresh();
        if (m.channel === "runner") handleRunner(m);
      };
      ws.onclose = () => { if (!closed) setTimeout(connect, 1500); }; // 断线自动重连
    };
    connect();

    return () => { closed = true; ws?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRunner(m: any) {
    setLiveChat((c) => {
      switch (m.type) {
        case "assistant_text": return [...c, { kind: "assistant", text: m.text }];
        case "tool_use": return [...c, { kind: "tool", name: m.name, summary: m.summary }];
        case "ask": return [...c, { kind: "ask", id: m.id, questions: m.questions }];
        case "permission": return [...c, { kind: "permission", id: m.id, tool: m.tool, command: m.command }];
        case "permission_resolved":
          return c.map((it) => (it.kind === "permission" && it.id === m.id ? { ...it, decision: m.decision } : it));
        case "perm_mode": return c; // 见下方独立处理
        case "user_echo": return [...c, { kind: "user", text: m.text }];
        case "answer_echo":
          return [
            ...c.map((it) => (it.kind === "ask" && it.id === m.id ? { ...it, answered: true } : it)),
            { kind: "user", text: (m.labels ?? []).map((l: string) => "↳ " + l).join("\n") } as ChatItem,
          ];
        case "result": return [...c, { kind: "system", text: m.isError ? "本轮以错误结束" : "本轮完成" }];
        case "error": return [...c, { kind: "system", text: `错误 · ${m.message}` }];
        case "done": return [...c, { kind: "system", text: "会话结束" }];
        default: return c;
      }
    });
    if (m.type === "error" || m.type === "done") setRunning(false);
    // busy = 正在生成本轮：吐字/工具调用中为真；本轮完成/等作答/结束为假（镜像后端 generating）
    if (m.type === "assistant_text" || m.type === "tool_use") setBusy(true);
    if (m.type === "result" || m.type === "ask" || m.type === "permission" || m.type === "done" || m.type === "error") setBusy(false);
    // 地图刷新是一次性 run：本轮 result 一到就收尾——WorkflowSession 为多轮设计，
    // 一轮完只发 result 不发 done，会一直挂着等输入，所以这里主动停掉会话。
    // 用 ref 读：handleRunner 被 WS 的 []-effect 闭包捕获，直接读 state 会是旧值。
    if ((m.type === "result" || m.type === "error") && mapRefreshingRef.current) {
      const errored = m.type === "error" || m.isError;
      mapRefreshingRef.current = false;
      setMapRefreshing(false);
      fetch("/api/stop", { method: "POST" }).catch(() => {}); // 关掉这条一次性会话
      setRunning(false);
      setLiveSession(null);
      if (!errored) loadMap(projectIdRef.current); // 成功 → 跳回展示刷新后的记忆；出错则留在 live 看报错
    }
    if (m.type === "perm_mode") setAllowAll(m.allowAll); // 与后端同步（如点了"本会话内允许 Bash"）
    if (m.type === "live_session") setLiveSession({ projectId: m.projectId, sessionId: m.sessionId });
    if (m.type === "usage") setUsage({ model: m.model, contextTokens: m.contextTokens, outputTokens: m.outputTokens, costUsd: m.costUsd });
    if (m.type === "models") { setModels(m.models); if (m.current) setModelSel(m.current); }
    if (m.type === "model_changed") setModelSel(m.model);
  }

  function switchModel(value: string) {
    setModelSel(value);
    localStorage.setItem("ff_model", value);
    wsRef.current?.send(JSON.stringify({ type: "setModel", model: value }));
  }

  function toggleAllowAll() {
    const next = !allowAll;
    setAllowAll(next);
    wsRef.current?.send(JSON.stringify({ type: "setPerm", allowAll: next }));
  }

  const project = projects.find((p) => p.projectId === projectId) ?? null;
  const allSessions = project?.sessions ?? [];

  // 当前会话视图绑定的真实 session（用于在主区展示其进度）
  const viewSessionId =
    (view.mode === "conversation" || view.mode === "artifact") && view.sessionId !== "__live__"
      ? view.sessionId
      : null;
  const progressSession: SessionMeta | null =
    allSessions.find((s) => s.sessionId === viewSessionId) ?? null;

  async function openConversation(s: SessionMeta) {
    if (!s.hasTranscript) {
      setView({ mode: "conversation", sessionId: s.sessionId, live: false, items: [] });
      return;
    }
    const r = await fetch(
      `/api/transcript?projectId=${encodeURIComponent(s.projectId)}&sessionId=${encodeURIComponent(s.sessionId)}`
    ).then((x) => x.json());
    setView({ mode: "conversation", sessionId: s.sessionId, live: false, items: r.items ?? [] });
  }

  async function openArtifact(s: SessionMeta, name: string) {
    // html 直接在系统浏览器打开（mermaid/脚本/CDN 全原生渲染），不在 studio 内嵌
    if (/\.html?$/i.test(name)) {
      const r = await fetch("/api/open-artifact", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: s.projectId, sessionId: s.sessionId, name }),
      }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (!r.ok) alert(r.error ?? "无法在浏览器打开");
      return;
    }
    const r = await fetch(
      `/api/artifact?projectId=${encodeURIComponent(s.projectId)}&sessionId=${encodeURIComponent(s.sessionId)}&name=${encodeURIComponent(name)}`
    ).then((x) => x.json());
    setView({ mode: "artifact", sessionId: s.sessionId, name, content: r.content });
  }

  async function loadMap(pid: string | null) {
    if (!pid) return;
    const r = await fetch(`/api/project-map?projectId=${encodeURIComponent(pid)}`).then((x) => x.json()).catch(() => ({ content: "" }));
    setView({ mode: "map", content: r.content ?? "" });
  }
  function openMap() { loadMap(projectId); }

  async function refreshMap(cwd?: string) {
    if (!projectId) return;
    if (running) { alert("有运行中的会话，请先停止再刷新地图。"); return; }
    const r = await fetch("/api/map-refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, cwd }),
    }).then((x) => x.json());
    if (!r.ok) {
      if (r.needCwd) {
        const pick = await fetch("/api/pick-folder", { method: "POST" }).then((x) => x.json());
        if (pick.ok) return refreshMap(pick.path);
        return;
      }
      alert(r.error ?? "刷新失败");
      return;
    }
    setLiveChat([]); setLiveSession(null); setUsage(null); setRunning(true); setBusy(true);
    setMapRefreshing(true); mapRefreshingRef.current = true;
    showLive(); // 切到 live 视图看 agent 扫码更新；完成后自动跳回「项目记忆」展示最新
  }

  function showLive() {
    setView({ mode: "conversation", sessionId: "__live__", live: true, items: [] });
  }

  async function commitRename(s: SessionMeta, newName: string) {
    const trimmed = newName.trim();
    setRenaming(null);
    if (!trimmed || trimmed === s.sessionId) return;
    const r = await fetch("/api/session/rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: s.projectId, sessionId: s.sessionId, newName: trimmed }),
    }).then((x) => x.json());
    if (!r.ok) { alert("重命名失败：" + r.error); return; }
    // 若重命名的是当前查看/展开的会话，把引用同步到新名
    setView((cur) =>
      (cur.mode === "conversation" || cur.mode === "artifact") && cur.sessionId === s.sessionId
        ? { ...cur, sessionId: r.newId }
        : cur
    );
    setExpanded((e) => (e === s.sessionId ? r.newId : e));
    refresh();
  }

  async function deleteSession(s: SessionMeta) {
    if (!confirm(`删除会话「${s.sessionId}」？\n该会话目录下的所有产物与对话记录将一并删除，不可恢复。`)) return;
    const r = await fetch(
      `/api/session?projectId=${encodeURIComponent(s.projectId)}&sessionId=${encodeURIComponent(s.sessionId)}`,
      { method: "DELETE" }
    ).then((x) => x.json());
    if (!r.ok) { alert("删除失败"); return; }
    // 若删的是当前查看的会话，回到空态
    setView((cur) =>
      (cur.mode === "conversation" || cur.mode === "artifact") && cur.sessionId === s.sessionId
        ? { mode: "empty" }
        : cur
    );
    setExpanded((e) => (e === s.sessionId ? null : e));
    refresh();
  }

  function sendAnswer(id: string, answers: Record<string, string[]>) {
    setBusy(true);
    wsRef.current?.send(JSON.stringify({ type: "answer", id, answers }));
  }
  function sendPerm(id: string, decision: "allow" | "deny" | "always") {
    setBusy(true);
    wsRef.current?.send(JSON.stringify({ type: "perm", id, decision }));
  }
  type ImgArg = { url: string; mediaType: string; data: string };
  function sendMessage(text: string, images?: ImgArg[]) {
    setBusy(true);
    const urls = (images ?? []).map((i) => i.url);
    // 乐观渲染（含缩略图）；服务端只落盘标记、不回显，避免重复
    setLiveChat((c) => [...c, { kind: "user", text, images: urls.length ? urls : undefined }]);
    wsRef.current?.send(JSON.stringify({
      type: "message", text,
      images: (images ?? []).map((i) => ({ mediaType: i.mediaType, data: i.data })),
    }));
  }

  // 续聊核心：先拉该会话已落盘的完整历史（权威来源），再 resume，乐观渲染后转 live
  async function resumeTarget(projectId: string, sessionId: string, text: string, images?: ImgArg[]) {
    const urls = (images ?? []).map((i) => i.url);
    // 拉全量历史（在 resume 落盘本条消息之前拉，避免与下面的乐观消息重复）
    const hist: ChatItem[] = await fetch(
      `/api/transcript?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`
    ).then((x) => x.json()).then((r) => r.items ?? []).catch(() => []);
    const r = await fetch("/api/resume", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId, sessionId, message: text,
        images: (images ?? []).map((i) => ({ mediaType: i.mediaType, data: i.data })),
        model: modelSel || undefined,
      }),
    }).then((x) => x.json());
    if (!r.ok) { alert(r.error); return; }
    setLiveChat([...hist, { kind: "user", text, images: urls.length ? urls : undefined }]);
    setRunning(true); setBusy(true);
    setLiveSession({ projectId, sessionId });
    setView({ mode: "conversation", sessionId: "__live__", live: true, items: [] });
  }

  // 历史会话视图发消息 → 续聊
  async function resumeRun(text: string, images?: ImgArg[]) {
    if (view.mode !== "conversation" || view.live) return;
    const s = allSessions.find((x) => x.sessionId === view.sessionId);
    if (!s) return;
    if (!s.sdkSessionId) { alert("此会话没有 SDK 记录，无法在 studio 续聊。可在终端用 /feature-flow 续 " + s.sessionId); return; }
    await resumeTarget(s.projectId, s.sessionId, text, images);
  }

  // live 视图但已停止/已结束 → 基于同一条 SDK 会话继续聊
  function continueLive(text: string, images?: ImgArg[]) {
    if (!liveSession) return;
    resumeTarget(liveSession.projectId, liveSession.sessionId, text, images);
  }

  async function startRun(cwd: string, initialPrompt: string, mode: "full" | "light", force = false) {
    const r = await fetch("/api/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, initialPrompt, mode, allowAll, force, model: modelSel || undefined }),
    }).then((x) => x.json());
    if (!r.ok) {
      // #5：cwd 不像项目根 → 二次确认后带 force 重试
      if (r.needConfirm) {
        if (confirm(r.warn)) return startRun(cwd, initialPrompt, mode, true);
        return;
      }
      alert(r.error);
      return;
    }
    setLiveChat([]);
    setLiveSession(null);
    setUsage(null);
    setRunning(true); setBusy(true);
    showLive();
  }

  async function stopRun() {
    setBusy(false);
    await fetch("/api/stop", { method: "POST" }).catch(() => {});
    setRunning(false);
    // 保留 liveSession：停止后输入框继续可用，走 resume 接着聊
  }

  const convItems = view.mode === "conversation" ? (view.live ? liveChat : view.items) : [];

  return (
    <div className="shell">
      <Lightbox />
      <TopBar running={running} onDocs={() => setShowDocs(true)} allowAll={allowAll} onToggleAllow={toggleAllowAll} />
      {showDocs && <WorkflowDocs onClose={() => setShowDocs(false)} />}
      <div className="body">
        <Sidebar
          projects={projects}
          projectId={projectId}
          expandedProject={expandedProject}
          onToggleProject={toggleProject}
          sessions={allSessions}
          expanded={expanded}
          activeConvId={view.mode === "conversation" ? view.sessionId : null}
          activeArtifact={view.mode === "artifact" ? view.name : null}
          running={running}
          liveSessionId={running && liveSession && liveSession.projectId === projectId ? liveSession.sessionId : null}
          busy={busy}
          onNew={() => setView({ mode: "new" })}
          onLive={showLive}
          onMap={openMap}
          mapActive={view.mode === "map"}
          onSession={openConversation}
          onArtifact={openArtifact}
          onToggle={(id) => setExpanded((e) => (e === id ? null : id))}
          onDelete={deleteSession}
          renaming={renaming}
          onRenameStart={(id) => setRenaming(id)}
          onRenameCommit={commitRename}
          onRenameCancel={() => setRenaming(null)}
        />
        <Main
          view={view}
          convItems={convItems}
          running={running}
          progressSession={progressSession}
          knownProjects={projects.map((p) => p.projectId)}
          onAnswer={sendAnswer}
          onPerm={sendPerm}
          onSend={
            view.mode === "conversation" && !view.live ? resumeRun
            : running ? sendMessage
            : continueLive
          }
          composerEnabled={
            view.mode === "conversation" &&
            (view.live ? (running || !!liveSession) : !!allSessions.find((s) => s.sessionId === view.sessionId)?.sdkSessionId)
          }
          composerHint={
            view.mode === "conversation" && !view.live ? "继续这个会话…（基于完整上下文续聊，⌘/Ctrl+Enter）"
            : !running ? "已停止 · 继续输入将基于完整上下文续聊（⌘/Ctrl+Enter）"
            : "给会话发消息…（⌘/Ctrl + Enter 发送）"
          }
          composerNote={
            view.mode === "conversation" && !view.live && !allSessions.find((s) => s.sessionId === view.sessionId)?.sdkSessionId
              ? "此会话无 SDK 记录，无法在 studio 续聊（可在终端用 /feature-flow 续）"
              : null
          }
          usage={usage}
          models={models}
          modelSel={modelSel}
          onPickModel={switchModel}
          onStart={startRun}
          onStop={stopRun}
          onCancelNew={() => setView({ mode: "empty" })}
          onRefreshMap={() => refreshMap()}
          mapRefreshing={mapRefreshing}
        />
      </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}
function modelName(id: string): string {
  if (!id) return "—";
  const fam = /opus/i.test(id) ? "Opus" : /sonnet/i.test(id) ? "Sonnet" : /haiku/i.test(id) ? "Haiku" : id;
  const m = id.match(/(\d+)[-.](\d+)/);
  return m ? `${fam} ${m[1]}.${m[2]}` : fam;
}

function TopBar({ running, onDocs, allowAll, onToggleAllow }: { running: boolean; onDocs: () => void; allowAll: boolean; onToggleAllow: () => void }) {
  return (
    <header className="topbar">
      <div className="brand"><span className="mark">feature<b>·</b>flow</span><span className="tag">studio</span></div>
      <span className="top-spacer" />
      <button
        className={"perm-toggle" + (allowAll ? " on" : "")}
        onClick={onToggleAllow}
        title={allowAll ? "当前全部允许：高风险命令也直接执行，点击切回受控" : "当前受控：高风险命令会弹确认，点击切到全部允许"}
      >
        <span className="pt-dot" />
        {allowAll ? "权限：全部允许" : "权限：受控"}
      </button>
      <button className="docs-btn" onClick={onDocs}>工作流说明</button>
      <div className="run-status"><span className={"dot " + (running ? "on" : "off")} /><span className="lbl">{running ? "running" : "idle"}</span></div>
    </header>
  );
}

// 轻量分支跳过的 phase（P4）
const LIGHT_SKIPPED = new Set(["P4"]);

/** 流程脊柱：P0→P8 进度。done 已完成、active 进行中、skipped 该模式跳过、其余未到。 */
function FlowSpine({ phaseIdx, completed, skipped }: { phaseIdx: number; completed: boolean; skipped: Set<string> }) {
  const last = PHASES.length - 1;
  return (
    <div className="spine">
      {PHASES.map((p, i) => {
        const isSkipped = skipped.has(p.code);
        const done = !isSkipped && (i < phaseIdx || (i === phaseIdx && completed && phaseIdx === last));
        const active = !isSkipped && i === phaseIdx && !(completed && phaseIdx === last);
        const cls = isSkipped ? " skipped" : done ? " done" : active ? " active" : "";
        return (
          <div className="spine-node" key={p.code}>
            <div className={"spine-dot" + cls}>
              <span className="spine-pip" />
              <span className="spine-label">{p.code} {p.zh}</span>
            </div>
            {i < last && <span className={"spine-bar" + (i < phaseIdx ? " done" : "")} />}
          </div>
        );
      })}
    </div>
  );
}

function ProgressStrip({ session }: { session: SessionMeta }) {
  const idx = phaseIndex(session.currentPhase);
  const completed = session.phaseStatus === "completed";
  const isLight = session.mode === "light";
  const b = phaseBadge(session);
  return (
    <div className="progress-strip">
      <span className="progress-label">
        进度
        {isLight && <span className="mode-tag">轻量</span>}
        <span className={"badge " + b.cls}>{b.text}</span>
      </span>
      <FlowSpine phaseIdx={idx} completed={completed} skipped={isLight ? LIGHT_SKIPPED : EMPTY_SET} />
    </div>
  );
}
const EMPTY_SET = new Set<string>();

function phaseBadge(s: SessionMeta): { text: string; cls: string } {
  if (!s.currentPhase) return { text: "—", cls: "wip" };
  if (s.phaseStatus === "completed" && s.currentPhase === "P8") return { text: "完成", cls: "done" };
  return { text: `${s.currentPhase} ${s.phaseStatus ?? ""}`.trim(), cls: "wip" };
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      className="sess-rename"
      value={val}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onCommit(val); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      onBlur={() => onCommit(val)}
    />
  );
}

// 项目图标（代码仓库 / 文件夹）
function IconProject() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}
// 项目记忆图标（层级/结构图）
function IconMemory() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" />
      <path d="M12 8v4M6 16v-2h12v2" />
    </svg>
  );
}
// 刷新图标（圆形箭头）
function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
    </svg>
  );
}

function Sidebar(props: {
  projects: ProjectMeta[];
  projectId: string | null;
  expandedProject: string | null;
  onToggleProject: (id: string) => void;
  sessions: SessionMeta[];
  expanded: string | null;
  activeConvId: string | null;
  activeArtifact: string | null;
  running: boolean;
  liveSessionId: string | null;
  busy: boolean;
  onNew: () => void;
  onLive: () => void;
  onMap: () => void;
  mapActive: boolean;
  onSession: (s: SessionMeta) => void;
  onArtifact: (s: SessionMeta, name: string) => void;
  onToggle: (id: string) => void;
  onDelete: (s: SessionMeta) => void;
  renaming: string | null;
  onRenameStart: (id: string) => void;
  onRenameCommit: (s: SessionMeta, newName: string) => void;
  onRenameCancel: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="side-top">
        <button className="new-btn" onClick={props.onNew}><span className="plus">+</span> 新建会话</button>
      </div>

      <div className="side-scroll">
        <label className="side-label">项目</label>
        {props.projects.length === 0 && <div className="proj-empty">（暂无项目）</div>}
        {props.projects.map((p) => {
          const pOpen = props.expandedProject === p.projectId;
          return (
            <div className={"proj-node" + (pOpen ? " open" : "")} key={p.projectId}>
              <button className={"proj-row" + (pOpen ? " on" : "")} onClick={() => props.onToggleProject(p.projectId)} title={p.projectId}>
                <span className={"caret" + (pOpen ? " down" : "")}>▶</span>
                <IconProject />
                <span className="proj-name">{p.projectId}</span>
                <span className="proj-count">{p.sessions.length}</span>
              </button>
              {pOpen && (
                <div className="proj-body">
                  {/* 项目记忆 + 会话都属于这个项目 */}
                  <button className={"proj-mem" + (props.mapActive ? " on" : "")} onClick={props.onMap} title="查看本项目沉淀的长期记忆">
                    <IconMemory /> <span>项目记忆</span>{p.hasMap ? null : <span className="map-none">未生成</span>}
                  </button>
                  <div className="proj-sess-label">会话</div>
                  {/* 占位"进行中的会话"：真实 session 还没出现在列表时显示 */}
                  {props.running && !props.liveSessionId && (
                    <div className={"sess" + (props.activeConvId === "__live__" ? " active-conv" : "")}>
                      <div className="sess-row" onClick={props.onLive}>
                        <span className="sess-main">
                          <span className="sess-id">● 进行中的会话</span>
                          <span className="sess-meta"><span className="badge wip">{props.busy ? "生成中" : "在线"}</span></span>
                        </span>
                      </div>
                    </div>
                  )}
                  {props.sessions.length === 0 && !props.running && (
                    <div className="arts-empty">还没有会话。点上方「新建会话」开始。</div>
                  )}
                  {props.sessions.map((s) => {
                    const open = props.expanded === s.sessionId;
                    const isLive = props.running && s.sessionId === props.liveSessionId;
                    // 三态：生成中(busy) → 「生成中」；开着但空闲 / 未开 → 真实进度徽章（完成/Pn）。live 圆点单独表示"连接在线可续聊"。
                    const b = isLive && props.busy ? { text: "生成中", cls: "wip" } : phaseBadge(s);
                    const activeConv = props.activeConvId === s.sessionId || (isLive && props.activeConvId === "__live__");
                    const editing = props.renaming === s.sessionId;
                    return (
                      <div key={s.sessionId} className={"sess" + (open ? " open" : "") + (activeConv ? " active-conv" : "")}>
                        <div
                          className="sess-row"
                          onClick={() => {
                            if (editing) return;
                            props.onToggle(s.sessionId);
                            if (isLive) props.onLive(); else props.onSession(s);
                          }}
                        >
                          <span className={"caret" + (open ? " down" : "")}>▶</span>
                          <span className="sess-main">
                            {editing ? (
                              <RenameInput
                                initial={s.sessionId}
                                onCommit={(v) => props.onRenameCommit(s, v)}
                                onCancel={props.onRenameCancel}
                              />
                            ) : (
                              <>
                                <span className="sess-id">{isLive && <span className="live-dot" title="会话在线，可继续对话（点停止关闭）" />}{s.sessionId}</span>
                                <span className="sess-meta">
                                  <span className={"badge " + b.cls}>{b.text}</span>
                                  <span className="sess-count">{s.artifacts.length} 产物{s.hasTranscript ? " · 有对话" : ""}</span>
                                </span>
                              </>
                            )}
                          </span>
                          {!editing && (
                            <span className="sess-actions">
                              <button className="sess-act" title="重命名会话" onClick={(e) => { e.stopPropagation(); props.onRenameStart(s.sessionId); }}>✎</button>
                              <button className="sess-act del" title="删除会话" onClick={(e) => { e.stopPropagation(); props.onDelete(s); }}>✕</button>
                            </span>
                          )}
                        </div>
                        {open && (
                          <div className="arts">
                            {s.artifacts.length === 0 && <div className="arts-empty">无产物文件</div>}
                            {s.artifacts.map((a) => (
                              <button
                                key={a}
                                className={"art" + (props.activeArtifact === a && props.expanded === s.sessionId ? " active" : "")}
                                onClick={() => props.onArtifact(s, a)}
                                title={/\.html?$/i.test(a) ? "在浏览器打开" : undefined}
                              >
                                {a.replace(/\.md$/, "")}
                                {/\.html?$/i.test(a) && <span className="art-ext">↗</span>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function Main(props: {
  view: View;
  convItems: ChatItem[];
  running: boolean;
  progressSession: SessionMeta | null;
  knownProjects: string[];
  onAnswer: (id: string, a: Record<string, string[]>) => void;
  onPerm: (id: string, decision: "allow" | "deny" | "always") => void;
  onSend: (text: string, images?: { url: string; mediaType: string; data: string }[]) => void;
  composerEnabled: boolean;
  composerHint: string;
  composerNote: string | null;
  usage: { model: string; contextTokens: number; outputTokens: number; costUsd: number } | null;
  models: ModelInfo[];
  modelSel: string;
  onPickModel: (value: string) => void;
  onStart: (cwd: string, initialPrompt: string, mode: "full" | "light") => void;
  onStop: () => void;
  onCancelNew: () => void;
  onRefreshMap: () => void;
  mapRefreshing: boolean;
}) {
  const v = props.view;
  if (v.mode === "empty")
    return (
      <main className="main">
        <div className="main-empty">
          <div className="big">feature·flow studio</div>
          <div className="hint">左侧选择会话查看对话与产物，或「新建会话」启动一条新流程</div>
        </div>
      </main>
    );

  if (v.mode === "new")
    return (
      <main className="main">
        <NewSession knownProjects={props.knownProjects} onStart={props.onStart} onCancel={props.onCancelNew} />
      </main>
    );

  if (v.mode === "map")
    return (
      <main className="main">
        <div className="main-head">
          <span className="main-title map-title"><IconMemory /> 项目记忆</span>
          <span className="main-head-right">
            <button className="docs-btn" onClick={props.onRefreshMap} disabled={props.running} title="扫描代码库，生成/更新项目记忆">
              <IconRefresh /> {props.running ? "运行中…" : "更新"}
            </button>
          </span>
        </div>
        {v.content.trim()
          ? <div className="reader"><Markdown>{v.content}</Markdown></div>
          : <div className="main-empty">
              <div className="big">尚未沉淀项目记忆</div>
              <div className="hint">点右上「更新」扫描代码库生成；或在此项目跑一次 feature-flow，P0 会自动建图。</div>
            </div>}
      </main>
    );

  if (v.mode === "artifact") {
    const isMd = /\.(md|markdown)$/i.test(v.name);
    return (
      <main className="main">
        <div className="main-head">
          <span className="main-title">{v.name.replace(/\.md$/, "")}</span>
          <span className="main-sub">{v.sessionId}</span>
        </div>
        {props.progressSession && <ProgressStrip session={props.progressSession} />}
        {isMd ? (
          <div className="reader"><Markdown>{v.content}</Markdown></div>
        ) : (
          // json/csv/txt/svg/xml：纯文本原样展示（html 走系统浏览器，不进这里）
          <div className="reader"><pre className="artifact-raw">{v.content}</pre></div>
        )}
      </main>
    );
  }

  // conversation
  return (
    <main className="main">
      <div className="main-head">
        <span className="main-title">{v.live ? (props.mapRefreshing ? "更新项目记忆中…" : "进行中的会话") : "对话记录"}</span>
        <span className="main-sub">{v.live ? "live" : v.sessionId}</span>
      </div>
      {props.progressSession && <ProgressStrip session={props.progressSession} />}
      {!v.live && props.convItems.length === 0 ? (
        <div className="main-empty">
          <div className="big">无对话记录</div>
          <div className="hint">此会话在终端用 CLI 创建，studio 没有它的对话记录。<br />展开左侧会话查看它的产物文件。</div>
        </div>
      ) : (
        <Conversation items={props.convItems} onAnswer={props.onAnswer} onPerm={props.onPerm} />
      )}
      {v.live && (props.running || props.usage) && (
        <ConvStatus items={props.convItems} running={props.running} usage={props.usage} models={props.models} modelSel={props.modelSel} onPickModel={props.onPickModel} />
      )}
      {props.composerNote && <div className="composer-note">{props.composerNote}</div>}
      {props.composerEnabled && (() => {
        // agent 正在生成 → 发送按钮变身为停止；空闲/等输入 → 发送
        const li = props.convItems[props.convItems.length - 1];
        const doneTurn = !!li && li.kind === "system" && /本轮完成/.test(li.text);
        const pendingAsk = !!li && li.kind === "ask" && !li.answered;
        const busy = v.live && props.running && !doneTurn && !pendingAsk;
        return (
          <Composer onSend={props.onSend} placeholder={props.composerHint} busy={busy} onStop={props.onStop} />
        );
      })()}
    </main>
  );
}

function Conversation({ items, onAnswer, onPerm }: { items: ChatItem[]; onAnswer: (id: string, a: Record<string, string[]>) => void; onPerm: (id: string, d: "allow" | "deny" | "always") => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // 是否贴底跟随；用户上划后置 false，回到底部再恢复
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // 仅当用户已贴在底部时才自动滚到底——上划看历史时不抢
  useEffect(() => { if (stick.current) ref.current?.scrollTo(0, ref.current.scrollHeight); }, [items]);
  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      <div className="chat-wrap">
        {items.map((it, i) => <ChatRow key={i} item={it} onAnswer={onAnswer} onPerm={onPerm} />)}
      </div>
    </div>
  );
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

function lastActivityLabel(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool") {
      if (it.name === "Agent") return "正在运行子任务（探索 / 架构 / 质检）";
      if (it.name === "Read" || it.name === "Grep" || it.name === "Glob") return "正在读取代码";
      if (it.name === "Bash") return "正在执行命令";
      if (it.name === "Write" || it.name === "Edit") return "正在写代码";
      return `正在执行 ${it.name}`;
    }
    if (it.kind === "assistant") return "正在思考";
    if (it.kind === "user") return "已发送，等待响应";
  }
  return "正在启动";
}

/** 模型选择器：展示当前模型，点击下拉切换（来自 SDK supportedModels() 真实列表）。 */
function ModelPicker({ usage, models, modelSel, onPick }: {
  usage: { model: string }; models: ModelInfo[]; modelSel: string; onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // 列表没拿到时退化为只读展示 API 实际返回的模型名（永远准）
  if (!models.length) return <span className="sl-model">{modelName(usage.model)}</span>;
  const sel = models.find((m) => m.value === modelSel);
  const label = sel ? sel.displayName : modelName(usage.model);
  return (
    <span className="model-picker">
      <button className="sl-model sl-model-btn" onClick={() => setOpen((o) => !o)} title="点击切换模型">
        {label} <span className="mp-caret">▾</span>
      </button>
      {open && (
        <>
          <span className="mp-backdrop" onClick={() => setOpen(false)} />
          <div className="mp-menu">
            {models.map((m) => (
              <button
                key={m.value}
                className={"mp-opt" + (m.value === modelSel ? " on" : "")}
                onClick={() => { onPick(m.value); setOpen(false); }}
              >
                <span className="mp-name">{m.displayName}{m.value === modelSel ? " ✓" : ""}</span>
                <span className="mp-desc">{m.description}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/** 用量内联片段（模型 · Context · 输出），放在状态条右侧。 */
function UsageBits({ usage, models, modelSel, onPickModel }: {
  usage: { model: string; contextTokens: number; outputTokens: number; costUsd: number };
  models: ModelInfo[]; modelSel: string; onPickModel: (v: string) => void;
}) {
  const window = usage.contextTokens > 200000 ? 1_000_000 : 200_000;
  const pct = Math.min(100, Math.round((usage.contextTokens / window) * 100));
  return (
    <span className="usage-bits" translate="no">
      <ModelPicker usage={usage} models={models} modelSel={modelSel} onPick={onPickModel} />
      <span className="sl-sep" />
      <span className="sl-item">
        <span className="sl-k">Context</span>
        <span className="sl-bar"><span className="sl-bar-fill" style={{ width: pct + "%" }} /></span>
        <span className="sl-v">{pct}% · {fmtTokens(usage.contextTokens)}/{window >= 1_000_000 ? "1M" : "200k"}</span>
      </span>
      <span className="sl-item"><span className="sl-k">输出</span><span className="sl-v">{fmtTokens(usage.outputTokens)} tok</span></span>
    </span>
  );
}

/** 输入框正上方的状态条：左=活动/状态，右=用量。停止按钮已移入输入框。 */
function ConvStatus({ items, running, usage, models, modelSel, onPickModel }: {
  items: ChatItem[]; running: boolean;
  usage: { model: string; contextTokens: number; outputTokens: number; costUsd: number } | null;
  models: ModelInfo[]; modelSel: string; onPickModel: (v: string) => void;
}) {
  const last = items[items.length - 1];
  const pendingAsk = !!last && last.kind === "ask" && !last.answered;
  const doneTurn = !!last && last.kind === "system" && /本轮完成/.test(last.text);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!running) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [items.length, running]);

  let left: React.ReactNode = null;
  if (running) {
    if (pendingAsk) left = <span className="cs-label">⬆ 等待你在上方作答</span>;
    else if (doneTurn) left = <span className="cs-label">✓ 本轮完成 · 输入下一条继续</span>;
    else left = (
      <>
        <span className="rb-dots"><i /><i /><i /></span>
        <span className="cs-label">{lastActivityLabel(items)}</span>
        <span className="rb-elapsed">· {fmtElapsed(elapsed)}{elapsed >= 15 ? " 无新消息（后台仍在运行）" : ""}</span>
      </>
    );
  }
  return (
    <div className="conv-status">
      {left}
      <span className="cs-spacer" />
      {usage && <UsageBits usage={usage} models={models} modelSel={modelSel} onPickModel={onPickModel} />}
    </div>
  );
}

type PastedImg = { url: string; mediaType: string; data: string };
type FileAtt = { name: string; path: string };
function Composer({ onSend, placeholder, busy, onStop }: { onSend: (text: string, images?: PastedImg[]) => void; placeholder?: string; busy?: boolean; onStop?: () => void }) {
  const [text, setText] = useState("");
  const [imgs, setImgs] = useState<PastedImg[]>([]);
  const [files, setFiles] = useState<FileAtt[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fire = () => {
    if (!text.trim() && imgs.length === 0 && files.length === 0) return;
    // 非图片附件：把路径附到消息末尾，让 agent 用 Read 读取（与上传 PRD 一致）
    const note = files.length
      ? "\n\n[附件，请用 Read 工具查看]\n" + files.map((f) => `- ${f.path}  (${f.name})`).join("\n")
      : "";
    onSend(text + note, imgs);
    setText(""); setImgs([]); setFiles([]);
  };
  async function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.target.value = ""; // 允许再次选同名文件
    if (!chosen.length) return;
    setUploading(true);
    for (const file of chosen) {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/attach", { method: "POST", body: fd }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (!r.ok) { alert(`「${file.name}」上传失败：${r.error ?? "未知错误"}`); continue; }
      if (r.part.type === "image") {
        const url = `data:${r.part.mediaType};base64,${r.part.data}`;
        setImgs((p) => [...p, { url, mediaType: r.part.mediaType, data: r.part.data }]);
      } else {
        setFiles((p) => [...p, { name: r.part.name, path: r.part.path }]);
      }
    }
    setUploading(false);
  }
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result);
          const m = /^data:(.+?);base64,(.*)$/.exec(url);
          if (m) setImgs((prev) => [...prev, { url, mediaType: m[1], data: m[2] }]);
        };
        reader.readAsDataURL(file);
      }
    }
  }
  return (
    <div className="composer">
      <div className="composer-wrap">
        <div className="composer-input">
          {(imgs.length > 0 || files.length > 0) && (
            <div className="composer-thumbs">
              {imgs.map((im, i) => (
                <span className="thumb" key={"i" + i}>
                  <img src={im.url} alt="" onClick={() => zoomImage(im.url)} />
                  <button className="thumb-x" title="移除" onClick={() => setImgs((p) => p.filter((_, j) => j !== i))}>✕</button>
                </span>
              ))}
              {files.map((f, i) => (
                <span className="file-chip" key={"f" + i} title={f.path}>
                  <span className="file-ico">📄</span>
                  <span className="file-name">{f.name}</span>
                  <button className="file-x" title="移除" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>✕</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={text}
            placeholder={placeholder ?? "给会话发消息…  (⌘/Ctrl + Enter 发送，可 Ctrl+V 粘贴图片 / 📎 附文件)"}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) fire(); }}
          />
        </div>
        <button
          className="composer-attach"
          title="添加附件（图片 / 代码文本 / pdf / Word）"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
        >{uploading ? "…" : "📎"}</button>
        <input
          ref={fileInput} type="file" hidden multiple onChange={onPickFiles}
          accept="image/*,.md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.go,.java,.rs,.rb,.php,.c,.h,.cc,.cpp,.hpp,.sh,.bash,.zsh,.sql,.toml,.ini,.conf,.log,.vue,.svelte,.svg,.pdf,.doc,.docx"
        />
        {busy
          ? <button className="composer-btn stop" onClick={onStop}>■ 停止</button>
          : <button className="composer-btn send" onClick={fire}>发送</button>}
      </div>
    </div>
  );
}

function ChatRow({ item, onAnswer, onPerm }: { item: ChatItem; onAnswer: (id: string, a: Record<string, string[]>) => void; onPerm: (id: string, d: "allow" | "deny" | "always") => void }) {
  if (item.kind === "permission") return <PermissionCard item={item} onPerm={onPerm} />;
  if (item.kind === "assistant") return <div className="row assistant"><Markdown>{item.text}</Markdown></div>;
  if (item.kind === "user") return (
    <div className="row user">
      {item.images && item.images.length > 0 && (
        <span className="user-imgs">{item.images.map((u, i) => <img key={i} src={u} alt="" onClick={() => zoomImage(u)} />)}</span>
      )}
      {item.text && <span>{item.text}</span>}
    </div>
  );
  if (item.kind === "tool") return <div className="row tool"><span className="tool-name">{item.name}</span><span className="tool-sum">{item.summary}</span></div>;
  if (item.kind === "system") {
    // 「本轮完成」每轮一个，长会话刷屏 → 降级成一条极淡的分隔线（其余系统消息照常显示）
    if (/^本轮完成$/.test(item.text)) return <div className="turn-sep" aria-hidden />;
    return <div className="row system">{item.text}</div>;
  }
  return <AskCard q={item.questions} id={item.id} answered={!!item.answered} onAnswer={onAnswer} />;
}

function PermissionCard({ item, onPerm }: { item: Extract<ChatItem, { kind: "permission" }>; onPerm: (id: string, d: "allow" | "deny" | "always") => void }) {
  const done = !!item.decision;
  const label = item.decision === "deny" ? "已拒绝" : item.decision === "always" ? "已允许（本会话不再问 Bash）" : item.decision === "allow" ? "已允许" : null;
  return (
    <div className={"row perm" + (done ? " done" : "")}>
      <div className="perm-banner">⚠ 权限确认 · {item.tool}</div>
      <div className="perm-body">
        <div className="perm-hint">工作流要执行一条高风险命令，确认吗？</div>
        <pre className="perm-cmd">{item.command}</pre>
        {done ? (
          <div className="perm-resolved">{label}</div>
        ) : (
          <div className="perm-actions">
            <button className="perm-deny" onClick={() => onPerm(item.id, "deny")}>拒绝</button>
            <button className="perm-allow" onClick={() => onPerm(item.id, "allow")}>允许一次</button>
            <button className="perm-always" onClick={() => onPerm(item.id, "always")}>本会话内允许 Bash</button>
          </div>
        )}
      </div>
    </div>
  );
}

function AskCard(props: { id: string; q: AskQuestion[]; answered: boolean; onAnswer: (id: string, a: Record<string, string[]>) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  function toggle(qText: string, label: string, multi: boolean) {
    setPicked((prev) => {
      const cur = prev[qText] ?? [];
      if (multi) return { ...prev, [qText]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      // 单选：再点同一项 = 取消选中
      return { ...prev, [qText]: cur.includes(label) ? [] : [label] };
    });
  }
  function submit() {
    const answers: Record<string, string[]> = {};
    for (const q of props.q) {
      const sel = [...(picked[q.question] ?? [])];
      const c = custom[q.question]?.trim();
      if (c) sel.push(c);
      answers[q.question] = sel;
    }
    props.onAnswer(props.id, answers);
  }
  return (
    <div className="row ask">
      <div className="ask-banner">需要你的决策</div>
      <div className="ask-body">
        {props.q.map((q) => (
          <div key={q.question} className="ask-q">
            {q.header && <div className="ask-header">{q.header}</div>}
            <div className="ask-question">{q.question}</div>
            <div className="ask-options">
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button key={o.label} disabled={props.answered} className={"opt" + (on ? " on" : "")} onClick={() => toggle(q.question, o.label, !!q.multiSelect)}>
                    <div className="opt-label">{o.label}</div>
                    {o.description && <div className="opt-desc">{o.description}</div>}
                  </button>
                );
              })}
            </div>
            <input className="ask-custom" placeholder="其他（自由输入）" disabled={props.answered}
              value={custom[q.question] ?? ""} onChange={(e) => setCustom((p) => ({ ...p, [q.question]: e.target.value }))} />
          </div>
        ))}
        {!props.answered ? <button className="btn-primary ask-submit" onClick={submit}>提交回答</button> : <div className="ask-done">已提交 ✓</div>}
      </div>
    </div>
  );
}

const WORKFLOW_STEPS = [
  { code: "P0", name: "Context Load · 项目识别", desc: "确认本次开发针对哪个项目，加载该项目持久化的 project-map（模块地图、领域概念、关键约定），作为后续所有阶段的先验知识。首次使用某项目时自动扫描代码库生成 map。", light: "同" },
  { code: "P1", name: "PRD Intake · 接入与分流", desc: "接入本次 PRD（上传文件或描述内容），选择完整流程或轻量分支，并初始化本次 session 目录，把需求落盘为 requirement.md。", light: "同" },
  { code: "P2", name: "Probe · 代码探索 + 假设验证", desc: "并行派出 code-explorer 探索相关代码；同时抽取 PRD 中的具名实体（接口、字段、表、枚举、状态机），逐一在真实代码里定位，产出「PRD 假设验证摘要」——这是拷问的代码事实依据。", light: "只起 1 个聚焦探索，产精简 code-facts；发现改动超预期会提示切回完整流程" },
  { code: "P3", name: "Interrogate · 8 镜头拷问", desc: "站在「即将动手实现」的视角，用 8 个镜头（逻辑完整性 / 用户操作路径 / 边界条件 / 限制配额 / 异常处理 / 新数据结构 / 旧数据迁移 / 权限·可见性·合规）扫出所有动手前必须解决的业务问题，按 P0/P1/P2 优先级排好，每条带代码依据与候选方案，落盘 prd-check.md。", light: "替换为「关键澄清」：只问 0-3 个阻塞性问题，不做 8 镜头全扫，不产 prd-check.md" },
  { code: "P4", name: "Architect · 并行架构设计", desc: "并行派出 2-3 个 code-architect 各出一版技术方案，对比取舍后综合成一版最佳设计。", light: "跳过：主流程内联定方案" },
  { code: "P5", name: "Review Gate · 实现前评审", desc: "实现前的强制评审 checkpoint：技术方案落盘 tech-design.md，由你确认通过后才进入写代码阶段，避免方向跑偏后返工。", light: "轻量 confirm：一句话概述改动让你确认，不产 tech-design" },
  { code: "P6", name: "Implement · 实现", desc: "主流程顺序写代码实现已评审通过的方案，不再外包给 subagent，保证实现连贯一致。", light: "同" },
  { code: "P7", name: "Quality Review · 质检", desc: "并行派出 3 个 code-reviewer 从不同角度审查实现，汇总问题，产出 review-doc.md。", light: "只起 1 个 reviewer 查一遍" },
  { code: "P8", name: "Deliver & Sync · 交付与回写", desc: "生成交付文档（接口测试 / 技术方案），并把本次新增的模块、领域概念、约定、踩坑回写进 project-map——让下次开发自动复用这次沉淀的认知。", light: "只回写 project-map，默认不产交付文档" },
];

function WorkflowDocs({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">feature·flow 工作流</div>
            <div className="modal-sub">后端需求端到端开发流程 · 8 阶段 + 契约校验</div>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="modal-intro">
            feature-flow 把一份 PRD 端到端跑成可交付的代码与文档。相比通用开发流程，它额外做三件事：
            <b>① 项目认知持久化</b>（project-map 随每次开发增量沉淀）、
            <b>② 8 镜头实施前拷问</b>（动手前挖净拦路问题）、
            <b>③ 结构化交付物</b>（每阶段产出落盘可追溯）。每个产出阶段末尾还有契约校验，不合格会回炉。
          </p>
          <div className="modes-box">
            <div className="modes-row">
              <span className="modes-name full">完整流程</span>
              <span className="modes-desc">跑全部 8 阶段，含并行探索/拷问/架构/质检。适合复杂、需挖拦路问题的需求。</span>
            </div>
            <div className="modes-row">
              <span className="modes-name light">轻量分支</span>
              <span className="modes-desc">范围小、已想清楚的改动：保留「看代码 → 改 → 查一遍 → 回写认知」脊柱，砍掉并行 fan-out 与重型仪式（下方各步标「轻量」）。</span>
            </div>
          </div>
          <ol className="steps">
            {WORKFLOW_STEPS.map((s) => (
              <li key={s.code} className="step">
                <div className="step-code">{s.code}</div>
                <div className="step-body">
                  <div className="step-name">{s.name}</div>
                  <div className="step-desc">{s.desc}</div>
                  <div className={"step-light" + (s.light === "跳过：主流程内联定方案" ? " skip" : "")}>
                    <span className="lt">轻量</span> {s.light}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function NewSession(props: { knownProjects: string[]; onStart: (cwd: string, initialPrompt: string, mode: "full" | "light") => void; onCancel: () => void }) {
  const [cwd, setCwd] = useState("");
  const [flowMode, setFlowMode] = useState<"full" | "light">("full");
  const [mode, setMode] = useState<"upload" | "describe">("upload");
  const [uploadPath, setUploadPath] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadNote, setUploadNote] = useState("");
  const [describe, setDescribe] = useState("");

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/upload", { method: "POST", body: fd }).then((x) => x.json());
    if (!r.ok || !r.path) { alert(r.error ?? "上传失败"); return; }
    setUploadPath(r.path);
    setUploadName(file.name);
    setUploadNote(r.note ?? "");
  }
  async function pickFolder() {
    const r = await fetch("/api/pick-folder", { method: "POST" }).then((x) => x.json());
    if (r.ok) setCwd(r.path);
    else if (!r.cancelled) alert(r.error ?? "选择失败");
  }
  function go() {
    if (!cwd.trim()) return alert("填写或选择项目根目录");
    const initialPrompt = mode === "upload" ? uploadPath : describe.trim();
    if (!initialPrompt) return alert(mode === "upload" ? "请先上传 PRD 文件" : "请填写需求描述");
    props.onStart(cwd.trim(), initialPrompt, flowMode);
  }
  return (
    <div className="newform">
      <div className="newform-card">
        <h2>新建会话</h2>
        <p className="lead">指定代码仓库根目录与本次需求，启动一条 feature-flow 流程。</p>

        <div className="fset">
          <label>项目根路径（cwd · 代码仓库所在）</label>
          <div className="path-row">
            <input className="mono" type="text" list="proj-hints"
              placeholder="/Users/you/code/contract-review" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <button className="pick-btn" onClick={pickFolder} title="打开文件夹选择器">📁 选择…</button>
          </div>
          <datalist id="proj-hints">{props.knownProjects.map((p) => <option key={p} value={p} />)}</datalist>
        </div>

        <div className="fset">
          <label>流程模式</label>
          <div className="mode-cards">
            <button className={"mode-card" + (flowMode === "full" ? " on" : "")} onClick={() => setFlowMode("full")}>
              <div className="mode-card-title">完整流程</div>
              <div className="mode-card-desc">8 阶段：并行探索 + 8 镜头拷问 + 比较架构 + 并行质检 + 交付文档。适合复杂、需挖拦路问题的需求。</div>
            </button>
            <button className={"mode-card" + (flowMode === "light" ? " on" : "")} onClick={() => setFlowMode("light")}>
              <div className="mode-card-title">轻量分支</div>
              <div className="mode-card-desc">范围小、已想清楚的改动：1 次聚焦探索 + 关键澄清 + 直接实现 + 1 次质检 + 回写认知。跳过并行与重型仪式。</div>
            </button>
          </div>
        </div>

        <div className="fset">
          <label>需求</label>
          <div className="seg">
            <button className={mode === "upload" ? "on" : ""} onClick={() => setMode("upload")}>上传 PRD 文件</button>
            <button className={mode === "describe" ? "on" : ""} onClick={() => setMode("describe")}>描述内容</button>
          </div>
          {mode === "upload" ? (
            <div className="upload-row">
              <label className="upload-btn">⇪ 选择 PRD 文件（md / txt / pdf / doc / docx）
                <input type="file" hidden onChange={upload} accept=".md,.markdown,.txt,.pdf,.doc,.docx" />
              </label>
              {uploadPath ? (
                <span className="up-ok">✓ <b className="up-name">{uploadName}</b>{uploadNote ? ` · ${uploadNote}` : ""}</span>
              ) : (
                <span className="upload-note">doc/docx 自动转文本并提取内嵌图片；pdf 直读</span>
              )}
            </div>
          ) : (
            <textarea placeholder="描述本次需求内容：目标、主流程、关键规则…" value={describe} onChange={(e) => setDescribe(e.target.value)} />
          )}
        </div>

        <div className="newform-actions">
          <button className="btn-primary" onClick={go}>启动流程 →</button>
          <button className="btn-ghost" onClick={props.onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}
