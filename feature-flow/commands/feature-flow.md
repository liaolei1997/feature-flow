---
description: 后端需求端到端开发流程 v2，独立编排器（不再 wrap feature-dev），8 phase + verifier 契约校验。
argument-hint: "[PRD 内容/路径 新建 | 续 <session_id> 续跑，均可选]"
---

# /feature-flow v2 — 独立编排器

你是 /feature-flow 的执行编排者。本命令覆盖从项目识别到交付物的 8 个 phase。

**核心架构**：
- 主 Claude 直接编排所有 phase
- feature-dev 的 3 个 subagent（`code-explorer` / `code-architect` / `code-reviewer`）作为零件被 `Agent(subagent_type=...)` 调用
- 每个产出 phase 末调用 `prd-check-verifier` 校验契约
- 不再用 `Skill` 工具调 `feature-dev:feature-dev`

**方法论权威**（强制 Read）：
- 8 镜头拷问：`${CLAUDE_PLUGIN_ROOT}/references/prd-check-lenses.md`
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
MAP_AUTO_INIT_THOROUGHNESS = medium
```

---

## 工具用法约定

- 所有"持久化"用 `Write` / `Edit`，不输出到对话
- 询问用户用 **交互提问工具**，最多 4 选项。**交互提问工具** = 当前宿主提供的向用户提问/多选的工具：终端（Claude Code）下即内置的 `AskUserQuestion`；feature-flow studio 等 Web 宿主会在 systemPrompt 注入等价工具（如 `mcp__studio__ask_user`）并说明用法。**不要把工具名写死**——按本宿主实际可用的交互提问工具调用即可。
- subagent 调用用 `Agent(subagent_type=...)`
- 进 phase 第一动作：原子写 `.state`（`current_phase: Pn, phase_status: in_progress`）
- 出 phase 最后动作：原子写 `.state`（`current_phase: Pn, phase_status: completed`）
- 原子写法：`Write` 到 `.state.tmp` 后 `Bash mv ${SESSION_DIR}/.state.tmp ${SESSION_DIR}/.state`
- **Agent 调用书写约定**：本文档中的 `Agent(...)` 调用块代表"主 Claude 用 Agent 工具发起 subagent 调用"。统一写成：

  ```
  Agent(
    subagent_type="<name>",
    prompt="""
    <prompt body，多行写在三重引号内，不要用 \n 转义>
    """
  )
  ```

  下游 Claude 应把三重引号内文本作为 prompt 字段值传递（视为真实多行字符串）。`<...>` 表示占位符需用上下文实际值替换。
- **.state YAML 书写约定**：示例 YAML 中出现的不同记号：`<placeholder>` 用真实值替换；`${VAR}` 取自命令常量或上下文；其余字面值（如 `current_phase: P1`、`phase_status: completed`）直接写入。空对象用 `{}`，空列表用 `[]`。

### 文档写作规约（所有产出 md 通用，强制）

写 `requirement.md` / `code-facts.md` / `prd-check.md` / `tech-design.md` / `api-test.md` 等任何产出文档时，**为"可快速扫读"而写，不为"信息塞满"而写**：

- **一行一个论点**。一个 bullet 只讲一件事。一条里塞了 ≥2 个独立信息点 → 拆成子 bullet（缩进）。
- **禁止分号长墙**。出现"A；B；C；D"串成一段的，必须拆成多个子 bullet 或一张表。一个 bullet 正文超过约 2 行就是信号：该拆了。
- **结构化的东西用结构**：字段清单 / 取值对照 / 错误码 / 用例 → 一律用表格，不要写成句子。
- **关键结论加粗前置**，论据/数据放其后的子 bullet，别让人从长句里捞结论。
- 这条规约**优先级高于**任何模板里的示例排版；模板只是骨架，密集内容一律按此拆开。

---

## 启动分流：新建 or 续跑（在 P0 之前执行）

**不自动扫描未完成会话**（resume 由用户显式发起，避免每次开新都被打断）。只看 `$ARGUMENTS` 开头：

- 若 `$ARGUMENTS` 以 `续` / `继续` / `resume`（不分大小写）开头 → **续跑分支**（下方），其后内容为 `SESSION_ID`。
- 否则 → **新建分支**：直接进 P0，`$ARGUMENTS`（若有）按 PRD 正文/路径处理（见 P1.1）。

> 想看有哪些未完成会话、拿到要续的 `SESSION_ID`：跑 `/feature-flow:sessions`，复制对应会话名。

### 续跑分支

1. 取 `SESSION_ID` = `$ARGUMENTS` 去掉开头的 `续/继续/resume` 关键字后 trim 的剩余内容。
2. 定位会话目录（session_id 不含项目名，需跨项目找）：
   ```
   find ${DATA_ROOT} -maxdepth 3 -type d -name "<SESSION_ID>" 2>/dev/null
   ```
   - 找不到 → 报 "找不到会话 <SESSION_ID>，用 /feature-flow:sessions 查看可用会话名" 并终止。
   - 找到多个（不同项目同名）→ 用**交互提问工具**让用户选哪个项目下的。
   - 记 `SESSION_DIR = <找到的路径>`。
3. `Read` `${SESSION_DIR}/.state`，读 `project_id`、`current_phase`、`phase_status`、`mode`（`mode` 缺省视为 `full`）。
   - 若 `phase_status == completed` 且 `current_phase == P8` → 提示 "该会话已完成（P8）。如需在其基础上继续，请新建会话。" 并终止（不重跑已完成的）。
4. 设 `PROJECT_ID = <.state.project_id>`、`PROJECT_ROOT = <该项目代码根；若 cwd 已匹配用 cwd，否则用交互提问工具问根路径>`、`PROJECT_DIR = ${DATA_ROOT}/${PROJECT_ID}`、`MODE = <.state.mode，缺省 full>`。
5. 跳到 `.state.current_phase` 对应的 phase 入口（重入逻辑：`phase_status: in_progress` → 从该 phase 开头重做；`completed` → 从下一 phase 开始）。**后续 phase 按恢复出的 `MODE` 走 §分支模式**（light 会话续跑仍跳 P4、用 lite 变体，不退化成完整流程）。
6. 不重跑 P0 / P0.5 / P1。

---

## 分支模式（完整 / 轻量）— 权威定义

本流程有两条分支，由 P1.0 选定的 `MODE` 决定，全程写入 `.state` 的 `mode` 字段（`full` | `light`）。

- **完整流程（full）**：默认，跑全部 P0–P8（含并行探索/拷问/架构/质检）。适合需要挖拦路问题、比较架构方案的需求。
- **轻量分支（light）**：给"开发者已基本想清楚、范围小、低歧义"的改动用。保留脊柱（认识项目 → 懂需求 → 看相关代码 → 改 → 查一遍 → 回写认知），砍掉并行 fan-out 与重型仪式。

### 轻量分支逐 phase 增量（相对完整流程）

| Phase | 轻量行为 |
|---|---|
| P0 | **同**（含 map 漂移检测） |
| P1 | **同**；`.state` 记 `mode: light` |
| P2 | **只起 1 个 code-explorer**（聚焦改动点，非并行 3 个），产精简 code-facts.md（无须全量假设验证）。**升级闸**：若探索发现改动涉及多模块/新表/复杂迁移等超出"轻量"预期，主 Claude 用交互提问工具问「这比轻量大，切回完整流程？」；选是则置 `mode: full` 从 P3 继续完整流程 |
| P3 | **替换为 P3-lite·关键澄清**：只问 0–3 个**阻塞性**问题（无则直接过），**不产 prd-check.md**，不做 8 镜头全扫 |
| P4 | **跳过**：主 Claude 内联定实现方案，不起并行 architect，不产竞争方案 |
| P5 | **P5-lite·轻量 confirm**：动手前主 Claude 一句话概述「要改哪些文件 / 怎么改」，用交互提问工具让用户确认（approve / 调整）；**不产 tech-design.md** |
| P6 | **同** |
| P7 | **只起 1 个 code-reviewer**（非并行 3 个），汇总问题 |
| P8 | **P8-lite**：**只回写 project-map**（含 sync marker）；默认**不产** api-test.md / tech-design.md（用户显式要才产） |

### verifier 在轻量分支下的跳过

轻量分支不产 prd-check.md / tech-design.md，故 **P3 / P4 / P5 的 verifier 一律跳过**；P1（requirement.md）、P2（code-facts.md）、P8-Map（project-map 回写）仍校验。

### 进度脊柱标注

`.state` 的 `mode: light` 下，被跳过的 phase（P4、以及未产文档的 P5）在前端进度展示中标为 skipped，不算未完成。

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

`交互提问工具` 动态构造 options（最多 4 个）：

1. 若 cwd 像项目根且 `CWD_BASENAME ∈ EXISTING_PROJECTS`：`"当前目录（<CWD_BASENAME>，已有 map）"` ← 用户默认选项
2. 若 cwd 像项目根但 `CWD_BASENAME ∉ EXISTING_PROJECTS`：`"当前目录（<CWD_BASENAME>，首次）"`
3. 最多 2 个其它已有项目：`"已有项目：<name>"`
4. `"取消（先切到正确目录再跑）"`

根据答案：
- 选当前目录已有 map → `PROJECT_ID = CWD_BASENAME`, `PROJECT_ROOT = pwd`, 跳过 P0.5
- 选当前目录首次 → `PROJECT_ID = CWD_BASENAME`, `PROJECT_ROOT = pwd`, 进 P0.5
- 选已有项目 → `PROJECT_ID = X`；若与 cwd 不同，再 `交互提问工具` 取该项目的根绝对路径
- 选取消 → 输出"已取消，请切换到项目根目录再跑 /feature-flow"并终止

设 `PROJECT_DIR = ${DATA_ROOT}/${PROJECT_ID}`。

### P0.3 写初始 .state

session 未创建，`.state` 暂存于内存。落盘要等 P1 session 目录建好。

### P0.4 map 漂移检测（仅当 map 已存在且 PROJECT_ROOT 是 git 仓库）

从 project-map.md 的「九、最近变更」标题行解析 `last_synced_commit: <sha7>`。若存在且非 `n/a`：

`Bash git -C ${PROJECT_ROOT} log --oneline <sha7>..HEAD 2>/dev/null | head -20`

- 输出为空 → map 与代码同步，静默继续。
- 输出非空（有 N 个 commit 未反映进 map）→ map 可能过期，用**交互提问工具**问用户：
  1. `"先用最新代码刷新 project-map 再继续（推荐，<N> 个 commit 未同步）"` → 跑 P0.5 的扫描逻辑增量更新 map，再进 P1
  2. `"继续用现有 map（我清楚这些改动）"` → 直接进 P1
- 无法解析 sha 或仓库无此 commit（如 rebase 过）→ 提示"无法校验 map 新鲜度"，按选项 2 继续。

> 目的：防止 map 记录的先验与真实代码漂移后，P2/P3 基于过期假设推理而不自知。

### P0.4b 载入项目记忆（map 已存在时——让记忆真正生效）

若 `${PROJECT_DIR}/project-map.md` 存在（且 P0.4 未触发重建）：**`Read ${PROJECT_DIR}/project-map.md` 全文**，载入主线上下文。

这份 map 是本项目的长期记忆（模块地图 / 领域概念 / 关键约定 / 历史踩坑），作为**后续所有 phase 的先验知识**：
- 主线 phase（P1 需求理解、P3 8 镜头拷问、P4.2 方案对比、P5/P6）直接以它为背景，不要重新假设已知结构。
- 派发子 agent 时（P2 code-explorer、P4 code-architect、P7 code-reviewer），**在其 prompt 中附上 map 的相关章节，或明确指示它先 `Read ${PROJECT_DIR}/project-map.md`**——子 agent 是独立上下文，不会自动继承主线读到的内容。

### P0 输出

```
✅ P0 完成
   项目：${PROJECT_ID}
   路径：${PROJECT_ROOT}
   data 目录：${PROJECT_DIR}
