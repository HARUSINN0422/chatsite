const { spawn } = require("child_process");
const path = require("path");

const serverPath = path.join(__dirname, "..", "server.js");
let child;
let stopping = false;

function startServer() {
  if (stopping) return;
  child = spawn(process.execPath, [serverPath], { cwd: path.dirname(serverPath), env: process.env, stdio: "inherit" });
  child.on("error", err => {
    console.error("[Runner] サーバーを起動できません:", err.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (code === 75) {
      console.log("[Runner] 更新後のサーバー再起動を行います。");
      setTimeout(startServer, 1000);
      return;
    }
    if (signal) {
      console.error("[Runner] サーバーがシグナルで終了しました:", signal);
      process.exitCode = 1;
    } else {
      process.exitCode = code === 0 ? 0 : (code || 1);
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (child && !child.killed) child.kill(signal);
  });
}

startServer();
