/**
 * 人在回路桥：MCP 的 ask_user 工具 handler 在这里挂起，等网页用户作答。
 *
 * 设计说明：feature-flow 工作流大量用 AskUserQuestion 做交互。在 SDK headless 环境，
 * 我们不依赖 AskUserQuestion 的终端 UI，而是注入一个自定义 MCP 工具 ask_user 取而代之
 * （systemPrompt 里会告知 Claude 改用它）。这样答案完全由我们的 handler 控制——确定性强，
 * 不赌 AskUserQuestion 在 headless 下的回传行为。
 */

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}
export interface AskRequest {
  id: string;
  questions: AskQuestion[];
}
/** answers: 以问题文本为键，值为被选中的 label（多选则多个）。 */
export type AskAnswers = Record<string, string[]>;

interface Pending {
  resolve: (a: AskAnswers) => void;
  reject: (e: Error) => void;
}

export class AskBridge {
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** 由 server 注入：把问题推给前端。 */
  onAsk: (req: AskRequest) => void = () => {};

  ask(questions: AskQuestion[]): Promise<AskAnswers> {
    const id = `ask-${++this.seq}`;
    return new Promise<AskAnswers>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.onAsk({ id, questions });
    });
  }

  resolve(id: string, answers: AskAnswers): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(answers);
  }

  /** 会话中断时拒绝所有挂起问题，避免泄漏。 */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }
}

/** 工具权限确认桥：高风险 Bash 命令挂起，等网页用户 approve/deny。 */
export interface PermRequest {
  id: string;
  tool: string;
  command: string;
}
export type PermDecision = "allow" | "deny" | "always";

export class PermBridge {
  private pending = new Map<string, (d: PermDecision) => void>();
  private seq = 0;
  onPerm: (req: PermRequest) => void = () => {};

  request(tool: string, command: string): Promise<PermDecision> {
    const id = `perm-${++this.seq}`;
    return new Promise<PermDecision>((resolve) => {
      this.pending.set(id, resolve);
      this.onPerm({ id, tool, command });
    });
  }

  resolve(id: string, decision: PermDecision): void {
    const r = this.pending.get(id);
    if (!r) return;
    this.pending.delete(id);
    r(decision);
  }

  /** 会话中断：挂起的一律按 deny 放行 promise，避免泄漏。 */
  rejectAll(): void {
    for (const [, r] of this.pending) r("deny");
    this.pending.clear();
  }
}
