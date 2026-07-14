# /feature-flow v2 设计文档

- Date: 2026-05-18
- Status: Approved (brainstorming 阶段)
- Owner: lei.liao@freelexai.com
- 前身：`commands/feature-flow.md`（wrapper feature-dev 形态，v1）

---

## 1. 背景与动机

v1 的 `/feature-flow` 是 `feature-dev:feature-dev` 的 wrapper：自己做 Pre（项目认知 + PRD 分流）和 Post（交付物 + 回写 map），中间通过 Skill args 注入巨型 prose 指令给 feature-dev 来"强制"7 镜头拷问、PRD 假设验证、答案回写等方法论。

实际落地后暴露的根本问题：**方法论变成 feature-dev 的附庸**。

- args 注入靠 prose，下游 skill 内部 phase 流转不可控，硬规则全是"求"不是"强制"
- 无任何 verifier 机制，产出文件缺章节、缺标签、缺答都能静默通过
- feature-dev 升级 / system prompt 调整会把 wrapper 的覆盖吃掉
- 模型在长上下文里 lost-in-the-middle，注入规则被遗忘

v2 的核心动作：**主 Claude 拿回编排权**，feature-dev 的 3 个 subagent 作为稳定零件被调用，方法论变成可由 verifier subagent 校验的硬契约。

---

## 2. 架构骨架

### 2.1 定位

`/feature-flow` v2 是后端需求端到端的**编排器**。主 Claude 是唯一编排者；feature-dev 的 `code-explorer` / `code-architect` / `code-reviewer` 作为稳定零件被 `Agent(subagent_type=...)` 调用，**不再依赖** `feature-dev:feature-dev` 这个 skill。

### 2.2 三层结构

```
┌─────────────────────────────────────────────────────┐
│  /feature-flow 命令（主 Claude，编排 8 个 phase）    │
│  - AskUserQuestion / Read / Write / Edit            │
│  - phase 之间写 .state，支持中断恢复                 │
└──────────────────┬──────────────────────────────────┘
                   │ Agent(subagent_type=...)
       ┌───────────┴────────────┐
       ▼                        ▼
┌─────────────────┐    ┌──────────────────┐
│ feature-dev     │    │ prd-check-       │
│ 3 个 subagent   │    │ verifier         │
│ (借零件)        │    │ (本插件新增)     │
└─────────────────┘    └──────────────────┘
```

### 2.3 方法论 source of truth

`references/` 下三份模板是唯一权威：

- `prd-check-lenses.md`：7 镜头拷问方法论
- `project-map-template.md`：项目骨架认知模板
- `output-templates.md`：tech-design / api-test 交付模板

命令文件 `commands/feature-flow.md` **只引用不内联**——v1 把方法论复制一份当 args 注入是反模式，v2 禁止。

### 2.4 砍掉的 v1 设计

- 不再 `Skill` 调用 `feature-dev:feature-dev` + 巨型 args 注入
- 不再在命令文件内联方法论（双源真理）
- 砍掉 `light` / `full` 分支（5 个真实 session 全是 full，YAGNI）
- 砍掉 prd-check 里的 `DEV-DECIDE` 标签（已演进，工程选型归 P4 code-architect 处理）

---

## 3. 8 Phase 完整契约表

