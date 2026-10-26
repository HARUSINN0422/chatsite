const express = require("express");
const path = require("path");
const fsp = require("fs").promises;
const crypto = require("crypto");
const admin = require("firebase-admin");
const webpush = require("web-push");
const app = express();
const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.jsonl");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const MAX_TEXT = 4000, MAX_MESSAGES = 200;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (pushConfigured) webpush.setVapidDetails(process.env.VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
admin.initializeApp({ credential: admin.credential.applicationDefault() });
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
let writeQueue = Promise.resolve();
async function readMessages() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  let raw;
  try { raw = await fsp.readFile(MESSAGES_FILE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return raw.split("\n").filter(Boolean).slice(-MAX_MESSAGES).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
async function appendMessage(message) {
  writeQueue = writeQueue.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.appendFile(MESSAGES_FILE, JSON.stringify(message) + "\n", { encoding: "utf8", mode: 0o600 });
  });
  return writeQueue;
}
async function readSubscriptions() {
  try { return JSON.parse(await fsp.readFile(SUBSCRIPTIONS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function writeSubscriptions(data) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = SUBSCRIPTIONS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, SUBSCRIPTIONS_FILE);
}
async function sendNewMessagePush(senderUid) {
  if (!pushConfigured) return;
  let subscriptions;
  try { subscriptions = await readSubscriptions(); } catch (e) { console.error("Push subscription read failed:", e); return; }
  let changed = false;
  const jobs = [];
  for (const [endpoint, entry] of Object.entries(subscriptions)) {
    if (entry.uid === senderUid) continue;
    jobs.push(webpush.sendNotification(entry.subscription, JSON.stringify({ title: "ChatSite", body: "新しいメッセージが届きました", url: "/" })).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) { delete subscriptions[endpoint]; changed = true; }
      else console.error("Push delivery failed:", err.statusCode || err.message);
    }));
  }
  await Promise.allSettled(jobs);
  if (changed) await writeSubscriptions(subscriptions);
}
async function requireLogin(req, res, next) {
  const match = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!match) return res.status(401).json({ error: "ログインが必要です" });
  try { req.user = await admin.auth().verifyIdToken(match[1]); next(); }
  catch { return res.status(401).json({ error: "ログインの有効期限が切れています。再ログインしてください" }); }
}
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/push/public-key", (_req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: "プッシュ通知のVAPID設定が未完了です" });
  res.set("Cache-Control", "no-store").json({ publicKey: VAPID_PUBLIC_KEY });
});
app.post("/api/push/subscribe", requireLogin, async (req, res, next) => {
  try {
    if (!pushConfigured) return res.status(503).json({ error: "プッシュ通知のVAPID設定が未完了です" });
    const sub = req.body && req.body.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") || !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string")
      return res.status(400).json({ error: "通知購読情報が無効です" });
    const data = await readSubscriptions();
    data[sub.endpoint] = { uid: req.user.uid, subscription: sub, updatedAt: new Date().toISOString() };
    await writeSubscriptions(data);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/push/unsubscribe", requireLogin, async (req, res, next) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (typeof endpoint !== "string") return res.status(400).json({ error: "endpointが必要です" });
    const data = await readSubscriptions();
    if (data[endpoint] && data[endpoint].uid === req.user.uid) delete data[endpoint];
    await writeSubscriptions(data);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get("/api/messages", requireLogin, async (_req, res, next) => {
  try { res.set("Cache-Control", "no-store"); res.json({ messages: await readMessages() }); } catch (e) { next(e); }
});
app.post("/api/messages", requireLogin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : "";
    if (text.length > MAX_TEXT) return res.status(400).json({ error: "テキストは4000文字以内にしてください" });
    if (imageUrl && (!/^https:\/\/drive\.google\.com\//.test(imageUrl) || imageUrl.length > 2000)) return res.status(400).json({ error: "写真URLが無効です" });
    if (!text && !imageUrl) return res.status(400).json({ error: "テキストか写真を指定してください" });
    const message = { id: crypto.randomUUID(), uid: req.user.uid, displayName: String(req.user.name || req.user.email || "ユーザー").slice(0, 100), text, imageUrl, createdAt: new Date().toISOString() };
    await appendMessage(message);
    res.status(201).json({ message });
    sendNewMessagePush(req.user.uid).catch(e => console.error("Push notification failed:", e));
  } catch (e) { next(e); }
});
app.use((req, res, next) => { if (req.path === "/data" || req.path.startsWith("/data/")) return res.status(404).end(); next(); });
app.use(express.static(__dirname, { index: "index.html", etag: true, maxAge: "5m" }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "サーバー内部エラー" }); });
app.listen(PORT, HOST, () => console.log("ChatSite listening on http://" + HOST + ":" + PORT));
