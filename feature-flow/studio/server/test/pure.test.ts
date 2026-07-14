import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSystemPrompt } from "../src/promptAssembler.js";
import { parseAgentMd } from "../src/agentsParser.js";

test("assembleSystemPrompt 替换所有 ${CLAUDE_PLUGIN_ROOT}", () => {
  const md = "a ${CLAUDE_PLUGIN_ROOT}/x b ${CLAUDE_PLUGIN_ROOT}/y";
  const out = assembleSystemPrompt(md, "/root");
  assert.equal(out, "a /root/x b /root/y");
  assert.ok(!out.includes("${CLAUDE_PLUGIN_ROOT}"));
});

test("assembleSystemPrompt 无变量时原样返回", () => {
  assert.equal(assembleSystemPrompt("hello", "/root"), "hello");
});

test("parseAgentMd 解析完整 frontmatter", () => {
  const md = `---
name: code-explorer
description: traces code
tools: Glob, Grep, Read
model: sonnet
color: yellow
---

You are an analyst.
Second line.`;
  const { name, def } = parseAgentMd(md);
  assert.equal(name, "code-explorer");
  assert.equal(def.description, "traces code");
  assert.deepEqual(def.tools, ["Glob", "Grep", "Read"]);
  assert.equal(def.model, "sonnet");
  assert.equal(def.prompt, "You are an analyst.\nSecond line.");
});

test("parseAgentMd 无 tools/model 时省略", () => {
  const md = `---
name: verifier
description: checks contracts
---

body`;
  const { def } = parseAgentMd(md);
  assert.equal(def.tools, undefined);
  assert.equal(def.model, undefined);
});

test("parseAgentMd 缺 frontmatter 抛错", () => {
  assert.throws(() => parseAgentMd("no frontmatter here"));
});

test("parseAgentMd 缺 name 抛错", () => {
  const md = `---
description: x
---
body`;
  assert.throws(() => parseAgentMd(md));
});

test("parseAgentMd 忽略非法 model", () => {
  const md = `---
name: a
description: b
model: gpt-4
---
body`;
  const { def } = parseAgentMd(md);
  assert.equal(def.model, undefined);
});