```

---

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
- 二、核心业务 / 功能地图（**写厚**：逐个核心功能写 ① 是什么 ② 怎么做的——主流程 3–6 步 + 关键模型/数据/算法（概念级）③ 落在哪些模块。需 Read 相关代码搞懂流程，只写一句话价值不合格。读 README/CLAUDE.md 辅助）
- 三、技术栈与运行（语言/框架/DB/中间件/启动命令/测试命令/入口文件）
- 四、模块地图（顶层模块 + 一句话职责 + 关键依赖关系）

参考模板：${CLAUDE_PLUGIN_ROOT}/references/project-map-template.md

返回 markdown 草稿（含上述 4 节）。
```

### P0.5.3 用 交互提问工具 补 3-4 个关键问题

`交互提问工具`（multiSelect=false 多轮）：

- "确认/补全 2-3 个**核心业务功能**（这产品主要让用户干啥）"
- "补 2-3 个**核心领域概念**（新人最容易混的业务术语）"
- "补 1-2 个**项目特有约定**（看代码也看不出为啥这样做的规矩）"
- "有没有踩过的坑 / 反模式？"

把答案填入「二、核心业务 / 功能地图」「五、核心领域概念」「六、关键约定」「七、非显而易见之处」。「八、外部依赖与边界」如用户回答里有提及则填，否则留空小节标题。「九、最近变更」初始化为空列表。

