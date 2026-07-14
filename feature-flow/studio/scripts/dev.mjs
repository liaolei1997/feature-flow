#!/usr/bin/env node
// 同时拉起 server(4317) 与 web(4316)，并打开浏览器。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(name, cwd, cmd, args) {
  const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  p.on("exit", (code) => {
    console.log(`[${name}] 退出 code=${code}`);
    process.exit(code ?? 0);
  });
  return p;
}

run("server", join(root, "server"), "npm", ["start"]);
run("web", join(root, "web"), "npm", ["run", "dev"]);

// 等 web 起来再开浏览器
setTimeout(() => {
  const url = "http://127.0.0.1:4316";
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { shell: process.platform === "win32" });
  console.log(`[studio] opening ${url}`);
}, 3000);
