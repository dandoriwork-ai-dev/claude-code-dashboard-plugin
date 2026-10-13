#!/usr/bin/env node

/**
 * Codex の使い方を集める（入口C・tool=codex／source=local_log）。
 *
 * Claude Code の Stop フック（collector.mjs）が 10 分に 1 回まで、切り離したプロセスでこれを起こす
 * （Codex の notify は 1 つしか置けず、Codex 自身の機能が使っていることがある＝上書きしない・社長 10/11 判断）。
 * Claude Code を開かない日の Codex の分は、次に Claude Code を使ったときに届く（遅れるだけで欠けない）。
 *
 * 変わった記録だけを読み直し、前回送った時刻より後のスナップショット（指示の終わりごとの累計）を送る。
 * 送った時刻はセッション（スレッド id）ごとに記録する＝記録が archived_sessions へ移っても送り直さない。
 * 同じものを送り直しても集計は変わらない（累計の最後・系列ごとの MAX で読む）が、量を増やさないため。
 *
 * 使い方:
 *   node codex-collector.mjs                       送る（通常は Stop フックが起こす）
 *   node codex-collector.mjs --dry-run [--out <path>]  送らず・記録を変えずに、送る予定の行を数える（--out で行を書き出す）
 *
 * Privacy: 送るのはメタデータだけ（codex-stats.mjs 参照）。会話・コマンド・ファイルの中身は送らない。
 */

import {
  readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync,
  openSync, closeSync, unlinkSync, createReadStream,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import {
  createCodexStats, addCodexLine, finishCodexStats, selectSnapshots, snapshotEvents, CODEX_CUTOFF,
} from "./codex-stats.mjs";
import {
  DASH_DIR, ensureDirs, logError, extractWorkspace, getUserEmail, codexHome,
  saveFailedEvents, sendEvents,
} from "./shared-io.mjs";
import { PLUGIN_VERSION } from "./plugin-version.mjs";

const STATE_FILE = join(DASH_DIR, "codex-state.json");
const LOCK_FILE = join(DASH_DIR, "codex-collector.lock");
const LOCK_STALE_MS = 30 * 60 * 1000;
const STATE_VERSION = 1;

// ── 記録を探す ───────────────────────────────────────────────────────────────

/** sessions/<y>/<m>/<d>/ と archived_sessions/ の rollout-*.jsonl のうち、締め日より後に書かれたもの */
export function findRollouts(home = codexHome(), cutoff = CODEX_CUTOFF) {
  const since = Date.parse(cutoff);
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          const st = statSync(path);
          if (st.mtimeMs >= since) out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* 消えた */ }
      }
    }
  };
  walk(join(home, "sessions"), 0);
  walk(join(home, "archived_sessions"), 0);
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function readRollout(path) {
  const stats = createCodexStats({ home: homedir() });
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // 書きかけの最終行など
    addCodexLine(stats, entry);
  }
  finishCodexStats(stats);
  return stats;
}

// ── 状態（送った時刻）とロック ────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    if (s && s.version === STATE_VERSION) return s;
  } catch { /* 初回・壊れた */ }
  return { version: STATE_VERSION, files: {}, sessions: {} };
}

function saveState(state) {
  ensureDirs();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf-8");
  renameSync(tmp, STATE_FILE);
}

/** 同時に 2 つ動かない（Claude Code のセッションが複数あると Stop が重なる）。取れなければ null */
function acquireLock() {
  ensureDirs();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return fd;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        // 落ちたプロセスのロックだけを外す（時間で判断。動いている収集は 30 分もかからない）
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) { unlinkSync(LOCK_FILE); continue; }
      } catch { continue; }
      return null;
    }
  }
  return null;
}

function releaseLock(fd) {
  try { closeSync(fd); } catch { /* ignore */ }
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ── 本体 ────────────────────────────────────────────────────────────────────

/** 変わった記録を読み、送る行を作る。state は読むだけ（書き換えは呼び出し側） */
export async function collect(state, { cutoff = CODEX_CUTOFF } = {}) {
  const userEmail = getUserEmail();
  const workspaceCache = new Map();
  const workspaceOf = (cwd) => {
    if (!workspaceCache.has(cwd)) workspaceCache.set(cwd, extractWorkspace(cwd));
    return workspaceCache.get(cwd);
  };
  const files = findRollouts(codexHome(), cutoff);
  const changed = files.filter((f) => {
    const prev = state.files[f.path];
    return !prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs;
  });
  const events = [];
  const fileUpdates = {};
  const sessionUpdates = {};
  const perSession = [];
  for (const f of changed) {
    let stats;
    try { stats = await readRollout(f.path); } catch (err) { logError("codex-read", err); continue; }
    fileUpdates[f.path] = { size: f.size, mtimeMs: f.mtimeMs };
    if (!stats.sessionId) continue;
    const sentUntil = state.sessions[stats.sessionId]?.sent_until || null;
    const chosen = selectSnapshots(stats.snapshots, { sentUntil, cutoff });
    if (!chosen.length) continue;
    for (const snap of chosen) {
      events.push(...snapshotEvents(snap, {
        sessionId: stats.sessionId, userEmail, cliVersion: stats.cliVersion, accountId: stats.accountId, pluginVersion: PLUGIN_VERSION, workspaceOf,
      }));
    }
    sessionUpdates[stats.sessionId] = { sent_until: chosen[chosen.length - 1].timestamp };
    perSession.push({ session_id: stats.sessionId, snapshots: chosen.length, last: chosen[chosen.length - 1] });
  }
  return { scanned: files.length, changed: changed.length, events, fileUpdates, sessionUpdates, perSession };
}

async function run() {
  const lock = acquireLock();
  if (lock === null) return;
  try {
    const state = loadState();
    const { events, fileUpdates, sessionUpdates } = await collect(state);
    if (events.length) {
      const leftover = await sendEvents(events);
      // 一時的に送れなかった分は再送キューへ（Claude Code の Stop が少しずつ送り直す）。届かなかった行を記録上「送った」にしても、キューに残る
      if (leftover.length) saveFailedEvents(leftover);
    }
    Object.assign(state.files, fileUpdates);
    Object.assign(state.sessions, sessionUpdates);
    state.last_run_at = new Date().toISOString();
    saveState(state);
  } finally {
    releaseLock(lock);
  }
}

async function dryRun(outPath) {
  const state = loadState();
  const started = Date.now();
  const r = await collect(state);
  const rows = (type) => r.events.filter((e) => e.event_type === type).length;
  console.log(JSON.stringify({
    scanned: r.scanned, changed: r.changed, sessions: r.perSession.length,
    snapshots: r.perSession.reduce((a, s) => a + s.snapshots, 0),
    events: r.events.length, session_summary_rows: rows("session_summary"), tool_rows: r.events.length - rows("session_summary"),
    elapsed_ms: Date.now() - started,
  }, null, 2));
  if (outPath) {
    writeFileSync(outPath, r.events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    console.log(`wrote ${r.events.length} events to ${outPath}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--dry-run")) {
      const i = args.indexOf("--out");
      if (i !== -1 && !args[i + 1]) throw new Error("--out にはパスが要る");
      await dryRun(i === -1 ? null : args[i + 1]);
    } else {
      await run();
    }
  } catch (err) {
    logError("codex-collector", err);
    if (args.includes("--dry-run")) { console.error(err); process.exitCode = 1; }
  }
}

// 他のファイルから import されたときは動かない（テストで collect を使う）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
