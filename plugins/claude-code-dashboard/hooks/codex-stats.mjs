/**
 * Codex の記録（~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl）の集計（純関数のみ・I/O なし）
 *
 * codex-collector.mjs が 1 行ずつ addCodexLine に渡し、finishCodexStats でスナップショット（指示＝ターンの終わりごとの累計）を得る。
 * 送る形は Claude Code の Stop と同じ「セッションの累計」＝tf_session_resolved の読み方（最後の累計・系列ごとの MAX・増分の投票）がそのまま効く。
 * 🔴 送るのはメタデータだけ（トークン数・道具の名前と回数・フォルダのパス・版）。会話・コマンド・ファイルの中身は読んでも送らない。
 *
 * 記録の形（2026-10-11 社長 PC の 57 本・cli 0.130〜0.162 で実測）:
 * - トークン: event_msg/token_count の info.total_token_usage＝スレッドの累計（全版にある）。
 *   0.153.4 以降は token_usage_record（response_id ごと）もあり、こちらは会話の要約（compaction）の呼び出しも含む
 *   （累計には入らない＝46 本中 45 本で差が要約の呼び出しと完全一致・残る 1 本は累計が途中で巻き戻った記録）。
 *   → 応答ごとの記録の合計と累計の大きい方（どちらも実消費の下限）。
 * - OpenAI の input_tokens は cached・cache_write を含む（5,848 回すべてで cached+cache_write ≤ input・total＝input+output）。
 *   Claude の列に合わせて input から引いて分ける。reasoning は output の内数（料金も output 単価）。
 * - 道具: code mode（0.147 以降）では exec（JS）の中から複数のコマンドが動く＝呼び出し 1 回と実行の回数が合わない。
 *   実行された項目（event_msg/item_completed）を数え、項目を出さない古い版（0.130・0.142）は呼び出しで数える（指示ごと・種類ごとに選ぶ）。
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { posix, win32 } from "node:path";
import {
  USAGE_METHOD, classifyBashCommand, classifyToolKind, touchedFolder, turnFolderOf,
} from "./transcript-stats.mjs";

export const CODEX_TOOL = "codex";
export const CODEX_SOURCE = "local_log";

/** 過去分はここから送る（Claude Code の記録の始まり＝2026-06-26 JST・社長 10/11 判断） */
export const CODEX_CUTOFF = "2026-06-25T15:00:00.000Z";

const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
const TOTAL_USAGE = "total_token_usage";

// ── 道具の種類（実行された項目 ↔ 呼び出し）──────────────────────────────────
// 同じ動作を項目と呼び出しの両方で数えないため、種類（family）ごとにどちらか一方だけを使う
const ITEM_FAMILY = {
  CommandExecution: "cmd", FileChange: "patch", McpToolCall: "mcp", WebSearch: "web", ImageView: "image", Extension: "ext",
};
const COMMAND_CALLS = new Set(["exec_command", "shell"]);
const WRAPPER_CALLS = new Set(["exec"]); // code mode の入れ物。中で動いたものは項目で数える

// 道具の名前は識別子だけを送る（念のため形を固定。外れたら名前を送らない）
const SAFE_NAME = /^[\w.:\-]{1,100}$/;
const safeName = (s) => (typeof s === "string" && SAFE_NAME.test(s) ? s : "unknown");

/** 呼び出し（response_item）の種類。項目を出さない道具は "call"（常に呼び出しで数える） */
function callFamily(p) {
  if (p.type === "web_search_call") return "web";
  const name = p.name;
  if (WRAPPER_CALLS.has(name) && p.type === "custom_tool_call") return null;
  if (typeof p.namespace === "string" && p.namespace.startsWith("mcp__")) return "mcp";
  if (typeof p.namespace === "string" && p.namespace) return "ext";
  if (COMMAND_CALLS.has(name)) return "cmd";
  if (name === "apply_patch") return "patch";
  if (name === "view_image") return "image";
  return "call";
}

