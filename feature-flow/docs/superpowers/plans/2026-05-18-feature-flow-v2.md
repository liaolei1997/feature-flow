# /feature-flow v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/feature-flow` 从 wrapper `feature-dev:feature-dev` 重写成独立编排器，方法论通过 verifier subagent 校验，覆盖 P0-P8 共 8 个 phase 的端到端流程。

**Architecture:** 主 Claude 直接编排 8 phase；每个产出 phase 末调用通用 `prd-check-verifier` subagent 对照 `verifier-contracts.md` 做契约校验；feature-dev 的 `code-explorer` / `code-architect` / `code-reviewer` 仍作为零件被 `Agent(subagent_type=...)` 调用。

**Tech Stack:** Claude Code 插件框架（`commands/*.md`、`agents/*.md`、`references/*.md`、`.claude-plugin/plugin.json`）；`Agent` / `Read` / `Write` / `Edit` / `Bash` / `Grep` / `AskUserQuestion` 工具。

**Spec Reference:** `docs/superpowers/specs/2026-05-18-feature-flow-v2-design.md`

**Git 说明：** 当前 `/Users/liaolei/plugins/feature-flow/` 不是 git 仓库（owner 决定 v2 跑稳后再 init）。本计划每个任务末尾的 "Checkpoint" 步只做"`ls -la` 确认产出存在 + 记一个里程碑"，不出 git 命令。每个 task 都附了未来 `git init` 后该跑的 commit 模板，注释起来即可激活。

---

## Phase 0：Foundation — verifier 基础设施

verifier 与契约文件先于一切。后面任何 phase 实现都需要"先有契约才能验"。

### Task 1：创建 `references/verifier-contracts.md`

**Files:**
- Create: `/Users/liaolei/plugins/feature-flow/references/verifier-contracts.md`

**Background:** verifier subagent 是数据驱动的，所有契约规则集中在这一文件。每个产出 phase 一个小节，含必含章节、必含模式、禁止模式、计数下限。grep-friendly。

- [ ] **Step 1: 写完整契约文件**

Create `/Users/liaolei/plugins/feature-flow/references/verifier-contracts.md`：

```markdown
# /feature-flow Verifier Contracts

> 各 phase artifact 必须满足的契约。`prd-check-verifier` subagent 读本文件 + 读 artifact + 返回结构化 JSON。
>
> 规则类型：
> - **必含章节（required_sections）**：grep 字面匹配 markdown 标题
> - **必含模式（required_patterns）**：正则匹配 + 出现次数下限
> - **禁止模式（forbidden_patterns）**：正则匹配 + 必须 0 命中
> - **空节检测**：标题下到下个标题之间内容长度

---

## P0.5 / project-map.md

- **artifact**: `${PROJECT_DIR}/project-map.md`
- **required_sections (≥6 of 8 must exist)**:
  - `## 一、项目概述`
  - `## 二、技术栈与运行`
  - `## 三、模块地图`
  - `## 四、核心领域概念`
  - `## 五、关键约定`
  - `## 六、非显而易见之处`
  - `## 七、外部依赖与边界`
  - `## 八、最近变更`
- **forbidden_patterns**:
  - `<填>` / `<待补>` / `TBD` / `XXX`
- **size_limit**: 总行数 ≤ 250（骨架级）

---

## P1 / requirement.md

- **artifact**: `${SESSION_DIR}/requirement.md`
- **min_length**: 20 字符
- **forbidden_patterns**: 空文件 / 仅空白

---

## P2 / code-facts.md

- **artifact**: `${SESSION_DIR}/code-facts.md`
- **required_sections**:
  - `## PRD 假设验证摘要`
  - `## 代码事实清单`
- **required_patterns**:
  - `[\w/\.\-]+\.(py|ts|tsx|js|jsx|sql|go|java|rs|md):\d+` ≥ 3 次（具名实体的 file:line 引用）
- **forbidden_patterns**:
  - `<待定>` / `TBD` / `不确定`

---

## P3 / prd-check.md

- **artifact**: `${SESSION_DIR}/prd-check.md`
- **required_sections**:
  - `## 待解决问题清单` （内含至少一个 P0/P1/P2 三级小节）
  - `### P0 - 逻辑与设计`
  - `### P1 - 边界/异常/限制`
  - `### P2 - 旧数据兼容`
  - `## 工程选型线索`
  - `## 7 镜头记录`
- **required_subsections under "## 7 镜头记录"（必须 7 个）**:
  - `### 1. 逻辑完整性`
  - `### 2. 用户操作路径`
  - `### 3. 边界条件`
  - `### 4. 限制与配额`
  - `### 5. 异常与错误处理`
  - `### 6. 新数据结构`
  - `### 7. 旧数据迁移`
- **per_question_required**（在「待解决问题清单」每一个编号问题块内必含 4 行）：
  - 三元标签：正则 `\[P[012]\]\[PRD-TBD\]\[[^\]]+\]`
  - `依据：` 起首行
  - `候选答案：` 起首行
  - `\*\*答\*\*` 起首行（用户已答的标记）
- **forbidden_patterns**:
  - `可能需要进一步确认`
  - `建议团队评估`
  - `\[DEV-DECIDE\]`（v2 砍掉，工程选型归 P4）
  - `待补` / `TBD`

---

## P5 / tech-design.md

- **artifact**: `${SESSION_DIR}/tech-design.md`
- **required_sections**:
  - `## 1. 目标一句话`
  - `## 2. 核心设计决策`
  - `## 3. 变更清单`
- **non_empty_sections**:
  - `## 2. 核心设计决策`：节内 ≥ 30 字符
  - `## 3. 变更清单`：节内含至少 1 个 `[\w/\.\-]+\.(py|ts|tsx|js|sql|go|java|md)` 文件路径
- **forbidden_patterns**:
  - `TBD` / `待定` / `看情况`

---

## P8 / api-test.md（可选产出，存在则校验）

- **artifact**: `${SESSION_DIR}/api-test.md`
- **required_sections**:
  - `## 接口列表`
- **per_interface_required**（每个 `### \d+\. ` 编号接口块内必含）：
  - `\*\*字段\*\*` 或 `\*\*Body\*\*` 表
  - `\*\*错误码\*\*` 表
  - `\*\*测试用例\*\*` 表
  - ` ```bash` 或 ` ```shell` curl 块
- **forbidden_patterns**:
  - `TBD` 在已写接口块内
```

- [ ] **Step 2: 验证文件落地**

Run:
```bash
ls -la /Users/liaolei/plugins/feature-flow/references/verifier-contracts.md
wc -l /Users/liaolei/plugins/feature-flow/references/verifier-contracts.md
```
Expected: 文件存在，约 100-150 行。

- [ ] **Step 3: 语义自检**

Run:
```bash
grep -nE "^##|^###" /Users/liaolei/plugins/feature-flow/references/verifier-contracts.md
```
Expected: 至少看到 P0.5 / P1 / P2 / P3 / P5 / P8 六个二级小节。

- [ ] **Step 4: Checkpoint**

```bash
ls -la /Users/liaolei/plugins/feature-flow/references/
# git template (未启用)：
# git add references/verifier-contracts.md
# git commit -m "feat(feature-flow): add verifier contracts for all output phases"
```

---

### Task 2：创建 `agents/prd-check-verifier.md`

**Files:**
- Create: `/Users/liaolei/plugins/feature-flow/agents/prd-check-verifier.md`

**Background:** 通用 verifier subagent，phase 参数化。读 contracts 文件 + 读 artifact + 返回 JSON。不修改文件、不与用户对话。

- [ ] **Step 1: 创建 agents 目录（如果不存在）**

Run:
```bash
mkdir -p /Users/liaolei/plugins/feature-flow/agents
```

- [ ] **Step 2: 写 verifier subagent 定义文件**

Create `/Users/liaolei/plugins/feature-flow/agents/prd-check-verifier.md`：

```markdown
---
name: prd-check-verifier
description: 校验 /feature-flow 各 phase 产出文件是否符合契约。被主命令 /feature-flow 调用，不应被用户直接触发。
tools: Read, Grep, Glob, Bash
---

