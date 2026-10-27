const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "..", "server.js");

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  let contents;
  try { contents = fs.readFileSync(envPath, "utf8"); }
  catch (err) { if (err.code !== "ENOENT") console.warn("[Runner] .envを読み込めません:", err.message); return; }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#") || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[match[1]] = value;
  }
}

loadDotEnv();
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
