/**
 * トランスクリプト JSONL の集計（純関数のみ・I/O なし）
 *
 * collector.mjs の Stop フックが1行ずつ addTranscriptEntry に渡し、
 * summarizeTranscriptStats で session_summary とツール別回数の元データを得る。
 */

import { posix, win32 } from "node:path";

// ── 集計方式の版 ─────────────────────────────────────────────────────────────
// 1回のAPI応答は、トランスクリプトに content block ごとの複数行（思考・本文・tool_use）
// として書かれ、各行が同じ usage（応答全体の確定値）を持つ。行ごとに足すと応答あたり
// 2〜3倍に水増しされる（2026-10-04 実測: 直近40セッションで2.11倍）。
// usage と message_count は message.id ごとに1回だけ数える。
// session_summary の event_detail に載せ、ダッシュボードが集計方式を見分けられるようにする。
// event_detail が null の行 = 旧collector（行ごとに加算＝水増しあり）。
export const USAGE_METHOD = "usage-v2";

// Built-in tools — everything else is potentially MCP or custom
const BUILTIN_TOOLS = new Set([
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep",
  "Agent", "Task",
  "Skill",
  "ToolSearch",
  "WebFetch", "WebSearch",
  "NotebookEdit",
  "AskUserQuestion",
  "TodoRead", "TodoWrite",
  "CronCreate", "CronDelete", "CronList",
  "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
  "Config",
  "SendMessage",
]);

export function classifyTool(toolName, toolInput) {
  if (toolName === "Skill") {
    return { event_type: "skill", event_name: toolInput?.skill || "unknown" };
  }
  if (toolName === "Agent" || toolName === "Task") {
    // 説明文（自由文）は送らない（社長 10/6 判断・Ingest でも捨てている）
    return { event_type: "subagent", event_name: toolInput?.subagent_type || "general-purpose" };
  }
  if (BUILTIN_TOOLS.has(toolName)) {
    return { event_type: "builtin_tool", event_name: toolName };
  }
  // Unknown → possibly MCP, stored separately
  return { event_type: "unknown_external", event_name: toolName };
}

// ── 道具の種別（設計書 §6.1 の型 #1 検証・#3 分業）────────────────────────────
// 🔴 コマンド本文は送らない。ここで種別に落とし、種別だけを送る（Ingest の VALID_TOOL_KINDS と同じ語彙）。
// 分類はコードで固定・マップ外は other（推測で寄せない）。
export const TOOL_KINDS = ["verify", "edit", "read", "delegate", "other"];

const KIND_BY_TOOL = {
  Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Read: "read", Grep: "read", Glob: "read", WebFetch: "read", WebSearch: "read",
  Agent: "delegate", Task: "delegate", Workflow: "delegate",
};

// Bash で「確かめる」に当たるコマンド（区切り && ; | の各段の先頭で見る）
const VERIFY_COMMAND = [
  /^(npx\s+|pnpm\s+(exec\s+)?|yarn\s+)?(tsc|vitest|jest|mocha|playwright|eslint|biome|ruff|mypy|pytest)\b/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|type-check|lint|check|e2e|verify)\b/,
  /^node\s+--test\b/,
  /^(go|cargo)\s+test\b/,
  /^python3?\s+-m\s+(pytest|unittest|mypy)\b/,
  /^(curl|wget|http)\b/,
  /^node\s+\S*(verify|check|smoke|l[345]-)[^\s/]*\.m?[jt]s\b/,
];

export function classifyBashCommand(command) {
  if (typeof command !== "string") return "other";
  const segments = command.split(/&&|\|\||;|\||\n/).map((x) => x.trim());
  for (const seg of segments) {
    // 環境変数の前置き（FOO=1 cmd）と時間計測は飛ばして先頭のコマンドを見る
    const head = seg.replace(/^(\w+=\S*\s+)+/, "").replace(/^time\s+/, "");
    if (VERIFY_COMMAND.some((re) => re.test(head))) return "verify";
  }
  return "other";
}

export function classifyToolKind(toolName, toolInput) {
  if (toolName === "Bash") return classifyBashCommand(toolInput?.command);
  if (KIND_BY_TOOL[toolName]) return KIND_BY_TOOL[toolName];
  if (typeof toolName === "string" && toolName.startsWith("mcp__playwright__")) return "verify";
  return "other";
}

// トランスクリプトの usage キー（左）→ 送信イベントの列名（右）
const USAGE_FIELDS = {
  input_tokens: "input_tokens",
  output_tokens: "output_tokens",
  cache_read_input_tokens: "cache_read_tokens",
  cache_creation_input_tokens: "cache_creation_tokens",
};

/**
 * pathKind（任意）＝Glob/Grep の path がファイルかフォルダかを実物で確かめる関数（p → "file" | "dir" | null）。
 * I/O なので collector が渡す。同じパスは 1 回だけ確かめる
 */