# 角色

你是 /feature-flow 的产出契约校验员。你的唯一职责：

1. 读入一个 phase 标识 + session 目录 + contracts 文件路径
2. 在 contracts 文件中找到对应 phase 的契约
3. 检查 artifact 是否满足契约
4. 返回一个结构化 JSON 判定

# 不要做的事

- 不修改任何文件
- 不与用户对话
- 不询问澄清问题
- 不输出 JSON 之外的任何文本

# 输入约定

主命令会以 prompt 形式传入：

```
phase: P3
session_dir: /Users/liaolei/plugins/feature-flow/data/projects/contract-review/sessions/2026-05-18-foo
contracts_file: /Users/liaolei/plugins/feature-flow/references/verifier-contracts.md
```

# 执行步骤

1. `Read` contracts_file，定位 `## P{phase}` 小节，提取该 phase 的：artifact 路径模板、required_sections、required_patterns、required_subsections、per_question_required / per_interface_required、forbidden_patterns、min_length、size_limit、non_empty_sections（适用的字段）
2. 将 artifact 路径中的 `${SESSION_DIR}` / `${PROJECT_DIR}` 替换为输入中的具体路径
3. `Read` artifact 文件；不存在则 `pass=false, missing=["artifact_file"]`
4. 对照每一类规则做检查：
   - **required_sections**：用 `Grep -n` 在 artifact 中匹配字面字符串；找不到的加入 missing
   - **required_subsections**：同上
   - **required_patterns**：用 `Grep -E -c` 数命中次数；不足下限的加入 missing（标注实际/期望）
   - **per_question_required** / **per_interface_required**：用 `Bash` + `awk` / `grep` 按 `^### \d+\.` 切块，逐块检查 4 项规则；缺项的加入 missing（标注块号）
   - **forbidden_patterns**：用 `Grep -nE`；任何命中加入 violations（含行号 + 命中字符串）
   - **min_length**：`wc -c` 检查；不足的加入 missing
   - **size_limit**：`wc -l` 检查；超出的加入 violations
   - **non_empty_sections**：`awk` 提取节内容，按字符数检查；空节加入 missing
5. 整理 suggest：基于 missing/violations，给一句话修复方向（如 "补全 P0 节缺失的 2 个三级小节" 或 "替换 line 42 的「可能需要」改成具体方案"）
6. 输出且只输出 JSON：

```json
{
  "phase": "P3",
  "artifact_path": "/.../prd-check.md",
  "pass": false,
  "missing": ["### P0 - 逻辑与设计", "per_question_required.依据 in block #2"],
  "violations": [{"pattern": "[DEV-DECIDE]", "line": 42, "text": "..."}],
  "suggest": "P3 prd-check.md 缺 P0 小节；block#2 缺依据行；line 42 含已弃用 DEV-DECIDE 标签需移除"
}
```

# 输出格式严格要求

- 整个回复必须**只有**一个 JSON 对象
- 不加 markdown 代码栅、不加前言、不加结语、不加解释
- JSON 必须可直接 `json.loads` 解析

# 边界

如果 contracts 文件中找不到该 phase 的小节，返回：
```json
{"phase": "Px", "pass": false, "missing": ["no contract defined for phase"], "violations": [], "suggest": "verifier-contracts.md 中无该 phase 契约定义"}
```
```

- [ ] **Step 3: 验证文件落地**

Run:
```bash
ls -la /Users/liaolei/plugins/feature-flow/agents/prd-check-verifier.md
head -5 /Users/liaolei/plugins/feature-flow/agents/prd-check-verifier.md
```
Expected: 文件存在，前 5 行为 YAML frontmatter（含 `name:`、`description:`、`tools:`）。

- [ ] **Step 4: Checkpoint**

```bash
ls /Users/liaolei/plugins/feature-flow/agents/
# git template (未启用)：
# git add agents/prd-check-verifier.md
# git commit -m "feat(feature-flow): add prd-check-verifier subagent"
```

---

### Task 3：用现有 5 个 session 跑 verifier 做回归基线

**Files:**
- 只读：`/Users/liaolei/plugins/feature-flow/data/projects/contract-review/sessions/*/prd-check.md`
- Create: `/Users/liaolei/plugins/feature-flow/docs/superpowers/plans/task-3-verifier-baseline.md`（记录基线结果）

**Background:** 现有 5 个 session 用的是 v1 方法论（可能有 DEV-DECIDE / 缺 7 镜头全节）。新契约严格，期望 1-2 个通过、3-4 个被拦。这是 verifier 校准的依据。**这一步必须本人在 Claude Code 中触发 verifier subagent 完成。**

- [ ] **Step 1: 列出全部 5 个 session 的 prd-check.md 路径**

Run:
```bash
ls -1 /Users/liaolei/plugins/feature-flow/data/projects/contract-review/sessions/*/prd-check.md
```
Expected: 5 行路径输出（如有缺 prd-check.md 的 session 跳过）。

- [ ] **Step 2: 对每个 prd-check.md 跑 verifier**

对每个 session 路径，调用：

```
Agent(
  subagent_type="prd-check-verifier",
  prompt='''
phase: P3
session_dir: <该 session 目录绝对路径>
contracts_file: /Users/liaolei/plugins/feature-flow/references/verifier-contracts.md
'''
)
```

收集每次返回的 JSON。

- [ ] **Step 3: 写回归报告**

Create `/Users/liaolei/plugins/feature-flow/docs/superpowers/plans/task-3-verifier-baseline.md`：

按以下结构记录：

```markdown
# Verifier 回归基线 — 2026-05-18

对 5 个历史 session 跑 P3 prd-check.md 契约校验，作为 verifier 调优依据。

## 结果汇总

| session | pass | missing 数 | violations 数 | suggest 摘要 |
|---|---|---|---|---|
| 2026-04-24-card-position-logic-opt | ?  | ? | ? | ... |
| 2026-05-06-rule-verification | ?  | ? | ? | ... |
| 2026-05-12-user-checklist-default-recommend | ? | ? | ? | ... |
| 2026-05-13-editorial-export-four-files | ? | ? | ? | ... |
| <第 5 个 session> | ? | ? | ? | ... |

## 详细 JSON
（粘贴每个的 verifier 返回 JSON）

## 调优结论
- 契约是否过严 / 过松
- 是否需要回头改 `verifier-contracts.md`
```

- [ ] **Step 4: 决策 — 是否需要调契约**

根据回归报告，若：
- **全部 5 个被拦**：契约过严，回 Task 1 放宽 1-2 条规则（如把 7 镜头小节"必须 7 个"改成"≥5 个"）
- **全部 5 个通过**：契约过松，回 Task 1 加严
- **2-4 个通过**：契约松紧合适，继续

若需回炉，跑完调整后回 Step 2 重测。

- [ ] **Step 5: Checkpoint**

```bash
ls /Users/liaolei/plugins/feature-flow/docs/superpowers/plans/task-3-verifier-baseline.md
# git template (未启用)：
# git add docs/superpowers/plans/task-3-verifier-baseline.md references/verifier-contracts.md
# git commit -m "test(feature-flow): regression baseline against 5 historical sessions"
```

---

## Phase 1：v1 备份

### Task 4：备份 v1 命令

**Files:**
- Rename: `commands/feature-flow.md` → `commands/feature-flow.legacy.md`

**Background:** v1 命令保留 2 周作为回退窗口，文件名加 `.legacy` 后插件框架不再当成可触发命令（slash command 不识别 `.legacy.md`）。

- [ ] **Step 1: 改名**

Run:
```bash
mv /Users/liaolei/plugins/feature-flow/commands/feature-flow.md \
   /Users/liaolei/plugins/feature-flow/commands/feature-flow.legacy.md