| # | Phase | 主要动作 | Subagent 调用 | 产出文件 | Verifier 检查 | 失败动作 |
|---|---|---|---|---|---|---|
| **P0** | Context Load | 检测 cwd / 列已有项目 / `AskUserQuestion` 确认项目身份 | — | `.state` 初始化 | `${PROJECT_DIR}` 路径存在 | 终止 |
| **P0.5** | Map Init *(仅首次)* | 扫项目骨架 + 用户补 3-4 问 | `Agent(Explore, medium)` ×1 | `project-map.md` | 含模板 8 节中 ≥6 节 | 回炉 ≤2 轮 |
| **P1** | PRD Intake | 分流（粘贴 / 路径 / 口述）→ 命名 slug → 建 session | — | `requirement.md` | 非空，含目标 | 终止 |
| **P2** | Probe | code-explorer 并行 2 个（架构视角 + 相似功能） + 专跑 PRD 假设验证 1 个 | `code-explorer` ×3 | `code-facts.md` | 含「PRD 假设验证摘要」节 + ≥3 个具名实体标注 `file:line` | 回炉 ≤2 轮 |
| **P3** | Interrogate (7 镜头) | 主 Claude 按 `prd-check-lenses.md` 拷问；每答立即 `Edit` 回写 | — | `prd-check.md` | 7 节齐全；每条 `[Px][PRD-TBD][镜头]` 三元标签 + 依据 + 候选答案 + 答 | 回炉 ≤2 轮 |
| **P4** | Architect | code-architect 并行 2-3 个（最小改动 / 干净架构 / 务实平衡）；消化 prd-check 的「工程选型线索」 | `code-architect` ×2-3 | （内存中持有方案对比） | ≥2 候选 + 每个含推荐理由 + 候选影响范围（涉及目录/模块清单） | 回炉 ≤2 轮 |
| **P5** | Review Gate | 生成 `tech-design.md`（按 `output-templates.md` 模板 A）→ 跑 verifier → 通过后 `AskUserQuestion`: approve / 调整 / 重出 | — | `tech-design.md` v1 | 含「核心设计决策」+「变更清单」非空 | verifier 失败 → 回炉 ≤2 轮；user reject 流程见 §6.3 |
| **P6** | Implement | 主 Claude 按 approved 方案顺序写代码；每个文件改完即落盘；不调 subagent | — | 实际代码 + `.state` 记录修改文件清单 | approved 方案中所有变更点都有对应 `file:line` 改动 | 回炉补漏 |
| **P7** | Quality Review | code-reviewer 并行 3 个（简洁性 / bug / 项目约定）+ 共识高优问题 → 主 Claude 修 | `code-reviewer` ×3 | reviewer 报告内嵌 + 修正 commit | 三个 reviewer 报告全部回来 + 高优问题已修或用户明确放过 | 回炉 ≤2 轮 |
| **P8** | Deliver & Sync | `AskUserQuestion`: 是否要 `api-test.md` → 按需生成 → 回写 `project-map.md`「最近变更」+ 按需更新模块/概念/约定 | — | `api-test.md`（可选）+ map 增量 | api-test 若产出则含字段表/错误码表/curl；map 增量行 ≤30 字 | 回炉补 |

### 3.1 关键设计点

1. **subagent 并行数固定**：P2 调 3 个（2 探索 + 1 PRD 验证），P4 调 2-3 个（按需），P7 调 3 个。不让模型现编。
2. **P5 "重出方案" 不丢 prd-check.md**：只回 P4 重跑 architect，拷问记录保留。
3. **P6 主 Claude 自己写**：不调 subagent，避免上下文割裂、补丁碎片化。
4. **verifier 回炉上限 2 轮**：超过 2 轮报告"方法论与现实冲突，需手动介入"并停在该 phase 走 §6.2 兜底，不静默通过、不无限循环。
5. **`.state` 文件每 phase 末刷新**：原子写（`.state.tmp` → `mv`）。
6. **P0.5 只在首建项目时跑**：已有 `project-map.md` 跳过。

---

## 4. 数据目录与状态恢复

### 4.1 目录布局

```
${PLUGIN_ROOT}/                           # /Users/liaolei/plugins/feature-flow
├── .claude-plugin/plugin.json
├── commands/feature-flow.md              # v2 命令本体（编排器）
├── commands/feature-flow.legacy.md       # v1 备份，2 周后删
├── agents/
│   └── prd-check-verifier.md             # 新增
├── references/                           # 方法论 source of truth
│   ├── prd-check-lenses.md
│   ├── project-map-template.md
│   ├── output-templates.md
│   └── verifier-contracts.md             # 新增
└── data/projects/<PROJECT_ID>/
    ├── project-map.md
    └── sessions/<YYYY-MM-DD>-<feature-slug>[-NN]/
        ├── .state                        # 新增
        ├── requirement.md
        ├── code-facts.md                 # 新增（v1 缺）
        ├── prd-check.md
        ├── tech-design.md
        └── api-test.md
```

### 4.2 `.state` 文件格式

```yaml
session_id: 2026-05-18-batch-review-limit
project_id: contract-review
current_phase: P3
phase_status: completed       # completed | in_progress | failed
last_updated: 2026-05-18T15:42:11+08:00
verifier_attempts:
  P2: 1
  P3: 0
artifacts:
  - requirement.md
  - code-facts.md
  - prd-check.md
```

