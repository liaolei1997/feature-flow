import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AskBridge, PermBridge, type AskQuestion } from "./askBridge.js";
import type { AgentDefinition } from "./agentsParser.js";

// 高风险 Bash：破坏性/不可逆命令才弹确认，工作流自身的 mv/mkdir/cp 管线与只读命令不拦
const DANGER_BASH =
  /(^|[\s;&|(])(rm|rmdir|dd|shred|mkfs\w*|sudo|chmod|chown|kill|pkill|killall|truncate)\b|>\s*\/|\bgit\s+push\b|\bgit\s+reset\s+--hard\b/i;

/** 推给前端的事件。 */
export type RunnerEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; name: string; summary: string }
  | { type: "ask"; id: string; questions: AskQuestion[] }
  | { type: "phase"; sessionDir: string }
  | { type: "result"; sdkSessionId: string | null; isError: boolean }
  | { type: "error"; message: string }
  | { type: "done" }
  // 由 server 注入（非 runner 产生），用于回显用户输入并落盘 transcript
  | { type: "user_echo"; text: string }
  | { type: "answer_echo"; id: string; labels: string[] }
  // 高风险工具权限确认
  | { type: "permission"; id: string; tool: string; command: string }
  // 权限模式变化（受控 / 全部允许），用于前端开关同步
  | { type: "perm_mode"; allowAll: boolean }
  // SDK 会话 id（首条消息即上报，供落盘 .studio——等 result 的话中途停止会丢）
  | { type: "sdk_session"; id: string }
  // 可选模型列表（SDK 真实返回）+ 当前选中值，用于前端模型选择器
  | { type: "models"; models: ModelInfo[]; current: string }
  // 模型已切换（setModel 成功后），current 为新选中的 value
  | { type: "model_changed"; model: string }
  // 用量：模型 / 上下文 token / 累计输出 token / 花费
  | { type: "usage"; model: string; contextTokens: number; outputTokens: number; costUsd: number };

/** SDK supportedModels() 返回的条目。 */
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
}

/** 可中途注入消息的异步输入队列（streaming input mode）。 */
class MessageQueue {
  private buf: any[] = [];
  private waiters: ((r: IteratorResult<any>) => void)[] = [];
  private closed = false;