/** file:// の URL・絶対パスをパスに。読めなければ null */
export function toPath(v) {
  if (typeof v !== "string" || !v) return null;
  if (v.startsWith("file:")) {
    try {
      return fileURLToPath(v);
    } catch { return null; }
  }
  return v;
}

const isAbsolute = (p) => posix.isAbsolute(p) || win32.isAbsolute(p);

/** コマンドを分類用の 1 本の文字列に（["/bin/zsh","-lc","npm test"] → "npm test"） */
export function commandText(cmd) {
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd)) return "";
  const parts = cmd.filter((x) => typeof x === "string");
  const i = parts.findIndex((x) => x === "-c" || x === "-lc" || x === "/c" || x === "-Command");
  return i >= 0 && parts[i + 1] !== undefined ? parts[i + 1] : parts.join(" ");
}

/** apply_patch の本文から触ったファイルのパスだけを取る（古い版の呼び出し用。本文は送らない） */
function patchPaths(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}

function parseArgs(p) {
  if (p.type === "custom_tool_call") return { input: p.input };
  try { return JSON.parse(p.arguments || "{}") || {}; } catch { return {}; }
}

// ── 集計の状態 ───────────────────────────────────────────────────────────────

export function createCodexStats({ home } = {}) {
  return {
    home,
    sessionId: null, cliVersion: null, accountId: null,
    responses: new Map(),   // response_id → usage（同じ id はフィールドごとの最大値）
    tcBest: null,           // token_count の累計で一番大きいもの
    tcResponses: 0,         // 累計が増えた回数＝応答の数（同じ値の再掲は数えない）
    model: null, effort: null, planType: null,
    effortCounts: new Map(), // 応答ごとの effort
    hasUserItems: false, promptCount: 0, turnCount: 0,
    toolCounts: new Map(),  // 系列キー → { event_type, event_name, tool_kind, count }
    turnCwd: null,          // 直近の turn_context.cwd
    turn: null,             // 開いている指示 { trigger, items: [], calls: [] }
    lastFolder: null,
    lastTimestamp: null,
    snapshots: [],
  };
}

function openTurn(stats, trigger = null) {
  stats.turn = { trigger, items: [], calls: [] };
  return stats.turn;
}

export function addCodexLine(stats, entry) {
  if (!entry || typeof entry !== "object") return;
  if (typeof entry.timestamp === "string") stats.lastTimestamp = entry.timestamp;
  const t = entry.type;
  const p = entry.payload && typeof entry.payload === "object" ? entry.payload : {};

  if (t === "session_meta") {
    stats.sessionId = p.id || p.session_id || stats.sessionId;
    stats.cliVersion = p.cli_version || stats.cliVersion;
    if (typeof p.creator_user_id === "string") stats.accountId = p.creator_user_id;
    if (!stats.turnCwd && typeof p.cwd === "string") stats.turnCwd = p.cwd;
    return;
  }
  if (t === "turn_context") {
    if (typeof p.cwd === "string" && p.cwd) stats.turnCwd = p.cwd;
    if (typeof p.model === "string" && p.model) stats.model = p.model;
    stats.effort = typeof p.effort === "string" && p.effort ? p.effort : null;
    return;
  }
  if (t === "token_usage_record") {
    if (!p.response_id || !p.usage) return;
    const prev = stats.responses.get(p.response_id) || {};
    const merged = {};
    for (const f of TOKEN_FIELDS) merged[f] = Math.max(prev[f] || 0, p.usage[f] || 0);
    stats.responses.set(p.response_id, merged);
    return;
  }
  if (t === "response_item") {
    if (["function_call", "custom_tool_call", "web_search_call"].includes(p.type)) {
      const family = callFamily(p);
      if (family) (stats.turn || openTurn(stats)).calls.push({ family, p, cwd: stats.turnCwd });
    }
    return;
  }
  if (t !== "event_msg") return;

  if (p.type === "task_started") {
    if (stats.turn) closeTurn(stats, null); // 終わりの印が無いまま次の指示が来た
    const trigger = p.turn_attribution && typeof p.turn_attribution === "object" ? p.turn_attribution.turn_trigger : null;
    openTurn(stats, trigger || null);
    stats.turnCount++;
  } else if (p.type === "task_complete" || p.type === "turn_aborted") {
    closeTurn(stats, entry.timestamp);
  } else if (p.type === "token_count") {
    if (p.rate_limits && typeof p.rate_limits.plan_type === "string") stats.planType = p.rate_limits.plan_type;
    const total = p.info && p.info[TOTAL_USAGE];
    if (total && typeof total === "object") {
      const prevTotal = stats.tcBest ? stats.tcBest.total_tokens || 0 : -1;
      if ((total.total_tokens || 0) > prevTotal) {
        stats.tcBest = total;
        stats.tcResponses++;
        const e = stats.effort || "(none)";
        stats.effortCounts.set(e, (stats.effortCounts.get(e) || 0) + 1);
      }
    }
  } else if (p.type === "item_completed") {
    const item = p.item && typeof p.item === "object" ? p.item : {};
    if (item.type === "UserMessage") {
      stats.hasUserItems = true;
      const trigger = stats.turn ? stats.turn.trigger : null;
      if (trigger === null || trigger === "user") stats.promptCount++;
      return;
    }
    let family = ITEM_FAMILY[item.type];
    if (!family) return;
    if (family === "ext" && item.kind === "web.search") family = "web";
    (stats.turn || openTurn(stats)).items.push({ family, item, cwd: stats.turnCwd });
  }
}

