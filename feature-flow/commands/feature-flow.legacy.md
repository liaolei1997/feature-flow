<!--
DEPRECATED — v1 wrapper. v2 重写已上线，本文件保留 2 周供回退（计划删除：2026-06-01）。
如需临时使用 v1，改名回 feature-flow.md 即可。
-->
---
description: [DEPRECATED v1] 后端需求端到端开发流程，基于 /feature-dev 加三样：项目认知持久化、拷问规范注入 Phase 3、结构化交付物。
argument-hint: "[PRD 内容 | PRD 文件绝对路径，可选]"
---

# /feature-flow — feature-dev 的增强 wrapper

**本命令不重复做 /feature-dev 已做的事**（代码探索、澄清、架构、实现、review、summary）。我们只在它前后加 3 件事：

- **Pre**：交互确认项目 → 加载/初始化 `project-map.md` → 分流（有无 PRD）→ 创建 session 目录
- **Main**：用 `Skill` 工具调 `feature-dev:feature-dev`，通过 `args` 注入 ① 项目认知 ② PRD 文件 ③ **Phase 3 澄清的强制规范**（7 镜头 + P0/P1/P2 + PRD-TBD/DEV-DECIDE 标签）
- **Post**：按用户选择产出 `tech-design.md` / `api-test.md` → 回写 `project-map.md`

初始用户输入：$ARGUMENTS

---

## 常量（本命令统一路径）

- `PLUGIN_ROOT` = `${CLAUDE_PLUGIN_ROOT}`（由 Claude 运行时提供，指向此插件根目录）
- 所有持久化数据放 `${PLUGIN_ROOT}/data/projects/<PROJECT_ID>/`
- 拷问规范模板：`${PLUGIN_ROOT}/references/prd-check-lenses.md`
- project-map 模板：`${PLUGIN_ROOT}/references/project-map-template.md`
- 产出模板：`${PLUGIN_ROOT}/references/output-templates.md`

---

## Phase A — Pre（项目识别 + 分流 + session 初始化）

### A.1 定位候选项目

用 `Bash`：
```
pwd && basename "$(pwd)" && ls -la 2>/dev/null | head -20
ls "${CLAUDE_PLUGIN_ROOT}/data/projects/" 2>/dev/null
```

判断 cwd 是否像项目根（有 `.git` / `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` 等其一）。记 `CWD_BASENAME`；列出已有项目到 `EXISTING_PROJECTS[]`。

### A.2 必问确认项目（不因在项目目录就默认）

用 `AskUserQuestion` 动态构造 options（最多 4 个），按以下优先级挑前 4 个：

1. 若 cwd 像项目根：`"当前目录（<CWD_BASENAME>）"` ← 多数情况下用户会选这个
2. 最多 2 个 `EXISTING_PROJECTS` 里与 cwd 不同的项目：`"已有项目：<name>"`
3. `"新建项目（再告诉你名字和根路径）"`
4. `"取消，我先切到正确目录再跑"`（若选则终止）

根据答案设：
- 选"当前目录"→ `PROJECT_ID = CWD_BASENAME`，`PROJECT_ROOT = pwd`
- 选"已有项目：X"→ `PROJECT_ID = X`；若与 cwd 不同，追问 `AskUserQuestion` 获取该项目的根绝对路径
- 选"新建"→ 追问"项目名（英文 kebab-case）+ 根路径"
- 选"取消"→ 输出消息并终止

设 `PROJECT_DIR=${PLUGIN_ROOT}/data/projects/${PROJECT_ID}`。

### A.3 加载或初始化 project-map.md

用 `Bash` 检查 `${PROJECT_DIR}/project-map.md`。

- **已存在**：`Read` 全文注入上下文；摘出"最近变更"章节最近 3 条备用
- **不存在**（首次）：
  - 告知用户："首次在此项目使用 feature-flow，先花 1-2 分钟建 project-map（后续复用）"
  - 用 `Agent`（`subagent_type=Explore`，thoroughness=medium）深扫 `PROJECT_ROOT`，按 `${PLUGIN_ROOT}/references/project-map-template.md` 的骨架级结构产出初稿
  - 用 `AskUserQuestion` 补 1-2 处关键空白（核心领域概念 / 非显而易见约定）
  - `Bash mkdir -p ${PROJECT_DIR}` 后 `Write` 写入 `${PROJECT_DIR}/project-map.md`