```

- [ ] **Step 2: 验证**

Run:
```bash
ls /Users/liaolei/plugins/feature-flow/commands/
```
Expected: 只看到 `feature-flow.legacy.md`，不再有 `feature-flow.md`。

- [ ] **Step 3: 在 legacy 文件顶部加备注**

Run `Edit` on `/Users/liaolei/plugins/feature-flow/commands/feature-flow.legacy.md`：

old_string:
```
---
description: 后端需求端到端开发流程，基于 /feature-dev 加三样：项目认知持久化、拷问规范注入 Phase 3、结构化交付物。
```

new_string:
```
<!--
DEPRECATED — v1 wrapper. v2 重写已上线，本文件保留 2 周供回退（计划删除：2026-06-01）。
如需临时使用 v1，改名回 feature-flow.md 即可。
-->
---
description: [DEPRECATED v1] 后端需求端到端开发流程，基于 /feature-dev 加三样：项目认知持久化、拷问规范注入 Phase 3、结构化交付物。
```

- [ ] **Step 4: Checkpoint**

```bash
ls /Users/liaolei/plugins/feature-flow/commands/
head -10 /Users/liaolei/plugins/feature-flow/commands/feature-flow.legacy.md
# git template (未启用)：
# git mv commands/feature-flow.md commands/feature-flow.legacy.md
# git commit -m "chore(feature-flow): rename v1 to legacy ahead of v2 rewrite"
```

---

## Phase 2：v2 命令编排器（增量构建）

每个 task 增量往 `commands/feature-flow.md` 加一个 phase 小节。每个 phase 加完做最小语义自检（grep 关键 anchors 在）。完整 end-to-end 验证留到 Task 17。

### Task 5：v2 命令骨架 + 常量 + Resume 检测 + P0 Context Load

**Files:**
- Create: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`

**Background:** 命令文件顶部含：frontmatter / 简介 / 常量 / 工具清单 / Resume 流程 / P0 phase。Resume 必须在 P0 之前——如果有未完成 session，要先问"接着继续还是新开"。

- [ ] **Step 1: 写骨架 + 常量 + Resume + P0**

Create `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`：

```markdown
---
description: 后端需求端到端开发流程 v2，独立编排器（不再 wrap feature-dev），8 phase + verifier 契约校验。
argument-hint: "[PRD 内容 | PRD 文件绝对路径，可选]"
---

# /feature-flow v2 — 独立编排器

你是 /feature-flow 的执行编排者。本命令覆盖从项目识别到交付物的 8 个 phase。

**核心架构**：
- 主 Claude 直接编排所有 phase
- feature-dev 的 3 个 subagent（`code-explorer` / `code-architect` / `code-reviewer`）作为零件被 `Agent(subagent_type=...)` 调用
- 每个产出 phase 末调用 `prd-check-verifier` 校验契约
- 不再用 `Skill` 工具调 `feature-dev:feature-dev`

**方法论权威**（强制 Read）：
- 7 镜头拷问：`${CLAUDE_PLUGIN_ROOT}/references/prd-check-lenses.md`
- project-map 模板：`${CLAUDE_PLUGIN_ROOT}/references/project-map-template.md`
- 交付物模板：`${CLAUDE_PLUGIN_ROOT}/references/output-templates.md`
- 契约定义：`${CLAUDE_PLUGIN_ROOT}/references/verifier-contracts.md`

初始用户输入：$ARGUMENTS

---

## 常量

```
PLUGIN_ROOT                = ${CLAUDE_PLUGIN_ROOT}
DATA_ROOT                  = ${PLUGIN_ROOT}/data/projects
REFS_ROOT                  = ${PLUGIN_ROOT}/references
CONTRACTS_FILE             = ${REFS_ROOT}/verifier-contracts.md

SUBAGENT_PARALLEL_EXPLORE  = 2     # P2 探索视角数（PRD 验证另外 1 个）
SUBAGENT_PARALLEL_ARCH     = 2     # P4 架构方案数（2 或 3）
SUBAGENT_PARALLEL_REVIEW   = 3     # P7 reviewer 数
VERIFIER_MAX_RETRY         = 2     # 每 phase verifier 回炉上限
RESUME_WINDOW_DAYS         = 7     # 检测未完成 session 的回溯窗口
MAP_AUTO_INIT_THOROUGHNESS = medium
```

---

## 工具用法约定

- 所有"持久化"用 `Write` / `Edit`，不输出到对话
- 询问用户用 `AskUserQuestion`，最多 4 选项
- subagent 调用用 `Agent(subagent_type=...)`
- 进 phase 第一动作：原子写 `.state`（`current_phase: Pn, phase_status: in_progress`）
- 出 phase 最后动作：原子写 `.state`（`current_phase: Pn, phase_status: completed`）
- 原子写法：`Write` 到 `.state.tmp` 后 `Bash mv ${SESSION_DIR}/.state.tmp ${SESSION_DIR}/.state`

---

## Resume 检测（在 P0 之前执行）

`Bash`：
```
find ${DATA_ROOT} -maxdepth 3 -name ".state" -mtime -${RESUME_WINDOW_DAYS} 2>/dev/null
```

对每个找到的 `.state`：`Read` 文件，提取 `current_phase` 和 `phase_status`，若 `phase_status != completed` 或 `current_phase != P8`，则视为未完成。

若有未完成：`AskUserQuestion` 给 4 选项：
1. `"继续 <session_id>（停在 <Pn>）"`
2. `"新建（这些先放着）"`
3. `"先看一眼再说"` → 选后 `Read` 出 prd-check.md / tech-design.md（若存在），重新问一次
4. `"标记 <session_id> 为废弃"` → 在该 `.state` 写 `phase_status: abandoned`，重新跑 Resume 检测

若用户选"继续"：跳到对应 phase 入口，不重跑 P0-P0.5-P1。

若无未完成 session：直接进 P0。

---

## P0 — Context Load（项目识别）

### P0.1 探测候选

`Bash`：
```
pwd && basename "$(pwd)"
ls -la 2>/dev/null | head -20
ls ${DATA_ROOT} 2>/dev/null
```

判断 cwd 是否像项目根（有 `.git` / `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` 等其一）。记 `CWD_BASENAME`；列出 `${DATA_ROOT}` 下已有项目到 `EXISTING_PROJECTS[]`。

### P0.2 确认项目身份

`AskUserQuestion` 动态构造 options（最多 4 个）：

1. 若 cwd 像项目根且 `CWD_BASENAME ∈ EXISTING_PROJECTS`：`"当前目录（<CWD_BASENAME>，已有 map）"` ← 用户默认选项
2. 若 cwd 像项目根但 `CWD_BASENAME ∉ EXISTING_PROJECTS`：`"当前目录（<CWD_BASENAME>，首次）"`
3. 最多 2 个其它已有项目：`"已有项目：<name>"`
4. `"取消（先切到正确目录再跑）"`

根据答案：
- 选当前目录已有 map → `PROJECT_ID = CWD_BASENAME`, `PROJECT_ROOT = pwd`, 跳过 P0.5
- 选当前目录首次 → `PROJECT_ID = CWD_BASENAME`, `PROJECT_ROOT = pwd`, 进 P0.5
- 选已有项目 → `PROJECT_ID = X`；若与 cwd 不同，再 `AskUserQuestion` 取该项目的根绝对路径
- 选取消 → 输出"已取消，请切换到项目根目录再跑 /feature-flow"并终止

设 `PROJECT_DIR = ${DATA_ROOT}/${PROJECT_ID}`。

### P0.3 写初始 .state

session 未创建，`.state` 暂存于内存。落盘要等 P1 session 目录建好。

### P0 输出

```
✅ P0 完成
   项目：${PROJECT_ID}
   路径：${PROJECT_ROOT}
   data 目录：${PROJECT_DIR}
```

---

<!-- 后续 phase 见后续 task -->
```