// ── 指示の締め：道具を数え、フォルダを決め、スナップショットを積む ────────────────

/** 1 つの動作 → 送る系列と、フォルダの手がかり */
function actionOf(kind, family, x) {
  const turnCwd = x.cwd;
  if (kind === "item") {
    const it = x.item;
    switch (family) {
      case "cmd": {
        const cwd = toPath(it.cwd) || turnCwd;
        return { type: "builtin_tool", name: "exec_command", kind: classifyBashCommand(commandText(it.command)), cwd, touched: [] };
      }
      case "patch": {
        const paths = it.changes && typeof it.changes === "object" ? Object.keys(it.changes) : [];
        return { type: "builtin_tool", name: "apply_patch", kind: "edit", cwd: turnCwd, touched: paths.map((f) => touchedFolder("Edit", { file_path: f })) };
      }
      case "mcp": {
        const name = `mcp__${safeName(it.server)}__${safeName(it.tool)}`;
        return { type: "unknown_external", name, kind: classifyToolKind(name, {}), cwd: turnCwd, touched: [] };
      }
      case "web": return { type: "builtin_tool", name: "web_search", kind: "read", cwd: turnCwd, touched: [] };
      case "image": return { type: "builtin_tool", name: "view_image", kind: "read", cwd: turnCwd, touched: [touchedFolder("Read", { file_path: toPath(it.path) })] };
      default: return { type: "builtin_tool", name: safeName(it.kind), kind: "other", cwd: turnCwd, touched: [] };
    }
  }
  const p = x.p;
  const args = parseArgs(p);
  switch (family) {
    case "cmd": {
      const workdir = typeof args.workdir === "string" && isAbsolute(args.workdir) ? args.workdir : turnCwd;
      return { type: "builtin_tool", name: "exec_command", kind: classifyBashCommand(commandText(args.cmd ?? args.command)), cwd: workdir, touched: [] };
    }
    case "patch": {
      const text = args.input ?? args.patch;
      const files = patchPaths(text).map((f) => (isAbsolute(f) || !turnCwd ? f : (win32.isAbsolute(turnCwd) ? win32 : posix).resolve(turnCwd, f)));
      return { type: "builtin_tool", name: "apply_patch", kind: "edit", cwd: turnCwd, touched: files.map((f) => touchedFolder("Edit", { file_path: f })) };
    }
    case "mcp": {
      const name = `${safeName(p.namespace)}__${safeName(p.name)}`;
      return { type: "unknown_external", name, kind: classifyToolKind(name, {}), cwd: turnCwd, touched: [] };
    }
    case "web": return { type: "builtin_tool", name: "web_search", kind: "read", cwd: turnCwd, touched: [] };
    case "image": return { type: "builtin_tool", name: "view_image", kind: "read", cwd: turnCwd, touched: [touchedFolder("Read", { file_path: args.path })] };
    case "ext": return { type: "builtin_tool", name: `${safeName(p.namespace)}.${safeName(p.name)}`, kind: "other", cwd: turnCwd, touched: [] };
    default: return { type: "builtin_tool", name: safeName(p.name), kind: "other", cwd: turnCwd, touched: [] };
  }
}

