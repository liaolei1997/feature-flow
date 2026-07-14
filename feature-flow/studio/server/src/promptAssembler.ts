import { readFileSync } from "node:fs";

/**
 * 把 feature-flow command md 组装成可注入 SDK 的 systemPrompt。
 * 唯一变换：将 ${CLAUDE_PLUGIN_ROOT} 字面量替换为插件根绝对路径。
 * 纯函数，便于单测。
 */
export function assembleSystemPrompt(commandMd: string, pluginRoot: string): string {
  return commandMd.split("${CLAUDE_PLUGIN_ROOT}").join(pluginRoot);
}

export function loadSystemPrompt(commandsFile: string, pluginRoot: string): string {
  const md = readFileSync(commandsFile, "utf8");
  return assembleSystemPrompt(md, pluginRoot);
}
