import { spawn, type ChildProcess } from "node:child_process";

// Keep both dev processes under one lifecycle; neither starts the Bot.
const children: ChildProcess[] = [];
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
  }, 5000);
  timer.unref();
}
for (const args of [
  ["node_modules/tsx/dist/cli.mjs", "dashboard/server/index.ts"],
  ["node_modules/vite/bin/vite.js", "--config", "dashboard/web/vite.config.ts"],
]) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  child.once("error", () => {
    console.error("面板开发进程启动失败");
    stop(1);
  });
  child.once("exit", (code) => stop(code ?? 1));
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
