import { spawn, spawnSync } from "node:child_process";

const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
const build = spawnSync(corepack, ["pnpm", "build"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(corepack, ["pnpm", "start", "-H", "127.0.0.1", "-p", "3210"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}

server.on("exit", (code) => process.exit(code ?? 0));
