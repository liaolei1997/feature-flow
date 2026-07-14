---
description: 列出所有 feature-flow 会话总览（按项目分组：模式 / 进度 / 完成状态 / 产物 / 时间），只读，不改任何东西。
---

# /feature-flow:sessions — 会话总览

只读列出所有项目下的 feature-flow 会话，让你一眼看清有哪些会话、各自走到哪、完没完。**不修改任何文件。**

## 执行

### 1. 扫描

用 `Bash` 一次性抓取所有会话的状态字段（`.state` 是 YAML，逐字段 grep）：

```bash
DATA="${CLAUDE_PLUGIN_ROOT}/data/projects"
[ -d "$DATA" ] || { echo "NO_DATA"; exit 0; }
for proj in "$DATA"/*/; do
  [ -d "${proj}sessions" ] || continue
  pname=$(basename "$proj")
  for s in "${proj}sessions"/*/; do
    [ -d "$s" ] || continue
    st="${s}.state"
    sid=$(basename "$s")
    phase=$(grep -m1 '^current_phase:' "$st" 2>/dev/null | cut -d: -f2- | tr -d ' ')
    pstatus=$(grep -m1 '^phase_status:' "$st" 2>/dev/null | cut -d: -f2- | tr -d ' ')
    mode=$(grep -m1 '^mode:' "$st" 2>/dev/null | cut -d: -f2- | tr -d ' ')
    updated=$(grep -m1 '^last_updated:' "$st" 2>/dev/null | cut -d: -f2- | sed 's/^ *//')
    arts=$(ls "$s"*.md 2>/dev/null | wc -l | tr -d ' ')
    hastx=$([ -f "${s}.studio-chat.jsonl" ] && echo "有对话" || echo "")
    echo "${pname}|${sid}|${mode:-full}|${phase:-?}|${pstatus:-?}|${updated:-?}|${arts}|${hastx}"
  done
done
```

### 2. 渲染

把每行 `项目|会话|模式|phase|状态|更新时间|产物数|对话` 解析后，**按项目分组**输出 markdown 表格，每组内**按更新时间倒序**（最近的在上）。

- 若输出 `NO_DATA` 或无任何会话：打印"还没有任何 feature-flow 会话"。
- **状态列语义**：`phase_status=completed` 且 `current_phase=P8` → 标 `✅ 完成`；否则标 `🔸 未完成（停在 <phase>）`。
- **模式列**：`light` 显示为 `轻量`，`full` 显示为 `完整`。
- 每组顶部一行小结：`<项目>（共 N 个会话，M 个未完成）`。

表格列：`会话 ID（session_id） | 模式 | 进度 | 状态 | 产物 | 更新时间`。

- **第一列直接展示完整 `session_id`（即会话目录名）**，不要截断——用户要复制它去续跑。未完成的会话，把这一列用反引号 `` ` `` 包起来方便复制。

### 3. 结尾提示

表格后追加（不询问、不执行）。若存在未完成会话，逐个给出可直接复制的续跑命令：

```
续某个未完成会话 → /feature-flow 续 <session_id>
   例：/feature-flow 续 2026-06-01-rule-review-sentence-grain-impl
看产物/对话    → /feature-flow:studio 在网页里浏览
```

## 硬规则

- **纯只读**：只允许 `Bash`(读) / `Read`。禁止 `Write` / `Edit` / 删除 / 重命名 / 启动流程。
- 不调任何 subagent，不做 resume 检测的"继续"动作——只列出。
