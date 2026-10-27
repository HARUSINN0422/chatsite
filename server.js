const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const { promisify } = require("util");
const { execFile } = require("child_process");
const multer = require("multer");
const webpush = require("web-push");
const sharp = require("sharp");

const app = express();
const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.jsonl");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const READS_FILE = path.join(DATA_DIR, "read-receipts.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const MAX_TEXT = 4000;
const MAX_MESSAGES = 200;
const PHOTO_MAX_BYTES = 256 * 1024;
const PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_UPDATE_INTERVAL = 60 * 1000;
const AUTO_UPDATE_BRANCH = "main";
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
let updateInProgress = false;\nconst activeCalls = new Map();\nlet nextSignalSeq = 1;
let writeQueue = Promise.resolve();

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (pushConfigured) webpush.setVapidDetails(process.env.VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

async function ensureDataDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(PHOTO_DIR, { recursive: true, mode: 0o700 });
}
async function readUsers() {
  await ensureDataDirs();
  try { return JSON.parse(await fsp.readFile(USERS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function writeUsers(users) {
  await ensureDataDirs();
  const tmp = USERS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, USERS_FILE);
}
async function readMessages() {
  await ensureDataDirs();
  let raw;
  try { raw = await fsp.readFile(MESSAGES_FILE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return raw.split("\n").filter(Boolean).slice(-5000).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
async function readConversations() {
  await ensureDataDirs();
  try { return JSON.parse(await fsp.readFile(CONVERSATIONS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function writeConversations(data) {
  await ensureDataDirs();
  const tmp = CONVERSATIONS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, CONVERSATIONS_FILE);
}
async function readReceipts() {
  await ensureDataDirs();
  try { return JSON.parse(await fsp.readFile(READS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function writeReceipts(data) {
  await ensureDataDirs();
  const tmp = READS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await fsp.rename(tmp, READS_FILE);
}
async function readSessions() {
  await ensureDataDirs();
  try { return JSON.parse(await fsp.readFile(SESSIONS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function writeSessions(data) {
  await ensureDataDirs();
  const tmp = SESSIONS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await fsp.rename(tmp, SESSIONS_FILE);
}
async function appendMessage(message) {
  writeQueue = writeQueue.then(async () => {
    await ensureDataDirs();
    await fsp.appendFile(MESSAGES_FILE, JSON.stringify(message) + "\n", { encoding: "utf8", mode: 0o600 });
  });
  return writeQueue;
}
async function readSubscriptions() {
  await ensureDataDirs();
  try { return JSON.parse(await fsp.readFile(SUBSCRIPTIONS_FILE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
async function writeSubscriptions(data) {
  await ensureDataDirs();
  const tmp = SUBSCRIPTIONS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, SUBSCRIPTIONS_FILE);
}
function getSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)chatsite_session=([a-f0-9]{64})(?:;|$)/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(match[1]);
    writeSessions(Object.fromEntries(sessions)).catch(e => console.error("[Session] セッション保存に失敗しました:", e.message));
    return null;
  }
  return { token: match[1], ...session };
}
function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", "chatsite_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000) + (secure ? "; Secure" : ""));
}
function clearSessionCookie(req, res) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", "chatsite_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (secure ? "; Secure" : ""));
}
function requireLogin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "ログインしてください" });
  req.user = { uid: session.uid, username: session.username };
  next();
}
function validUsername(username) {
  return typeof username === "string" && /^[A-Za-z0-9_-]{3,24}$/.test(username);
}
async function sendNewMessagePush(message, recipientUids) {
  if (!pushConfigured) return;
  let subscriptions;
  try { subscriptions = await readSubscriptions(); }
  catch (e) { console.error("Push subscription read failed:", e); return; }
  let changed = false;
  const jobs = [];
  const recipients = new Set(recipientUids || []);
  const senderName = String(message.displayName || "ユーザー").slice(0, 80);
  const messageText = String(message.text || "").trim();
  const preview = messageText || (message.imageUrl ? "写真が届きました" : "新しいメッセージ");
  const body = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
  for (const [endpoint, entry] of Object.entries(subscriptions)) {
    if (entry.uid === message.uid || !recipients.has(entry.uid)) continue;
    jobs.push(webpush.sendNotification(entry.subscription, JSON.stringify({
      title: senderName + " からメッセージ",
      body,
      url: entry.basePath || process.env.APP_BASE_PATH || "/"
    })).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) { delete subscriptions[endpoint]; changed = true; }
      else console.error("Push delivery failed:", err.statusCode || err.message);
    }));
  }
  await Promise.allSettled(jobs);
  if (changed) await writeSubscriptions(subscriptions);
}

const allowedImageTypes = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "image/webp": ".webp", "image/avif": ".avif"
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!allowedImageTypes[file.mimetype]) return cb(new Error("JPEG、PNG、GIF、WebP、AVIF形式の画像を選択してください"));
    cb(null, true);
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.post("/api/register", async (req, res, next) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!validUsername(username)) return res.status(400).json({ error: "ユーザー名は英数字、_、- の3〜24文字にしてください" });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "パスワードは8〜128文字にしてください" });
    const users = await readUsers();
    const key = username.toLowerCase();
    if (users[key]) return res.status(409).json({ error: "そのユーザー名はすでに使われています" });
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (await scrypt(password, salt, 64)).toString("hex");
    const uid = crypto.randomUUID();
    users[key] = { uid, username, salt, passwordHash: hash, createdAt: new Date().toISOString() };
    await writeUsers(users);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { uid, username, expiresAt: Date.now() + SESSION_TTL_MS });
    await writeSessions(Object.fromEntries(sessions));
    setSessionCookie(req, res, token);
    res.status(201).json({ user: { uid, username } });
  } catch (e) { next(e); }
});
app.post("/api/login", async (req, res, next) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!validUsername(username) || !password || password.length > 128)
      return res.status(400).json({ error: "ユーザー名またはパスワードを確認してください" });
    const users = await readUsers();
    const user = users[username.toLowerCase()];
    if (!user) return res.status(401).json({ error: "ユーザー名またはパスワードが違います" });
    const candidate = await scrypt(password, user.salt, 64);
    const actual = Buffer.from(user.passwordHash, "hex");
    if (actual.length !== candidate.length || !crypto.timingSafeEqual(actual, candidate))
      return res.status(401).json({ error: "ユーザー名またはパスワードが違います" });
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { uid: user.uid, username: user.username, expiresAt: Date.now() + SESSION_TTL_MS });
    await writeSessions(Object.fromEntries(sessions));
    setSessionCookie(req, res, token);
    res.json({ user: { uid: user.uid, username: user.username } });
  } catch (e) { next(e); }
});
app.get("/api/me", requireLogin, (req, res) => res.json({ user: req.user }));
app.post("/api/logout", async (req, res, next) => {
  try {
    const session = getSession(req);
    if (session) sessions.delete(session.token);
    await writeSessions(Object.fromEntries(sessions));
    clearSessionCookie(req, res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

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
    const prefixHeader = req.headers["x-forwarded-prefix"];
    const basePath = typeof prefixHeader === "string" && /^\/[A-Za-z0-9/_-]*$/.test(prefixHeader) ? (prefixHeader.endsWith("/") ? prefixHeader : prefixHeader + "/") : (process.env.APP_BASE_PATH || undefined);
    data[sub.endpoint] = { uid: req.user.uid, subscription: sub, basePath, updatedAt: new Date().toISOString() };
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

app.get("/api/users", requireLogin, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    if (q.length < 1) return res.json({ users: [] });
    const users = await readUsers();
    const results = Object.values(users)
      .filter(u => u.uid !== req.user.uid && u.username.toLowerCase().includes(q))
      .sort((a, b) => a.username.localeCompare(b.username))
      .slice(0, 30)
      .map(u => ({ uid: u.uid, username: u.username }));
    res.set("Cache-Control", "no-store").json({ users: results });
  } catch (e) { next(e); }
});
app.get("/api/conversations", requireLogin, async (req, res, next) => {
  try {
    const [conversations, messages] = await Promise.all([readConversations(), readMessages()]);
    const result = Object.values(conversations)
      .filter(c => c.memberUids.includes(req.user.uid))
      .map(c => {
        const last = [...messages].reverse().find(m => m.conversationId === c.id);
        const otherNames = c.memberUids.filter(uid => uid !== req.user.uid).map(uid => c.memberNames[uid] || "ユーザー");
        return { id: c.id, type: c.type, name: c.type === "group" ? c.name : (otherNames[0] || "DM"), members: c.memberUids.length, lastMessage: last ? (last.text || (last.imageUrl ? "写真" : "")) : "", updatedAt: last ? last.createdAt : c.createdAt };
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.set("Cache-Control", "no-store").json({ conversations: result });
  } catch (e) { next(e); }
});
app.post("/api/conversations/dm", requireLogin, async (req, res, next) => {
  try {
    const targetUid = typeof req.body?.uid === "string" ? req.body.uid : "";
    if (!targetUid || targetUid === req.user.uid) return res.status(400).json({ error: "相手のユーザーを選択してください" });
    const users = await readUsers();
    const target = Object.values(users).find(u => u.uid === targetUid);
    if (!target) return res.status(404).json({ error: "ユーザーが見つかりません" });
    const conversations = await readConversations();
    let conversation = Object.values(conversations).find(c => c.type === "dm" && c.memberUids.length === 2 && c.memberUids.includes(req.user.uid) && c.memberUids.includes(targetUid));
    if (!conversation) {
      const memberNames = { [req.user.uid]: req.user.username, [target.uid]: target.username };
      conversation = { id: crypto.randomUUID(), type: "dm", name: "", memberUids: [req.user.uid, target.uid], memberNames, createdBy: req.user.uid, createdAt: new Date().toISOString() };
      conversations[conversation.id] = conversation;
      await writeConversations(conversations);
    }
    res.status(201).json({ conversation: { id: conversation.id } });
  } catch (e) { next(e); }
});

function callPublicView(call, viewerUid) {
  return { id: call.id, conversationId: call.conversationId, kind: call.kind, status: call.status,
    caller: call.callerUid === viewerUid, callerUid: call.callerUid, calleeUid: call.calleeUid,
    fromName: call.callerName, createdAt: call.createdAt };
}
function getAuthorizedCall(callId, uid) {
  const call = activeCalls.get(callId);
  if (!call || (call.callerUid !== uid && call.calleeUid !== uid)) return null;
  return call;
}
app.post("/api/calls", requireLogin, async (req, res, next) => {
  try {
    const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : "";
    const kind = req.body?.kind === "video" ? "video" : req.body?.kind === "audio" ? "audio" : "";
    if (!kind) return res.status(400).json({ error: "通話形式が無効です" });
    const conversations = await readConversations();
    const conversation = conversations[conversationId];
    if (!conversation || conversation.type !== "dm" || conversation.memberUids.length !== 2 || !conversation.memberUids.includes(req.user.uid))
      return res.status(403).json({ error: "1対1のDMからのみ発信できます" });
    for (const c of activeCalls.values()) {
      if (c.status === "ringing" || c.status === "accepted") {
        if (c.callerUid === req.user.uid || c.calleeUid === req.user.uid)
          return res.status(409).json({ error: "すでに別の通話が進行中です" });
      }
    }
    const calleeUid = conversation.memberUids.find(uid => uid !== req.user.uid);
    const users = await readUsers();
    const callerName = Object.values(users).find(u => u.uid === req.user.uid)?.username || req.user.username;
    const call = { id: crypto.randomUUID(), conversationId, callerUid: req.user.uid, calleeUid,
      callerName, kind, status: "ringing", createdAt: Date.now(), signals: [] };
    activeCalls.set(call.id, call);
    res.status(201).json({ call: { ...callPublicView(call, req.user.uid), caller: true } });
  } catch (e) { next(e); }
});
app.get("/api/calls", requireLogin, (req, res) => {
  const now = Date.now();
  for (const [id, call] of activeCalls) {
    if (now - call.createdAt > (call.status === "ringing" ? 90000 : 4 * 60 * 60 * 1000)) activeCalls.delete(id);
  }
  res.set("Cache-Control", "no-store").json({ calls: [...activeCalls.values()]
    .filter(c => c.callerUid === req.user.uid || c.calleeUid === req.user.uid)
    .map(c => ({ ...callPublicView(c, req.user.uid), callee: c.calleeUid === req.user.uid })) });
});
app.get("/api/calls/:id", requireLogin, (req, res) => {
  const call = getAuthorizedCall(req.params.id, req.user.uid);
  if (!call) return res.status(404).json({ error: "通話が見つかりません" });
  if (call.status === "ringing" && Date.now() - call.createdAt > 90000) call.status = "missed";
  res.set("Cache-Control", "no-store").json({ call: callPublicView(call, req.user.uid) });
});
app.post("/api/calls/:id/answer", requireLogin, (req, res) => {
  const call = getAuthorizedCall(req.params.id, req.user.uid);
  if (!call || call.calleeUid !== req.user.uid) return res.status(404).json({ error: "着信が見つかりません" });
  if (call.status !== "ringing") return res.status(409).json({ error: "この着信には応答できません" });
  if (Date.now() - call.createdAt > 90000) { call.status = "missed"; return res.status(410).json({ error: "着信の有効期限が切れました" }); }
  if (req.body?.accept === true) call.status = "accepted";
  else call.status = "declined";
  res.json({ call: callPublicView(call, req.user.uid) });
});
app.post("/api/calls/:id/signals", requireLogin, express.json({ limit: "64kb" }), (req, res) => {
  const call = getAuthorizedCall(req.params.id, req.user.uid);
  if (!call || call.status === "ended" || call.status === "declined" || call.status === "missed")
    return res.status(404).json({ error: "有効な通話が見つかりません" });
  const { type, data } = req.body || {};
  if (!["offer", "answer", "candidate"].includes(type) || !data || JSON.stringify(data).length > 50000)
    return res.status(400).json({ error: "接続情報が無効です" });
  if (type === "offer" && (req.user.uid !== call.callerUid || call.status !== "accepted"))
    return res.status(403).json({ error: "offerを送信できません" });
  if (type === "answer" && req.user.uid !== call.calleeUid)
    return res.status(403).json({ error: "answerを送信できません" });
  call.signals.push({ seq: nextSignalSeq++, toUid: req.user.uid === call.callerUid ? call.calleeUid : call.callerUid, fromUid: req.user.uid, type, data, createdAt: Date.now() });
  if (call.signals.length > 300) call.signals.splice(0, call.signals.length - 300);
  res.status(201).json({ ok: true });
});
app.get("/api/calls/:id/signals", requireLogin, (req, res) => {
  const call = getAuthorizedCall(req.params.id, req.user.uid);
  if (!call) return res.status(404).json({ error: "通話が見つかりません" });
  const after = Math.max(0, Number.parseInt(req.query.after, 10) || 0);
  res.set("Cache-Control", "no-store").json({ signals: call.signals.filter(s => s.toUid === req.user.uid && s.seq > after).map(({seq,type,data}) => ({seq,type,data})) });
});
app.post("/api/calls/:id/end", requireLogin, (req, res) => {
  const call = getAuthorizedCall(req.params.id, req.user.uid);
  if (!call) return res.json({ ok: true });
  call.status = "ended"; call.signals.length = 0;
  res.json({ ok: true });
});
\napp.post("/api/conversations/group", requireLogin, async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const submitted = Array.isArray(req.body?.memberUids) ? req.body.memberUids : [];
    const memberUids = [...new Set([req.user.uid, ...submitted.filter(v => typeof v === "string")])];
    if (!name || name.length > 60) return res.status(400).json({ error: "グループ名は1〜60文字にしてください" });
    if (memberUids.length < 3) return res.status(400).json({ error: "グループには自分以外に2人以上選択してください" });
    if (memberUids.length > 50) return res.status(400).json({ error: "グループは50人までです" });
    const users = await readUsers();
    const userByUid = new Map(Object.values(users).map(u => [u.uid, u]));
    if (memberUids.some(uid => !userByUid.has(uid))) return res.status(400).json({ error: "存在しないユーザーが含まれています" });
    const memberNames = Object.fromEntries(memberUids.map(uid => [uid, userByUid.get(uid).username]));
    const conversation = { id: crypto.randomUUID(), type: "group", name, memberUids, memberNames, createdBy: req.user.uid, createdAt: new Date().toISOString() };
    const conversations = await readConversations();
    conversations[conversation.id] = conversation;
    await writeConversations(conversations);
    res.status(201).json({ conversation: { id: conversation.id } });
  } catch (e) { next(e); }
});
app.get("/api/conversations/:id/members", requireLogin, async (req, res, next) => {
  try {
    const conversations = await readConversations();
    const conversation = conversations[req.params.id];
    if (!conversation || conversation.type !== "group" || !conversation.memberUids.includes(req.user.uid))
      return res.status(404).json({ error: "グループが見つからないか、参加権限がありません" });
    const members = conversation.memberUids.map(uid => ({
      uid,
      username: conversation.memberNames[uid] || "ユーザー"
    }));
    res.set("Cache-Control", "no-store").json({ members });
  } catch (e) { next(e); }
});
app.post("/api/conversations/:id/members", requireLogin, async (req, res, next) => {
  try {
    const submitted = Array.isArray(req.body?.memberUids) ? req.body.memberUids : [];
    const addUids = [...new Set(submitted.filter(uid => typeof uid === "string" && uid !== req.user.uid))];
    if (!addUids.length) return res.status(400).json({ error: "追加するユーザーを選択してください" });
    const conversations = await readConversations();
    const conversation = conversations[req.params.id];
    if (!conversation || conversation.type !== "group" || !conversation.memberUids.includes(req.user.uid))
      return res.status(404).json({ error: "グループが見つからないか、参加権限がありません" });
    const users = await readUsers();
    const userByUid = new Map(Object.values(users).map(u => [u.uid, u]));
    if (addUids.some(uid => !userByUid.has(uid))) return res.status(400).json({ error: "存在しないユーザーが含まれています" });
    const newUids = addUids.filter(uid => !conversation.memberUids.includes(uid));
    if (!newUids.length) return res.status(400).json({ error: "選択したユーザーはすでに参加しています" });
    if (conversation.memberUids.length + newUids.length > 50) return res.status(400).json({ error: "グループは50人までです" });
    conversation.memberUids.push(...newUids);
    for (const uid of newUids) conversation.memberNames[uid] = userByUid.get(uid).username;
    await writeConversations(conversations);
    res.json({ added: newUids.length, conversation: { id: conversation.id } });
  } catch (e) { next(e); }
});

app.get("/api/conversations/:id/messages", requireLogin, async (req, res, next) => {
  try {
    const conversations = await readConversations();
    const conversation = conversations[req.params.id];
    if (!conversation || !conversation.memberUids.includes(req.user.uid)) return res.status(404).json({ error: "会話が見つからないか、参加権限がありません" });
    const messages = (await readMessages()).filter(m => m.conversationId === conversation.id).slice(-MAX_MESSAGES);
    const receipts = await readReceipts();
    let changed = false;
    for (const message of messages) {
      if (message.uid !== req.user.uid) {
        const readers = Array.isArray(receipts[message.id]) ? receipts[message.id] : [];
        if (!readers.includes(req.user.uid)) { receipts[message.id] = [...readers, req.user.uid]; changed = true; }
      }
    }
    if (changed) await writeReceipts(receipts);
    const withReceipts = messages.map(message => ({ ...message, readBy: receipts[message.id] || [] }));
    res.set("Cache-Control", "no-store").json({ messages: withReceipts });
  } catch (e) { next(e); }
});
app.post("/api/photos", requireLogin, (req, res, next) => {
  upload.single("photo")(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "写真は10MB以下にしてください" : err.message });
    if (!req.file) return res.status(400).json({ error: "写真ファイルを選択してください" });
    try {
      let savedBuffer = req.file.buffer;
      let extension = allowedImageTypes[req.file.mimetype];
      if (savedBuffer.length > PHOTO_MAX_BYTES) {
        let compressed = null;
        const widths = [1600, 1400, 1200, 1000, 800, 640, 480, 360, 240];
        const qualities = [82, 72, 62, 52, 42, 32, 24];
        for (const width of widths) {
          for (const quality of qualities) {
            compressed = await sharp(req.file.buffer, { animated: false })
              .rotate()
              .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
              .jpeg({ quality, mozjpeg: true })
              .toBuffer();
            if (compressed.length <= PHOTO_MAX_BYTES) break;
          }
          if (compressed && compressed.length <= PHOTO_MAX_BYTES) break;
        }
        if (!compressed || compressed.length > PHOTO_MAX_BYTES)
          return res.status(400).json({ error: "写真を256KB以下に圧縮できませんでした。別の画像を選択してください" });
        savedBuffer = compressed;
        extension = ".jpg";
      }
      const filename = crypto.randomUUID() + extension;
      await fsp.writeFile(path.join(PHOTO_DIR, filename), savedBuffer, { flag: "wx", mode: 0o600 });
      res.status(201).json({ imageUrl: "/api/photos/" + filename, size: savedBuffer.length });
    } catch (e) { next(e); }
  });
});
app.get("/api/photos/:filename", requireLogin, async (req, res, next) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9-]+\.(jpg|png|gif|webp|avif)$/.test(filename)) return res.status(404).end();
  try {
    await fsp.access(path.join(PHOTO_DIR, filename));
    res.set("Cache-Control", "private, no-store");
    res.sendFile(path.join(PHOTO_DIR, filename), { headers: { "X-Content-Type-Options": "nosniff" } });
  } catch (e) { if (e.code === "ENOENT") return res.status(404).json({ error: "写真は削除済みか見つかりません" }); next(e); }
});
app.post("/api/conversations/:id/messages", requireLogin, async (req, res, next) => {
  try {
    const conversations = await readConversations();
    const conversation = conversations[req.params.id];
    if (!conversation || !conversation.memberUids.includes(req.user.uid)) return res.status(404).json({ error: "会話が見つからないか、参加権限がありません" });
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : "";
    if (text.length > MAX_TEXT) return res.status(400).json({ error: "テキストは4000文字以内にしてください" });
    if (imageUrl && !/^\/api\/photos\/[a-f0-9-]+\.(jpg|png|gif|webp|avif)$/.test(imageUrl))
      return res.status(400).json({ error: "写真URLが無効です" });
    if (!text && !imageUrl) return res.status(400).json({ error: "テキストか写真を指定してください" });
    const message = {
      id: crypto.randomUUID(), conversationId: conversation.id, uid: req.user.uid, displayName: req.user.username,
      text, imageUrl, createdAt: new Date().toISOString()
    };
    await appendMessage(message);
    res.status(201).json({ message });
    sendNewMessagePush(message, conversation.memberUids).catch(e => console.error("Push notification failed:", e));
  } catch (e) { next(e); }
});