### A.4 分流（有无 PRD）

若启动参数 `$ARGUMENTS` 非空，直接视为"有 PRD"（正文或路径），进入 A.5。

否则 `AskUserQuestion`：
- question: "本次开发有 PRD 吗？"
- options:
  1. `"有 PRD，我粘贴正文"`
  2. `"有 PRD，我给文件绝对路径"`
  3. `"无正式 PRD，口头描述需求，做完整拷问"`
  4. `"无 PRD 且是小改动，跳过拷问直接开发"`

分别处理：
- 选 1 → 让用户粘贴到下条消息，取 `PRD_CONTENT`
- 选 2 → 让用户给路径，`Read` 得 `PRD_CONTENT`
- 选 3 → 让用户口述，转写成简化 PRD（目标 / 主路径 / 关键规则）→ `PRD_CONTENT`
- 选 4 → 让用户口述，作为 `DEV_BRIEF`（1-2 段）

设分支：选 1/2/3 → `BRANCH=full`；选 4 → `BRANCH=light`。

### A.5 命名 + 创建 session

- 从 PRD/brief 提炼 `FEATURE_SLUG`（3-5 词，英文 kebab-case）。名字模糊时 `AskUserQuestion` 让用户定
- `SESSION_DIR=${PROJECT_DIR}/sessions/$(date +%Y-%m-%d)-${FEATURE_SLUG}`
- `Bash mkdir -p ${SESSION_DIR}`
- full 分支 → `Write` `PRD_CONTENT` 到 `${SESSION_DIR}/requirement.md`
- light 分支 → `Write` `DEV_BRIEF` 到 `${SESSION_DIR}/brief.md`

### A.6 输出进度

```
✅ Phase A 完成
   项目：${PROJECT_ID}
   分支：<full|light>
   session：${SESSION_DIR}
```

---

## Phase B — Main（调用 /feature-dev，通过 args 注入增强）

用 `Skill` 工具调用 `feature-dev:feature-dev`。`args` 按分支构造：

### B.1 full 分支的 args

`args` 是一个字符串，整块传给 feature-dev。**关键**：args 里要**同时给 Phase 2 和 Phase 3 下规范**——Phase 3 拷问依赖 Phase 2 产出的代码事实，二者必须绑定。

文本如下（把占位符替换成实际值）：

