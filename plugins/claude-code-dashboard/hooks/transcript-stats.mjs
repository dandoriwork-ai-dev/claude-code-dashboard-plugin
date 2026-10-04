/**
 * トランスクリプト JSONL の集計（純関数のみ・I/O なし）
 *
 * collector.mjs の Stop フックが1行ずつ addTranscriptEntry に渡し、
 * summarizeTranscriptStats で session_summary とツール別回数の元データを得る。
 */

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
    return {
      event_type: "subagent",
      event_name: toolInput?.subagent_type || "general-purpose",
      event_detail: toolInput?.description || "",
    };
  }
  if (BUILTIN_TOOLS.has(toolName)) {
    return { event_type: "builtin_tool", event_name: toolName };
  }
  // Unknown → possibly MCP, stored separately
  return { event_type: "unknown_external", event_name: toolName };
}

// トランスクリプトの usage キー（左）→ 送信イベントの列名（右）
const USAGE_FIELDS = {
  input_tokens: "input_tokens",
  output_tokens: "output_tokens",
  cache_read_input_tokens: "cache_read_tokens",
  cache_creation_input_tokens: "cache_creation_tokens",
};

export function createTranscriptStats() {
  return {
    usageByMessage: new Map(), // 応答キー → { usage キー: 最大値 }
    unkeyedEntries: 0,         // 応答を特定できない行の通し番号
    toolUseIds: new Set(),
    toolCounts: new Map(),     // "type:name" → count
    model: "unknown",
    ccVersion: "unknown",
  };
}

export function addTranscriptEntry(stats, entry) {
  if (!entry || typeof entry !== "object") return;
  if (entry.version) stats.ccVersion = entry.version;
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

  if (!Array.isArray(msg.content)) return;
  for (const block of msg.content) {
    if (block?.type !== "tool_use") continue;
    // tool_use は行ごとに別ブロックなので通常は重複しない。同じ id が再掲されても1回だけ数える
    if (block.id) {
      if (stats.toolUseIds.has(block.id)) continue;
      stats.toolUseIds.add(block.id);
    }
    const c = classifyTool(block.name, block.input);
    const toolKey = `${c.event_type}:${c.event_name}`;
    stats.toolCounts.set(toolKey, (stats.toolCounts.get(toolKey) || 0) + 1);
  }
}

export function summarizeTranscriptStats(stats) {
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
  };
}