export function createTranscriptStats({ pathKind } = {}) {
  const kinds = new Map();
  return {
    usageByMessage: new Map(), // 応答キー → { usage キー: 最大値 }
    unkeyedEntries: 0,         // 応答を特定できない行の通し番号
    toolUseIds: new Set(),
    // 系列キー → { event_type, event_name, tool_kind, count }。名前に ":" が入る（plugin:skill）ので文字列を割らない
    toolCounts: new Map(),
    model: "unknown",
    ccVersion: "unknown",
    hasOrigin: false,          // 人の発話の印（origin）を持つ版か。持たない古い版は発話数を「不明」で送る
    promptCount: 0,
    effortByMessage: new Map(), // 応答キー → effort
    turnCwdCounts: new Map(),   // 直近の人の発話以降に、どのフォルダでツールを使ったか
    turnTouchCounts: new Map(), // 直近の人の発話以降に、どのフォルダのファイルを読み書きしたか（v0.7.0）
    pathKind: pathKind ? (p) => { if (!kinds.has(p)) kinds.set(p, pathKind(p)); return kinds.get(p); } : null,
  };
}

export function addTranscriptEntry(stats, entry) {
  if (!entry || typeof entry !== "object") return;
  if (entry.version) stats.ccVersion = entry.version;
  if ("origin" in entry) stats.hasOrigin = true;
  if (isHumanPrompt(entry)) {
    if (entry.origin?.kind === "human") stats.promptCount++;
    stats.turnCwdCounts = new Map(); // 人の発話＝ここから新しい指示
    stats.turnTouchCounts = new Map();
  }
  if (entry.type !== "assistant" || !entry.message) return;

  const msg = entry.message;
  if (msg.model) stats.model = msg.model;

  // 同じ応答の行は1つにまとめる。通常は全行が同じ確定値だが、途中値の行が混じっても
  // 確定値が残るようフィールドごとの最大値を採る。応答を特定できない行は1行=1応答として数える。
  const key = msg.id || entry.requestId || `unkeyed-${stats.unkeyedEntries++}`;
  const prev = stats.usageByMessage.get(key) || {};
  const usage = msg.usage || {};
  const merged = {};
  for (const field of Object.keys(USAGE_FIELDS)) {
    merged[field] = Math.max(prev[field] || 0, usage[field] || 0);
  }
  stats.usageByMessage.set(key, merged);
  if (typeof entry.effort === "string" && entry.effort) stats.effortByMessage.set(key, entry.effort);

  if (!Array.isArray(msg.content)) return;
  for (const block of msg.content) {
    if (block?.type !== "tool_use") continue;
    // tool_use は行ごとに別ブロックなので通常は重複しない。同じ id が再掲されても1回だけ数える
    if (block.id) {
      if (stats.toolUseIds.has(block.id)) continue;
      stats.toolUseIds.add(block.id);
    }
    const c = classifyTool(block.name, block.input);
    const kind = classifyToolKind(block.name, block.input);
    const toolKey = JSON.stringify([c.event_type, c.event_name, kind]);
    const row = stats.toolCounts.get(toolKey) || { event_type: c.event_type, event_name: c.event_name, tool_kind: kind, count: 0 };
    row.count++;
    stats.toolCounts.set(toolKey, row);
    if (typeof entry.cwd === "string" && entry.cwd) {
      stats.turnCwdCounts.set(entry.cwd, (stats.turnCwdCounts.get(entry.cwd) || 0) + 1);
    }
    const folder = touchedFolder(block.name, block.input, stats.pathKind);
    if (folder) stats.turnTouchCounts.set(folder, (stats.turnTouchCounts.get(folder) || 0) + 1);
  }
}

