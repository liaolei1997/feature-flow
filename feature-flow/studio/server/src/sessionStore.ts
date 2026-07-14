import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DATA_ROOT } from "./config.js";

/** Claude Code 原生会话目录：cwd 中非字母数字字符全替成 -（与 CC 命名一致）。 */
function ccProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}
function ccTranscriptPath(cwd: string, sid: string): string {
  return join(ccProjectDir(cwd), sid + ".jsonl");
}
function summarizeNativeTool(name: string, input: any): string {
  if (name === "Bash") return `$ ${String(input?.command ?? "").slice(0, 80)}`;
  if (name === "Read" || name === "Write" || name === "Edit") return input?.file_path ?? "";
  if (name === "Grep") return `grep ${input?.pattern ?? ""}`;
  if (name === "Glob") return input?.pattern ?? "";
  if (name === "Task" || name === "Agent") return `subagent: ${input?.subagent_type ?? ""}`;
  return "";
}

/** 解析 Claude Code 原生 jsonl → studio ChatItem 形状（用于展示终端跑的会话）。 */
export function readNativeTranscript(cwd: string, sid: string): unknown[] {
  const path = ccTranscriptPath(cwd, sid);
  if (!existsSync(path)) return [];
  const out: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "assistant") {
      for (const b of j.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) out.push({ kind: "assistant", text: b.text });
        else if (b.type === "tool_use") out.push({ kind: "tool", name: b.name, summary: summarizeNativeTool(b.name, b.input) });
      }
    } else if (j.type === "user") {
      const c = j.message?.content;
      if (typeof c === "string") {
        if (c.trim()) out.push({ kind: "user", text: c });
      } else if (Array.isArray(c)) {
        // tool_result 是工具输出而非用户输入，跳过；只取真正的用户 text / 图片
        if (c.some((b: any) => b.type === "tool_result")) continue;
        const texts = c.filter((b: any) => b.type === "text").map((b: any) => b.text).filter(Boolean);
        const nImg = c.filter((b: any) => b.type === "image").length;
        if (texts.length || nImg) out.push({ kind: "user", text: texts.join("\n") + (nImg ? `  [图片 ${nImg} 张]` : "") });
      }
    }
    // summary / system / file-history-snapshot 等忽略
  }
  return out;
}

export interface SessionMeta {
  projectId: string;
  sessionId: string;
  dir: string;
  currentPhase: string | null;
  phaseStatus: string | null;
  lastUpdated: string | null;
  sdkSessionId: string | null; // 来自 .studio
  mode: string | null; // full | light（来自 .state）
  hasTranscript: boolean; // 是否有 studio 对话记录
  artifacts: string[]; // session 目录下可查看的产物文件名（md / html / json / csv 等）
}

export const TRANSCRIPT_FILE = ".studio-chat.jsonl";

export interface ProjectMeta {
  projectId: string;
  dir: string;
  hasMap: boolean;
  sessions: SessionMeta[];
}

const ARTIFACT_ORDER = [
  "requirement.md",
  "brief.md",
  "code-facts.md",
  "prd-check.md",
  "tech-design.md",
  "api-test.md",
  "review-doc.md",
];

// 可在 studio 里查看的产物后缀（文本类，可渲染/可读）
const ARTIFACT_EXT = /\.(md|markdown|html?|json|csv|txt|svg|xml|ya?ml)$/i;

/** 极简 .state YAML 取值（只取顶层 key: value，够用即可，不引 yaml 依赖）。 */
function readStateField(stateText: string, key: string): string | null {
  const m = stateText.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : null;
}