function countTurnTools(stats) {
  const turn = stats.turn;
  const itemFamilies = new Set(turn.items.map((x) => x.family));
  const actions = [
    ...turn.items.map((x) => actionOf("item", x.family, x)),
    // 項目のある種類は呼び出しを数えない（同じ動作を 2 回数えない）
    ...turn.calls.filter((x) => !itemFamilies.has(x.family)).map((x) => actionOf("call", x.family, x)),
  ];
  const cwdCounts = new Map();
  const touchCounts = new Map();
  for (const a of actions) {
    const key = JSON.stringify([a.type, a.name, a.kind]);
    const row = stats.toolCounts.get(key) || { event_type: a.type, event_name: a.name, tool_kind: a.kind, count: 0 };
    row.count++;
    stats.toolCounts.set(key, row);
    if (a.cwd) cwdCounts.set(a.cwd, (cwdCounts.get(a.cwd) || 0) + 1);
    for (const f of a.touched) if (f) touchCounts.set(f, (touchCounts.get(f) || 0) + 1);
  }
  return turnFolderOf(cwdCounts, touchCounts, stats.home) || stats.turnCwd;
}

function closeTurn(stats, timestamp) {
  if (!stats.turn) return;
  stats.lastFolder = countTurnTools(stats);
  stats.turn = null;
  if (timestamp) pushSnapshot(stats, timestamp);
}

/** 今の累計（Claude の列の意味にそろえる） */
export function cumulativeUsage(stats) {
  const rec = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0]));
  for (const u of stats.responses.values()) for (const f of TOKEN_FIELDS) rec[f] += u[f] || 0;
  const tc = stats.tcBest || {};
  const v = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, Math.max(rec[f], tc[f] || 0)]));
  return {
    input_tokens: Math.max(v.input_tokens - v.cached_input_tokens - v.cache_write_input_tokens, 0),
    cache_read_tokens: v.cached_input_tokens,
    cache_creation_tokens: v.cache_write_input_tokens,
    output_tokens: v.output_tokens,
    reasoning_tokens: v.reasoning_output_tokens,
    message_count: Math.max(stats.responses.size, stats.tcResponses),
  };
}

function mostFrequent(counts) {
  let best = null;
  for (const [v, n] of counts) if (best === null || n > counts.get(best)) best = v;
  return best === "(none)" ? null : best;
}

function pushSnapshot(stats, timestamp) {
  const snap = {
    timestamp,
    model: stats.model,
    effort: mostFrequent(stats.effortCounts),
    plan_type: stats.planType,
    folder: stats.lastFolder || stats.turnCwd,
    ...cumulativeUsage(stats),
    // 人の指示の数。UserMessage の項目を一度も出していない記録は「不明」（推測で数えない）
    prompt_count: stats.hasUserItems ? stats.promptCount : null,
    turn_count: stats.turnCount,
    tools: [...stats.toolCounts.values()].map((r) => ({ ...r })),
  };
  const sig = (s) => JSON.stringify([s.input_tokens, s.cache_read_tokens, s.cache_creation_tokens, s.output_tokens, s.message_count, s.prompt_count, s.turn_count, s.tools]);
  const last = stats.snapshots[stats.snapshots.length - 1];
  if (last && sig(last) === sig(snap)) return; // 何も増えていない
  // 同じ時刻（同じミリ秒）に終わった指示が続いたら、最後の累計 1 つにまとめる（v0.8.1）。
  // 行の id は時刻から作るので、2 つ送ると同じ id で別の累計が入り、画面がどちらを最終値に拾うかも決まらなかった
  // （10/11 北原さんの 7/31 のセッション＝14 時刻・重複 25 行）
  if (last && last.timestamp === snap.timestamp) stats.snapshots[stats.snapshots.length - 1] = snap;
  else stats.snapshots.push(snap);
}