- [ ] **Step 2: 验证文件落地**

Run:
```bash
ls -la /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
grep -n "^## " /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 文件存在；grep 至少看到 `## 常量`、`## 工具用法约定`、`## Resume 检测`、`## P0 — Context Load`。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): scaffold v2 command with P0 context load + resume"
```

---

### Task 6：追加 P0.5 Map Init + P1 PRD Intake

**Files:**
- Modify: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`（追加到末尾）

- [ ] **Step 1: 追加 P0.5 与 P1**

`Edit` `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`：

old_string:
```
<!-- 后续 phase 见后续 task -->
```

new_string:
```
## P0.5 — Map Init（仅当 project-map.md 不存在时跑）

### P0.5.1 探测

`Bash`：
```
test -f ${PROJECT_DIR}/project-map.md && echo "EXISTS" || echo "MISSING"
```

若 EXISTS：跳过本 phase。
若 MISSING：继续。

### P0.5.2 用 Explore subagent 扫骨架

告诉用户："首次在此项目使用 /feature-flow，先花 1-2 分钟建 project-map。后续复用，不重跑。"

`Agent`：
- subagent_type: `Explore`（superpowers/general）
- thoroughness: `${MAP_AUTO_INIT_THOROUGHNESS}`
- 提示词：

```
扫描项目根 ${PROJECT_ROOT}，按以下骨架填充 project-map：
- 一、项目概述（一句话定位 + 当前阶段 + 项目根路径）
- 二、技术栈与运行（语言/框架/DB/中间件/启动命令/测试命令/入口文件）
- 三、模块地图（顶层模块 + 一句话职责 + 关键依赖关系）

参考模板：${CLAUDE_PLUGIN_ROOT}/references/project-map-template.md

返回 markdown 草稿（含上述 3 节）。
```

### P0.5.3 用 AskUserQuestion 补 3-4 个关键问题

`AskUserQuestion`（multiSelect=false 多轮）：

- "补 2-3 个**核心领域概念**（新人最容易混的业务术语）"
- "补 1-2 个**项目特有约定**（看代码也看不出为啥这样做的规矩）"
- "有没有踩过的坑 / 反模式？"

把答案填入「四、核心领域概念」「五、关键约定」「六、非显而易见之处」三节。「七、外部依赖与边界」如用户回答里有提及则填，否则留空小节标题。「八、最近变更」初始化为空列表。

### P0.5.4 落盘并 verifier 校验

`Bash mkdir -p ${PROJECT_DIR}` 后 `Write` 到 `${PROJECT_DIR}/project-map.md`。

调 verifier：

```
Agent(
  subagent_type="prd-check-verifier",
  prompt="phase: P0.5\nsession_dir: ${PROJECT_DIR}\ncontracts_file: ${CONTRACTS_FILE}"
)
```

> 注：P0.5 artifact 在 PROJECT_DIR 而不是 SESSION_DIR，contracts 文件里写的就是 `${PROJECT_DIR}/project-map.md`，传 session_dir 字段时把 PROJECT_DIR 路径作为占位值给过去（verifier 不区分两者，按字段名替换即可）。

`pass=true` 进下一 phase。`pass=false` 走 §错误处理（见后）。

### P0.5 输出

```
✅ P0.5 完成
   project-map.md 已生成 / 校验通过
```

---

## P1 — PRD Intake（接入 + 分流 + session 初始化）

### P1.1 PRD 分流

若 `$ARGUMENTS` 非空：直接视为有 PRD（正文或路径），进入 P1.2。

否则 `AskUserQuestion`（max 4 options）：

1. `"有 PRD，我粘贴正文"`
2. `"有 PRD，我给文件绝对路径"`
3. `"无正式 PRD，口头描述需求"`
4. `"取消本次开发"`

处理：
- 选 1 → 让用户在下一条消息粘贴；得 `PRD_CONTENT`
- 选 2 → 让用户在下一条消息给路径；`Read` 路径得 `PRD_CONTENT`
- 选 3 → 让用户口述；将口述转写成简化 PRD（结构：目标 / 主路径 / 关键规则）得 `PRD_CONTENT`
- 选 4 → 输出"已取消"并终止

### P1.2 命名 FEATURE_SLUG

从 PRD 提炼 3-5 词的英文 kebab-case slug。模糊时用 `AskUserQuestion` 让用户从 3 个候选中选。

### P1.3 创建 session（处理同日冲突）

`Bash`：
```
DATE=$(date +%Y-%m-%d)
SESSION_BASE=${PROJECT_DIR}/sessions/${DATE}-${FEATURE_SLUG}
if [ ! -d "${SESSION_BASE}" ]; then
  SESSION_DIR="${SESSION_BASE}"
else
  for i in 02 03 04 05 06 07 08 09; do
    if [ ! -d "${SESSION_BASE}-${i}" ]; then
      SESSION_DIR="${SESSION_BASE}-${i}"
      break
    fi
  done
fi
mkdir -p ${SESSION_DIR}
echo "SESSION_DIR=${SESSION_DIR}"
```

若用了 `-NN` 后缀，输出一行 `📁 session 名冲突，使用 <SESSION_DIR>`。

### P1.4 落盘 requirement.md + 初始 .state

`Write` `PRD_CONTENT` 到 `${SESSION_DIR}/requirement.md`。

`Write` 初始 `.state` 到 `${SESSION_DIR}/.state`：

```yaml
session_id: <date>-<slug>[-NN]
project_id: ${PROJECT_ID}
current_phase: P1
phase_status: completed
last_updated: <ISO 8601 now>
verifier_attempts: {}
artifacts:
  - requirement.md
```

### P1.5 verifier 校验 requirement.md

调 verifier `phase: P1`。pass 进 P2，fail 让用户重写 / 补充内容。

### P1 输出

```
✅ P1 完成
   session：${SESSION_DIR}
   requirement.md 已落盘
```
```

- [ ] **Step 2: 验证 anchors 在**

Run:
```bash
grep -nE "^## P(0\.5|1)" /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 至少 2 行命中 `## P0.5 — Map Init` 与 `## P1 — PRD Intake`。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): add P0.5 map init and P1 PRD intake"
```

---

### Task 7：追加 P2 Probe（code-explorer × 3 + verifier）

**Files:**
- Modify: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`

- [ ] **Step 1: 追加 P2 小节**

`Edit` 在 P1 末尾追加：

old_string:
```
### P1 输出

```
✅ P1 完成
   session：${SESSION_DIR}
   requirement.md 已落盘
```
```