**状态机约定**：

- 进入 phase Pn 第一步：原子写 `current_phase: Pn, phase_status: in_progress`
- phase 内 verifier 通过：原子写 `current_phase: Pn, phase_status: completed`，**再**推进到下一 phase
- 恢复时读到 `phase_status: completed` 表示该 phase 已收尾，从**下一**phase 开始；读到 `in_progress` 表示该 phase 未完，从该 phase 重入

### 4.3 命名冲突处理

同一天同一 slug 跑两次：

- 检测到 `<date>-<slug>/` 已存在 → 自动加后缀 `-02`，依次 `-03`
- 不覆盖、不询问；日志输出一行 `📁 session 名冲突，使用 <new-name>`

### 4.4 恢复流程

`/feature-flow` 启动时先扫 `data/projects/<PROJECT_ID>/sessions/` 找最近 7 天内 `phase_status != completed` 或 `current_phase != P8` 的 session：

```
检测到未完成 session：
  - 2026-05-17-export-bug-fix（停在 P5 等评审，1 天前）

如何处理？
  → 1. 继续这个 session（从 P5 评审继续）
  → 2. 新建（这个先放着）
  → 3. 看一眼 prd-check.md / tech-design.md 再说
  → 4. 标记为废弃（在 .state 写 abandoned，不再提醒）
```

`RESUME_WINDOW_DAYS = 7`。超过 7 天的当作废弃不打扰，目录保留供 grep 历史。

---

## 5. Verifier Subagent 设计

### 5.1 为什么独立 subagent 而不是主 Claude 自检

上下文隔离才能做诚实校验。主 Claude 写完 `prd-check.md` 自己审，会有"我刚写的应该 OK"的惰性偏见；独立 subagent 只看产出文件 + 契约定义，没有立场。

### 5.2 verifier 文件形态

`agents/prd-check-verifier.md`（一个 verifier 跑所有 phase，靠参数分流）：

```yaml
---
name: prd-check-verifier
description: 校验 /feature-flow 各 phase 产出文件是否符合契约。被主命令调用，不应被用户直接触发。
tools: Read, Grep, Glob
---

# 任务
读取 `references/verifier-contracts.md` 中 phase 对应的契约，
检查 `${SESSION_DIR}/<artifact>` 文件，返回结构化判定：
{ pass: bool, missing: [...], violations: [...], suggest: "..." }

不修改任何文件。不与用户对话。只输出 JSON。
```

### 5.3 `verifier-contracts.md` 示例（P3）

```markdown
## P3 prd-check.md 契约
必含章节：
  - "## 待解决问题清单（业务 PRD-TBD）"
  - "### P0 - 逻辑与设计"
  - "### P1 - 边界/异常/限制"
  - "### P2 - 旧数据兼容"
  - "## 工程选型线索"
  - "## 7 镜头记录"（含 7 个三级标题）
每条问题必含：
  - 三元标签 `[P0|P1|P2][PRD-TBD][<镜头名>]`
  - "依据：" 行
  - "候选答案：" 行
  - "**答**（YYYY-MM-DD）：" 行
违规示例（grep 应不命中）：
  - "可能需要进一步确认"
  - "建议团队评估"
  - "[DEV-DECIDE]"
```

verifier 用 Grep + Read 跑契约，几秒返回，主 Claude 拿 JSON 决定回炉 / 通过 / 升级到 §6.2 兜底。

---

## 6. 错误处理与恢复

### 6.1 phase 内回炉

任一 phase verifier 不通过：

1. 主 Claude 读取 verifier 返回的 `missing` / `violations` / `suggest`
2. 针对性补全 / 修正本 phase 产出
3. 重跑 verifier
4. `verifier_attempts[Px] += 1`，写回 `.state`

最多 2 轮。

### 6.2 verifier 二次失败兜底

任一 phase verifier 连续 2 轮回炉仍不过：

1. 主 Claude `Write` 把 `${SESSION_DIR}/.verifier-blocked.md` 落盘（含「最后一次产出节选」+「verifier 不通过原因」+「建议方向」）
2. `.state` 标 `phase_status: failed`
3. 提示用户 4 选项：
   - 手动改产出（用户 Edit 后回来选"继续"）
   - 放过本次 verifier 继续（写一条 `bypassed_phase: Px` 到 `.state`）
   - 退到上一 phase 重做
   - 终止本次 `/feature-flow`

