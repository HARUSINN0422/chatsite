const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const admin = require("firebase-admin");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.jsonl");
const MAX_TEXT = 4000;
const MAX_MESSAGES = 200;

admin.initializeApp({ credential: admin.credential.applicationDefault() });
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

let writeQueue = Promise.resolve();
async function readMessages() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  let raw;
  try { raw = await fsp.readFile(MESSAGES_FILE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return raw.split("\n").filter(Boolean).slice(-MAX_MESSAGES).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
async function appendMessage(message) {
  writeQueue = writeQueue.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.appendFile(MESSAGES_FILE, JSON.stringify(message) + "\n", { encoding: "utf8", mode: 0o600 });
  });
  return writeQueue;
}
async function requireLogin(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!match) return res.status(401).json({ error: "ログインが必要です" });
  try { req.user = await admin.auth().verifyIdToken(match[1]); next(); }
  catch { return res.status(401).json({ error: "ログインの有効期限が切れています。再ログインしてください" }); }
}
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/messages", requireLogin, async (_req, res, next) => {
  try { res.set("Cache-Control", "no-store"); res.json({ messages: await readMessages() }); }
  catch (e) { next(e); }
});
app.post("/api/messages", requireLogin, async (req, res, next) => {
  try {
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    const imageUrl = typeof req.body.imageUrl === "string" ? req.body.imageUrl : "";
    if (text.length > MAX_TEXT) return res.status(400).json({ error: "テキストは4000文字以内にしてください" });
    if (imageUrl && (!/^https:\/\/drive\.google\.com\//.test(imageUrl) || imageUrl.length > 2000))
      return res.status(400).json({ error: "写真URLが無効です" });
    if (!text && !imageUrl) return res.status(400).json({ error: "テキストか写真を指定してください" });
    const message = {
      id: require("crypto").randomUUID(),
      uid: req.user.uid,
      displayName: String(req.user.name || req.user.email || "ユーザー").slice(0, 100),
      text, imageUrl, createdAt: new Date().toISOString()
    };
    await appendMessage(message);
    res.status(201).json({ message });
  } catch (e) { next(e); }
});
app.use((req, res, next) => {\n  if (req.path === "/data" || req.path.startsWith("/data/")) return res.status(404).end();\n  next();\n});\napp.use(express.static(__dirname, { index: "index.html", etag: true, maxAge: "5m" }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "サーバー内部エラー" });
});
app.listen(PORT, HOST, () => console.log(`ChatSite listening on http://${HOST}:${PORT}`));
