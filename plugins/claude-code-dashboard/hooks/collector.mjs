#!/usr/bin/env node

/**
 * Claude Code Dashboard - Usage Metrics Collector
 *
 * C案: PostToolUse → ローカルファイルにバッファ、Stop → まとめて Ingest API へ送信
 *
 * PostToolUse: Skill/Subagent/unknown_external イベントをローカルファイルにバッファ（クラッシュ保護）
 * Stop: セッションのトランスクリプト JSONL を解析し、全メトリクスを抽出して Ingest API へ送信
 *       - トランスクリプト解析が権威データソース（トークン/モデル情報含む）
 *       - バッファは Stop が呼ばれなかった（クラッシュ）セッションの復旧用
 *
 * Privacy: メタデータ/イベント種別のみ収集。会話本文は送信しない。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  USAGE_METHOD, classifyTool, classifyToolKind,
  createTranscriptStats, addTranscriptEntry, summarizeTranscriptStats,
} from "./transcript-stats.mjs";
import {
  DASH_DIR, ensureDirs, logError, extractWorkspace, getUserEmail, codexHome, pathKind,
  saveFailedEvents, loadFailedEvents, sendEvents,
} from "./shared-io.mjs";
import { PLUGIN_VERSION } from "./plugin-version.mjs";

// ── Configuration ──────────────────────────────────────────────────────────

// CWD_FILTER_PREFIX is no longer used — all directories are tracked.
const BUFFER_FILE = join(DASH_DIR, "event-buffer.jsonl");
// Codex の収集（v0.8.0）。Stop のたびではなく 10 分に 1 回まで
const CODEX_COLLECTOR = join(dirname(fileURLToPath(import.meta.url)), "codex-collector.mjs");
const CODEX_MARKER = join(DASH_DIR, "codex-last-start");
const CODEX_INTERVAL_MS = 10 * 60 * 1000;

// ── stdin reading ───────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`stdin parse error: ${e.message}`)); }
    });
    process.stdin.on("error", reject);
    setTimeout(() => reject(new Error("stdin read timeout")), 4000);
  });
}

// ── Buffer operations ───────────────────────────────────────────────────────

function appendToBuffer(event) {
  ensureDirs();
  appendFileSync(BUFFER_FILE, JSON.stringify(event) + "\n", "utf-8");
}

function readBuffer() {
  if (!existsSync(BUFFER_FILE)) return [];
  try {
    const content = readFileSync(BUFFER_FILE, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function clearBuffer() {
  try { if (existsSync(BUFFER_FILE)) unlinkSync(BUFFER_FILE); } catch { /* ignore */ }
}

// ── Transcript parsing ──────────────────────────────────────────────────────

async function parseTranscript(transcriptPath, sessionId, cwd) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  const userEmail = getUserEmail();
  const now = new Date().toISOString();

  const stats = createTranscriptStats({ pathKind }); // Glob/Grep の path がファイルかを実物で確かめる（v0.8.0）
  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    addTranscriptEntry(stats, entry);
  }

  const summary = summarizeTranscriptStats(stats, { home: homedir() });
  // 送る行のフォルダ＝直近の指示の中心（v0.6.0＝一番ツールを使ったフォルダ）。
  // 応答が終わった時点の cwd だと、最後に別フォルダへ移った指示の作業がまるごとそちらに付いた
  // （10/10 社長の実測: 30 日 240 セッション中 90 で PJ がずれる → この方式で 12）。
  // v0.7.0＝ホーム・記憶ファイル等にいたまま、または今いるフォルダの外のファイルを読み書きした指示は、そのファイルのフォルダ（chooseTurnFolder）。
  const labelCwd = summary.turnCwd || cwd;
  const base = {
    session_id: sessionId, user_email: userEmail, timestamp: now,
    model: summary.model, cwd: labelCwd, workspace: extractWorkspace(labelCwd),
    claude_code_version: summary.claude_code_version,
    plugin_version: PLUGIN_VERSION,
  };

  const events = [];

  // Session summary (tokens / messages)
  events.push({
    ...base,
    event_id: randomUUID(),
    event_type: "session_summary",
    event_name: "session",
    event_detail: USAGE_METHOD,
    input_tokens: summary.input_tokens,
    output_tokens: summary.output_tokens,
    cache_read_tokens: summary.cache_read_tokens,
    cache_creation_tokens: summary.cache_creation_tokens,
    message_count: summary.message_count,
    count: 1,
    ...(summary.prompt_count !== null && { prompt_count: summary.prompt_count }),
    ...(summary.effort && { effort: summary.effort }),
  });

  // Per-tool counts（種別ごとの累計。同じ Bash でも「確かめる」と「その他」は別の行）
  for (const { event_type: eventType, event_name: eventName, tool_kind: toolKind, count } of summary.toolCounts.values()) {
    events.push({
      ...base,
      event_id: randomUUID(),
      event_type: eventType,
      event_name: eventName,
      tool_kind: toolKind,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      message_count: 0,
      count,
    });
  }

  return events;
}