new_string:
```
### P1 输出

\`\`\`
✅ P1 完成
   session：${SESSION_DIR}
   requirement.md 已落盘
\`\`\`

---

## P2 — Probe（代码探索 + PRD 假设验证）

进 P2 第一步：写 `.state` (current_phase: P2, phase_status: in_progress)。

### P2.1 并行 3 个 subagent

并行调（同一消息内 3 个 Agent 调用）：

**Agent 1 — code-explorer（架构视角）**

\`\`\`
subagent_type: code-explorer
prompt:
  围绕 ${PROJECT_ROOT}，针对以下 PRD 做架构视角探索：

  PRD：
  @${SESSION_DIR}/requirement.md

  任务：
  1. 找到与本需求相关的核心模块、抽象、流程
  2. 列 5-10 个最值得读的关键文件（file:line）
  3. 总结：现有架构如何 / 抽象层级 / 数据流方向
  返回结构化总结。
\`\`\`

**Agent 2 — code-explorer（相似功能视角）**

\`\`\`
subagent_type: code-explorer
prompt:
  围绕 ${PROJECT_ROOT}，针对以下 PRD 寻找**相似已有功能**：

  PRD：
  @${SESSION_DIR}/requirement.md

  任务：
  1. 找已有最像的 1-2 个功能，trace 其完整实现
  2. 列具体可借鉴的代码片段（file:line）
  3. 指出哪些可直接复用、哪些要改造
  返回结构化总结。
\`\`\`

**Agent 3 — code-explorer（PRD 假设验证视角）**

\`\`\`
subagent_type: code-explorer
prompt:
  围绕 ${PROJECT_ROOT}，针对以下 PRD 做**假设验证**：

  PRD：
  @${SESSION_DIR}/requirement.md

  任务：
  1. 从 PRD 中抽出所有具名实体（接口名 / 字段名 / 表名 / 枚举值 / 状态机 / 外部服务名）
  2. 用 Grep + Read 逐一定位真实代码：
     - 找不到的标"PRD 新增"
     - 找到但用法不一致的标"PRD 术语错用"或"PRD-代码 gap"
  3. 核对现有接口 schema / 枚举取值 / 已有校验 / DB 字段索引，与 PRD 假设的差异

  返回：
  - PRD 假设验证摘要（3-8 行）
  - 具名实体定位结果表（每条含 file:line 或 "不存在"）
  - 发现的 PRD-代码 gap 列表

  探索预算 5-15 次 tool call，不要通读项目。
\`\`\`

### P2.2 合并 3 份返回到 code-facts.md

收集 3 个 agent 的返回后，主 Claude 合并写 `${SESSION_DIR}/code-facts.md`，结构：

\`\`\`markdown
# 代码事实清单 — <feature-slug>
Date: <date>

## PRD 假设验证摘要
（来自 agent 3 的摘要 3-8 行）

## 具名实体定位
| 实体 | 类型 | 位置 / 状态 | 备注 |
|---|---|---|---|
| ... | 接口 | src/x.py:42 | ... |
| ... | 字段 | （PRD 新增） | ... |

## PRD-代码 gap 列表
- gap 1：...
- gap 2：...

## 代码事实清单
（来自 agent 1 / 2 的关键文件列表 + 一句话职责）
\`\`\`

\`Write\` 到 \`${SESSION_DIR}/code-facts.md\`。

### P2.3 verifier 校验

\`\`\`
Agent(
  subagent_type="prd-check-verifier",
  prompt="phase: P2\nsession_dir: ${SESSION_DIR}\ncontracts_file: ${CONTRACTS_FILE}"
)
\`\`\`

\`pass=true\` 进 P3。\`pass=false\` 走 §错误处理。

### P2 输出与 .state

写 \`.state\` (current_phase: P2, phase_status: completed, artifacts append: code-facts.md)。

\`\`\`
✅ P2 完成
   code-facts.md 已生成，verifier 通过
\`\`\`
```

- [ ] **Step 2: 验证 anchors**

Run:
```bash
grep -nE "^## P2|^### P2" /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 至少 4 行（P2 主标题 + P2.1/P2.2/P2.3）。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): add P2 probe with parallel code-explorer + verifier"
```

---

### Task 8：追加 P3 Interrogate（7 镜头拷问 + verifier）

**Files:**
- Modify: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`

- [ ] **Step 1: 追加 P3**

`Edit` 追加到 P2 末尾后：

old_string:
```
✅ P2 完成
   code-facts.md 已生成，verifier 通过
\`\`\`
```

new_string:
```
✅ P2 完成
   code-facts.md 已生成，verifier 通过
\`\`\`

---

## P3 — Interrogate（7 镜头拷问）

进 P3 第一步：写 .state (current_phase: P3, phase_status: in_progress)。

### P3.1 加载方法论

\`Read\` \`${CLAUDE_PLUGIN_ROOT}/references/prd-check-lenses.md\` 作为拷问方法论权威。

### P3.2 生成拷问问题清单（用 code-facts.md 做依据）

\`Read\` \`${SESSION_DIR}/code-facts.md\`，作为每条问题"依据"字段的素材库。

按 7 镜头逐一扫描 PRD：

1. 逻辑完整性
2. 用户操作路径
3. 边界条件
4. 限制与配额
5. 异常与错误处理
6. 新数据结构
7. 旧数据迁移

**只识别 PRD-TBD（业务层面）**；发现工程选型岔路口的，记入「工程选型线索」章节给 P4 参考，不向用户提问。

对每条问题：
- 三元标签：\`[P0|P1|P2][PRD-TBD][<镜头名>]\`
- 一句话问题
- 依据（引 code-facts.md 中的 file:line 或 PRD 段落）
- 候选答案：A / B / C

### P3.3 初版落盘

\`Write\` 到 \`${SESSION_DIR}/prd-check.md\`，结构遵循 \`prd-check-lenses.md\` 中的「文件结构」节：

\`\`\`markdown
# 实施前拷问 — <feature-slug>
Date: <date>
PRD 源：requirement.md

## 待解决问题清单（业务 PRD-TBD）

### P0 - 逻辑与设计（X 条）
（按优先级列出 P0 镜头下的问题，每条 4 行）

### P1 - 边界/异常/限制（Y 条）

### P2 - 旧数据兼容（Z 条）

---

## 工程选型线索（留给 Phase 4）
> 代码探索中发现的工程岔路口，不向用户提问，给 code-architect agent 参考：
- ...

---

## 拷问过程（内部追溯）

### 代码探索摘要（来自 code-facts.md 的 PRD 假设验证摘要）
...

### 7 镜头记录
#### 1. 逻辑完整性
#### 2. 用户操作路径
#### 3. 边界条件
#### 4. 限制与配额
#### 5. 异常与错误处理
#### 6. 新数据结构
#### 7. 旧数据迁移
\`\`\`

（7 镜头记录子节即便某面镜下无 PRD-TBD 也保留空标题。）

### P3.4 verifier 校验「问题清单结构」（初版，无答）

调 verifier `phase: P3`。verifier 此时会因「**答**」缺失报 violations——**这是预期**，本步只校验结构完整性。

主 Claude 此时不进入回炉，按 P3.5 走交互回填。

> 实现注意：此处需在调用 verifier 时多传一个 `mode: structure_only` 字段，verifier 在 structure_only 模式下跳过 `**答**` 行的 per_question_required 检查。
>
> （作为本插件 v2 第一版兼容做法：暂时主 Claude 只取 verifier 返回里的 `missing` / `violations` 中**非「答」相关**项作判定；后续 Task 17 端到端测完后可决定要不要给 verifier 加 mode 参数。）

### P3.5 用户答 → Edit 回写

把问题清单展示给用户。对每条问题（按 P0 → P1 → P2 顺序展示）：

\`AskUserQuestion\`：单选 / 用户自由文本。

每收到一个答：

\`Edit\` \`${SESSION_DIR}/prd-check.md\`，在对应问题块内追加：

\`\`\`
   **答**（YYYY-MM-DD）：<用户答案>
\`\`\`

**禁止**只把答案留在对话里。

> 节流提示：若 P3 总问题数 > 10，先告诉用户预估总数与时长（如"共 12 条，预估 8 分钟"），并允许用户选"我先批量答 A/B/C"。

### P3.6 verifier 终版校验

所有问题答完后再调 verifier `phase: P3`。预期 pass。fail 走 §错误处理。

### P3 输出与 .state

写 .state (current_phase: P3, phase_status: completed, artifacts append: prd-check.md)。

\`\`\`
✅ P3 完成
   prd-check.md 已生成 + 全部答 + verifier 通过
\`\`\`
```

- [ ] **Step 2: 验证 anchors**

Run:
```bash
grep -nE "^## P3|^### P3" /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 至少 7 行（P3 主标题 + P3.1-P3.6）。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): add P3 7-lens interrogation with answer write-back"
```

---

### Task 9：追加 P4 Architect（code-architect × 2-3）

**Files:**
- Modify: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`

- [ ] **Step 1: 追加 P4**

`Edit` 追加在 P3 末尾后：

old_string:
```
✅ P3 完成
   prd-check.md 已生成 + 全部答 + verifier 通过
\`\`\`
```