```
需求：${FEATURE_SLUG}

## 预加载的项目上下文（Phase 2 请先读这个，作为代码探索的先验知识，避免重复扫已记录的模块）
@${PROJECT_DIR}/project-map.md

## PRD 正文（本次需求）
@${SESSION_DIR}/requirement.md

---

## Phase 2 Codebase Exploration 额外指令（附加，不覆盖默认）

在你的默认探索（架构/模式/相似功能）之外，**必须额外完成"PRD 假设验证"**，为 Phase 3 的拷问准备代码事实：

1. **抽名词**：从 PRD 正文中抽出所有具名实体 —— 接口名、字段名、表名、枚举值、状态机、外部服务名
2. **逐一定位**：对每个实体用 `Grep` + `Read` 定位真实代码：
   - 找不到的记为"PRD 新增"（此前代码里不存在）
   - 找到但用法不一致的记为"PRD 术语错用"或"PRD-代码 gap"
3. **关键行为核对**：读现有接口的入参/出参 schema、枚举实际取值、已有校验/限制、DB 字段和索引，核对 PRD 里的相关假设是否与现状一致
4. **产出**：除了你默认的 code-explorer 总结外，额外输出一份"PRD 假设验证摘要"，列出：
   - 涉及的具名实体 → 代码位置（file:line）或"不存在"
   - 发现的 PRD 与代码 gap（bullet list）

这份摘要是 Phase 3 拷问每条问题"依据"字段的素材库。**没做这步，Phase 3 无法产出合格清单**。

探索要节制：围绕 PRD 做定点验证，不是通读项目。此步骤预算 5-15 次 tool call。

---

## Phase 3 Clarifying Questions 强制规范（覆盖默认）

Phase 3 必须按下面的框架执行，不要用通用清单。这是项目长期沉淀的拷问方法论。

### 核心视角
站在"我要开始实现这个需求"的开发者视角，把所有动手前必须解决的**业务/需求层面**拦路问题挖出来。不是挑 PRD 的错。

### 关键边界：Phase 3 只问 PRD-TBD（业务拷问）

**不要问工程选型类问题**（同步 vs 异步、新表 vs 旧表、缓存策略、错误码分配、具体数据结构选择等）。这些是 Phase 4 Architecture Design 的职责，那里会给 2-3 套完整方案让用户选。Phase 3 重复问会让用户被双重打扰。

如果代码探索中发现工程选型的岔路口，**记录在 prd-check.md 的"工程选型线索（留给 Phase 4）"章节，不写进问题清单问用户**。Phase 4 code-architect agent 读到后会自然覆盖。

### 只识别的问题类型：PRD-TBD（业务侧需回答）

产品没说清、需要业务侧回答的：
- 业务规则缺失（如"超限后怎么做？"）
- 数值阈值（如"最多批量多少份？"）
- 优先级 / 行为定义（如"用户撤销后是否保留痕迹？"）
- 边界场景的产品期望（如"权限不足时用户看到什么？"）
- 新老功能共存 / 下线策略
- 跨租户 / 多角色的业务行为差异

### 7 镜头（每条问题必须归属到某个镜头）

每面镜子下**只识别 PRD-TBD 类问题**，跳过纯工程选型：

1. **逻辑完整性** — 流程是否自洽？隐藏前提？规则冲突时谁赢？
2. **用户操作路径** — 实际触发时机？并发行为？撤销/重做的产品期望？
3. **边界条件** — 入参边界、数量/时间/权限边界下的产品行为定义
4. **限制与配额** — 上限数值（业务决策）、触顶时的产品侧响应
5. **异常与错误处理** — 失败后用户看到什么、回滚策略的产品期望
6. **新数据结构** — 只问业务层面的"要不要存这个字段""这个字段必填吗"，不问表结构/索引
7. **旧数据迁移** — 只问业务层面的"历史数据要不要回填""老规则还是新规则"，不问回填脚本实现

### 优先级
- P0：逻辑完整性 / 用户操作路径 / 新数据结构（业务数据语义）
- P1：边界条件 / 异常与错误处理 / 限制与配额
- P2：旧数据迁移

具体问题可按阻塞度升降级。

### 每条问题的写法
格式：`[P0|P1|P2][PRD-TBD][镜头名] 具体问题`
每条必含：
- 问题本身（一句话，不模糊）
- 依据：代码位置（file:line）或 PRD 段落（Phase 2 的 PRD 假设验证摘要是主要素材源）
- 候选答案：A / B / C（列可能的产品答案，不是工程方案）

### 展示顺序
按优先级分组：P0 → P1 → P2，组内按发现顺序排列。

### 产出落盘（必须执行）
把完整清单 + 拷问过程 + 所有答案写入：
`${SESSION_DIR}/prd-check.md`

结构：
```
# 实施前拷问 — ${FEATURE_SLUG}

## 待解决问题清单（业务 PRD-TBD）

### P0 - 逻辑与设计
### P1 - 边界/异常/限制
### P2 - 旧数据兼容

## 工程选型线索（留给 Phase 4）
> 代码探索中发现的工程岔路口，不问用户，给 Phase 4 code-architect 参考：
- <选型 1>：背景 ..., 可能方向 A/B
- <选型 2>：...

## 拷问过程（内部追溯）
### 代码探索摘要（Phase 2 的 PRD 假设验证摘要）
### 7 镜头扫描记录（7 小节全写）
```

### 交互约束
- 每收到用户答案，立即 `Edit` 回写 prd-check.md，在对应问题下追加 `**答**（YYYY-MM-DD）：...`
- **禁止** 把答案只留在对话里不回写
- **禁止** "可能需要进一步确认"、"建议团队评估"这类糊涂措辞
- **禁止** 问工程选型类问题（移交 Phase 4）

---

按以上规范执行完整的 7-phase 流程（Discovery → Codebase Exploration → Clarifying Questions → Architecture Design → Implementation → Quality Review → Summary）。
```

