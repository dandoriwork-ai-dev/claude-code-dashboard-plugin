/**
 * Claude Code の収集（collector.mjs）と Codex の収集（codex-collector.mjs）が共有する I/O。
 * 設定の読み込み・Ingest への送信・再送キュー・エラーログ・人とフォルダの特定。
 */

import {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, unlinkSync, readdirSync, statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// ── Configuration ──────────────────────────────────────────────────────────

export const DASH_DIR = join(homedir(), ".claude", "claude-dash");
const CONFIG_FILE = join(DASH_DIR, "config.json");
const FAILED_DIR = join(DASH_DIR, "failed");
const ERROR_LOG = join(DASH_DIR, "error.log");

// Ingest payload limits — keep headroom under the server's caps (2MB body / 1000
// events) so a single request can never trip HTTP 413/400. Without this guard a
// failed queue snowballs and stays stuck in a permanent 413 loop.
const MAX_EVENTS_PER_REQUEST = 500;
const MAX_BYTES_PER_REQUEST = 1_500_000;
// Drain a large failed backlog gradually so the Stop hook never blocks on a huge
// queue, and an oversized queue can self-recover instead of failing forever.
const MAX_BACKLOG_EVENTS_PER_SESSION = 2000;

// env vars → .env ファイルフォールバック（デスクトップアプリ等で .zshrc が読まれない場合の対策）
export function loadEnvFallback(key) {
  if (process.env[key]) return process.env[key];
  const envFile = join(DASH_DIR, ".env");
  try {
    if (existsSync(envFile)) {
      // 先頭 BOM を除去（メモ帳等が UTF-8 BOM で保存すると 1 行目がマッチしなくなるため）
      const content = readFileSync(envFile, "utf-8").replace(/^﻿/, "");
      // 同一キーが重複した場合は最後の一致を採用（値を打ち直して追記した際、古い誤値が勝たないように）
      const matches = [...content.matchAll(new RegExp(`^${key}=(.+)$`, "gm"))];
      if (matches.length) return matches[matches.length - 1][1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* ignore */ }
  return "";
}

const INGEST_URL = loadEnvFallback("CLAUDE_DASH_INGEST_URL");
const INGEST_API_KEY = loadEnvFallback("CLAUDE_DASH_API_KEY");

/** Codex の記録の置き場所（CODEX_HOME で移せる・既定は ~/.codex） */
export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** パスがファイルかフォルダかを実物で確かめる（Glob/Grep の path 用・transcript-stats の pathKind）。見つからなければ null */
export function pathKind(p) {
  try {
    const st = statSync(p);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

export function ensureDirs() {
  for (const dir of [DASH_DIR, FAILED_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function logError(context, err) {
  try {
    ensureDirs();
    const msg = `[${new Date().toISOString()}] [${context}] ${err?.message || err}\n`;
    appendFileSync(ERROR_LOG, msg, "utf-8");
  } catch {
    // swallow
  }
}

export function extractWorkspace(cwd) {
  if (!cwd) return "unknown";
  const resolved = resolve(cwd);

  // 1. Try git repo root name (most accurate for project identification)
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 3000,
      cwd: resolved,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (gitRoot) {
      const name = gitRoot.split("/").pop();
      if (name) return name;
    }
  } catch { /* not a git repo — fall through */ }

  // 2. Fall back to directory basename
  const name = resolved.split("/").pop();
  return name || "unknown";
}

export function getUserEmail() {
  // 1. environment variable or .env ファイル (明示的な上書き — git config より優先)
  const envEmail = loadEnvFallback("CLAUDE_DASH_USER_EMAIL");
  if (envEmail) return envEmail;

  // 2. git config user.email
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (email) return email;
  } catch { /* ignore */ }

  // 3. local config file
  try {
    if (existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      if (cfg.user_email) return cfg.user_email;
    }
  } catch { /* ignore */ }

  // 4. OS username (fallback)
  return process.env.USER || "unknown";
}

// ── Failed queue ────────────────────────────────────────────────────────────

export function saveFailedEvents(events) {
  if (!events.length) return;
  ensureDirs();
  const file = join(FAILED_DIR, `failed-${Date.now()}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

// Load up to `limit` events from the failed/ backlog so a large queue drains
// gradually instead of being re-sent (and re-failing) all at once. A fully
// consumed file is removed; a partially consumed file is rewritten with its
// remainder. Files beyond the limit are left untouched for the next session.
export function loadFailedEvents(limit = MAX_BACKLOG_EVENTS_PER_SESSION) {
  if (!existsSync(FAILED_DIR)) return [];
  const events = [];
  try {
    const files = readdirSync(FAILED_DIR).filter((f) => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      if (events.length >= limit) break;
      const path = join(FAILED_DIR, file);
      try {
        const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
        const room = limit - events.length;
        if (lines.length <= room) {
          for (const line of lines) {
            try { events.push(JSON.parse(line)); } catch { /* skip */ }
          }
          unlinkSync(path);
        } else {
          for (let i = 0; i < room; i++) {
            try { events.push(JSON.parse(lines[i])); } catch { /* skip */ }
          }
          writeFileSync(path, lines.slice(room).join("\n") + "\n", "utf-8");
        }
      } catch { /* skip unreadable file */ }
    }
  } catch { /* ignore */ }
  return events;
}

// ── Send to Ingest API ──────────────────────────────────────────────────────

// Approximate JSON byte size of one event, plus a small overhead for the array
// separators in the final payload.
function eventByteSize(event) {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf-8") + 2;
  } catch {
    return MAX_BYTES_PER_REQUEST; // unserializable → isolate it (dropped if it can't fit)
  }
}

// Greedily split events into chunks that respect BOTH the event-count and the
// payload-size limits, keeping headroom under the server's 2MB / 1000 caps.
function chunkEvents(events) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const ev of events) {
    const size = eventByteSize(ev);
    if (current.length >= MAX_EVENTS_PER_REQUEST ||
        (current.length > 0 && currentBytes + size > MAX_BYTES_PER_REQUEST)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(ev);
    currentBytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// POST a single chunk. Returns:
//   "ok"        → accepted
//   "too_large" → HTTP 413, caller should split and retry
//   "drop"      → other non-retryable 4xx (bad data) → discard, never re-queue
//   "retry"     → 5xx / 429 / network error after retries → keep for next session
async function postChunk(events, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(INGEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INGEST_API_KEY}`,
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return "ok";
      if (res.status === 413) return "too_large";
      // Other 4xx (except 429) → not retryable; discard to avoid a poison-pill loop.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        logError("postChunk", `HTTP ${res.status} - dropping ${events.length} event(s)`);
        return "drop";
      }
      // 5xx / 429 → fall through to retry
    } catch (err) {
      logError("postChunk", `attempt ${attempt + 1}: ${err.message}`);
    }
    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return "retry";
}

// Send a chunk, halving it on 413 until it fits. A single event that still 413s
// can never fit, so it is dropped (logged). Returns events to re-queue (transient
// failures only); sent and permanently-rejected events are not returned.
async function sendChunkWithSplit(events) {
  const status = await postChunk(events);
  if (status === "ok" || status === "drop") return [];
  if (status === "retry") return events;
  // status === "too_large"
  if (events.length <= 1) {
    logError("sendChunkWithSplit", `single event exceeds size limit - dropping event_id=${events[0]?.event_id}`);
    return [];
  }
  const mid = Math.floor(events.length / 2);
  const left = await sendChunkWithSplit(events.slice(0, mid));
  const right = await sendChunkWithSplit(events.slice(mid));
  return [...left, ...right];
}

// Send all events in size-bounded chunks. Returns events that should be re-queued
// (transient failures). When the endpoint is unconfigured, everything is kept.
export async function sendEvents(events) {
  if (!events.length) return [];
  if (!INGEST_URL || !INGEST_API_KEY) return events;
  const leftover = [];
  for (const chunk of chunkEvents(events)) {
    const requeue = await sendChunkWithSplit(chunk);
    if (requeue.length) leftover.push(...requeue);
  }
  return leftover;
}