new_string:
```
✅ P3 完成
   prd-check.md 已生成 + 全部答 + verifier 通过
\`\`\`

---

## P4 — Architect（并行 2-3 个 code-architect）

进 P4 第一步：写 .state (current_phase: P4, phase_status: in_progress)。

### P4.1 并行调 code-architect

\`Read\` \`${SESSION_DIR}/prd-check.md\` 中的「工程选型线索」节作为额外输入。

并行调 \`SUBAGENT_PARALLEL_ARCH\` 个（默认 2 个，复杂需求可手动 3 个）：

**Agent 1 — 最小改动方案**

\`\`\`
subagent_type: code-architect
prompt:
  针对以下需求设计**最小改动**架构方案（改动最少、最大化复用）：

  需求（已澄清）：
  @${SESSION_DIR}/requirement.md
  @${SESSION_DIR}/prd-check.md

  代码事实：
  @${SESSION_DIR}/code-facts.md

  要求：
  - 列具体新增 / 修改 / 删除的文件清单（file path + 描述）
  - 列核心设计决策 2-3 条，每条带理由
  - 列影响范围（涉及哪些模块 / 接口 / DB 表）
  - 估算难度（小 / 中 / 大）
\`\`\`

**Agent 2 — 干净架构方案**

\`\`\`
subagent_type: code-architect
prompt:
  针对以下需求设计**干净架构**方案（优雅抽象、可维护性优先）：
  @${SESSION_DIR}/requirement.md
  @${SESSION_DIR}/prd-check.md
  @${SESSION_DIR}/code-facts.md

  要求同上。
\`\`\`

（如选 3 个，加 Agent 3 - 务实平衡方案）

### P4.2 主 Claude 整理对比

收到 2-3 份方案后，主 Claude 在对话里输出方案对比：

\`\`\`
| 维度 | 方案 A（最小改动） | 方案 B（干净架构） |
|---|---|---|
| 改动文件数 | 3 | 8 |
| 新抽象 | 无 | 引入 BatchRunner 接口 |
| 估算难度 | 小 | 中 |
| 关键风险 | 复用现有 batch 路径耦合 | 需要重构 review_service |
\`\`\`

并给出**主 Claude 自己的推荐 + 理由**（基于此项目阶段和需求复杂度）。

### P4.3 verifier 校验方案对比内容

此 phase 产出在内存（暂未落盘 tech-design.md，那是 P5 的事）。verifier 此时**跳过 P4**（contracts 文件中 P4 没有 artifact 定义）。

主 Claude 只做语义自检：至少 2 个候选 + 每个含推荐理由 + 影响范围。

### P4 输出与 .state

写 .state (current_phase: P4, phase_status: completed)。

\`\`\`
✅ P4 完成
   <N> 个架构方案就绪 + 推荐：方案 <X>
\`\`\`
```

- [ ] **Step 2: 验证 anchors**

Run:
```bash
grep -nE "^## P4|^### P4" /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 至少 4 行（P4 主标题 + P4.1-P4.3）。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): add P4 parallel architect proposals"
```

---

### Task 10：追加 P5 Review Gate（tech-design.md + user approve）

**Files:**
- Modify: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`

- [ ] **Step 1: 追加 P5**

`Edit` 追加：

old_string:
```
✅ P4 完成
   <N> 个架构方案就绪 + 推荐：方案 <X>
\`\`\`
```

new_string:
```
✅ P4 完成
   <N> 个架构方案就绪 + 推荐：方案 <X>
\`\`\`

---

## P5 — Review Gate（实现前强制评审 checkpoint）

进 P5 第一步：写 .state (current_phase: P5, phase_status: in_progress)。

### P5.1 用户先选方案

\`AskUserQuestion\`：
- "选哪个方案推进？"
- 选项：方案 A / 方案 B / (方案 C) / "都不满意，回 P4 重出"
- 选"都不满意"：标记 P5 reject → 跳到 §6.3 重出流程

### P5.2 按选定方案生成 tech-design.md

\`Read\` \`${CLAUDE_PLUGIN_ROOT}/references/output-templates.md\` 中模板 A。

按模板填充：
- 关联 PRD: requirement.md
- 拷问记录: prd-check.md
- **核心设计决策**：来自 P4 选定方案 + 主 Claude 自己补的小决策
- **变更清单**：来自 P4 选定方案的文件清单
- **数据流与时序**：主路径文字描述（不画图，必要时 ASCII）
- **异常与边界处理**：来自 prd-check.md P1 节
- **配置与开关**：若涉及 env / flag
- **依赖 & 影响范围**：来自 P4 影响范围
- **未尽事项 / TODO**：留空或写 P5 未答的边角

\`Write\` 到 \`${SESSION_DIR}/tech-design.md\`。

### P5.3 verifier 校验 tech-design.md

\`\`\`
Agent(
  subagent_type="prd-check-verifier",
  prompt="phase: P5\nsession_dir: ${SESSION_DIR}\ncontracts_file: ${CONTRACTS_FILE}"
)
\`\`\`

\`pass=true\` 进 P5.4。\`pass=false\` 走 §错误处理（回炉补节）。

### P5.4 用户评审 + 决策

把 tech-design.md 路径 + 关键节摘要展示给用户。

\`AskUserQuestion\` 4 选项：
1. \`"approve，进入实现"\` → 进 P6
2. \`"调整某处再 approve（接下来告诉你哪里改）"\` → 留在 P5 等用户具体指令，主 Claude \`Edit\` tech-design.md，改完重跑 P5.3 verifier + P5.4 AskUserQuestion
3. \`"重出方案（回 P4）"\` → 走 §6.3 重出流程
4. \`"暂存，稍后再说"\` → 写 .state (phase_status: in_progress)，输出 session 路径让用户后续 resume

### P5 输出与 .state

approve 后写 .state (current_phase: P5, phase_status: completed, artifacts append: tech-design.md)。

\`\`\`
✅ P5 完成
   tech-design.md 已 approve
\`\`\`
```

- [ ] **Step 2: 验证 anchors**

Run:
```bash
grep -nE "^## P5|^### P5" /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 至少 5 行（P5 主标题 + P5.1-P5.4）。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): add P5 review gate with mandatory user approval"
```

---

### Task 11：追加 P6 Implement + P7 Quality Review + P8 Deliver

把后三个 phase 合一个 task —— 它们各自的逻辑相对短，且 P6/P7/P8 是顺序依赖紧耦合的。

**Files:**
- Modify: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`

- [ ] **Step 1: 追加 P6 + P7 + P8**

`Edit` 追加：

old_string:
```
✅ P5 完成
   tech-design.md 已 approve
\`\`\`
```