不静默跳过。

### 6.3 P5 重出方案

P5 user 选"重出"：

1. 备份当前 `tech-design.md` 到 `tech-design.md.v1.bak`
2. 清空 P4 内存方案对比
3. 回 P4 重跑 code-architect 并行
4. 生成 `tech-design.md` v2 重新进 P5
5. `prd-check.md` 保留不动

`.state` 记 `phase_status: in_progress`，`current_phase: P4`。

---

## 7. 可调参数

命令文件顶部常量节，不让模型现编：

```
SUBAGENT_PARALLEL_EXPLORE  = 2   # P2 探索视角数（专跑 PRD 验证另外 1 个）
SUBAGENT_PARALLEL_ARCH     = 2   # P4 架构方案数（2 或 3）
SUBAGENT_PARALLEL_REVIEW   = 3   # P7 reviewer 数
VERIFIER_MAX_RETRY         = 2   # 每 phase verifier 回炉上限
RESUME_WINDOW_DAYS         = 7   # 检测未完成 session 的回溯窗口
MAP_AUTO_INIT_THOROUGHNESS = medium  # P0.5 首建探索深度
```

---

## 8. 测试策略

### 8.1 单元层（用真实 session 跑回归）

1. 拿现有 5 个真实 session 的 `prd-check.md` 喂 verifier，期望 4-5 个通过、1 个或多个被拦（旧版没有 7 镜头全节）— 用作 verifier 调优 fixture
2. `verifier-contracts.md` 每条规则配一个正例 + 一个反例 fixture，跑 verifier 应正反分明

### 8.2 集成层（端到端干跑）

3. 选一个轻量 feature（如"给某接口加分页"），从 P0 跑到 P8 全程，验证：
   - `.state` 每 phase 末刷新
   - verifier 至少被触发一次（构造一次"故意漏 P2 镜头小节"看是否回炉）
   - P5 评审 reject "重出方案" 能正确回 P4 且 `prd-check.md` 不丢
   - 同日同 slug 重跑能自动 `-02`

### 8.3 人工验收门

4. 由 owner 跑一个真实需求，体感 OK 才投入主力使用

---

## 9. 迁移路径

```bash
# 第 1 步：备份 v1 命令
mv commands/feature-flow.md commands/feature-flow.legacy.md

# 第 2 步：落地新增文件
# - commands/feature-flow.md（v2 编排器）
# - agents/prd-check-verifier.md
# - references/verifier-contracts.md

# 第 3 步：跑 §8 测试

# 第 4 步：投入使用，2 周稳定后删 legacy
rm commands/feature-flow.legacy.md
```

旧 `data/projects/contract-review/sessions/` 5 个历史 session 不动。新 session 走新契约。

---

## 10. 与既有资产兼容矩阵

| 资产 | 当前位置 | v2 如何用 | 是否要改 |
|---|---|---|---|
| `prd-check-lenses.md` | references/ | P3 强制 Read 为方法论权威 | 否 |
| `project-map-template.md` | references/ | P0.5 首建 + P8 回写时 Read | 否 |
| `output-templates.md` | references/ | P5 生成 tech-design / P8 生成 api-test 时 Read | 否 |
| `commands/feature-flow.md` | commands/ | 整体重写 | 全替换 |
| `data/projects/contract-review/` 5 个 session | data/ | 历史保留只读 | 否 |
| `agents/prd-check-verifier.md` | — | 新建 | 新增 |
| `references/verifier-contracts.md` | — | 新建 | 新增 |

---

## 11. 验收标准（owner 视角）

设计落地后，下面 6 条全部满足才算 v2 完成：

1. `/feature-flow` 启动到产出 `requirement.md`，过程中**不再** `Skill` 调用 `feature-dev:feature-dev`
2. P2 强制产出 `code-facts.md`，verifier 校验通过
3. P3 产出 `prd-check.md` 含 7 节 + 每条三元标签 + 答；verifier 校验通过
4. P5 生成 `tech-design.md` 后阻塞等 user approve，reject 能正确回 P4 重出且 prd-check.md 不丢
5. 中断后下次启动能正确检测未完成 session 并 4 选项询问
6. 至少跑一个真实需求端到端，owner 体感"比 v1 更省心"
