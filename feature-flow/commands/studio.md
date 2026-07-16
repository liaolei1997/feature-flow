---
description: 启动 feature-flow studio Web 工作台（浏览历史会话/产物、上传 PRD、聊天框走完整流程）。
---

# /feature-flow:studio — 启动 Web 工作台

启动伴生 Web 应用：左栏浏览项目/会话（带 phase 进度）、中栏渲染各 md 产物、右栏聊天框上传 PRD 并走完整 feature-flow 流程。

## 执行步骤

1. 用 `Bash` 检查依赖是否已装：
   ```
   test -d "${CLAUDE_PLUGIN_ROOT}/studio/server/node_modules" && test -d "${CLAUDE_PLUGIN_ROOT}/studio/web/node_modules" && echo INSTALLED || echo NEED_INSTALL
   ```
2. 若 `NEED_INSTALL`，先告知用户要装依赖（约 1-2 分钟），再 `Bash`：
   ```
   cd "${CLAUDE_PLUGIN_ROOT}/studio" && npm run install:all
   ```
3. **清理占用同端口的旧实例**（4316/4317 是 studio 专用端口；占用者必是上一次没退干净的 studio）。`Bash`：
   ```
   for p in 4316 4317; do
     pid=$(lsof -ti tcp:$p 2>/dev/null)
     if [ -n "$pid" ]; then echo "端口 $p 被旧实例占用(pid $pid)，杀掉"; kill $pid 2>/dev/null; sleep 1; kill -9 $pid 2>/dev/null; fi
   done
   echo "端口已就绪"
   ```
   > 只按 studio 专用端口 4316/4317 精确杀，不按进程名泛杀（避免误伤其它 `tsx`/`vite` 进程）。
4. **脱离会话独立启动**（关键：用**普通 `Bash` 调用**，**不要用 `run_in_background`**）。`run_in_background` 会把进程挂在本 Claude Code 会话下，会话结束/压缩就被一并杀掉（表现为"日志干净、端口释放"的莫名终止）。改用 `setsid`/`nohup` + `disown` + 重定向，让它 reparent 到 launchd 独立存活。`Bash`：
   ```
   cd "${CLAUDE_PLUGIN_ROOT}/studio"
   LOG="${CLAUDE_PLUGIN_ROOT}/studio/.studio-runtime.log"
   if command -v setsid >/dev/null 2>&1; then
     setsid npm run dev > "$LOG" 2>&1 < /dev/null &
   else
     nohup npm run dev > "$LOG" 2>&1 < /dev/null &
   fi
   disown 2>/dev/null || true
   echo "studio 已脱离会话独立启动（日志：$LOG）。等待端口就绪…"
   ```
   > 这条 Bash 调用会立刻返回（进程已 `&` 后台化并 disown），不要挂起等待；`< /dev/null` 让它不占用会话 stdin。
5. 校验起来了（约 4 秒后）。`Bash`：
   ```
   sleep 4; lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && echo "OK: server 已在 4317" || { echo "未起来，末尾日志："; tail -20 "${CLAUDE_PLUGIN_ROOT}/studio/.studio-runtime.log"; }
   ```
   起来则告诉用户：工作台已在 http://127.0.0.1:4316 打开（脚本会自动开浏览器）、server 在 4317、**已脱离本会话独立运行，关掉/压缩本对话也不会停**。
6. 提醒：v1 同时只支持一个运行中的会话；终端 `/feature-flow` 与 studio 共用同一份 `data/`，可互相 resume。

## 注意

- 需要 `ANTHROPIC_API_KEY` 或已登录的 Claude 凭证（Agent SDK 走与 CLI 相同的鉴权）。
- 停止：用 **`/feature-flow:studio-stop`**（对称的停止命令，释放 4316/4317 + 清理残留进程）。或直接重跑 `/feature-flow:studio`（启动前会先按端口清理旧实例）。
- 日志在 `${CLAUDE_PLUGIN_ROOT}/studio/.studio-runtime.log`（脱离会话后终端看不到输出，排查看这里）。