// ── Codex ───────────────────────────────────────────────────────────────────

// Codex の記録を集めるプロセスを切り離して起こす（Stop を待たせない・終わりを待たない）。
// Codex を使っていない PC（~/.codex/sessions が無い）では何もしない
function startCodexCollector() {
  try {
    if (!existsSync(join(codexHome(), "sessions"))) return;
    if (existsSync(CODEX_MARKER) && Date.now() - statSync(CODEX_MARKER).mtimeMs < CODEX_INTERVAL_MS) return;
    ensureDirs();
    writeFileSync(CODEX_MARKER, new Date().toISOString(), "utf-8");
    spawn(process.execPath, [CODEX_COLLECTOR], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (err) {
    logError("codex-start", err);
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handlePostToolUse(input) {
  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const classified = classifyTool(toolName, toolInput);

  // Only buffer interesting events (skip built-in tools)
  if (classified.event_type === "builtin_tool") return;

  const cwd = input.cwd || "";
  const event = {
    event_id: randomUUID(),
    session_id: input.session_id || "unknown",
    user_email: getUserEmail(),
    timestamp: new Date().toISOString(),
    event_type: classified.event_type,
    event_name: classified.event_name,
    tool_kind: classifyToolKind(toolName, toolInput),
    model: "unknown",
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    message_count: 0, count: 1,
    cwd,
    workspace: extractWorkspace(cwd),
    claude_code_version: "unknown",
    plugin_version: PLUGIN_VERSION,
  };

  appendToBuffer(event);
}

async function handleStop(input) {
  const sessionId = input.session_id || "unknown";
  const cwd = input.cwd || "";
  const transcriptPath = input.transcript_path || "";

  startCodexCollector();

  // 1. Parse transcript (authoritative data with tokens/model)
  const transcriptEvents = await parseTranscript(transcriptPath, sessionId, cwd);

  // 2. Read buffer events (fallback if transcript is empty/unavailable)
  const bufferEvents = readBuffer();
  clearBuffer();

  // 3. Pick up a bounded slice of failed events from previous sessions
  const failedEvents = loadFailedEvents();

  // 4. Fresh session data first (priority), then the older backlog
  const sessionEvents = transcriptEvents.length > 0 ? transcriptEvents : bufferEvents;
  const allEvents = [...sessionEvents, ...failedEvents];
  if (!allEvents.length) return;

  // 5. Send in size-bounded chunks; only transient failures are re-queued
  const leftover = await sendEvents(allEvents);
  if (leftover.length) saveFailedEvents(leftover);
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2]; // "post-tool-use" | "stop"

  try {
    const input = await readStdin();
    const cwd = input.cwd || "";

    if (mode === "post-tool-use") {
      await handlePostToolUse(input);
    } else if (mode === "stop") {
      await handleStop(input);
    }
  } catch (err) {
    logError(mode, err);
  }

  // Hooks must always output JSON and exit 0
  console.log("{}");
  process.exit(0);
}

main();