### B.2 light 分支的 args

```
需求：${FEATURE_SLUG}（小改动，无 PRD，跳过拷问规范）

## 预加载的项目上下文
@${PROJECT_DIR}/project-map.md

## 需求简述
@${SESSION_DIR}/brief.md

---

本次为小改动，无正式 PRD。按 feature-dev 默认流程执行，Phase 3 用你默认的简短澄清清单即可，不需要按任何框架。Phase 6 quality review 照常。
```

### B.3 调用

用 `Skill` 工具：
- skill: `feature-dev:feature-dev`
- args: 上面构造好的文本

调用期间保持观察（供 Phase C 回写用）：
- 新增/修改的关键文件
- 引入的新模块或领域概念
- 定下的新约定
- 踩过的坑

feature-dev 执行完毕后进入 Phase C。

### B.4 输出进度

```
✅ Phase B 完成
   feature-dev 执行完毕
   主要变更：<简短列举>
```

---

## Phase C — Post（结构化交付 + 回写认知）

### C.1 选择产出文档

用 `AskUserQuestion`：
- question: "本次需要哪些交付文档？"
- options:
  - `"只要接口测试文档（简单改动）"`
  - `"只要技术方案"`
  - `"两者都要"`
  - `"都不要"`

按 `${PLUGIN_ROOT}/references/output-templates.md` 的模板生成：
- 技术方案 → `${SESSION_DIR}/tech-design.md`
- 接口测试 → `${SESSION_DIR}/api-test.md`

**数据源**：feature-dev 的 Phase 7 Summary + 实际改动文件（`Bash git diff --stat` / `git log -1 --name-status` 等辅助）。不要凭空编。

### C.2 回写 project-map

`Read` `${PROJECT_DIR}/project-map.md`。基于本次观察到的变更，按下表判断是否需要更新：

| 变化类型 | 更新小节 |
|---|---|
| 新模块 / 新接口 | 模块地图 |
| 新领域概念 | 核心领域概念 |
| 新约定（命名 / 错误码 / DB 模式等） | 关键约定 |
| 新踩的坑 / 反模式 | 非显而易见之处 |

**原则**：骨架级 —— 只记"下次开发必须知道"的；实现细节不写入 map（那是 sessions 的活）。

用 `Edit` 精确更新；变动大就 `Write` 整体重写。

最后在"最近变更"章节**追加一行**，只保留最近 10 条：
```
- YYYY-MM-DD ${FEATURE_SLUG}：一句话摘要（≤30 字）
```

### C.3 最终输出

```
✅ /feature-flow 完成
   分支：<full|light>
   项目：${PROJECT_ID}
   session：${SESSION_DIR}
   交付：<已生成的 md 列表>
   project-map 更新：<更新的小节>
   下次 /feature-flow，此项目上下文自动复用
```

---

## 硬规则（必须遵守）

1. **必须确认项目身份**（A.2 不可省）。不因 cwd 在某项目就自动默认
2. **必须分流**（A.4 不可省）。有/无 PRD 决定后续 args 构造
3. **full 分支必须同时注入 Phase 2 + Phase 3 规范**：
   - Phase 2 额外指令：PRD 假设验证（为 Phase 3 提供代码事实）
   - Phase 3 拷问规范：7 镜头 + P0/P1/P2，**只问 PRD-TBD（业务）**，不问工程选型
   - 二者绑定；只注入 Phase 3 不注入 Phase 2 会导致拷问缺乏代码事实，违反"代码驱动"原则
4. **Phase 3 不和 Phase 4 抢生意**：工程选型（同步 vs 异步、表结构、错误码等）交给 Phase 4 的 code-architect 方案对比，不在 Phase 3 单点问
5. **light 分支不注入规范**，但必须传 project-map 作为先验
6. **产出落盘路径统一**：所有文件在 `${SESSION_DIR}/` 下，不散落
7. **骨架级 project-map**：只放模块边界 + 领域概念 + 非显而易见约定
8. **失败即停**：任一工具/校验失败，明确报错停止，不静默跳过