new_string:
```
✅ P5 完成
   tech-design.md 已 approve
\`\`\`

---

## P6 — Implement（主 Claude 顺序写代码，不调 subagent）

进 P6 第一步：写 .state (current_phase: P6, phase_status: in_progress)。

### P6.1 准备实现 checklist

从 \`tech-design.md\` 的「变更清单」节抽出所有 `新增 / 修改 / 删除` 项，转成 `IMPL_CHECKLIST`（内存中，每项含 file + 动作 + 一句描述）。

### P6.2 逐项实现

对 IMPL_CHECKLIST 中每一项：
- 如该文件之前没读过 → `Read` 当前内容
- `Write` 新文件 / `Edit` 已有文件
- 每改一个文件就在 .state 的 \`modified_files\` 列表里追加路径

> 注意：主 Claude 自己写，不调 code-architect 写。code-architect 是出方案的，不是码农。

### P6.3 自检 — 变更清单 vs 实际修改一一对照

`Bash`：
```
# 用 .state 的 modified_files 列表对照 tech-design.md 的变更清单
```

任何遗漏在 IMPL_CHECKLIST 中但未实际修改的，回 P6.2 补。

### P6 输出与 .state

写 .state (current_phase: P6, phase_status: completed)。

\`\`\`
✅ P6 完成
   实际修改：<N> 个文件
\`\`\`

---

## P7 — Quality Review（并行 3 个 code-reviewer）

进 P7 第一步：写 .state (current_phase: P7, phase_status: in_progress)。

### P7.1 并行调 3 个 reviewer

并行调 \`SUBAGENT_PARALLEL_REVIEW\` (=3) 个：

**Agent 1 — 简洁性 / DRY / 优雅**

\`\`\`
subagent_type: code-reviewer
prompt:
  Review 以下变更（从 ${PROJECT_ROOT}），重点关注**简洁、DRY、优雅**：

  本次实现的文件清单（来自 .state.modified_files）：
  - file1
  - file2

  原始需求与方案：
  @${SESSION_DIR}/requirement.md
  @${SESSION_DIR}/tech-design.md

  请按问题严重度分级（critical / major / minor）。返回结构化清单。
\`\`\`

**Agent 2 — bug / 功能正确性**

\`\`\`
subagent_type: code-reviewer
prompt:
  Review 同一批变更，重点关注**bug、边界、错误处理**。

  对照拷问记录：
  @${SESSION_DIR}/prd-check.md
  各条「答」涉及的边界 / 异常处理在代码里是否真实落地？

  按严重度分级返回。
\`\`\`

**Agent 3 — 项目约定**

\`\`\`
subagent_type: code-reviewer
prompt:
  Review 同一批变更，重点关注**项目约定**（命名、错误码、日志、模式）。

  对照项目 map：
  @${PROJECT_DIR}/project-map.md
  特别是「五、关键约定」节。

  按严重度分级返回。
\`\`\`

### P7.2 共识汇总 + 修

主 Claude 收到 3 份后做共识汇总（≥2 个 reviewer 提到的同一问题为高优）：

\`AskUserQuestion\`：
- "高优问题修了再走？"
- 选项：
  1. \`"我来主导修，所有 critical/major 修完"\`
  2. \`"只修 critical，major 留给后续"\`
  3. \`"我看一眼报告自己来"\`
  4. \`"先放过，所有问题都不修"\`

按选择修代码。每修一处更新 .state 的 modified_files。

### P7.3 verifier 校验（无 artifact，只校验"高优问题已处理"）

contracts 文件中 P7 没有 artifact 契约。主 Claude 自检：所选用户分类内的问题是否全部处理。

### P7 输出与 .state

写 .state (current_phase: P7, phase_status: completed)。

\`\`\`
✅ P7 完成
   3 reviewer 报告整合，<N> 个高优问题处理完毕
\`\`\`

---

## P8 — Deliver & Sync（交付文档 + 回写 project-map）

进 P8 第一步：写 .state (current_phase: P8, phase_status: in_progress)。

### P8.1 是否要 api-test.md

\`AskUserQuestion\`：
1. \`"要"\`
2. \`"不要（无新接口或不需要文档）"\`

选要：
- \`Read\` \`${CLAUDE_PLUGIN_ROOT}/references/output-templates.md\` 模板 B
- 按模板填字段表 / 错误码表 / 测试用例表 / curl
- 数据源：实际改动的 API 接口文件 + tech-design.md
- \`Write\` 到 \`${SESSION_DIR}/api-test.md\`
- 调 verifier \`phase: P8\`；fail 走 §错误处理

选不要：跳过。

### P8.2 回写 project-map.md

\`Read\` \`${PROJECT_DIR}/project-map.md\`。

判断本次开发是否触发以下更新：

| 触发 | 更新小节 |
|---|---|
| 新模块 / 新接口 | 三、模块地图 |
| 新领域概念 | 四、核心领域概念 |
| 新约定 | 五、关键约定 |
| 新坑 / 反模式 | 六、非显而易见之处 |

任一触发：\`Edit\` 精确插入；触发多个：用 \`Edit\` 分别更新；变动大用 \`Write\` 整体重写并先备份 \`Bash cp project-map.md project-map.md.bak\`。

**最后必更新「八、最近变更」节**：追加一行

\`\`\`
- <date> <feature-slug>：<一句话摘要，≤30 字>
\`\`\`

只保留最近 10 条（删旧的）。

### P8.3 final .state

写 .state (current_phase: P8, phase_status: completed, artifacts: 全部列出)。

### P8 输出

\`\`\`
✅ /feature-flow 完成
   项目：${PROJECT_ID}
   session：${SESSION_DIR}
   交付：<已生成的 md 列表>
   project-map 更新：<更新的小节>
   下次 /feature-flow，此项目上下文自动复用。
\`\`\`
```

- [ ] **Step 2: 验证 anchors**

Run:
```bash
grep -nE "^## P[678]|^### P[678]" /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 至少 6 行（P6/P7/P8 主标题 + 各子节）。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): add P6 implement, P7 review, P8 deliver"
```

---

### Task 12：追加错误处理 / Resume 兜底 / 重出流程 / 硬规则节

**Files:**
- Modify: `/Users/liaolei/plugins/feature-flow/commands/feature-flow.md`

- [ ] **Step 1: 追加最后的"§错误处理 / §硬规则"节**

`Edit` 追加在 P8 末尾后：

old_string:
```
✅ /feature-flow 完成
   项目：${PROJECT_ID}
   session：${SESSION_DIR}
   交付：<已生成的 md 列表>
   project-map 更新：<更新的小节>
   下次 /feature-flow，此项目上下文自动复用。
\`\`\`
```

new_string:
```
✅ /feature-flow 完成
   项目：${PROJECT_ID}
   session：${SESSION_DIR}
   交付：<已生成的 md 列表>
   project-map 更新：<更新的小节>
   下次 /feature-flow，此项目上下文自动复用。
\`\`\`

---

## §6 错误处理

### §6.1 verifier 单轮失败 → 回炉

任一 phase verifier 返回 \`pass=false\`：

1. 读 verifier 返回的 \`missing\` + \`violations\` + \`suggest\`
2. 针对性修产出文件（\`Edit\` 补章节 / 改违规模式 / 补具体内容）
3. 重跑 verifier
4. 自增 \`.state.verifier_attempts[Pn] += 1\`

最多 2 轮。

### §6.2 verifier 连续 2 轮失败 → 兜底 4 选项

\`Write\` \`${SESSION_DIR}/.verifier-blocked.md\`，内容：

\`\`\`
# Verifier 阻塞 — Pn @ <ISO time>

## 最后一次产出节选
（artifact 文件最末段 50 行）

## verifier 不通过原因
- missing: ...
- violations: ...

## 建议方向
- suggest from verifier
\`\`\`

写 .state phase_status: failed。

\`AskUserQuestion\` 4 选项：
1. \`"我手动改 ${SESSION_DIR}/<artifact>，改完回来"\` → 用户手动 Edit 后回到对话说"改完了"，主 Claude 重跑 verifier
2. \`"放过本次 verifier 继续"\` → .state 写 \`bypassed_phase: Pn\`，继续下一 phase
3. \`"退到 P<n-1> 重做"\` → 写 .state current_phase: P<n-1>，artifact 保留
4. \`"终止 /feature-flow"\` → 写 .state phase_status: failed 后退出

### §6.3 P5 重出方案流程

当 P5.4 用户选"重出"或 P5.1 用户选"都不满意"：

1. \`Bash cp ${SESSION_DIR}/tech-design.md ${SESSION_DIR}/tech-design.md.v<N>.bak\`（递增 N）
2. \`Bash rm ${SESSION_DIR}/tech-design.md\`
3. 清空 P4 内存方案对比
4. 写 .state (current_phase: P4, phase_status: in_progress)
5. 回 §P4.1 重跑 code-architect 并行（可调换 prompt 视角，如让用户告诉哪个方向"更近"）
6. 完成后回 P5.2 生成 tech-design.md v2
7. \`prd-check.md\` 保留不动

---

## §7 硬规则（编排者必须遵守）

1. **必须确认项目身份**（P0.2 不可省）。不因 cwd 在某项目就自动默认
2. **必须 Resume 先检测**。有未完成 session 不询问直接新建是反模式
3. **必须落盘所有产出**。\`prd-check.md\` / \`code-facts.md\` / \`tech-design.md\` / \`api-test.md\` 永不只留在对话里
4. **必须 .state 原子写**（先 \`.state.tmp\` 后 \`mv\`）
5. **必须用 verifier**，不能主 Claude 自检产出代替
6. **禁止** "可能需要进一步确认" / "建议团队评估" / "[DEV-DECIDE]" 出现在 prd-check.md
7. **禁止** 静默跳过 verifier 失败。任一 phase 失败 ≥2 轮必须走 §6.2 兜底询问用户
8. **禁止** P3 拷问问业务以外（工程选型归 P4，写入「工程选型线索」节）
9. **禁止** P6 调 subagent 写代码（主 Claude 自己写）
10. **禁止** 删除 \`commands/feature-flow.legacy.md\`（保留 2 周回退窗口）
```

