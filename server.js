#!/usr/bin/env node
/**
 * Sagechat backend — Node.js recode (pengganti server.py).
 *
 * Fitur sama persis + perbaikan:
 *  - proxy chat streaming (SSE) + tool loop (shell sandbox & GitHub)
 *  - history per-sesi, memory, upload file/gambar, statistik token
 *  - permission-gate untuk aksi berisiko
 *  - parsing <<CMD>>/<<GH>> tahan banting (tidak pakai regex non-greedy rapuh)
 *  - snapshot sandbox ROOT (bukan cuma cwd) supaya file hasil AI pasti ketangkap / bisa didownload
 *  - zip pure-JS (adm-zip) tanpa dependency native
 *
 * Jalanin:
 *   npm install
 *   npm start
 *   buka http://127.0.0.1:5058
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const AdmZip = require("adm-zip");

const GITHUB_API = "https://api.github.com";
const PORT = 5058;
const HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// PATHS & CONFIG
// ---------------------------------------------------------------------------
const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, "data");
const CHATS_DIR = path.join(DATA_DIR, "chats");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const GENERATED_DIR = path.join(DATA_DIR, "generated");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const MEMORY_PATH = path.join(DATA_DIR, "memory.json");
const STATS_PATH = path.join(DATA_DIR, "stats.json");
const UPLOAD_INDEX_PATH = path.join(UPLOADS_DIR, "index.json");
const MODELS_CACHE_PATH = path.join(DATA_DIR, "models_cache.json");
const CUSTOM_MODELS_PATH = path.join(DATA_DIR, "custom_models.json");

for (const d of [DATA_DIR, CHATS_DIR, UPLOADS_DIR, GENERATED_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const SCAN_IGNORE_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"]);
const MAX_DOWNLOAD_FILES = 25;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TOOL_ROUNDS = 8;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const VISION_HINTS = ["vision", "-vl", "vl-", "gpt-4o", "claude", "gemini", "pixtral", "llava", "qwen2-vl", "qwen-vl"];

const DEFAULT_CONFIG = {
  router_url: "http://localhost:20128",
  router_api_key: "",
  github_token: "",
  github_repo: "",
  default_model: "",
  agent_mode: true,
  sandbox_dir: path.join(BASE_DIR, "workspace"),
};

const stopFlags = new Map(); // turnId -> { stopped: boolean }
const pendingPermissions = new Map(); // permId -> { resolve, allow, timer }

// ---------------------------------------------------------------------------
// JSON helpers (atomic write)
// ---------------------------------------------------------------------------
function readJson(p, def) {
  try {
    if (!fs.existsSync(p)) return def;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return def; }
}
function writeJson(p, data) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}
function loadConfig() { return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) }; }
function saveConfig(patch) {
  const cfg = loadConfig();
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "" && (k === "router_api_key" || k === "github_token")) continue; // kosong = biarkan lama (jangan wipe token)
    cfg[k] = v;
  }
  writeJson(CONFIG_PATH, cfg);
  return cfg;
}
function publicConfig(cfg) {
  cfg = cfg || loadConfig();
  return {
    router_url: cfg.router_url, default_model: cfg.default_model, agent_mode: cfg.agent_mode,
    github_repo: cfg.github_repo, sandbox_dir: cfg.sandbox_dir,
    router_api_key_set: !!cfg.router_api_key, github_token_set: !!cfg.github_token, github_available: true,
  };
}
function loadMemory() { return readJson(MEMORY_PATH, []); }
function saveMemory(items) { writeJson(MEMORY_PATH, items); }
function loadStats() {
  return readJson(STATS_PATH, { grand_total: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, per_model: {}, per_session: {} });
}
function loadModelsCache() { return readJson(MODELS_CACHE_PATH, null); }
function saveModelsCache(models) { writeJson(MODELS_CACHE_PATH, { models, cached_at: Date.now() / 1000 }); }
function loadCustomModels() { return readJson(CUSTOM_MODELS_PATH, []); }
function saveCustomModels(items) { writeJson(CUSTOM_MODELS_PATH, items); }
function mergeCustomModels(models, custom) {
  const seen = new Set(models.map(m => m.id));
  const out = [...models];
  for (const c of custom || []) { if (!seen.has(c.id)) { out.push({ id: c.id, vision: !!c.vision, custom: true }); seen.add(c.id); } }
  return out;
}
function recordUsage(sessionId, model, usage) {
  const stats = loadStats();
  for (const b of [stats.grand_total]) for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"]) b[k] = (b[k] || 0) + (usage[k] || 0);
  const m = stats.per_model[model] || (stats.per_model[model] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const s = stats.per_session[sessionId] || (stats.per_session[sessionId] = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  for (const b of [m, s]) for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"]) b[k] = (b[k] || 0) + (usage[k] || 0);
  writeJson(STATS_PATH, stats);
}

// ---------------------------------------------------------------------------
// SESSION HELPERS
// ---------------------------------------------------------------------------
function sessionPath(sid) { return path.join(CHATS_DIR, sid + ".json"); }
function newSession() {
  const cfg = loadConfig();
  const sid = crypto.randomBytes(6).toString("hex");
  const sess = { id: sid, title: "Obrolan baru", model: cfg.default_model || "", created_at: Date.now()/1000, updated_at: Date.now()/1000, messages: [] };
  writeJson(sessionPath(sid), sess);
  return sess;
}
function loadSession(sid) { try { const p = sessionPath(sid); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } }
function saveSession(sess) { sess.updated_at = Date.now()/1000; writeJson(sessionPath(sess.id), sess); }
function listSessions() {
  const out = [];
  try {
    for (const f of fs.readdirSync(CHATS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try { const s = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), "utf-8")); if (s && s.id) out.push({ id: s.id, title: s.title || "Obrolan", updated_at: s.updated_at || 0, model: s.model || "" }); } catch {}
    }
  } catch {}
  out.sort((a,b) => b.updated_at - a.updated_at);
  return out;
}
function toApiMessages(messages) { return (messages||[]).map(m => ({ role: m.role, content: m.content })); }

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------
function buildSystemPrompt(cfg) {
  const sandbox = cfg.sandbox_dir;
  const memory = loadMemory();
  let memBlock = "";
  if (memory && memory.length) memBlock = "\n\nCatatan memori dari user (anggap ini konteks yang sudah diketahui):\n" + memory.map(m => "- " + m.text).join("\n");
  if (!cfg.agent_mode) return ("Kamu adalah asisten chat biasa di Sagechat. Jawab pertanyaan user dengan jelas dan ringkas. Kamu TIDAK bisa menjalankan command atau mengubah apapun di luar percakapan ini (mode agent sedang nonaktif)." + memBlock);
  let ghBlock = "";
  if (cfg.github_repo) ghBlock = `\n\nKamu juga terhubung ke repo GitHub: ${cfg.github_repo} (bisa dioverride via field "repo").\nUntuk aksi GitHub, keluarkan blok:\n<<GH>>\n{"action": "read_file|list_tree|list_branches|create_file|update_file|delete_file|create_branch|create_pr|list_workflows|trigger_workflow",\n  "repo": "owner/name (opsional)", "path": "...", "content": "...", "message": "pesan commit",\n  "branch": "...", "base_branch": "...", "new_branch": "...", "title": "...", "body": "...",\n  "workflow_file": "nama-file.yml", "ref": "...", "reason": "kenapa aksi ini perlu"}\n<<END>>\nSEMUA aksi tulis (create_file/update_file/delete_file/create_branch/create_pr/trigger_workflow)\nakan SELALU minta konfirmasi manual dari user, termasuk kalau targetnya di .github/workflows/ —\nini bukan bug, ini kebijakan keamanan tetap. Jangan mengulang aksi yang baru saja ditolak user.`;
  return `Kamu adalah AI agent di web app "Sagechat" yang bisa menjalankan perintah shell\nuntuk membantu user dengan tugas pemrograman.\n\nSandbox root shell kamu: ${sandbox}\n\nUntuk command shell, keluarkan blok PERSIS:\n<<CMD>>\n{"cmd": "perintah shell", "cwd": "path relatif/absolut (opsional)", "reason": "alasan singkat"}\n<<END>>\n\nAturan:\n- Satu blok tool per giliran. Tunggu hasilnya sebelum lanjut ke command/aksi berikutnya.\n- Command di luar sandbox root akan diminta izin ke user — jujur saja di "reason".\n- Kalau tugas selesai tanpa perlu tool lagi, jawab teks biasa tanpa blok apapun.\n- Jangan jalankan command destruktif (rm -rf, dd, mkfs) tanpa alasan sangat eksplisit.\n- PENTING: kalau kamu membuat file (kode, html, zip, gambar, dsb) lewat shell, file itu OTOMATIS muncul sebagai tombol download di chat — beri tahu user nama filenya dan cara klik tombolnya. Jangan menempelkan seluruh isi file besar ke chat, cukup ringkasannya.${ghBlock}${memBlock}`;
}

// ---------------------------------------------------------------------------
// TOOL BLOCK PARSING — tahan banting (ganti regex rapuh <<CMD>>\\s*(\\{.*?\\})\\s*<<END>>)
// Regex lama gagal kalau JSON content berisi "}" di dalam string (kode!).
// Fungsi ini cari tag pembuka, lalu baca JSON dengan brace-counter yang sadar string.
// ---------------------------------------------------------------------------
function extractJsonBlock(text, tag) {
  const open = "<<" + tag + ">>";
  const close = "<<END>>";
  const i = text.indexOf(open);
  if (i === -1) return null;
  const js = text.indexOf("{", i + open.length);
  if (js === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = js; k < text.length; k++) {
    const ch = text[k];
    if (inStr) { if (esc) esc = false; else if (ch === "\\\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return { jsonText: text.slice(js, k+1), start: i, end: k+1 }; }
  }
  return null; // JSON belum lengkap (masih streaming) -> BUKAN error, tunggu chunk berikutnya
}
function findToolCall(text) {
  const c = extractJsonBlock(text, "CMD");
  const g = extractJsonBlock(text, "GH");
  if (c && g) return (c.start < g.start ? { kind: "cmd", ...c } : { kind: "gh", ...g });
  if (c) return { kind: "cmd", ...c };
  if (g) return { kind: "gh", ...g };
  return null;
}

// ---------------------------------------------------------------------------
// SHELL TOOL
// ---------------------------------------------------------------------------
function isWithin(p, root) {
  try {
    const rp = fs.realpathSync(p);
    const rr = fs.realpathSync(root);
    return rp === rr || rp.startsWith(rr + path.sep);
  } catch {
    const rel = path.relative(path.resolve(root), path.resolve(p));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }
}
function snapshotFiles(root) {
  const snap = {};
  if (!fs.existsSync(root)) return snap;
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SCAN_IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          snap[path.relative(root, full)] = st.mtimeMs + ":" + st.size;
        } catch {}
      }
    }
  };
  walk(root);
  return snap;
}
function diffNewFiles(before, after) { return Object.keys(after).filter(rel => before[rel] !== after[rel]); }
function packageGeneratedFiles(target, relPaths, batchId) {
  if (!relPaths || !relPaths.length) return [];
  relPaths = relPaths.slice(0, MAX_DOWNLOAD_FILES);
  const destDir = path.join(GENERATED_DIR, batchId);
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  let total = 0;
  for (const rel of relPaths) {
    if (rel.includes("..")) continue;
    const src = path.join(target, rel);
    try {
      if (!fs.statSync(src).isFile()) continue;
      const size = fs.statSync(src).size;
      if (total + size > MAX_DOWNLOAD_BYTES) continue;
      const dst = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
      total += size;
    } catch {}
  }
  if (!copied.length) return [];
  if (copied.length === 1) {
    const rel = copied[0];
    const fpath = path.join(destDir, rel);
    return [{ filename: path.basename(rel), url: "/downloads/" + batchId + "/" + rel.split(path.sep).join("/"), size: fs.statSync(fpath).size, zipped: false }];
  }
  const zipName = batchId + ".zip";
  const zipPath = path.join(GENERATED_DIR, zipName);
  try {
    const zip = new AdmZip();
    for (const rel of copied) zip.addLocalFile(path.join(destDir, rel), path.dirname(rel) === "." ? "" : path.dirname(rel).split(path.sep).join("/"));
    zip.writeZip(zipPath);
  } catch { return copied.map(rel => ({ filename: path.basename(rel), url: "/downloads/" + batchId + "/" + rel.split(path.sep).join("/"), size: 0, zipped: false })); }
  return [{ filename: zipName, url: "/downloads/" + zipName, size: fs.statSync(zipPath).size, zipped: true, count: copied.length }];
}
function executeShell(cmd, cwdField, reason, batchId) {
  return new Promise((resolve) => {
    const cfg = loadConfig();
    const sandbox = path.resolve(cfg.sandbox_dir);
    fs.mkdirSync(sandbox, { recursive: true });
    let target = sandbox;
    if (cwdField) target = path.isAbsolute(cwdField) ? path.resolve(cwdField) : path.resolve(path.join(sandbox, cwdField));
    else target = sandbox;
    const inside = isWithin(target, sandbox);
    try { fs.mkdirSync(target, { recursive: true }); } catch (e) { resolve({ output: "[ERROR mkdir: " + e.message + "]", code: -1, inside, targetStr: target, downloads: [] }); return; }
    // Snapshot SANDBOX ROOT (bukan cuma cwd) — perbaikan bug file AI tidak ketangkap/download.
    const before = snapshotFiles(sandbox);
    exec(cmd, { cwd: target, timeout: 60000, maxBuffer: 4*1024*1024, encoding: "utf8", shell: "/bin/sh" }, (err, stdout, stderr) => {
      const after = snapshotFiles(sandbox);
      const changed = diffNewFiles(before, after).filter(rel => {
        // hanya file di dalam sandbox yang boleh dibundel (keamanan)
        const abs = path.join(sandbox, rel);
        return isWithin(abs, sandbox);
      });
      // packageGeneratedFiles(target=sandbox, rel dari root) supaya path konsisten
      const downloads = packageGeneratedFiles(sandbox, changed, batchId);
      let out = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
      out = out.slice(0, 4000) || "(tidak ada output)";
      let code = 0;
      if (err) code = typeof err.code === "number" ? err.code : -1;
      if (err && err.killed) out = "[TIMEOUT setelah 60 detik]";
      resolve({ output: out, code, inside, targetStr: target, downloads });
    });
  });
}

// ---------------------------------------------------------------------------
// GITHUB TOOL (REST langsung via fetch — zero dependency tambahan)
// ---------------------------------------------------------------------------
const GH_READ_ACTIONS = new Set(["read_file", "list_tree", "list_branches", "list_workflows"]);
const GH_WRITE_ACTIONS = new Set(["create_file", "update_file", "delete_file", "create_branch", "create_pr", "trigger_workflow"]);

async function ghRequest(method, token, apiPath, params, jsonBody) {
  let url = GITHUB_API + apiPath;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += "?" + qs;
  }
  const resp = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "sagechat-node" },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  if (resp.status >= 400) {
    let msg = "HTTP " + resp.status;
    try { const j = await resp.json(); msg = j.message || msg; } catch { try { msg = await resp.text(); } catch {} }
    const e = new Error(msg); e.status = resp.status; throw e;
  }
  if (resp.status === 204) return {};
  const txt = await resp.text();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { return {}; }
}
async function resolveRepo(token, repoName) {
  const cfg = loadConfig();
  const name = repoName || cfg.github_repo;
  if (!name) throw new Error("Repo GitHub belum diset (Pengaturan atau field 'repo').");
  const meta = await ghRequest("GET", token, "/repos/" + name);
  return { repoName: name, defaultBranch: meta.default_branch };
}
async function executeGithub(actionData) {
  const cfg = loadConfig();
  const token = cfg.github_token;
  if (!token) return { text: "[GITHUB ERROR: token belum diset di Pengaturan]", ok: false };
  const action = actionData.action || "";
  try {
    const { repoName, defaultBranch } = await resolveRepo(token, actionData.repo);
    const branch = actionData.branch || defaultBranch;
    const p = actionData.path || "";
    if (action === "list_tree") {
      let items = await ghRequest("GET", token, "/repos/" + repoName + "/contents/" + p, { ref: branch });
      if (!Array.isArray(items)) items = [items];
      return { text: JSON.stringify(items.map(i => ({ name: i.name, path: i.path, type: i.type }))), ok: true };
    }
    if (action === "read_file") {
      const f = await ghRequest("GET", token, "/repos/" + repoName + "/contents/" + p, { ref: branch });
      const content = Buffer.from(f.content || "", "base64").toString("utf-8");
      return { text: content.slice(0, 6000), ok: true };
    }
    if (action === "list_branches") {
      const branches = await ghRequest("GET", token, "/repos/" + repoName + "/branches");
      return { text: JSON.stringify(branches.map(b => b.name)), ok: true };
    }
    if (action === "list_workflows") {
      const data = await ghRequest("GET", token, "/repos/" + repoName + "/actions/workflows");
      return { text: JSON.stringify((data.workflows || []).map(w => ({ name: w.name, path: w.path }))), ok: true };
    }
    if (action === "create_file") {
      await ghRequest("PUT", token, "/repos/" + repoName + "/contents/" + p, null, {
        message: actionData.message || "create via Sagechat",
        content: Buffer.from(actionData.content || "", "utf-8").toString("base64"), branch,
      });
      return { text: "File dibuat: " + p + " @ " + branch, ok: true };
    }
    if (action === "update_file") {
      const existing = await ghRequest("GET", token, "/repos/" + repoName + "/contents/" + p, { ref: branch });
      await ghRequest("PUT", token, "/repos/" + repoName + "/contents/" + p, null, {
        message: actionData.message || "update via Sagechat",
        content: Buffer.from(actionData.content || "", "utf-8").toString("base64"), branch, sha: existing.sha,
      });
      return { text: "File diupdate: " + p + " @ " + branch, ok: true };
    }
    if (action === "delete_file") {
      const existing = await ghRequest("GET", token, "/repos/" + repoName + "/contents/" + p, { ref: branch });
      await ghRequest("DELETE", token, "/repos/" + repoName + "/contents/" + p, null, {
        message: actionData.message || "delete via Sagechat", sha: existing.sha, branch,
      });
      return { text: "File dihapus: " + p + " @ " + branch, ok: true };
    }
    if (action === "create_branch") {
      const baseBranch = actionData.base_branch || defaultBranch;
      const newBranch = actionData.new_branch;
      if (!newBranch) return { text: "[GITHUB ERROR: 'new_branch' wajib diisi]", ok: false };
      const ref = await ghRequest("GET", token, "/repos/" + repoName + "/git/ref/heads/" + baseBranch);
      const sha = ref.object.sha;
      await ghRequest("POST", token, "/repos/" + repoName + "/git/refs", null, { ref: "refs/heads/" + newBranch, sha });
      return { text: "Branch dibuat: " + newBranch, ok: true };
    }
    if (action === "create_pr") {
      const pr = await ghRequest("POST", token, "/repos/" + repoName + "/pulls", null, {
        title: actionData.title || "PR via Sagechat", body: actionData.body || "",
        head: actionData.branch, base: actionData.base_branch || defaultBranch,
      });
      return { text: "PR dibuat: #" + pr.number + " — " + pr.html_url, ok: true };
    }
    if (action === "trigger_workflow") {
      const wf = actionData.workflow_file;
      if (!wf) return { text: "[GITHUB ERROR: 'workflow_file' wajib diisi]", ok: false };
      await ghRequest("POST", token, "/repos/" + repoName + "/actions/workflows/" + wf + "/dispatches", null, {
        ref: actionData.ref || defaultBranch, inputs: actionData.inputs || {},
      });
      return { text: "Workflow dipicu: " + wf, ok: true };
    }
    return { text: "[GITHUB ERROR: aksi tidak dikenal: " + action + "]", ok: false };
  } catch (e) {
    if (e.status) return { text: "[GITHUB ERROR " + e.status + ": " + e.message + "]", ok: false };
    if (/Repo GitHub belum diset/.test(e.message)) return { text: "[GITHUB ERROR: " + e.message + "]", ok: false };
    return { text: "[GITHUB ERROR: koneksi gagal — " + e.message + "]", ok: false };
  }
}

// ---------------------------------------------------------------------------
// 9ROUTER STREAMING (SSE -> async generator of events)
// ---------------------------------------------------------------------------
function sse(ev) { return "data: " + JSON.stringify(ev) + "\n\n"; }

async function* streamChatWeb(messages, model, isStopped) {
  const cfg = loadConfig();
  const url = cfg.router_url.replace(/\/$/, "") + "/v1/chat/completions";
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (cfg.router_api_key || "") },
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch (e) {
    yield { type: "error", message: "Gagal konek ke router: " + e.message };
    return;
  }
  if (!resp.ok) {
    let txt = "";
    try { txt = await resp.text(); } catch {}
    yield { type: "error", message: "Router error " + resp.status + ": " + (txt || "").slice(0, 300) };
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      if (isStopped && isStopped()) { try { await reader.cancel(); } catch {} yield { type: "stopped" }; return; }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (let raw of lines) {
        raw = raw.trim();
        if (!raw.startsWith("data:")) continue;
        const data = raw.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        const choices = chunk.choices || [];
        if (choices.length) {
          const delta = choices[0].delta || {};
          if (delta.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content };
          if (delta.content) yield { type: "content", text: delta.content };
        }
        if (chunk.usage) yield { type: "usage", ...chunk.usage };
      }
    }
  } catch (e) {
    yield { type: "error", message: "Koneksi terputus: " + e.message };
  }
}

// ---------------------------------------------------------------------------
// PERMISSION GATE (promise-based, timeout 180s)
// ---------------------------------------------------------------------------
function askPermission(kind, detail) {
  const permId = crypto.randomBytes(5).toString("hex");
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const timer = setTimeout(() => { if (pendingPermissions.has(permId)) { pendingPermissions.delete(permId); resolve(false); } }, 180000);
  pendingPermissions.set(permId, { resolve, timer, allow: false });
  const reqEv = { type: "permission_request", permission_id: permId, kind, ...detail };
  return { permId, reqEv, promise };
}
function resolvePermission(permId, allow) {
  const rec = pendingPermissions.get(permId);
  if (!rec) return false;
  clearTimeout(rec.timer);
  pendingPermissions.delete(permId);
  rec.resolve(!!allow);
  return true;
}

// ---------------------------------------------------------------------------
// TURN ORCHESTRATION
// ---------------------------------------------------------------------------
async function runTurn(sessionId, send, isStopped) {
  const cfg0 = loadConfig();
  let sess = loadSession(sessionId);
  if (!sess) { send({ type: "error", message: "Session tidak ditemukan." }); send({ type: "done" }); return; }
  const model = sess.model || cfg0.default_model;
  if (!model) { send({ type: "error", message: "Belum ada model dipilih." }); send({ type: "done" }); return; }
  const turnId = crypto.randomBytes(5).toString("hex");
  const flag = { stopped: false };
  stopFlags.set(turnId, flag);
  const stopped = () => flag.stopped || (isStopped && isStopped());
  send({ type: "turn_start", turn_id: turnId });
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (stopped()) { send({ type: "stopped" }); return; }
      const cfg = loadConfig();
      const systemPrompt = buildSystemPrompt(cfg);
      const apiMessages = [{ role: "system", content: systemPrompt }, ...toApiMessages(sess.messages)];
      let bufContent = "", bufReasoning = "";
      let gotError = null, gotStopped = false;
      for await (const ev of streamChatWeb(apiMessages, model, stopped)) {
        if (ev.type === "content") bufContent += ev.text;
        else if (ev.type === "reasoning") bufReasoning += ev.text;
        else if (ev.type === "usage") { try { recordUsage(sessionId, model, ev); } catch {} }
        else if (ev.type === "stopped") { gotStopped = true; send(ev); break; }
        else if (ev.type === "error") { gotError = ev; send(ev); break; }
        else send(ev);
        if (ev.type === "content" || ev.type === "reasoning") send(ev);
      }
      if (gotStopped) return;
      if (gotError) { send({ type: "done" }); return; }
      if (stopped()) { send({ type: "stopped" }); return; }
      sess.messages.push({ role: "assistant", content: bufContent, reasoning: bufReasoning, synthetic: false });
      if (sess.title === "Obrolan baru") {
        const firstUser = sess.messages.find(m => m.role === "user" && !m.synthetic);
        if (firstUser) {
          const t = typeof firstUser.content === "string" ? firstUser.content : ((firstUser.content.find(c => c.type === "text") || {}).text || "Obrolan");
          sess.title = (t || "Obrolan").slice(0, 48);
        }
      }
      saveSession(sess);
      const cfgNow = loadConfig();
      if (!cfgNow.agent_mode) { send({ type: "done" }); return; }
      const tool = findToolCall(bufContent);
      if (!tool) { send({ type: "done" }); return; }
      if (tool.kind === "cmd") {
        let data;
        try { data = JSON.parse(tool.jsonText); }
        catch (e) {
          const resultText = "[GAGAL PARSE JSON COMMAND: " + e.message + "]";
          send({ type: "tool_result", kind: "shell", success: false, output: resultText, exit_code: -1, downloads: [] });
          sess.messages.push({ role: "user", synthetic: true, downloads: [], content: "[HASIL COMMAND]\nexit_code: -1\noutput:\n" + resultText });
          saveSession(sess);
          continue;
        }
        const cmd = data.cmd || "", cwdField = data.cwd, reason = data.reason || "";
        const sandbox = path.resolve(cfgNow.sandbox_dir);
        let target = sandbox;
        if (cwdField) target = path.isAbsolute(cwdField) ? path.resolve(cwdField) : path.resolve(path.join(sandbox, cwdField));
        const inside = isWithin(target, sandbox);
        let allow = true;
        if (!inside) {
          const { permId, reqEv, promise } = askPermission("shell_outside_sandbox", { cmd, cwd: String(target), reason });
          send(reqEv);
          allow = await promise;
        }
        const batchId = crypto.randomBytes(5).toString("hex");
        let resultText, code, downloads;
        if (!allow) { resultText = "[DITOLAK OLEH USER — command tidak dijalankan]"; code = -1; downloads = []; }
        else {
          const r = await executeShell(cmd, cwdField, reason, batchId);
          resultText = r.output; code = r.code; downloads = r.downloads;
        }
        send({ type: "tool_result", kind: "shell", cmd, success: code === 0, output: resultText, exit_code: code, downloads });
        sess.messages.push({ role: "user", synthetic: true, downloads, content: "[HASIL COMMAND]\nexit_code: " + code + "\noutput:\n" + resultText });
        saveSession(sess);
        continue;
      }
      if (tool.kind === "gh") {
        let gdata = {};
        let parseErr = null;
        try { gdata = JSON.parse(tool.jsonText); } catch (e) { parseErr = e; }
        if (parseErr) {
          const resultText = "[GAGAL PARSE JSON GITHUB: " + parseErr.message + "]";
          send({ type: "tool_result", kind: "github", action: "", success: false, output: resultText });
          sess.messages.push({ role: "user", synthetic: true, content: "[HASIL GITHUB]\n" + resultText });
          saveSession(sess);
          continue;
        }
        const action = gdata.action || "";
        let allow = true;
        if (GH_WRITE_ACTIONS.has(action)) {
          const { permId, reqEv, promise } = askPermission("github_write", { action, ...gdata });
          send(reqEv);
          allow = await promise;
        }
        let resultText, ok;
        if (!allow) { resultText = "[DITOLAK OLEH USER — aksi GitHub tidak dijalankan]"; ok = false; }
        else { const r = await executeGithub(gdata); resultText = r.text; ok = r.ok; }
        send({ type: "tool_result", kind: "github", action: gdata.action, success: ok, output: resultText });
        sess.messages.push({ role: "user", synthetic: true, content: "[HASIL GITHUB]\n" + resultText });
        saveSession(sess);
        continue;
      }
    }
    send({ type: "info", message: "Mencapai batas " + MAX_TOOL_ROUNDS + " giliran tool, berhenti." });
    send({ type: "done" });
  } finally {
    stopFlags.delete(turnId);
  }
}

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(BASE_DIR, "static")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function sendSse(res, ev) { res.write(sse(ev)); }

// ---- static ----
app.get("/", (req, res) => res.sendFile(path.join(BASE_DIR, "static", "index.html")));
app.get("/uploads/:fname", (req, res) => {
  const f = path.join(UPLOADS_DIR, path.basename(req.params.fname));
  if (!fs.existsSync(f)) return res.status(404).send("not found");
  res.sendFile(f);
});
// FIX: pakai basename per-segmen agar path traversal tidak bisa keluar dari GENERATED_DIR,
// tapi tetap dukung subpath <batchId>/<relpath>.
app.get("/downloads/*", (req, res) => {
  const rel = (req.params[0] || "").split("/").filter(Boolean).map(s => path.basename(s)).join(path.sep);
  const f = path.join(GENERATED_DIR, rel);
  if (!f.startsWith(GENERATED_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return res.status(404).send("not found");
  res.download(f, path.basename(f));
});

// ---- config ----
app.get("/api/config", (req, res) => res.json(publicConfig()));
app.post("/api/config", (req, res) => res.json(publicConfig(saveConfig(req.body || {}))));

// ---- models ----
app.get("/api/models", async (req, res) => {
  const cfg = loadConfig();
  const force = ["1", "true", "yes"].includes(String(req.query.refresh || ""));
  const cache = loadModelsCache();
  const custom = loadCustomModels();
  if (!force && cache && cache.models) return res.json({ models: mergeCustomModels(cache.models, custom), cached: true, cached_at: cache.cached_at });
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45000);
    const r = await fetch(cfg.router_url.replace(/\/$/, "") + "/v1/models", { headers: { Authorization: "Bearer " + (cfg.router_api_key || "") }, signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error("router " + r.status);
    const data = (await r.json()).data || [];
    const models = data.map(m => { const mid = m.id || ""; return { id: mid, vision: VISION_HINTS.some(h => mid.toLowerCase().includes(h)) }; });
    saveModelsCache(models);
    return res.json({ models: mergeCustomModels(models, custom), cached: false, cached_at: Date.now()/1000 });
  } catch (e) {
    if (cache && cache.models) return res.json({ models: mergeCustomModels(cache.models, custom), cached: true, cached_at: cache.cached_at, warning: "Gagal ekstrak ulang dari router (" + e.message + ") — menampilkan hasil ekstraksi lama." });
    if (custom && custom.length) return res.json({ models: mergeCustomModels([], custom), cached: false, cached_at: null, warning: "Gagal ekstrak dari router (" + e.message + ") — hanya menampilkan model manual." });
    return res.status(502).json({ error: String(e.message || e) });
  }
});
app.post("/api/models/custom", (req, res) => {
  const mid = String((req.body || {}).id || "").trim();
  if (!mid) return res.status(400).json({ error: "id model kosong" });
  const items = loadCustomModels();
  if (!items.some(c => c.id === mid)) { items.push({ id: mid, vision: !!req.body.vision }); saveCustomModels(items); }
  res.json({ ok: true, custom_models: items });
});
app.delete("/api/models/custom/:mid", (req, res) => {
  const items = loadCustomModels().filter(c => c.id !== req.params.mid);
  saveCustomModels(items);
  res.json({ ok: true, custom_models: items });
});

// ---- sessions ----
app.get("/api/sessions", (req, res) => res.json(listSessions()));
app.post("/api/sessions", (req, res) => res.json(newSession()));
app.get("/api/sessions/:sid", (req, res) => {
  const sess = loadSession(req.params.sid);
  if (!sess) return res.status(404).json({ error: "not found" });
  res.json(sess);
});
app.patch("/api/sessions/:sid", (req, res) => {
  const sess = loadSession(req.params.sid);
  if (!sess) return res.status(404).json({ error: "not found" });
  const patch = req.body || {};
  if ("model" in patch) sess.model = patch.model;
  if ("title" in patch) sess.title = patch.title;
  saveSession(sess);
  res.json(sess);
});
app.delete("/api/sessions/:sid", (req, res) => {
  try { fs.unlinkSync(sessionPath(req.params.sid)); } catch {}
  res.json({ ok: true });
});
app.post("/api/sessions/:sid/fork", (req, res) => {
  const src = loadSession(req.params.sid);
  if (!src) return res.status(404).json({ error: "not found" });
  const dup = newSession();
  dup.title = src.title + " (fork)";
  dup.model = src.model;
  dup.messages = JSON.parse(JSON.stringify(src.messages));
  saveSession(dup);
  res.json(dup);
});
app.get("/api/sessions/:sid/export", (req, res) => {
  const sess = loadSession(req.params.sid);
  if (!sess) return res.status(404).json({ error: "not found" });
  const fmt = req.query.format || "md";
  if (fmt === "json") return res.json(sess);
  const lines = ["# " + sess.title, ""];
  for (const m of sess.messages) {
    if (m.synthetic) continue;
    const who = m.role === "user" ? "**Kamu**" : "**Agent**";
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    lines.push(who + ":\n\n" + content + "\n");
  }
  res.type("text/markdown").send(lines.join("\n"));
});

// ---- chat send / stop / permission ----
app.post("/api/sessions/:sid/send", async (req, res) => {
  const sess = loadSession(req.params.sid);
  if (!sess) return res.status(404).json({ error: "not found" });
  const body = req.body || {};
  if (body.regenerate) {
    while (sess.messages.length && (sess.messages[sess.messages.length-1].role === "assistant" || sess.messages[sess.messages.length-1].synthetic)) sess.messages.pop();
  } else {
    const text = body.text || "";
    const attachments = body.attachments || [];
    const uploadIndex = readJson(UPLOAD_INDEX_PATH, {});
    const imageParts = [];
    let extraText = "";
    for (const attId of attachments) {
      const meta = uploadIndex[attId];
      if (!meta) continue;
      const fpath = path.join(UPLOADS_DIR, meta.stored_name);
      if (!fs.existsSync(fpath)) continue;
      if (meta.is_image) {
        try {
          const b64 = fs.readFileSync(fpath).toString("base64");
          imageParts.push({ type: "image_url", image_url: { url: "data:" + meta.mime + ";base64," + b64 } });
        } catch {}
      } else {
        let contentText;
        try { contentText = fs.readFileSync(fpath, "utf-8").slice(0, 6000); }
        catch { contentText = "[file biner, tidak bisa dibaca sebagai teks]"; }
        extraText += "\n\n[Lampiran: " + meta.filename + "]\n```\n" + contentText + "\n```";
      }
    }
    const fullText = (text || "") + extraText;
    const content = imageParts.length ? [{ type: "text", text: fullText }, ...imageParts] : fullText;
    const filesMeta = attachments.map(aid=>{ const mm=readJson(UPLOAD_INDEX_PATH, {})[aid]; return mm?{filename:mm.filename,is_image:mm.is_image,url:mm.filename?('/uploads/'+mm.stored_name):''}:null; }).filter(Boolean);
    const umsg={ role: "user", content, synthetic: false };
    if(filesMeta.length) umsg.files=filesMeta;
    sess.messages.push(umsg);
    saveSession(sess);
  }
  if (body.model) { sess.model = body.model; saveSession(sess); }
  // SSE stream
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let clientGone = false;
  req.on("close", () => { clientGone = true; });
  const send = (ev) => { try { if (!clientGone) res.write(sse(ev)); } catch {} };
  try { await runTurn(req.params.sid, send, () => clientGone); }
  catch (e) { try { send({ type: "error", message: String(e.message || e) }); send({ type: "done" }); } catch {} }
  try { res.end(); } catch {}
});
app.post("/api/turns/:turnId/stop", (req, res) => {
  const flag = stopFlags.get(req.params.turnId);
  if (flag) { flag.stopped = true; return res.json({ ok: true }); }
  res.status(404).json({ ok: false, message: "turn tidak ditemukan / sudah selesai" });
});
app.post("/api/permissions/:permId", (req, res) => {
  const ok = resolvePermission(req.params.permId, !!(req.body || {}).allow);
  if (!ok) return res.status(404).json({ ok: false, message: "permintaan sudah kadaluarsa" });
  res.json({ ok: true });
});

// ---- memory ----
app.get("/api/memory", (req, res) => res.json(loadMemory()));
app.post("/api/memory", (req, res) => {
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "text kosong" });
  const items = loadMemory();
  items.push({ id: crypto.randomBytes(4).toString("hex"), text, created_at: Date.now()/1000 });
  saveMemory(items);
  res.json(items);
});
app.delete("/api/memory/:mid", (req, res) => {
  const items = loadMemory().filter(m => m.id !== req.params.mid);
  saveMemory(items);
  res.json(items);
});

// ---- stats ----
app.get("/api/stats", (req, res) => res.json(loadStats()));
// FIX: endpoint clear stats (dipakai tombol di modal statistik kalau user mau reset)
app.delete("/api/stats", (req, res) => {
  writeJson(STATS_PATH, { grand_total: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, per_model: {}, per_session: {} });
  res.json(loadStats());
});

// ---- upload ----
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "tidak ada file" });
  const f = req.file;
  const mime = f.mimetype || "application/octet-stream";
  const isImage = mime.startsWith("image/");
  const uploadId = crypto.randomBytes(5).toString("hex");
  const safeName = path.basename(f.originalname || "file").replace(/[^\w.\- ]+/g, "_");
  const storedName = uploadId + "_" + safeName;
  try { fs.writeFileSync(path.join(UPLOADS_DIR, storedName), f.buffer); }
  catch (e) { return res.status(500).json({ error: "gagal simpan: " + e.message }); }
  const index = readJson(UPLOAD_INDEX_PATH, {});
  index[uploadId] = { filename: f.originalname, stored_name: storedName, mime, is_image: isImage };
  writeJson(UPLOAD_INDEX_PATH, index);
  res.json({ id: uploadId, filename: f.originalname, is_image: isImage, url: "/uploads/" + storedName });
});
// Error handler khusus upload (mis. file >15MB) supaya frontend dapat JSON, bukan HTML crash
app.use("/api/upload", (err, req, res, next)=>{
  if(err){ if(err.code==="LIMIT_FILE_SIZE") return res.status(400).json({ error: "file terlalu besar (maks 15MB)" });
    return res.status(400).json({ error: "upload gagal: "+(err.message||err) }); }
  next();
});

// ---- github direct (panel user = konfirmasi eksplisit, tanpa permission-gate) ----
// FIX + penyederhanaan: tambah aksi "save_file" (upsert: coba create, kalau sudah ada -> update)
// supaya tombol Simpan di panel tidak error 422 saat file sudah ada.
app.post("/api/github_direct", async (req, res) => {
  const actionData = req.body || {};
  let action = actionData.action || "";
  if (action === "save_file") {
    // upsert: cek dulu file ada atau tidak
    const probe = await executeGithub({ ...actionData, action: "read_file" });
    action = probe.ok ? "update_file" : "create_file";
    actionData.action = action;
  }
  const { text, ok } = await executeGithub(actionData);
  if (!ok) return res.json({ success: false, error: text, output: text });
  if (action === "list_tree" || action === "list_workflows") {
    let items = [];
    try { items = JSON.parse(text); } catch {}
    return res.json({ success: true, items });
  }
  if (action === "read_file") return res.json({ success: true, content: text });
  res.json({ success: true, output: text });
});

// ---- github status (konektor dipermudah: 1 endpoint untuk cek token+repo+branch) ----
app.get("/api/github_status", async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.github_token) return res.json({ connected: false, reason: "token belum diset" });
  if (!cfg.github_repo) return res.json({ connected: false, reason: "repo belum diset" });
  try {
    const { repoName, defaultBranch } = await resolveRepo(cfg.github_token, cfg.github_repo);
    let branches = [];
    try { const r = await executeGithub({ action: "list_branches" }); if (r.ok) branches = JSON.parse(r.text); } catch {}
    res.json({ connected: true, repo: repoName, default_branch: defaultBranch, branches });
  } catch (e) {
    res.json({ connected: false, reason: String(e.message || e) });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, port: PORT }));

app.listen(PORT, HOST, () => {
  console.log("Sagechat (node) jalan di http://" + HOST + ":" + PORT + "  (data: " + DATA_DIR + ")");
});
