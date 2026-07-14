import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit";
}

interface ParsedAgent {
  name: string;
  def: AgentDefinition;
}

const MODEL_WHITELIST = new Set(["sonnet", "opus", "haiku", "inherit"]);

/**
 * 解析单个 agent md（YAML frontmatter + 正文）为 {name, AgentDefinition}。
 * frontmatter 字段：name, description, tools(逗号分隔), model。正文即 prompt。
 * 纯函数，便于单测。
 */
export function parseAgentMd(md: string): ParsedAgent {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error("agent md 缺少 frontmatter");
  const [, fm, body] = m;

  const fields: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }

  if (!fields.name) throw new Error("agent frontmatter 缺少 name");
  if (!fields.description) throw new Error(`agent ${fields.name} 缺少 description`);

  const def: AgentDefinition = {
    description: fields.description,
    prompt: body.trim(),
  };
  if (fields.tools) {
    def.tools = fields.tools.split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (fields.model && MODEL_WHITELIST.has(fields.model)) {
    def.model = fields.model as AgentDefinition["model"];
  }

  return { name: fields.name, def };
}

/** 读一个目录下所有 *.md，解析成 agent 映射。 */
export function loadAgentsFromDir(dir: string): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const { name, def } = parseAgentMd(readFileSync(join(dir, file), "utf8"));
    out[name] = def;
  }
  return out;
}

/**
 * 组装全部 subagent：本插件 agents/ + feature-dev 缓存 agents/。
 * feature-dev 目录全部缺失则 fail fast（违反"失败即停"）。
 */
export function loadAllAgents(
  ownAgentsDir: string,
  featureDevDirs: string[]
): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  // feature-dev 目录仅作可选补充（本机装了就用），缺失不报错——本插件已自带全部所需 agent。
  const fdDir = featureDevDirs.find((d) => existsSync(d));
  if (fdDir) Object.assign(agents, loadAgentsFromDir(fdDir));

  // 自带 agents 覆盖在最上层：零依赖 + own 版本优先（不被 feature-dev 覆盖）。
  if (existsSync(ownAgentsDir)) Object.assign(agents, loadAgentsFromDir(ownAgentsDir));

  return agents;
}
