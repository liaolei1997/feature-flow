import { homedir } from "node:os";
import { join } from "node:path";

// studio/server/src/config.ts -> 上溯到插件根 ~/plugins/feature-flow
export const PLUGIN_ROOT = join(import.meta.dirname, "..", "..", "..");

export const DATA_ROOT = join(PLUGIN_ROOT, "data", "projects");
export const REFS_ROOT = join(PLUGIN_ROOT, "references");
export const COMMANDS_FILE = join(PLUGIN_ROOT, "commands", "feature-flow.md");
export const OWN_AGENTS_DIR = join(PLUGIN_ROOT, "agents");

// feature-dev 插件缓存目录（agents 零件来源）。优先用 unknown，缺失再 fallback 到 commit 目录。
const CLAUDE_PLUGINS_CACHE = join(homedir(), ".claude", "plugins", "cache");
export const FEATURE_DEV_AGENT_DIRS = [
  join(CLAUDE_PLUGINS_CACHE, "claude-plugins-official", "feature-dev", "unknown", "agents"),
  join(CLAUDE_PLUGINS_CACHE, "claude-plugins-official", "feature-dev", "3d368d2972d9", "agents"),
];

export const TMP_UPLOAD_DIR = join(PLUGIN_ROOT, "studio", ".uploads");

export const PORT = Number(process.env.STUDIO_PORT ?? 4317);
