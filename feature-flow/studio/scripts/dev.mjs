#!/usr/bin/env node
// 同时拉起 server(4317) 与 web(4316)，并打开浏览器。
// 任一子进程退出、或收到停止信号时，连坐清理另一个，避免留下孤儿 vite/tsx。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const procs = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // 子进程用 detached 起，各成进程组组长；负号 = 杀整组（连 npm 拉起的 tsx/vite/esbuild 一起）
  for (const p of procs) { try { process.kill(win ? p.pid : -p.pid, "SIGTERM"); } catch {} }
  setTimeout(() => {
    for (const p of procs) { try { process.kill(win ? p.pid : -p.pid, "SIGKILL"); } catch {} }
    process.exit(code);
  }, 600);
}

function run(name, cwd, cmd, args) {
  const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: win, detached: !win });
  procs.push(p);
  p.on("exit", (c) => { console.log(`[${name}] 退出 code=${c}`); shutdown(c ?? 0); });
  return p;
}

run("server", join(root, "server"), "npm", ["start"]);
run("web", join(root, "web"), "npm", ["run", "dev"]);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 等 web 起来再开浏览器
setTimeout(() => {
  const url = "http://127.0.0.1:4316";
  const opener = win ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { shell: win });
  console.log(`[studio] opening ${url}`);
}, 3000);
