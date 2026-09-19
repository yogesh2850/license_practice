import { createServer } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "server", "data");
const PORT = Number(process.env.PORT || 8787);
const SESSION_DAYS = 90;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "practice.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    attempts_json TEXT NOT NULL DEFAULT '[]',
    coverage_json TEXT NOT NULL DEFAULT '{"byTest":{}}',
    missed_json TEXT NOT NULL DEFAULT '{}',
    in_progress_json TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const stmts = {
  insertUser: db.prepare(
    "INSERT INTO users (email, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
  ),
  findUser: db.prepare("SELECT * FROM users WHERE email = ?"),
  insertSession: db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ),
  findSession: db.prepare(
    "SELECT s.token, s.user_id, s.expires_at, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  deleteExpired: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  insertProfile: db.prepare(
    "INSERT INTO profiles (user_id, attempts_json, coverage_json, missed_json, in_progress_json, updated_at) VALUES (?, '[]', '{\"byTest\":{}}', '{}', NULL, ?)",
  ),
  getProfile: db.prepare("SELECT * FROM profiles WHERE user_id = ?"),
  updateProfile: db.prepare(
    "UPDATE profiles SET attempts_json = ?, coverage_json = ?, missed_json = ?, in_progress_json = ?, updated_at = ? WHERE user_id = ?",
  ),
  userCount: db.prepare("SELECT COUNT(*) AS count FROM users"),
};

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

function checkPassword(password, saltHex, expectedHex) {
  const { hash } = hashPassword(password, saltHex);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function token() {
  return randomBytes(32).toString("hex");
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function sessionUser(req) {
  stmts.deleteExpired.run(nowIso());
  const tok = bearer(req);
  if (!tok) return null;
  const row = stmts.findSession.get(tok);
  if (!row || row.expires_at < nowIso()) return null;
  return row;
}

function emptyProfile(email) {
  return {
    email,
    name: email,
    attempts: [],
    coverage: { byTest: {} },
    missed: {},
    inProgress: null,
  };
}

function profileFromRow(row, email) {
  return {
    email,
    name: email,
    attempts: JSON.parse(row.attempts_json || "[]"),
    coverage: JSON.parse(row.coverage_json || '{"byTest":{}}'),
    missed: JSON.parse(row.missed_json || "{}"),
    inProgress: row.in_progress_json ? JSON.parse(row.in_progress_json) : null,
  };
}

function createSession(userId) {
  const tok = token();
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  stmts.insertSession.run(tok, userId, created, expires);
  return { token: tok, expiresAt: expires };
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, users: stmts.userCount.get().count });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signup") {
    const body = await readBody(req, 10_000);
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!EMAIL_RE.test(email)) {
      json(res, 400, { error: "Enter a valid email address." });
      return;
    }
    if (password.length < 6) {
      json(res, 400, { error: "Password must be at least 6 characters." });
      return;
    }
    if (stmts.findUser.get(email)) {
      json(res, 409, { error: "That email already has an account. Log in instead." });
      return;
    }
    const created = nowIso();
    const secret = hashPassword(password);
    const result = stmts.insertUser.run(email, secret.hash, secret.salt, created);
    stmts.insertProfile.run(result.lastInsertRowid, created);
    const session = createSession(result.lastInsertRowid);
    json(res, 201, { token: session.token, profile: emptyProfile(email) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req, 10_000);
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const user = stmts.findUser.get(email);
    if (!user || !checkPassword(password, user.salt, user.password_hash)) {
      json(res, 401, { error: "Email or password is incorrect." });
      return;
    }
    const session = createSession(user.id);
    const row = stmts.getProfile.get(user.id);
    json(res, 200, { token: session.token, profile: profileFromRow(row, user.email) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const tok = bearer(req);
    if (tok) stmts.deleteSession.run(tok);
    json(res, 200, { ok: true });
    return;
  }

  const user = sessionUser(req);
  if (!user) {
    json(res, 401, { error: "Please log in." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    json(res, 200, { email: user.email });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/profile") {
    const row = stmts.getProfile.get(user.user_id);
    json(res, 200, { profile: profileFromRow(row, user.email) });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/profile") {
    const body = await readBody(req);
    const attempts = Array.isArray(body.attempts) ? body.attempts : [];
    const coverage = body.coverage && typeof body.coverage === "object" ? body.coverage : { byTest: {} };
    const missed = body.missed && typeof body.missed === "object" ? body.missed : {};
    const inProgress = body.inProgress ?? null;
    stmts.updateProfile.run(
      JSON.stringify(attempts),
      JSON.stringify(coverage),
      JSON.stringify(missed),
      inProgress == null ? null : JSON.stringify(inProgress),
      nowIso(),
      user.user_id,
    );
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: "Not found." });
}

function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname);
  if (relative === "/") relative = "/index.html";
  const safe = normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT, safe);
  if (!filePath.startsWith(ROOT) || filePath.includes(`${join("server", "data")}`)) {
    json(res, 403, { error: "Forbidden." });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    json(res, 404, { error: "Not found." });
    return;
  }
  const type = MIME[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "Method not allowed." });
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    const message = error?.message === "invalid json" ? "Invalid JSON." : error?.message === "body too large" ? "Request too large." : "Server error.";
    if (!res.headersSent) json(res, 400, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`License practice server on http://127.0.0.1:${PORT}`);
});