  push(text: string, images?: { mediaType: string; data: string }[]): void {
    // 有图片时用 content 数组（文字块 + 图片块），否则用纯字符串
    let content: any = text;
    if (images && images.length) {
      content = [];
      if (text) content.push({ type: "text", text });
      for (const im of images) {
        content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } });
      }
    }
    const msg = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.buf.push(msg);
  }

  close(): void {
    this.closed = true;
    const w = this.waiters.shift();
    if (w) w({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<any> {
    while (true) {
      if (this.buf.length) {
        yield this.buf.shift();
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<any>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

export interface RunnerDeps {
  systemPrompt: string;
  agents: Record<string, AgentDefinition>;
  cwd: string;
  sessionDir: string;
  resumeSdkSessionId?: string | null;
  allowAll?: boolean; // 初始权限模式：true=全部允许，false=受控（默认）
  model?: string;     // 初始模型 value（来自上次选择）；不传则用 SDK 默认
  emit: (e: RunnerEvent) => void;
}

const ASK_USER_INSTRUCTION = `

---

## 本环境交互方式（覆盖默认）

你运行在 feature-flow studio 的 Web 环境。命令里提到的"**交互提问工具**"在本宿主即 MCP 工具 \`mcp__studio__ask_user\`：
- 入参：\`{ questions: [{ question, header, options: [{label, description}], multiSelect }] }\`（最多 4 个问题，每问最多 4 选项）
- 返回：用户在网页上选择的答案（以问题文本为键的对象）
所有需要向用户提问/确认/多选的地方，一律调 \`mcp__studio__ask_user\`，**不要**调 AskUserQuestion（本环境无终端 UI）。
其余工具（Read/Write/Edit/Bash/Grep/Glob/Agent 等）照常使用。
`;

export class WorkflowSession {
  private input = new MessageQueue();
  private ask = new AskBridge();
  private perm = new PermBridge();
  private bashAllowAll = false; // true=全部允许（不拦 Bash）
  private running = false;      // 会话是否开着（流式输入模式下，一轮完也保持开着等下一句）
  private generating = false;   // 是否正在生成本轮（发消息后~result 前为 true；空闲/等作答/结束为 false）
  private q: any = null;        // 当前 SDK Query 句柄，用于 setModel/supportedModels 等控制
  private selectedModel = "";   // 最近选中的模型 value（供续起时回填）
  // 用量统计
  private model = "";
  private contextTokens = 0; // 最近一轮上下文大小（input + cache）
  private cumOutput = 0;      // 累计输出 token
  private costUsd = 0;        // 累计花费（result.total_cost_usd）

  constructor(private deps: RunnerDeps) {
    this.bashAllowAll = !!deps.allowAll;
    this.selectedModel = deps.model || "";
    this.ask.onAsk = (req) => {
      this.generating = false; // 等用户作答 → 非生成中
      deps.emit({ type: "ask", id: req.id, questions: req.questions });
    };
    this.perm.onPerm = (req) => {
      this.generating = false; // 等用户决定 → 非生成中
      deps.emit({ type: "permission", id: req.id, tool: req.tool, command: req.command });
    };
  }

  /** 前端权限开关：true=全部允许，false=受控。 */
  setAllowAll(v: boolean): void {
    this.bashAllowAll = v;
    this.deps.emit({ type: "perm_mode", allowAll: v });
  }

  /** 会话中途热切换模型（下一轮生效）。model 为 supportedModels() 里的 value。 */
  async setModel(model: string): Promise<void> {
    this.selectedModel = model;
    if (this.q) {
      try {
        await this.q.setModel(model);
      } catch (e: any) {
        this.deps.emit({ type: "error", message: `切换模型失败：${e?.message ?? e}` });
        return;
      }
    }
    this.deps.emit({ type: "model_changed", model });
  }

  /** 网页用户对某个 ask_user 卡片作答。 */
  answerAsk(id: string, answers: Record<string, string[]>): void {
    this.generating = true; // 作答后 SDK 继续生成
    this.ask.resolve(id, answers);
  }

  /** 网页用户对权限确认卡的决定。 */
  resolvePerm(id: string, decision: "allow" | "deny" | "always"): void {
    this.generating = true; // 决定后 SDK 继续
    this.perm.resolve(id, decision);
  }

  /** 网页聊天框消息（中途注入会话），可带粘贴的图片。 */
  sendMessage(text: string, images?: { mediaType: string; data: string }[]): void {
    this.generating = true;
    this.input.push(text, images);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 是否正在生成本轮（true=不宜打断；false=空闲/等作答/已结束，可安全切走）。 */
  isBusy(): boolean {
    return this.generating;
  }

  stop(): void {
    this.q?.interrupt?.().catch(() => {}); // 中断当前生成，避免僵尸循环继续吐事件
    this.ask.rejectAll("会话已停止");
    this.perm.rejectAll();
    this.input.close();
  }

  /** 启动会话。initialPrompt 作为第一条 user 消息（= $ARGUMENTS / 上传的 PRD 路径 / 续聊消息），可带图片。 */
  async start(initialPrompt: string, initialImages?: { mediaType: string; data: string }[]): Promise<void> {
    this.running = true;
    this.generating = true;
    this.input.push(initialPrompt, initialImages);

    const askServer = createSdkMcpServer({
      name: "studio",
      version: "0.1.0",
      tools: [
        tool(
          "ask_user",
          "向网页用户提问并等待其在界面上作答。替代 AskUserQuestion。",
          {
            questions: z
              .array(
                z.object({
                  question: z.string(),
                  header: z.string().optional(),
                  options: z.array(
                    z.object({ label: z.string(), description: z.string().optional() })
                  ),
                  multiSelect: z.boolean().optional(),
                })
              )
              .min(1)
              .max(4),
          },
          async (args: { questions: AskQuestion[] }) => {
            const answers = await this.ask.ask(args.questions);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ answers }) }],
            };
          }
        ),
      ],
    });

    try {
      const q = query({
        prompt: this.input as AsyncIterable<any>,
        options: {
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: this.deps.systemPrompt + ASK_USER_INSTRUCTION,
          },
          agents: this.deps.agents as any,
          cwd: this.deps.cwd,
          ...(this.deps.model ? { model: this.deps.model } : {}), // 不传则用 SDK 默认；前端选择器可热切换
          // 全自动放行所有工具（studio 即在用户项目里自主跑工作流）。
          // 注意：0.3.x 起 bypassPermissions 必须配 allowDangerouslySkipPermissions:true 才生效，
          // 否则文件工具会被「directory denied by permission settings」拦死。
          // bypass 会绕过 canUseTool，所以危险 Bash 闸门 + AskUserQuestion 兜底改用 PreToolUse hook
          // 实现——hook 即便在 bypass 下也会触发，其 permissionDecision:"deny" 仍能拦截。
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          mcpServers: { studio: askServer },
          hooks: {
            PreToolUse: [
              {
                // 高风险 Bash（rm/sudo/kill…）→ 弹权限确认；其余命令放行
                matcher: "Bash",
                hooks: [
                  async (input: any) => {
                    const cmd = String(input?.tool_input?.command ?? "");
                    if (!this.bashAllowAll && DANGER_BASH.test(cmd)) {
                      const decision = await this.perm.request("Bash", cmd);
                      if (decision === "deny") {
                        return {
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse" as const,
                            permissionDecision: "deny" as const,
                            permissionDecisionReason: "用户在 studio 拒绝了该命令，请勿执行；换个安全做法或先征求用户。",
                          },
                        };
                      }
                      if (decision === "always") this.setAllowAll(true); // 同步前端开关到"全部允许"
                    }
                    return {
                      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const },
                    };
                  },
                ],
              },
              {
                // 兜底：模型若仍调内置 AskUserQuestion（headless 无 UI 会卡死），
                // 拦截并路由到同一个人在回路桥，把答案以 deny 理由文本喂回，避免挂起。
                matcher: "AskUserQuestion",
                hooks: [
                  async (input: any) => {
                    const questions: AskQuestion[] = (input?.tool_input?.questions ?? []).map((q: any) => ({
                      question: q.question,
                      header: q.header,
                      options: (q.options ?? []).map((o: any) =>
                        typeof o === "string" ? { label: o } : { label: o.label, description: o.description }
                      ),
                      multiSelect: q.multiSelect,
                    }));
                    const answers = await this.ask.ask(questions);
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse" as const,
                        permissionDecision: "deny" as const,
                        permissionDecisionReason:
                          "用户已通过 studio 界面回答（本环境用 mcp__studio__ask_user 替代 AskUserQuestion，请勿再调用它）。答案：" +
                          JSON.stringify({ answers }) +
                          "。请据此继续。",
                      },
                    };
                  },
                ],
              },
            ],
          },
          ...(this.deps.resumeSdkSessionId ? { resume: this.deps.resumeSdkSessionId } : {}),
        },
      });
      this.q = q;

      // 拉取 SDK 真实可选模型列表，填充前端选择器（与初始化并行，不阻塞消息循环）
      Promise.resolve(q.supportedModels?.())
        .then((models: ModelInfo[] | undefined) => {
          if (models?.length) {
            this.deps.emit({ type: "models", models, current: this.selectedModel || "default" });
          }
        })
        .catch(() => {});

      for await (const msg of q as AsyncIterable<any>) {
        this.handleMessage(msg);
      }
      this.deps.emit({ type: "done" });
    } catch (err: any) {
      this.deps.emit({ type: "error", message: err?.message ?? String(err) });
    } finally {
      this.running = false;
      this.generating = false;
      this.q = null;
      this.ask.rejectAll("会话结束");
    }
  }

  private lastSid = ""; // 已上报的 SDK session id（首条消息即有，别等 result——中途停止会丢）

  private handleMessage(msg: any): void {
    if (msg?.session_id && msg.session_id !== this.lastSid) {
      this.lastSid = msg.session_id;
      this.deps.emit({ type: "sdk_session", id: msg.session_id });
    }
    switch (msg?.type) {
      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            this.deps.emit({ type: "assistant_text", text: block.text });
          } else if (block.type === "tool_use") {
            this.deps.emit({
              type: "tool_use",
              name: block.name,
              summary: summarizeToolUse(block.name, block.input),
            });
          }
        }
        this.trackUsage(msg.message);
        break;
      }
      case "result": {
        this.generating = false; // 本轮生成结束（会话仍开着等下一句）
        if (typeof msg.total_cost_usd === "number") this.costUsd = msg.total_cost_usd;
        this.emitUsage();
        this.deps.emit({
          type: "result",
          sdkSessionId: msg.session_id ?? null,
          isError: msg.subtype !== "success",
        });
        break;
      }
      default:
        break;
    }
  }

  // 从 assistant 消息抽取用量：最近一轮的上下文 token（input+cache）+ 累计输出 token + 模型
  private trackUsage(message: any): void {
    if (!message) return;
    if (message.model) this.model = message.model;
    const u = message.usage;
    if (u) {
      this.contextTokens =
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this.cumOutput += u.output_tokens || 0;
    }
    this.emitUsage();
  }

  private emitUsage(): void {
    if (!this.model && !this.contextTokens) return;
    this.deps.emit({
      type: "usage",
      model: this.model,
      contextTokens: this.contextTokens,
      outputTokens: this.cumOutput,
      costUsd: this.costUsd,
    });
  }
}

function summarizeToolUse(name: string, input: any): string {
  if (name === "Bash") return `$ ${String(input?.command ?? "").slice(0, 80)}`;
  if (name === "Read" || name === "Write" || name === "Edit") return input?.file_path ?? "";
  if (name === "Grep") return `grep ${input?.pattern ?? ""}`;
  if (name === "Agent") return `subagent: ${input?.subagent_type ?? ""}`;
  return "";
}
