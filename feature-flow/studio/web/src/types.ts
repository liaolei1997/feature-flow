export interface SessionMeta {
  projectId: string;
  sessionId: string;
  dir: string;
  currentPhase: string | null;
  phaseStatus: string | null;
  lastUpdated: string | null;
  sdkSessionId: string | null;
  mode: string | null;
  hasTranscript: boolean;
  artifacts: string[];
}
export interface ProjectMeta {
  projectId: string;
  dir: string;
  hasMap: boolean;
  sessions: SessionMeta[];
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
}

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

export type ChatItem =
  | { kind: "assistant"; text: string }
  | { kind: "user"; text: string; images?: string[] }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "ask"; id: string; questions: AskQuestion[]; answered?: boolean }
  | { kind: "permission"; id: string; tool: string; command: string; decision?: "allow" | "deny" | "always" }
  | { kind: "system"; text: string };
