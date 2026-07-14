# /feature-flow Verifier Contracts

> 各 phase artifact 必须满足的契约。`prd-check-verifier` subagent 读本文件 + 读 artifact + 返回结构化 JSON。
>
> 规则类型：
> - **必含章节（required_sections / required_subsections）**：每条是 **anchored regex prefix**（如 `^## 待解决问题清单`），匹配以该模式起首的任意一行；不要求字面相等
> - **必含模式（required_patterns）**：正则匹配 + 出现次数下限
> - **禁止模式（forbidden_patterns）**：正则匹配 + 必须 0 命中
> - **块级规则（per_question_required / per_interface_required）**：在 block_delimiter 定义的块内逐块检查；块内 line patterns 均允许列表缩进，按 `^\s*<pattern>` 匹配
> - **大小规则（size_limit / min_length）**：行数 / 字符数上下限（字符数按 UTF-8 codepoint 计）
> - **空节检测（non_empty_sections）**：标题下到下个同级或更高级标题之间内容长度

---

## P0.5 / project-map.md

- **artifact**: `${PROJECT_DIR}/project-map.md`
- **required_sections (≥7 of 9 must exist; each is anchored regex prefix)**:
  - `^## 一、项目概述`
  - `^## 二、核心业务 / 功能地图`
  - `^## 三、技术栈与运行`
  - `^## 四、模块地图`
  - `^## 五、核心领域概念`
  - `^## 六、关键约定`
  - `^## 七、非显而易见之处`
  - `^## 八、外部依赖与边界`
  - `^## 九、最近变更`
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
- **required_sections (anchored regex prefix)**:
  - `^## PRD 假设验证摘要`
  - `^## 代码事实清单`
- **required_patterns**:
  - `[\w/\.\-]+\.(py|ts|tsx|js|jsx|sql|go|java|rs|md):\d+` ≥ 3 次（具名实体的 file:line 引用）
- **forbidden_patterns**:
  - `<待定>` / `TBD` / `不确定`

---

## P3 / prd-check.md

- **artifact**: `${SESSION_DIR}/prd-check.md`
- **required_sections (anchored regex prefix)**:
  - `^## 待解决问题清单` （其下应含 P0/P1/P2 三级小节）
  - `^### P0 - 逻辑与设计`
  - `^### P1 - 边界/异常/限制`
  - `^### P2 - 旧数据兼容`
  - `^## 工程选型线索`
  - `^## 拷问过程`
  - `^### 8 镜头记录`
- **required_subsections under "### 8 镜头记录"（必须 8 个，anchored regex prefix）**:
  - `^#### 1\. 逻辑完整性`
  - `^#### 2\. 用户操作路径`
  - `^#### 3\. 边界条件`
  - `^#### 4\. 限制与配额`
  - `^#### 5\. 异常与错误处理`
  - `^#### 6\. 新数据结构`
  - `^#### 7\. 旧数据迁移`
  - `^#### 8\. 权限 / 可见性 / 合规`
- **per_question_required**（在「待解决问题清单」每一个编号问题块内必含 4 行；line patterns 按 `^\s*<pattern>` 匹配，允许列表项 3 空格缩进）：
  - **block_delimiter**: 每块以 `^\d+\. \[P[012]\]\[PRD-TBD\]` 起首；下一块或下个 `^##` / `^---` 结束当前块
  - 三元标签：正则 `\[P[012]\]\[PRD-TBD\]\[[^\]]+\]`
  - 依据行：正则 `^\s*依据：`
  - 候选答案行：正则 `^\s*候选答案：`
  - 用户已答行：正则 `^\s*\*\*答\*\*`
- **forbidden_patterns**:
  - `可能需要进一步确认`
  - `建议团队评估`
  - `\[DEV-DECIDE\]`（v2 砍掉，工程选型归 P4）
  - `待补` / `TBD`

---

## P5 / tech-design.md

- **artifact**: `${SESSION_DIR}/tech-design.md`
- **required_sections (anchored regex prefix)**:
  - `^## 1\. 目标一句话`
  - `^## 2\. 核心设计决策`
  - `^## 3\. 变更清单`
- **non_empty_sections**:
  - `^## 2\. 核心设计决策`：节内 ≥ 30 字符（UTF-8 codepoint）
  - `^## 3\. 变更清单`：节内含至少 1 个 `[\w/\.\-]+\.(py|ts|tsx|js|sql|go|java|md)` 文件路径
- **forbidden_patterns**:
  - `TBD` / `待定` / `看情况`

---

## P8 / api-test.md（可选产出，存在则校验）

- **artifact**: `${SESSION_DIR}/api-test.md`
- **required_sections (anchored regex prefix)**:
  - `^## 接口列表`
- **per_interface_required**（每个编号接口块内必含；标签行按 `^\s*<pattern>` 匹配以容忍缩进）：
  - **block_delimiter**: 每块以 `^### \d+\. ` 起首；下一个同级 `^### \d+\. ` 或下个 `^## ` 或 EOF 结束当前块
  - 字段标签：正则 `^\s*\*\*字段\*\*` 或 `^\s*\*\*Body\*\*`
  - 错误码标签：正则 `^\s*\*\*错误码\*\*`
  - 测试用例标签：正则 `^\s*\*\*测试用例\*\*`
  - curl 块：含 fenced code 起首 `^\s*` + `` ``` `` + `(bash|shell)`
- **forbidden_patterns** (限定块作用域，应用同一 block_delimiter):
  - `TBD`

---

## P8-Map / project-map.md（回写后增量检查）

> P8 阶段除产 api-test.md 外，会向 `project-map.md` 的「九、最近变更」节追加一行。本契约校验"回写后该节非空 + 末行格式合规"。

- **artifact**: `${PROJECT_DIR}/project-map.md`
- **required_sections (anchored regex prefix)**:
  - `^## 九、最近变更`
- **non_empty_sections**:
  - `^## 九、最近变更`：节内 ≥ 1 个匹配 `^- \d{4}-\d{2}-\d{2} ` 的列表项
- **forbidden_patterns**:
  - `\(待补\)`