function sortArtifacts(names: string[]): string[] {
  return names.sort((a, b) => {
    const ia = ARTIFACT_ORDER.indexOf(a);
    const ib = ARTIFACT_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function readSession(projectId: string, sessionId: string, dir: string): SessionMeta {
  const statePath = join(dir, ".state");
  let currentPhase: string | null = null;
  let phaseStatus: string | null = null;
  let lastUpdated: string | null = null;
  let mode: string | null = null;
  if (existsSync(statePath)) {
    const text = readFileSync(statePath, "utf8");
    currentPhase = readStateField(text, "current_phase");
    phaseStatus = readStateField(text, "phase_status");
    lastUpdated = readStateField(text, "last_updated");
    mode = readStateField(text, "mode");
  }

  let sdkSessionId: string | null = null;
  let cwd: string | null = null;
  const studioPath = join(dir, ".studio");
  if (existsSync(studioPath)) {
    const t = readFileSync(studioPath, "utf8");
    sdkSessionId = readStateField(t, "sdk_session_id");
    cwd = readStateField(t, "cwd");
  }

  // 收集可查看的产物：工作流 .md + 用户额外生成的 html/json/csv/txt/svg 等。
  // 排除内部点文件（.state/.studio）、transcript、二进制。
  const artifacts = sortArtifacts(
    readdirSync(dir).filter((f) => !f.startsWith(".") && ARTIFACT_EXT.test(f))
  );
  // 有 studio 自己的对话记录，或能定位到 CC 原生 transcript（终端跑的会话），都算"有对话"
  const hasTranscript =
    existsSync(join(dir, TRANSCRIPT_FILE)) ||
    !!(cwd && sdkSessionId && existsSync(ccTranscriptPath(cwd, sdkSessionId)));

  return { projectId, sessionId, dir, currentPhase, phaseStatus, lastUpdated, sdkSessionId, mode, hasTranscript, artifacts };
}

export function listProjects(): ProjectMeta[] {
  if (!existsSync(DATA_ROOT)) return [];
  const projects: ProjectMeta[] = [];

  for (const projectId of readdirSync(DATA_ROOT)) {
    const projectDir = join(DATA_ROOT, projectId);
    if (!statSync(projectDir).isDirectory()) continue;

    const sessionsDir = join(projectDir, "sessions");
    const sessions: SessionMeta[] = [];
    if (existsSync(sessionsDir)) {
      for (const sessionId of readdirSync(sessionsDir)) {
        const sdir = join(sessionsDir, sessionId);
        if (!statSync(sdir).isDirectory()) continue;
        sessions.push(readSession(projectId, sessionId, sdir));
      }
    }
    // 最近更新的在前
    sessions.sort((a, b) => (b.lastUpdated ?? b.sessionId).localeCompare(a.lastUpdated ?? a.sessionId));

    projects.push({
      projectId,
      dir: projectDir,
      hasMap: existsSync(join(projectDir, "project-map.md")),
      sessions,
    });
  }

  return projects.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/** 解析单个 artifact 的绝对路径（限定在 data 目录内，防目录穿越）。 */
export function resolveArtifactPath(projectId: string, sessionId: string, name: string): string {
  const safeP = projectId.replace(/[^A-Za-z0-9._-]/g, "");
  const safeS = sessionId.replace(/[^A-Za-z0-9._-]/g, "");
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "");
  const path = join(DATA_ROOT, safeP, "sessions", safeS, safe);
  if (!path.startsWith(DATA_ROOT)) throw new Error("非法路径");
  return path;
}

/** 读取单个 artifact 文件内容（限定在 data 目录内，防目录穿越）。 */
export function readArtifact(projectId: string, sessionId: string, name: string): string {
  return readFileSync(resolveArtifactPath(projectId, sessionId, name), "utf8");
}

/** 读 session 的 .studio 元信息（cwd + sdk_session_id），供续聊 resume。 */
export function readStudioMeta(projectId: string, sessionId: string): { cwd: string | null; sdkSessionId: string | null } {
  const safeP = projectId.replace(/[^A-Za-z0-9._-]/g, "");
  const safeS = sessionId.replace(/[^A-Za-z0-9._-]/g, "");
  const path = join(DATA_ROOT, safeP, "sessions", safeS, ".studio");
  if (!path.startsWith(DATA_ROOT) || !existsSync(path)) return { cwd: null, sdkSessionId: null };
  const text = readFileSync(path, "utf8");
  const cwd = (text.match(/^cwd:\s*(.+)$/m)?.[1] ?? "").trim() || null;
  const sdkSessionId = (text.match(/^sdk_session_id:\s*(.+)$/m)?.[1] ?? "").trim() || null;
  return { cwd, sdkSessionId };
}

/** 读对话记录：优先 studio 自己的 .studio-chat.jsonl；没有则回落到 CC 原生 transcript（终端跑的会话）。 */
export function readTranscript(projectId: string, sessionId: string): unknown[] {
  const safeP = projectId.replace(/[^A-Za-z0-9._-]/g, "");
  const safeS = sessionId.replace(/[^A-Za-z0-9._-]/g, "");
  const path = join(DATA_ROOT, safeP, "sessions", safeS, TRANSCRIPT_FILE);
  if (!path.startsWith(DATA_ROOT) || !existsSync(path)) {
    // 回落：终端跑的会话没有 studio 对话记录，但 .studio 记了 cwd+id → 读 CC 原生 jsonl
    const meta = readStudioMeta(projectId, sessionId);
    if (meta.cwd && meta.sdkSessionId) return readNativeTranscript(meta.cwd, meta.sdkSessionId);
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readProjectMap(projectId: string): string {
  const path = join(DATA_ROOT, projectId, "project-map.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** 从该项目最近一条记录了 cwd 的 session（.studio）推断代码根；推不出返回 null。 */
export function latestProjectCwd(projectId: string): string | null {
  const sdir = join(DATA_ROOT, projectId.replace(/[^A-Za-z0-9._-]/g, ""), "sessions");
  if (!sdir.startsWith(DATA_ROOT) || !existsSync(sdir)) return null;
  let best: { cwd: string; mtime: number } | null = null;
  for (const s of readdirSync(sdir)) {
    const studio = join(sdir, s, ".studio");
    if (!existsSync(studio)) continue;
    const cwd = readStateField(readFileSync(studio, "utf8"), "cwd");
    if (!cwd) continue;
    const mtime = statSync(studio).mtimeMs;
    if (!best || mtime > best.mtime) best = { cwd, mtime };
  }
  return best?.cwd ?? null;
}

export function deleteSession(projectId: string, sessionId: string): void {
  const safeP = projectId.replace(/[^A-Za-z0-9._-]/g, "");
  const safeS = sessionId.replace(/[^A-Za-z0-9._-]/g, "");
  const path = join(DATA_ROOT, safeP, "sessions", safeS);
  if (!path.startsWith(DATA_ROOT) || path === DATA_ROOT) throw new Error("非法路径");
  rmSync(path, { recursive: true, force: true });
}

/** 把新名清洗成文件系统安全的目录名（保留中英文/数字/-_.），返回空则非法。 */
export function sanitizeSessionName(raw: string): string {
  return raw
    .replace(/[\/\\]/g, "")     // 去路径分隔符
    .replace(/\.\./g, "")        // 去上跳
    .replace(/^\.+/, "")         // 去前导点（避免隐藏目录）
    .replace(/\s+/g, "-")        // 空白转连字符
    .trim();
}

/** 重命名 session 目录，并同步 .state 里的 session_id。返回新 sessionId。 */
export function renameSession(projectId: string, sessionId: string, newName: string): string {
  const safeP = projectId.replace(/[^A-Za-z0-9._-]/g, "");
  const safeOld = sessionId.replace(/[^A-Za-z0-9._-]/g, "");
  const safeNew = sanitizeSessionName(newName);
  if (!safeNew) throw new Error("新名称为空或非法");

  const sessionsDir = join(DATA_ROOT, safeP, "sessions");
  const oldPath = join(sessionsDir, safeOld);
  const newPath = join(sessionsDir, safeNew);
  if (!oldPath.startsWith(sessionsDir) || !newPath.startsWith(sessionsDir)) throw new Error("非法路径");
  if (!existsSync(oldPath)) throw new Error("源会话不存在");
  if (existsSync(newPath)) throw new Error("同名会话已存在");

  renameSync(oldPath, newPath);

  // 同步 .state 的 session_id
  const statePath = join(newPath, ".state");
  if (existsSync(statePath)) {
    const text = readFileSync(statePath, "utf8");
    const updated = text.replace(/^session_id:.*$/m, `session_id: ${safeNew}`);
    writeFileSync(statePath, updated, "utf8");
  }
  return safeNew;
}