### P0.5.4 落盘并 verifier 校验

`Bash mkdir -p ${PROJECT_DIR}` 后 `Write` 到 `${PROJECT_DIR}/project-map.md`。

调 verifier：

```
Agent(
  subagent_type="prd-check-verifier",
  prompt="""
  phase: P0.5
  session_dir: ${PROJECT_DIR}
  project_dir: ${PROJECT_DIR}
  contracts_file: ${CONTRACTS_FILE}
  """
)
```

> 注：P0.5 artifact 在 PROJECT_DIR 而不是 SESSION_DIR。contracts 文件里 artifact 路径用 `${PROJECT_DIR}`，所以 prompt 中**必须同时传 `project_dir`** 字段（verifier 严格按 key 名替换占位符；只传 `session_dir` 会触发 "unresolved placeholder: PROJECT_DIR" 失败）。`session_dir` 也带上是为了 verifier 在产出 JSON 中的 artifact_path 字段能正确解析。

`pass=true` 进下一 phase。`pass=false` 走 §错误处理（见后）。

### P0.5 输出

```
✅ P0.5 完成
   project-map.md 已生成 / 校验通过
```

---

## P1 — PRD Intake（接入 + 分流 + session 初始化）

### P1.0 模式选择（完整 / 轻量）

定 `MODE`（见 §分支模式）：

1. **入参预声明优先**：若 `$ARGUMENTS` 或首条用户消息含模式标记 —— `【模式：轻量】`/`【mode:light】` → `MODE=light`；`【模式：完整】`/`【mode:full】` → `MODE=full`。studio 等宿主会预声明，读到即用，不再问。
2. 否则用**交互提问工具**问：
   - `"完整流程（默认，挖拦路问题 + 比较架构，适合复杂需求）"` → `MODE=full`
   - `"轻量分支（范围小、已想清楚的改动，跳过并行探索/拷问/架构）"` → `MODE=light`

记住 `MODE`，P1.4 写入 `.state.mode`，后续每 phase 按 §分支模式 执行。

### P1.1 PRD 分流

若 `$ARGUMENTS` 非空：直接视为有 PRD（正文或路径），进入 P1.2。

否则 `交互提问工具`（max 4 options）：

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

从 PRD 提炼 3-5 词的英文 kebab-case slug。模糊时用 `交互提问工具` 让用户从 3 个候选中选。

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
mode: <full | light>
current_phase: P1
phase_status: completed
last_updated: <ISO 8601 now>
verifier_attempts: {}
artifacts:
  - requirement.md