- [ ] **Step 2: 验证 anchors 完整**

Run:
```bash
grep -nE "^## " /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
```
Expected: 主标题列表至少含：常量 / 工具用法约定 / Resume 检测 / P0 / P0.5 / P1 / P2 / P3 / P4 / P5 / P6 / P7 / P8 / §6 错误处理 / §7 硬规则。

- [ ] **Step 3: Checkpoint**

```bash
wc -l /Users/liaolei/plugins/feature-flow/commands/feature-flow.md
# git template (未启用)：
# git add commands/feature-flow.md
# git commit -m "feat(feature-flow): add error handling, resume fallback, redo flow, hard rules"
```

---

## Phase 3：端到端验证

### Task 13：端到端干跑一个真实小需求

**Files:**
- 触发 `/feature-flow`，端到端走通；不预写文件

**Background:** 选一个真实但小的需求（如"给某个接口加分页"）端到端跑一次，验证全部 phase 都能正确执行 + verifier 至少触发一次回炉 + Resume 能正确处理中断。

- [ ] **Step 1: 选 feature**

在 `contract-review` 项目中挑一个**真实但小**的待办（≤ 3 文件改动），写一段简短 PRD 备用。例如："给 `/api/contract/list` 加分页（page + page_size，默认 page=1 page_size=20）"。

- [ ] **Step 2: 干跑 /feature-flow**

在 `contract-review` 项目根目录下触发 `/feature-flow` 并直接提供这段 PRD 作为 `$ARGUMENTS`。

跟踪检查点（用 TaskCreate 记录）：

- [ ] P0 — 正确识别 contract-review 项目
- [ ] P0.5 — 跳过（已有 project-map.md）
- [ ] P1 — requirement.md 落盘，session 目录建立，命名格式正确
- [ ] P2 — code-facts.md 含 PRD 假设验证摘要 + ≥3 个 file:line；verifier 通过
- [ ] P3 — prd-check.md 含 7 镜头全节；逐条交互回填；verifier 通过
- [ ] P4 — 2 个方案对比展示
- [ ] P5 — tech-design.md 生成 → 故意先选"调整"试 1 次再 approve → 看 verifier 是否在中间触发
- [ ] P6 — 主 Claude 写代码完成
- [ ] P7 — 3 reviewer 并行返回，共识修
- [ ] P8 — 是否 api-test 询问 → 选要 → api-test.md 落盘 → project-map「八、最近变更」追加 1 行

- [ ] **Step 3: 干跑 Resume**

干跑结束后，故意再触发一次 `/feature-flow`：

- [ ] 验证 Resume 检测扫到刚才的 session（应该是 P8 completed，不会出现在未完成列表里）
- [ ] 故意先准备一个手动构造的"停在 P5"的 session（直接复制 P5 已完成的 session 一份、删 tech-design.md、改 .state 为 `current_phase: P5, phase_status: in_progress`），再触发 `/feature-flow`，应正确识别并询问 4 选项

- [ ] **Step 4: 故意触发 verifier 失败**

构造一个 prd-check.md 故意删掉「7 镜头记录」节里 3 个小节，调 verifier `phase: P3`，预期 `pass=false`、missing 包含被删的 3 个小节。

- [ ] **Step 5: 干跑命名冲突**

同日重复触发同 slug 的 session，确认自动 `-02` 后缀。

- [ ] **Step 6: 总结 + 回炉若失败**

写一份 `docs/superpowers/plans/task-13-e2e-report.md` 记：

- 哪些 phase 一次过
- 哪些 phase 需要主 Claude 即兴补救（说明命令文件可能某处不够具体，需要回炉）
- verifier 实际触发次数 + 误判次数
- 用户视角的痛点（一句话）

如有 phase 需要补救：回到对应 Task 修命令文件，再跑一次本 task。

- [ ] **Step 7: Checkpoint**

```bash
ls /Users/liaolei/plugins/feature-flow/docs/superpowers/plans/task-13-e2e-report.md
# git template (未启用)：
# git add docs/superpowers/plans/task-13-e2e-report.md commands/feature-flow.md
# git commit -m "test(feature-flow): end-to-end smoke verified on contract-review"
```

---

## Self-Review

### Spec 覆盖核对

| Spec 节 | 任务覆盖 |
|---|---|
| §1 背景与动机 | (背景，无需任务) |
| §2.1 定位 | Task 5 命令骨架 |
| §2.2 三层结构 | Task 5（编排器）+ Task 2（verifier subagent）|
| §2.3 方法论 source of truth | Task 5 显式 Read references |
| §2.4 砍掉的 v1 设计 | Task 4 备份 + Task 5 命令不内联方法论 |
| §3 8 phase 契约表 | Task 5（P0）/ Task 6（P0.5 P1）/ Task 7（P2）/ Task 8（P3）/ Task 9（P4）/ Task 10（P5）/ Task 11（P6 P7 P8）|
| §4.1 目录布局 | Task 4-12 落盘到约定路径 |
| §4.2 .state 格式 | Task 5 工具约定节 + Task 6/Task 12 显式写 .state |
| §4.3 命名冲突处理 | Task 6 P1.3 |
| §4.4 恢复流程 | Task 5 Resume 检测节 |
| §5 verifier 设计 | Task 1（contracts）+ Task 2（subagent）|
| §6.1 phase 内回炉 | Task 12 §6.1 |
| §6.2 二次失败兜底 | Task 12 §6.2 |
| §6.3 P5 重出 | Task 10 + Task 12 §6.3 |
| §7 可调参数 | Task 5 常量节 |
| §8 测试策略 | Task 3（verifier 回归）+ Task 13（端到端）|
| §9 迁移路径 | Task 4（备份）+ 2 周稳定后人工删 legacy |
| §10 兼容矩阵 | (信息性，无需任务) |
| §11 验收 6 条 | Task 13 检查点逐条对应 |

**结论：全覆盖**。

### 命名 / 类型一致性

- `session_id` / `project_id` / `current_phase` / `phase_status` 在 Task 5 / Task 6 / Task 12 一致
- `verifier_attempts[Pn]` 计数器命名一致
- `code-facts.md` / `prd-check.md` / `tech-design.md` / `api-test.md` 全文一致
- `SUBAGENT_PARALLEL_*` 常量在 Task 5 定义、Task 7 / Task 9 / Task 11 引用，名字一致

### Placeholder 扫描

- 无 "TBD" / "TODO" / "fill in later"
- 任务步骤都给出具体内容或具体命令
- 例外：Task 13 涉及干跑真实需求，需要 owner 在执行时选具体 feature——这是设计上的人工介入点，不是 placeholder

---

## 执行选择

**计划完成，落盘到 `/Users/liaolei/plugins/feature-flow/docs/superpowers/plans/2026-05-18-feature-flow-v2.md`。**

两种执行方式：

1. **Subagent-Driven Development（推荐）**：每个 task 派发一个新鲜 subagent，主 Claude 在 task 之间 review，迭代快。

2. **Inline Execution**：当前 session 内顺序跑，按检查点对齐。

选哪种？