// ── 指示ごとのフォルダ（v0.7.0・2026-10-11）─────────────────────────────────
// シェルの今いる場所（cwd）は「最後に cd した先」で、作業の場所とは限らない。ホームや記憶ファイルのフォルダに
// いたまま絶対パスで案件のファイルを読み書きする使い方だと、案件が分からない（佐藤さん 30 日で 42%・10/11 実測）。
// → Claude が読み書きしたファイルのフォルダを手がかりにする。送るのはフォルダのパスだけ（ファイル名・本文は送らない）。
const PATH_INPUT = { Read: "file_path", Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path", Glob: "path", Grep: "path" };
const DIR_INPUT = new Set(["Glob", "Grep"]); // path はフォルダのことが多いが、Grep はファイル 1 つも指せる
// 置き場所（記憶ファイル・設定・一時フォルダ）は案件の手がかりにならないので数えない
const NOT_A_PLACE = [/\/\.claude\//, /^\/(private\/)?tmp\//, /^\/(private\/)?var\/folders\//, /\/AppData\/Local\/Temp\//i];

/**
 * 道具の入力から「触ったフォルダ」を返す。数えないもの（相対パス・置き場所・パスを持たない道具）は null。
 * Glob/Grep の path は pathKind で実物を確かめる＝ファイルならその親・見つからなければ数えない（v0.8.0。
 * v0.7.0 は path をそのままフォルダにしていたので、Grep でファイルを指すと workspace がファイル名になった・浦谷さん 10/11）。
 * pathKind が無ければ path そのもの
 */
export function touchedFolder(toolName, toolInput, pathKind) {
  const key = PATH_INPUT[toolName];
  const p = key ? toolInput?.[key] : undefined;
  if (typeof p !== "string" || !p) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(p);
  if (!windows && !p.startsWith("/")) return null;
  const parent = (windows ? win32 : posix).dirname(p);
  const kind = !DIR_INPUT.has(toolName) ? "file" : pathKind ? pathKind(p) : "dir";
  if (kind !== "file" && kind !== "dir") return null;
  const folder = kind === "file" ? parent : p;
  const normalized = folder.replace(/\\/g, "/") + "/";
  if (NOT_A_PLACE.some((re) => re.test(normalized))) return null;
  return folder;
}

// 比べるときだけ区切りを / に・Windows は大文字小文字を区別しない
const comparable = (p) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
};
const isInside = (child, parent) => (comparable(child) + "/").startsWith(comparable(parent) + "/");
// 入れ物＝案件を入れておく場所（ホーム・デスクトップ・ダウンロード等）と置き場所（記憶ファイル・一時フォルダ）。
// ここにいたまま作業すると、シェルの居場所からは案件が分からない
const CONTAINERS = ["", "Desktop", "Downloads", "Documents", "OneDrive/Desktop", "OneDrive/Documents", "OneDrive/デスクトップ", "Desktop/デスクトップ"];
const isContainer = (cwd, home) =>
  (home && CONTAINERS.some((c) => comparable(cwd) === comparable(c ? `${home}/${c}` : home)))
  || NOT_A_PLACE.some((re) => re.test(cwd.replace(/\\/g, "/") + "/"));

/**
 * 指示のフォルダを決める（v0.7.0）。cwd＝一番ツールを使ったシェルの居場所・touched＝一番読み書きしたファイルのフォルダ。
 * 案件フォルダの中を触った指示は今まで通り cwd（深いフォルダにすると、git でない案件では workspace が奥の名前になり規則が外れる）。
 * 変えるのは ①入れ物にいたまま作業した ②今いるフォルダの外を触った、のときだけ
 */
export function chooseTurnFolder(cwd, touched, home) {
  if (!touched) return cwd;
  if (!cwd) return touched;
  if (isContainer(cwd, home)) return touched;
  return isInside(touched, cwd) ? cwd : touched;
}

// 人が打った指示か。origin（2.1.258 以降）があればそれだけで判定する。
// 無い古い版は「メタでない文字の発話・タグで始まらない」で区切りだけに使う（発話数は数えない）。
export function isHumanPrompt(entry) {
  if (entry?.type !== "user") return false;
  if ("origin" in entry) return entry.origin?.kind === "human";
  if (entry.isMeta || entry.isCompactSummary) return false;
  const c = entry.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((b) => b?.type === "text")?.text : undefined;
  return typeof text === "string" && text.length > 0 && !text.startsWith("<");
}

const mostFrequent = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (best === null || n > counts.get(best)) best = v;
  return best;
};

const mostUsed = (counts) => [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a), [null, 0])[0];

/** 指示のフォルダ＝一番ツールを使った cwd と一番読み書きしたフォルダから chooseTurnFolder で決める（Codex の収集も同じ決め方を使う） */
export function turnFolderOf(cwdCounts, touchCounts, home) {
  return chooseTurnFolder(mostUsed(cwdCounts), mostUsed(touchCounts), home);
}

export function summarizeTranscriptStats(stats, { home } = {}) {
  const tokens = Object.fromEntries(Object.values(USAGE_FIELDS).map((col) => [col, 0]));
  for (const usage of stats.usageByMessage.values()) {
    for (const [field, col] of Object.entries(USAGE_FIELDS)) tokens[col] += usage[field] || 0;
  }
  return {
    ...tokens,
    message_count: stats.usageByMessage.size,
    model: stats.model,
    claude_code_version: stats.ccVersion,
    toolCounts: stats.toolCounts,
    // 人の発話数。印の無い古い版は null（推測で数えない）
    prompt_count: stats.hasOrigin ? stats.promptCount : null,
    // 応答ごとの effort で一番多かったもの。無ければ null
    effort: mostFrequent(stats.effortByMessage.values()),
    // 直近の指示のフォルダ（v0.7.0）＝chooseTurnFolder。ファイルに触っていない指示は一番ツールを使った cwd（v0.6.0 と同じ）。
    // 同数なら先に使った方。どちらも無ければ null＝呼び出し側の cwd を使う
    turnCwd: turnFolderOf(stats.turnCwdCounts, stats.turnTouchCounts, home),
  };
}