/**
 * 記録の終わりまで読んだら呼ぶ。指示の途中（Codex が動作中・落ちた）なら、そこまでの累計を積む
 * （次に読んだときは最初から数え直すので二重にならない）
 */
export function finishCodexStats(stats) {
  if (stats.turn) {
    stats.lastFolder = countTurnTools(stats);
    stats.turn = null;
  }
  if (stats.lastTimestamp) pushSnapshot(stats, stats.lastTimestamp);
  return stats.snapshots;
}

/**
 * 送るスナップショットを選ぶ。sentUntil＝前回までに送った最後の時刻（無ければ初回）。
 * 締め日（CODEX_CUTOFF）より前の分は送らない。ただし締め日をまたぐセッションは、締め日の直前の 1 つを基準として送る
 * （無いと締め日の後の最初の累計に前の分まで乗り、その日に使ったことになる）
 */
export function selectSnapshots(snapshots, { sentUntil = null, cutoff = CODEX_CUTOFF } = {}) {
  const cut = Date.parse(cutoff);
  const after = snapshots.filter((s) => Date.parse(s.timestamp) >= cut);
  if (!after.length) return [];
  const before = snapshots.filter((s) => Date.parse(s.timestamp) < cut);
  const chosen = before.length ? [before[before.length - 1], ...after] : after;
  const since = sentUntil ? Date.parse(sentUntil) : -Infinity;
  return chosen.filter((s) => Date.parse(s.timestamp) > since);
}

// ── 送る行 ──────────────────────────────────────────────────────────────────

/** 同じスナップショットを送り直しても同じ id（Ingest/BigQuery 側で重複を見分けられる） */
export function stableEventId(...parts) {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * スナップショット 1 つ → Ingest に送る行（session_summary 1 行＋道具の系列ごとの累計）。
 * 形は Claude Code の collector と同じ。workspaceOf はフォルダ → workspace 名（git のルート名）
 */
export function snapshotEvents(snap, { sessionId, userEmail, cliVersion, accountId, pluginVersion, workspaceOf }) {
  const cwd = snap.folder || null;
  const base = {
    session_id: sessionId, user_email: userEmail, timestamp: snap.timestamp,
    model: snap.model || "unknown", cwd, workspace: cwd ? workspaceOf(cwd) : "unknown",
    tool: CODEX_TOOL, source: CODEX_SOURCE,
    ...(cliVersion && { client_version: cliVersion }),
    ...(accountId && { account_id: accountId }),
    ...(pluginVersion && { plugin_version: pluginVersion }),
  };
  const id = (type, name, kind) => stableEventId(CODEX_TOOL, sessionId, snap.timestamp, type, name, kind || "");
  const events = [{
    ...base,
    event_id: id("session_summary", "session"),
    event_type: "session_summary",
    event_name: "session",
    // 応答単位で数えた値（水増しなし）の印。Ingest が残すのは usage-vN の形だけ
    event_detail: USAGE_METHOD,
    input_tokens: snap.input_tokens,
    output_tokens: snap.output_tokens,
    cache_read_tokens: snap.cache_read_tokens,
    cache_creation_tokens: snap.cache_creation_tokens,
    reasoning_tokens: snap.reasoning_tokens,
    message_count: snap.message_count,
    count: 1,
    turn_count: snap.turn_count,
    ...(snap.prompt_count !== null && { prompt_count: snap.prompt_count }),
    ...(snap.effort && { effort: snap.effort }),
    ...(snap.plan_type && { plan_type: snap.plan_type }),
  }];
  for (const t of snap.tools) {
    events.push({
      ...base,
      event_id: id(t.event_type, t.event_name, t.tool_kind),
      event_type: t.event_type,
      event_name: t.event_name,
      tool_kind: t.tool_kind,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      message_count: 0,
      count: t.count,
    });
  }
  return events;
}