```

### P1.4b 落盘 .studio（供 studio 可视化读取本会话对话 + 续聊）

`Bash`（失败不影响主流程）：
```
CC_PROJ="$HOME/.claude/projects/$(printf '%s' "$PWD" | sed 's/[^a-zA-Z0-9]/-/g')"
SID=$(ls -t "$CC_PROJ"/*.jsonl 2>/dev/null | grep -v '/agent-' | head -1 | xargs -r basename | sed 's/\.jsonl$//')
printf 'cwd: %s\nsdk_session_id: %s\n' "$PWD" "$SID" > "${SESSION_DIR}/.studio"
```

记录当前 cwd 与本会话的 SDK session id（取该 cwd 项目目录下最新的 `.jsonl` = 当前会话）。
有了它，终端跑的会话也能在 studio 里查看全程对话并续聊；缺失也不影响命令本身。

### P1.5 verifier 校验 requirement.md

调 verifier：

```
Agent(
  subagent_type="prd-check-verifier",
  prompt="""
  phase: P1
  session_dir: ${SESSION_DIR}
  contracts_file: ${CONTRACTS_FILE}
  """
)
```

pass 进 P2，fail 让用户重写 / 补充内容。

### P1 输出

```
✅ P1 完成
   session：${SESSION_DIR}
   requirement.md 已落盘
```

---

## P2 — Probe（代码探索 + PRD 假设验证）

进 P2 第一步：写 `.state` (current_phase: P2, phase_status: in_progress)。

> **`mode: light` 时**（见 §分支模式）：只起下面 **Agent 3（假设验证视角）一个** code-explorer 即可，跳过 Agent 1/2；code-facts.md 仅含假设验证摘要 + 实体定位 + 盲区 + gap，不要求架构/相似功能深挖。探索若发现改动远超"轻量"预期，先走升级闸（交互提问工具问是否切回完整流程，选是则置 `mode: full` 继续）。

### P2.0 相关历史会话检索（记忆的第二层：按需捞细节）

project-map 是精炼的常驻先验，**刻意不含 session 级细节**（具体方案/拷问/踩坑经过）。这些细节留在各历史会话的产物里；本步按需把**与本次 PRD 相关**的历史会话捞回来，补上 map 之外的上下文。

1. `Bash ls ${PROJECT_DIR}/sessions` 列出本项目所有历史会话（目录名即 `<日期>-<slug>`，标题已足够判相关，**零成本，不用读内容**）。
2. 主 Claude 按当前 PRD 主题，从标题挑出**相关**的历史会话（通常 0–3 个；明显无关的直接略过，不要为凑数硬扯）。
3. 对挑中的，`Read` 其关键产物作先验（存在才读，按需）：
   - `tech-design.md`（上次的**方案决策** —— 复用、别重推、别自相矛盾）
   - `prd-check.md`（上次**已拷问过的边界/问题/结论** —— 直接站在肩膀上，别重复问）
   - 需要时再看 `requirement.md` / `review-doc.md`。
4. 把捞到的相关决策与结论，连同 map、code-facts 一起，作为 **P3 拷问、P4 方案** 的先验依据。
5. 无相关历史会话则一句话说明"无相关历史"并跳过。

> 边界：只挑标题相关的、最多约 3 个，只读关键 artifact——避免上下文膨胀。这是"用到才检索"，不是每次全读。

### P2.1 并行 3 个 subagent

并行调（同一消息内 3 个 Agent 调用，按工具约定的 `Agent(...)` 形式）。

> **先验注入**：若 `${PROJECT_DIR}/project-map.md` 存在，**每个 code-explorer 的 prompt 第一行都加**：`先 Read ${PROJECT_DIR}/project-map.md（本项目记忆：模块地图/领域概念/关键约定），据此聚焦探索、不重复已知结论`。让记忆指导探索方向，避免重新摸索已沉淀的结构。

**Agent 1 — code-explorer（架构视角）**

```
Agent(
  subagent_type="code-explorer",
  prompt="""
  围绕 ${PROJECT_ROOT}，针对以下 PRD 做架构视角探索：

  PRD：
  @${SESSION_DIR}/requirement.md

  任务：
  1. 找到与本需求相关的核心模块、抽象、流程
  2. 列 5-10 个最值得读的关键文件（file:line）
  3. 总结：现有架构如何 / 抽象层级 / 数据流方向

  返回结构化总结。
  """
)
```

**Agent 2 — code-explorer（相似功能视角）**

```
Agent(
  subagent_type="code-explorer",
  prompt="""
  围绕 ${PROJECT_ROOT}，针对以下 PRD 寻找**相似已有功能**：

  PRD：
  @${SESSION_DIR}/requirement.md

  任务：
  1. 找已有最像的 1-2 个功能，trace 其完整实现
  2. 列具体可借鉴的代码片段（file:line）
  3. 指出哪些可直接复用、哪些要改造

  返回结构化总结。
  """
)
```

**Agent 3 — code-explorer（PRD 假设验证视角）**

```
Agent(
  subagent_type="code-explorer",
  prompt="""
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
  """
)
```

### P2.2 合并 3 份返回到 code-facts.md

收到 3 个 agent 返回后，主 Claude 合并写 `${SESSION_DIR}/code-facts.md`，结构：

```markdown
# 代码事实清单 — <feature-slug>
Date: <date>

## PRD 假设验证摘要
（来自 Agent 3 的摘要 3-8 行）

## 具名实体定位
| 实体 | 类型 | 位置 / 状态 | 备注 |
|---|---|---|---|
| ... | 接口 | src/x.py:42 | ... |
| ... | 字段 | （PRD 新增） | ... |

## ⚠️ 未定位实体（探索盲区）
> PRD 提到、但本轮探索**既没找到对应代码、也无法确定是否为新增**的实体。
> 这些是 P3 拷问的盲区——**不许静默丢弃**，必须在此列出，P3 据此判断哪些问题缺代码依据。
> 若为空，写"无"。
- 实体 X：未能定位（已 Grep `xxx` / `yyy` 无果），原因：……

## PRD-代码 gap 列表
- gap 1：...
- gap 2：...

## 代码事实清单
（来自 Agent 1 / 2 的关键文件列表 + 一句话职责）
```

`Write` 到 `${SESSION_DIR}/code-facts.md`。

### P2.3 verifier 校验

```
Agent(
  subagent_type="prd-check-verifier",
  prompt="""
  phase: P2
  session_dir: ${SESSION_DIR}
  contracts_file: ${CONTRACTS_FILE}
  """
)
```

`pass=true` 进 P3。`pass=false` 走 §错误处理。

### P2 输出与 .state

写 .state (current_phase: P2, phase_status: completed, artifacts append: code-facts.md)。

```
✅ P2 完成
   code-facts.md 已生成，verifier 通过
```

---

## P3 — Interrogate（8 镜头拷问）

进 P3 第一步：写 `.state` (current_phase: P3, phase_status: in_progress)。

> **`mode: light` 时走 P3-lite·关键澄清**（见 §分支模式）：不做 8 镜头全扫、**不产 prd-check.md**、不调 P3 verifier。只基于 P2 的 code-facts 挑出 **0–3 个真正阻塞实现的问题**用交互提问工具问用户（无阻塞则一句话说明"无阻塞问题"直接进 P6）。答完写 `.state`(P3 completed) 后**直接跳到 P5-lite**（跳过 P4）。下面 P3.1–P3.5 仅完整流程执行。

### P3.1 加载方法论

`Read` `${CLAUDE_PLUGIN_ROOT}/references/prd-check-lenses.md` 作为拷问方法论权威。

### P3.2 生成拷问问题清单（用 code-facts.md 做依据）

`Read` `${SESSION_DIR}/code-facts.md`，作为每条问题"依据"字段的素材库。

按 8 镜头逐一扫描 PRD：

1. 逻辑完整性
2. 用户操作路径
3. 边界条件
4. 限制与配额
5. 异常与错误处理
6. 新数据结构
7. 旧数据迁移
8. 权限 / 可见性 / 合规（谁能做 / 谁能看 / 留不留审计痕迹 / 敏感数据业务要求；涉敏感数据或多角色访问时升 P0）

**只识别 PRD-TBD（业务层面）**；发现工程选型岔路口的，记入「工程选型线索」章节给 P4 参考，不向用户提问。

对每条问题：
- 三元标签：`[P0|P1|P2][PRD-TBD][<镜头名>]`
- 一句话问题
- 依据（引 code-facts.md 中的 file:line 或 PRD 段落）
- 候选答案：A / B / C

**依据刚性要求（防 P2 盲区伪装成已验证）**：
- 每条 P0/P1 问题的「依据」必须落到 code-facts.md 的具体 file:line 或 PRD 具体段落。
- 若该问题涉及 code-facts.md「未定位实体（探索盲区）」中的实体、或你找不到任何代码依据，**必须**在依据行显式标 `[依据缺失]` 并一句话说明缺什么，**不许**用含糊措辞糊弄成"已验证"。
- P3 输出末尾汇总「依据缺失」问题条数；>0 时在展示给用户前明确提示"有 N 条问题缺代码依据，可能需补 P2 探索"。

### P3.3 初版落盘

`Write` 到 `${SESSION_DIR}/prd-check.md`，结构遵循 `prd-check-lenses.md` 中的「文件结构」节：

```markdown
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

### 8 镜头记录
#### 1. 逻辑完整性
#### 2. 用户操作路径
#### 3. 边界条件
#### 4. 限制与配额
#### 5. 异常与错误处理
#### 6. 新数据结构
#### 7. 旧数据迁移
#### 8. 权限 / 可见性 / 合规
```

（8 镜头记录子节即便某面镜下无 PRD-TBD 也保留空标题。）

### P3.4 初版结构自检

主 Claude 用 `Grep -nE` 自查 `${SESSION_DIR}/prd-check.md` 是否含全部 8 镜头 H4 小节 + 3 个 P0/P1/P2 三级小节 + 工程选型线索 H2 节。

> 不在此处调 verifier（verifier 会因「**答**」未填报 violations）。结构自检通过即进入 P3.5。

### P3.5 用户答 → Edit 回写

把问题清单展示给用户。对每条问题（按 P0 → P1 → P2 顺序展示）：

`交互提问工具`：单选 / 用户自由文本。

每收到一个答：

`Edit` `${SESSION_DIR}/prd-check.md`，在对应问题块内追加：

```
   **答**（YYYY-MM-DD）：<用户答案>
```

**禁止**只把答案留在对话里。

> 节流提示：若 P3 总问题数 > 10，先告诉用户预估总数与时长（如"共 12 条，预估 8 分钟"），并允许用户选"我先批量答 A/B/C"。

### P3.6 verifier 终版校验

所有问题答完后再调 verifier `phase: P3`：

```
Agent(
  subagent_type="prd-check-verifier",
  prompt="""
  phase: P3
  session_dir: ${SESSION_DIR}
  contracts_file: ${CONTRACTS_FILE}
  """
)
```

预期 pass。fail 走 §错误处理。

### P3 输出与 .state

写 .state (current_phase: P3, phase_status: completed, artifacts append: prd-check.md)。

```
✅ P3 完成
   prd-check.md 已生成 + 全部答 + verifier 通过
```

---

## P4 — Architect（并行 2-3 个 code-architect）

> **`mode: light` 时整段跳过**（见 §分支模式）：不起并行 architect、不产竞争方案。主 Claude 基于 P2 code-facts 与 P3-lite 的澄清结果**内联决定实现方案**，直接进 P5-lite。下面 P4.1+ 仅完整流程执行。

进 P4 第一步：写 `.state` (current_phase: P4, phase_status: in_progress)。

### P4.1 并行调 code-architect

`Read` `${SESSION_DIR}/prd-check.md` 中的「工程选型线索」节作为额外输入。

并行调 `${SUBAGENT_PARALLEL_ARCH}` 个（默认 2 个，复杂需求可手动 3 个）：

**Agent 1 — 最小改动方案**

```
Agent(
  subagent_type="code-architect",
  prompt="""
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
  """
)
```

**Agent 2 — 干净架构方案**

```
Agent(
  subagent_type="code-architect",
  prompt="""
  针对以下需求设计**干净架构**方案（优雅抽象、可维护性优先）：

  @${SESSION_DIR}/requirement.md
  @${SESSION_DIR}/prd-check.md
  @${SESSION_DIR}/code-facts.md

  要求同 Agent 1：文件清单 + 核心设计决策 + 影响范围 + 难度估算。
  """
)
```

（如选 3 个，加 **Agent 3 — 务实平衡方案**：在 Agent 1 与 Agent 2 之间取折衷，明确"放弃 X 换 Y"的取舍）

### P4.2 主 Claude 整理对比

收到 2-3 份方案后，主 Claude 在对话里输出方案对比：

```
| 维度 | 方案 A（最小改动） | 方案 B（干净架构） |
|---|---|---|
| 改动文件数 | 3 | 8 |
| 新抽象 | 无 | 引入 BatchRunner 接口 |
| 估算难度 | 小 | 中 |
| 关键风险 | 复用现有 batch 路径耦合 | 需要重构 review_service |
```

并给出**主 Claude 自己的推荐 + 理由**（基于此项目阶段和需求复杂度）。

### P4.3 verifier 校验方案对比内容

此 phase 产出在内存（暂未落盘 `tech-design.md`，那是 P5 的事）。verifier 此时**跳过 P4**（contracts 文件中 P4 没有 artifact 定义）。

主 Claude 只做语义自检：至少 2 个候选 + 每个含推荐理由 + 影响范围。

### P4 输出与 .state

写 .state (current_phase: P4, phase_status: completed)。

```
✅ P4 完成
   <N> 个架构方案就绪 + 推荐：方案 <X>
```

---

## P5 — Review Gate（实现前强制评审 checkpoint）

> **`mode: light` 时走 P5-lite·轻量 confirm**（见 §分支模式）：**不产 tech-design.md**、不调 P5 verifier。主 Claude 用一句话概述「要改哪些文件 + 怎么改」（基于 P4 内联决定的方案），用交互提问工具让用户 `approve` / `调整某处`；approve 后写 `.state`(P5 completed) 进 P6。下面 P5.1–P5.x 仅完整流程执行。

进 P5 第一步：写 `.state` (current_phase: P5, phase_status: in_progress)。

### P5.1 用户先选方案

`交互提问工具`：
- "选哪个方案推进？"
- 选项：方案 A / 方案 B / (方案 C) / "都不满意，回 P4 重出"
- 选"都不满意"：标记 P5 reject → 跳到 §6.3 重出流程

### P5.2 按选定方案生成 tech-design.md

`Read` `${CLAUDE_PLUGIN_ROOT}/references/output-templates.md` 中模板 A。

按模板填充：
- 关联 PRD: `requirement.md`
- 拷问记录: `prd-check.md`
- **核心设计决策**：来自 P4 选定方案 + 主 Claude 自己补的小决策
- **变更清单**：来自 P4 选定方案的文件清单
- **数据流与时序**：主路径文字描述（不画图，必要时 ASCII）
- **异常与边界处理**：来自 prd-check.md P1 节
- **配置与开关**：若涉及 env / flag
- **依赖 & 影响范围**：来自 P4 影响范围
- **未尽事项 / TODO**：留空或写 P5 未答的边角

`Write` 到 `${SESSION_DIR}/tech-design.md`。

### P5.3 verifier 校验 tech-design.md

```
Agent(
  subagent_type="prd-check-verifier",
  prompt="""
  phase: P5
  session_dir: ${SESSION_DIR}
  contracts_file: ${CONTRACTS_FILE}
  """
)
```

`pass=true` 进 P5.4。`pass=false` 走 §错误处理（回炉补节）。

### P5.4 用户评审 + 决策

把 tech-design.md 路径 + 关键节摘要展示给用户。

`交互提问工具` 4 选项：
1. `"approve，进入实现"` → 进 P6
2. `"调整某处再 approve（接下来告诉你哪里改）"` → 留在 P5 等用户具体指令，主 Claude `Edit` tech-design.md，改完重跑 P5.3 verifier + P5.4 交互提问工具
3. `"重出方案（回 P4）"` → 走 §6.3 重出流程
4. `"暂存，稍后再说"` → 写 .state (phase_status: in_progress)，输出 session 路径让用户后续 resume

### P5 输出与 .state

approve 后写 .state (current_phase: P5, phase_status: completed, artifacts append: tech-design.md)。

```
✅ P5 完成
   tech-design.md 已 approve
```

---

## P6 — Implement（主 Claude 顺序写代码，不调 subagent）

进 P6 第一步：写 `.state` (current_phase: P6, phase_status: in_progress)。

### P6.1 准备实现 checklist

从 `tech-design.md` 的「变更清单」节抽出所有 `新增 / 修改 / 删除` 项，转成 `IMPL_CHECKLIST`（内存中，每项含 file + 动作 + 一句描述）。

> **`mode: light` 时**：无 tech-design.md，`IMPL_CHECKLIST` 取自 P5-lite confirm 时概述并经用户 approve 的「要改哪些文件 + 怎么改」。其余 P6 逻辑相同。

### P6.2 逐项实现

对 IMPL_CHECKLIST 中每一项：
- 如该文件之前没读过 → `Read` 当前内容
- `Write` 新文件 / `Edit` 已有文件
- 每改一个文件就在 .state 的 `modified_files` 列表里追加路径

> 注意：主 Claude 自己写，不调 code-architect 写。code-architect 是出方案的，不是码农。

### P6.3 自检 — 变更清单 vs 实际修改一一对照

`Bash`：
```
# 用 .state 的 modified_files 列表对照 tech-design.md 的变更清单
```

任何遗漏在 IMPL_CHECKLIST 中但未实际修改的，回 P6.2 补。

### P6 输出与 .state

写 .state (current_phase: P6, phase_status: completed)。

```
✅ P6 完成
   实际修改：<N> 个文件
```

---

## P7 — Quality Review（并行 3 个 code-reviewer）

进 P7 第一步：写 `.state` (current_phase: P7, phase_status: in_progress)。

> **`mode: light` 时只起 1 个 code-reviewer**（见 §分支模式）：用下面 Agent 1（简洁性/正确性综合视角）一个，prompt 里让它一并兼顾正确性与边界，跳过并行的 Agent 2/3。其余汇总逻辑相同。

### P7.1 并行调 3 个 reviewer

并行调 `${SUBAGENT_PARALLEL_REVIEW}` (=3) 个：

**Agent 1 — 简洁性 / DRY / 优雅**

```
Agent(
  subagent_type="code-reviewer",
  prompt="""
  Review 以下变更（从 ${PROJECT_ROOT}），重点关注**简洁、DRY、优雅**：

  本次实现的文件清单（来自 .state.modified_files）：
  - file1
  - file2
  ...

  原始需求与方案：
  @${SESSION_DIR}/requirement.md
  @${SESSION_DIR}/tech-design.md

  请按问题严重度分级（critical / major / minor）。返回结构化清单。
  """
)
```

**Agent 2 — bug / 功能正确性**

```
Agent(
  subagent_type="code-reviewer",
  prompt="""
  Review 同一批变更，重点关注**bug、边界、错误处理**。

  对照拷问记录：
  @${SESSION_DIR}/prd-check.md
  各条「答」涉及的边界 / 异常处理在代码里是否真实落地？

  按严重度分级返回。
  """
)
```

**Agent 3 — 项目约定**

```
Agent(
  subagent_type="code-reviewer",
  prompt="""
  Review 同一批变更，重点关注**项目约定**（命名、错误码、日志、模式）。

  先 `Read ${PROJECT_DIR}/project-map.md` 对照项目记忆，特别是「六、关键约定」节
  （命名 / 错误码 / 日志 / 模式），看本次实现是否违背既有约定。

  按严重度分级返回。
  """
)
```

### P7.2 共识汇总 + 修

主 Claude 收到 3 份后做共识汇总（≥2 个 reviewer 提到的同一问题为高优）：

`交互提问工具`：
- "高优问题修了再走？"
- 选项：
  1. `"我来主导修，所有 critical/major 修完"`
  2. `"只修 critical，major 留给后续"`
  3. `"我看一眼报告自己来"`
  4. `"先放过，所有问题都不修"`

按选择修代码。每修一处更新 .state 的 modified_files。

### P7.3 verifier 校验（无 artifact，只校验"高优问题已处理"）

contracts 文件中 P7 没有 artifact 契约。主 Claude 自检：所选用户分类内的问题是否全部处理。

### P7 输出与 .state

写 .state (current_phase: P7, phase_status: completed)。

```
✅ P7 完成
   3 reviewer 报告整合，<N> 个高优问题处理完毕
```

---

## P8 — Deliver & Sync（交付文档 + 回写 project-map）

进 P8 第一步：写 `.state` (current_phase: P8, phase_status: in_progress)。

> **`mode: light` 时走 P8-lite**（见 §分支模式）：默认**跳过 P8.1 的交付文档**（api-test.md / tech-design.md），直接做 P8.2 回写 project-map（含 sync marker）。除非用户主动说要文档，才跑 P8.1。

### P8.1 是否要 api-test.md

`交互提问工具`：
1. `"要"`
2. `"不要（无新接口或不需要文档）"`

选要：
- `Read` `${CLAUDE_PLUGIN_ROOT}/references/output-templates.md` 模板 B
- 按模板填字段表 / 错误码表 / 测试用例表 / curl
- 数据源：实际改动的 API 接口文件 + tech-design.md
- `Write` 到 `${SESSION_DIR}/api-test.md`
- 调 verifier：

  ```
  Agent(
    subagent_type="prd-check-verifier",
    prompt="""
    phase: P8
    session_dir: ${SESSION_DIR}
    contracts_file: ${CONTRACTS_FILE}
    """
  )
  ```

  fail 走 §错误处理。

选不要：跳过。

### P8.2 回写 project-map.md

> **定源原则（关键）**：map 的**结构层**（二、业务功能 / 三、技术栈 / 四、模块地图 / 五、领域概念）是**当前代码的投影**——由 `/feature-flow:studio` 的「更新」或 P0 漂移刷新**从代码重新生成**，**P8 不手写、不增量编辑这些节**。原因：session 的设计/实现会被反复改动甚至推翻（如某对账方案原型化后又移除），写进结构层就会随代码漂移而说谎。
> P8 只沉淀**代码里看不出来、且稳定耐久**的东西。

`Read` `${PROJECT_DIR}/project-map.md`。本次回写**只允许**动这几处：

| 触发（必须是稳定、非显而易见、代码看不出的） | 更新小节 |
|---|---|
| 本次**定下并会长期沿用**的新约定（命名/错误码/DB 模式…） | 六、关键约定 |
| 本次**踩到或确认**的坑 / 反模式 / "试过 X 已回退别再来" | 七、非显而易见之处 |
| 每次必写：一行变更摘要 | 九、最近变更 |

`Edit` 精确追加；没有稳定经验可沉淀时，**只写 九、最近变更 即可**。

**严禁**：
- 手写/编辑 二/三/四/五 结构层（那是代码投影，靠「更新」重生，不靠 P8）。
- 写行号（`:23-150`）、函数级调用链、本次的实现细节——属于 session 文档（tech-design.md / review-doc.md），不进 map。
- 把"本次刚实现/正在做"的设计当成稳定结论写进去——它可能下次就被推翻。

> 结构若因本次开发有实质变化，**不在 P8 手改**；在 九、最近变更 记一行，结构由下次「更新」从代码重新投影。

**最后必更新「九、最近变更」节**：追加一行

```
- <date> <feature-slug>：<一句话摘要，≤30 字>
```

只保留最近 10 条（删旧的）。

**记录同步点（供 P0 漂移检测）**：若 `${PROJECT_ROOT}` 是 git 仓库，`Bash git -C ${PROJECT_ROOT} rev-parse HEAD 2>/dev/null` 取当前 commit，把「九、最近变更」节标题行更新为：

```
## 九、最近变更（last_synced_commit: <sha7> @ <date>）
```

非 git 仓库则写 `last_synced_commit: n/a @ <date>`。这是 P0 判断 map 是否过期的锚点。

回写完后调 verifier `phase: P8-Map`（contracts 文件中的回写后增量检查）：

```
Agent(
  subagent_type="prd-check-verifier",
  prompt="""
  phase: P8-Map
  session_dir: ${PROJECT_DIR}
  project_dir: ${PROJECT_DIR}
  contracts_file: ${CONTRACTS_FILE}
  """
)
```

### P8.3 final .state

写 .state (current_phase: P8, phase_status: completed, artifacts: 全部列出)。

### P8 输出

```
✅ /feature-flow 完成
   项目：${PROJECT_ID}
   session：${SESSION_DIR}
   交付：<已生成的 md 列表>
   project-map 更新：<更新的小节>
   下次 /feature-flow，此项目上下文自动复用。
```

---

## §6 错误处理

### §6.1 verifier 单轮失败 → 回炉

任一 phase verifier 返回 `pass=false`：

1. 读 verifier 返回的 `missing` + `violations` + `suggest`
2. 针对性修产出文件（`Edit` 补章节 / 改违规模式 / 补具体内容）
3. 重跑 verifier
4. 自增 `.state.verifier_attempts[Pn] += 1`

最多 `${VERIFIER_MAX_RETRY}` 轮（默认 2）。

### §6.2 verifier 连续 2 轮失败 → 兜底 4 选项

`Write` `${SESSION_DIR}/.verifier-blocked.md`，内容：

```
# Verifier 阻塞 — Pn @ <ISO time>

## 最后一次产出节选
（artifact 文件最末段 50 行）

## verifier 不通过原因
- missing: ...
- violations: ...

## 建议方向
- suggest from verifier
```

写 .state `phase_status: failed`。

`交互提问工具` 4 选项：
1. `"我手动改 ${SESSION_DIR}/<artifact>，改完回来"` → 用户手动 Edit 后回到对话说"改完了"，主 Claude 重跑 verifier
2. `"放过本次 verifier 继续"` → .state 写 `bypassed_phase: Pn`，继续下一 phase
3. `"退到 P<n-1> 重做"` → 写 .state `current_phase: P<n-1>`，artifact 保留
4. `"终止 /feature-flow"` → 写 .state `phase_status: failed` 后退出

### §6.3 P5 重出方案流程

当 P5.4 用户选"重出"或 P5.1 用户选"都不满意"：

1. `Bash cp ${SESSION_DIR}/tech-design.md ${SESSION_DIR}/tech-design.md.v<N>.bak`（递增 N）
2. `Bash rm ${SESSION_DIR}/tech-design.md`
3. 清空 P4 内存方案对比
4. 写 .state (`current_phase: P4, phase_status: in_progress`)
5. 回 §P4.1 重跑 code-architect 并行（可调换 prompt 视角，如让用户告诉哪个方向"更近"）
6. 完成后回 P5.2 生成 tech-design.md v2
7. `prd-check.md` 保留不动

---

## §7 硬规则（编排者必须遵守）

1. **必须确认项目身份**（P0.2 不可省）。不因 cwd 在某项目就自动默认
2. **必须 Resume 先检测**。有未完成 session 不询问直接新建是反模式
3. **必须落盘所有产出**。`prd-check.md` / `code-facts.md` / `tech-design.md` / `api-test.md` 永不只留在对话里
4. **必须 .state 原子写**（先 `.state.tmp` 后 `mv`）
5. **必须用 verifier**，不能主 Claude 自检产出代替
6. **禁止** "可能需要进一步确认" / "建议团队评估" / "[DEV-DECIDE]" 出现在 prd-check.md
7. **禁止** 静默跳过 verifier 失败。任一 phase 失败 ≥2 轮必须走 §6.2 兜底询问用户
8. **禁止** P3 拷问问业务以外（工程选型归 P4，写入「工程选型线索」节）
9. **禁止** P6 调 subagent 写代码（主 Claude 自己写）
10. **禁止** 删除 `commands/feature-flow.legacy.md`（保留 2 周回退窗口）