async function cleanupOldPhotos() {
  try {
    await ensureDataDirs();
    const cutoff = Date.now() - PHOTO_TTL_MS;
    const names = await fsp.readdir(PHOTO_DIR);
    let deleted = 0;
    for (const name of names) {
      const fullPath = path.join(PHOTO_DIR, name);
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fsp.unlink(fullPath);
          deleted++;
        }
      } catch (e) { if (e.code !== "ENOENT") console.error("[PhotoCleanup]", e.message); }
    }
    if (deleted) console.log("[PhotoCleanup] 3日以上経過した写真を" + deleted + "件削除しました。");
  } catch (e) { console.error("[PhotoCleanup] 写真の整理に失敗しました:", e.message); }
}
app.use((req, res, next) => {
  if (req.path === "/data" || req.path.startsWith("/data/")) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, { index: "index.html", etag: true, maxAge: "5m" }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "サーバー内部エラー" });
});

function checkForUpdates() {
  if (updateInProgress) return;
  updateInProgress = true;
  const finish = () => { updateInProgress = false; };
  execFile("git", ["fetch", "origin", AUTO_UPDATE_BRANCH], { cwd: __dirname }, fetchError => {
    if (fetchError) { console.error("[AutoUpdate] GitHubの確認に失敗しました:", fetchError.message); finish(); return; }
    execFile("git", ["rev-parse", "HEAD"], { cwd: __dirname }, (localError, localStdout) => {
      if (localError) { console.error("[AutoUpdate] 現在のコミットを取得できません:", localError.message); finish(); return; }
      execFile("git", ["rev-parse", "origin/" + AUTO_UPDATE_BRANCH], { cwd: __dirname }, (remoteError, remoteStdout) => {
        if (remoteError) { console.error("[AutoUpdate] GitHub側のコミットを取得できません:", remoteError.message); finish(); return; }
        if (localStdout.trim() === remoteStdout.trim()) { finish(); return; }
        console.log("[AutoUpdate] GitHubの更新を取得します。");
        execFile("git", ["pull", "--ff-only", "origin", AUTO_UPDATE_BRANCH], { cwd: __dirname }, (pullError, pullStdout, pullStderr) => {
          if (pullError) { console.error("[AutoUpdate] git pullに失敗しました:", pullError.message); if (pullStderr) console.error(pullStderr.trim()); finish(); return; }
          if (pullStdout) console.log(pullStdout.trim());
          execFile("npm", ["install", "--omit=dev"], { cwd: __dirname }, (npmError, npmStdout, npmStderr) => {
            if (npmError) { console.error("[AutoUpdate] npm installに失敗しました:", npmError.message); if (npmStderr) console.error(npmStderr.trim()); finish(); return; }
            if (npmStdout) console.log(npmStdout.trim());
            console.log("[AutoUpdate] 更新完了。Node.jsプロセスを再起動します。");
            process.exit(75);
          });
        });
      });
    });
  });
}

async function start() {
  await ensureDataDirs();
  const savedSessions = await readSessions();
  const now = Date.now();
  for (const [token, session] of Object.entries(savedSessions)) {
    if (/^[a-f0-9]{64}$/.test(token) && session && typeof session.uid === "string" && typeof session.username === "string" && Number.isFinite(session.expiresAt) && session.expiresAt > now) {
      sessions.set(token, session);
    }
  }
  await writeSessions(Object.fromEntries(sessions));
  await cleanupOldPhotos();
  setInterval(cleanupOldPhotos, 60 * 60 * 1000);
  app.listen(PORT, HOST, () => {
    console.log("ChatSite listening on http://" + HOST + ":" + PORT);
    console.log("アカウントはサイト内で作成できます。写真はラズパイに保存し、3日経過後に削除します。");
    console.log("[AutoUpdate] GitHubの" + AUTO_UPDATE_BRANCH + "ブランチを60秒ごとに確認します。");
    setTimeout(checkForUpdates, AUTO_UPDATE_INTERVAL);
    setInterval(checkForUpdates, AUTO_UPDATE_INTERVAL);
  });
}
start().catch(err => { console.error("ChatSiteの起動に失敗しました:", err); process.exit(1); });
