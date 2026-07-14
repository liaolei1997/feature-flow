# 交付文档模板（Phase C.1）

Phase C.1 按用户选择生成 0-2 份 md。两份都**写给未来的自己**（不是给同事 review），标准是"下次回看能快速捡起上下文"。

## 何时生成哪个

| 场景 | 建议 |
|---|---|
| 改动 ≤ 2 个文件、无新接口、无 DB 变更 | 都不要 |
| 改动涉及新接口 / 接口参数变化 | api-test 至少要 |
| 改动引入新模块 / 新数据流 / 新领域概念 | tech-design 至少要 |
| 核心业务逻辑变更、多人协作、需回溯 | 两者都要 |

最终以用户 `AskUserQuestion` 选择为准，本表只是建议。

---

## 模板 A：tech-design.md

```markdown
# 技术方案 — <feature-slug>

- Date: YYYY-MM-DD
- Session: <session 目录名>
- 关联 PRD：@requirement.md
- 拷问记录：@prd-check.md

## 1. 目标一句话
<做了什么。不写背景不复述 PRD。>

## 2. 核心设计决策
> 关键岔路口为什么选 A 不选 B。未来回看，这是最值钱的部分。

- **<决策点 1>**：选 <A>，不选 <B>。原因：<1-2 行>
- **<决策点 2>**：...

## 3. 变更清单
> 每项带文件路径 + 变更类型，供未来 grep 用。

### 新增
- `src/foo/bar.py`：新增 BarService
### 修改
- `src/api/review.py:42-78`：入参新增 batch_id
### 删除
- ...
### DB 变更
- 新表 `batch_review_tasks`：见 `migrations/xxx.sql`
- `annotations.batch_id`：加索引

## 4. 数据流与时序
<只画主路径；异常分支到第 5 节>

## 5. 异常与边界处理
- <场景> → <行为>

## 6. 配置与开关
- 环境变量：`BATCH_MAX=50`
- feature flag：`batch_review_enabled`（默认 off）

## 7. 依赖 & 影响范围
- 上游：...
- 下游：...
- 不影响：... （澄清看似相关其实不影响的部分）

## 8. 未尽事项 / TODO
- [ ] ...
```

---

## 模板 B：api-test.md

```markdown
# 接口测试文档 — <feature-slug>

- Date: YYYY-MM-DD
- 关联：@requirement.md, @prd-check.md

## 接口列表

### 1. <METHOD> <path>

**用途**：一句话

**Headers**：
| Key | Required | 值示例 |
|---|---|---|
| Authorization | Y | `Bearer xxx` |
| Content-Type | Y | `application/json` |

**Query**：
| 名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| page | int | N | 默认 1 |

**Body**：
```json
{"field_a": "...", "field_b": 123}
```

**字段**：
| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| field_a | string | Y | 1-100 字 | ... |
| field_b | int | N | ≥0, ≤50 | 默认 10 |

**成功响应** (200)：
```json
{"code": 0, "data": {...}}
```

**错误码**：
| HTTP | code | 含义 | 触发 |
|---|---|---|---|
| 400 | 1001 | field_a 超长 | ... |
| 403 | 2001 | 无权访问 | ... |

**测试用例**：
| 用例 | 输入 | 预期 |
|---|---|---|
| 正常 | field_a="abc", field_b=5 | 200, data.id 返回 |
| 空值 | field_a="" | 400, code=1001 |
| 超限 | field_b=51 | 400, code=1002 |
| 无权 | contract_id 非本用户 | 403, code=2001 |
| 并发重复 | 同 contract_id 连调 2 次 | 第 2 次返回已存在 |

**curl**：
```bash
curl -X POST http://localhost:8000/api/xxx \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field_a":"abc","field_b":5}'
```

---

### 2. <下一个接口>
（同上结构）
```

---

## 写作要求

- **具体 > 抽象**：写"field_a 超长 → 400 code=1001"，不写"参数校验失败"
- **引代码位置**：能 grep 到就带 `src/foo.py:42`
- **不解释显然的事**："id 是资源唯一标识"这种不用写
- **空 section 删掉**：模板里某节本次没有，整节删，不留"无"
