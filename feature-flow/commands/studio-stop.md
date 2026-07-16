---
description: 彻底停止 feature-flow studio 工作台（关闭 4316/4317 + 清理残留进程）。
---

# /feature-flow:studio — 停止工作台

studio 是脱离会话独立运行的（关掉 Claude 终端它也不停），本命令提供一个干净的停止入口：释放 4316/4317 端口，并清理可能残留的 dev/vite/tsx 进程。

## 执行步骤

用 `Bash` 执行（按端口 + 按插件路径精确清理，**不做泛化 pkill**，只动 feature-flow/studio 自己的进程）：

```
SELF=$$; PARENT=${PPID:-0}

# 1) 按端口停当前活跃 studio（web 4316 + server 4317）
for p in 4316 4317; do
  pids=$(lsof -ti tcp:$p 2>/dev/null)
  if [ -n "$pids" ]; then kill $pids 2>/dev/null; sleep 0.4; kill -9 $pids 2>/dev/null; fi
done

# 2) 清理残留：只匹配 feature-flow/studio 下的 dev.mjs / web / server 进程，排除本命令自身
pids=$(ps ax -o pid=,command= | awk -v s="$SELF" -v pp="$PARENT" \
  '/feature-flow\/studio\/(scripts\/dev\.mjs|web\/node_modules|server\/node_modules)/ && $1!=s && $1!=pp {print $1}')
if [ -n "$pids" ]; then kill $pids 2>/dev/null; sleep 0.4; kill -9 $pids 2>/dev/null; fi

# 3) 复核端口已释放
still=$(lsof -ti tcp:4316 -ti tcp:4317 2>/dev/null)
[ -z "$still" ] && echo "✓ studio 已彻底停止（4316/4317 已释放，残留已清理）" || echo "⚠️ 仍有占用：$still，可重跑一次本命令"
```

## 注意

- 只精确清理 **feature-flow/studio** 自己的进程（按端口 + 按完整插件路径），不会误伤你机器上别的服务。
- 想重新启动：`/feature-flow:studio`（它启动前也会先按端口清理旧实例）。
