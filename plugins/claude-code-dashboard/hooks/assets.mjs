/**
 * 仕組みの資産（②・ナレッジ収集の段1）。設計＝docs/KNOWLEDGE_COLLECTION_DESIGN.md §4・§7.1。
 *
 * 何を読むか（listTargets）・設定ファイルから名前だけを抜く（deriveSettingsNames／deriveCodexConfig）・
 * 送る 1 行の組み立て（buildSnapshot）を持つ。読み書きと送信は asset-collector.mjs。
 *
 * 守りの順（崩さない）:
 *   1. contentGate（送らない口＝人・フォルダ）… 止まった資産は読まない
 *   2. 中身を読む … 大きすぎる・バイナリ・名前が秘密を扱うものらしいフック（SENSITIVE_NAME）は本文を持たない（名前と大きさだけ）
 *   3. leak-check（パスと本文の両方）… hard>0 は本文を持たない。パスに hard があれば 1 行も作らない
 *   4. 本人の承認（APPROVAL）… 初期は全件（社長決定 10/15）
 * 設定ファイル（settings.json・~/.claude.json・config.toml）は値を持たない「名前の一覧」に変えてから 3 に通す
 * （hook のコマンドや MCP の環境変数に秘密が入りうる＝本文は送らない・設計 §4 の「名前」）。
 *
 * 依存なし（プラグインは node だけで動く）。fs は差し替えられる（テスト用）。
 */

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { checkText, CHECKER_VERSION } from "./leak-check.mjs";
import { contentGate } from "./content-gate.mjs";

/** 本人の承認。"all"＝全件（初期・社長決定 2026-10-15）／"judgment"＝judgment>0 のときだけ（検査が信頼できたら） */
export const APPROVAL = "all";

/** 受け口の上限（packages/ingest/src/knowledge.ts の LIMITS.assets と同じ）。読むのは 1MB まで */
export const ASSET_LIMITS = { maxTextChars: 100_000, maxReadBytes: 1_000_000, maxRowsPerRequest: 20 };

const HOOK_EXTS = new Set([".py", ".mjs", ".js", ".cjs", ".ts", ".sh", ".bash", ".zsh", ".rb"]);
const TEST_FILE = /(?:^test_|[._-]test\.|_test\.)/;
const NAME = /^[A-Za-z0-9_.@:*+-]{1,80}$/;
/**
 * 名前が秘密を扱うものらしいフック（コード）は本文を送らない（名前と大きさだけ）。
 * 例＝秘密の読み出しを止めるフックは、止める語彙そのもの＝秘密の断片を持ちうるが、
 * 形で当てる検査器では分からない（2026-10-17 社長 PC の dry-run で素通りした）。迷ったら送らない側。
 * 文章（rules・skills）には効かせない＝秘密の扱い方の規則はノウハウそのもの（検査器が中身を見る）。
 */
export const SENSITIVE_NAME = /secret|credential|passw|token|api[-_]?key|private[-_]?key|\.env\b|dotenv/i;

export const defaultIo = {
  list(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((e) => {
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          try { const st = statSync(join(dir, e.name)); isDir = st.isDirectory(); isFile = st.isFile(); } catch { /* 切れたリンク */ }
        }
        return { name: e.name, isDir, isFile };
      });
    } catch {
      return [];
    }
  },
  isFile(p) { try { return statSync(p).isFile(); } catch { return false; } },
  size(p) { return statSync(p).size; },
  read(p) { return readFileSync(p); },
};

/** ホームの中のパスを ~ 始まりに（外なら null＝送れない） */
export function homeRel(abs, home) {
  const rel = relative(home, abs);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) return null;
  return "~/" + rel.split(sep).join("/");
}

// ── 何を読むか ─────────────────────────────────────────────────────────────────

/**
 * 読む資産の一覧（中身はまだ読まない）。
 * @param {{ home: string, codexHome: string, repoRoots?: string[], io?: object }} p
 *   repoRoots＝最近使ったリポジトリの根（collector が Stop で残した cwd から）。ホームそのものとホームの外は除く
 * @returns {{ key, tool, kind, path_rel, workspace, gateDir, file?, derive?, files? }[]}
 *   key＝手元の状態のキー（絶対パス入り・外へは出さない）
 */
export function listTargets({ home, codexHome, repoRoots = [], io = defaultIo }) {
  const out = [];
  const claude = join(home, ".claude");
  const addFile = (tool, kind, file, extra = {}) => {
    if (!io.isFile(file)) return;
    const path_rel = extra.path_rel ?? homeRel(file, home);
    if (!path_rel) return;
    out.push({ key: `${tool}:${kind}:${file}`, tool, kind, path_rel, workspace: extra.workspace ?? null, gateDir: extra.gateDir ?? join(file, ".."), file });
  };

  addFile("claude_code", "claude_md", join(claude, "CLAUDE.md"));

  // rules は下のフォルダも読み込まれる（Claude Code の仕様）＝3 段まで
  const walkRules = (dir, depth) => {
    for (const e of io.list(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDir && depth < 3 && !e.name.startsWith(".")) walkRules(p, depth + 1);
      else if (e.isFile && e.name.endsWith(".md")) addFile("claude_code", "rule", p);
    }
  };
  walkRules(join(claude, "rules"), 0);

  for (const e of io.list(join(claude, "skills")).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDir && !e.name.startsWith(".")) addFile("claude_code", "skill", join(claude, "skills", e.name, "SKILL.md"));
  }

  for (const e of io.list(join(claude, "hooks")).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isFile && HOOK_EXTS.has(extname(e.name)) && !TEST_FILE.test(e.name)) addFile("claude_code", "hook", join(claude, "hooks", e.name));
  }

  // 設定は名前だけ（中身は derive で作る）
  const settingsFiles = [join(claude, "settings.json"), join(claude, "settings.local.json"), join(home, ".claude.json")].filter((f) => io.isFile(f));
  if (settingsFiles.length) {
    out.push({
      key: "claude_code:settings_names", tool: "claude_code", kind: "settings_names",
      path_rel: "~/.claude/settings.json", workspace: null, gateDir: claude, derive: "settings_names", files: settingsFiles,
    });
  }

  const codexRel = homeRel(codexHome, home);
  if (codexRel) {
    addFile("codex", "agents_md", join(codexHome, "AGENTS.md"));
    const toml = join(codexHome, "config.toml");
    if (io.isFile(toml)) {
      out.push({
        key: "codex:codex_config", tool: "codex", kind: "codex_config",
        path_rel: `${codexRel}/config.toml`, workspace: null, gateDir: codexHome, derive: "codex_config", files: [toml],
      });
    }
  }

  // リポジトリの CLAUDE.md／AGENTS.md。パスはリポジトリからの相対・workspace は根のフォルダ名（raw_events.workspace と同じ作り方）
  const seen = new Set();
  for (const root of repoRoots) {
    if (typeof root !== "string" || seen.has(root)) continue;
    seen.add(root);
    const rel = homeRel(root, home);
    if (!rel || rel === "~/") continue; // ホームそのもの・ホームの外は読まない
    const workspace = basename(root);
    addFile("claude_code", "claude_md", join(root, "CLAUDE.md"), { path_rel: "CLAUDE.md", workspace, gateDir: root });
    addFile("codex", "agents_md", join(root, "AGENTS.md"), { path_rel: "AGENTS.md", workspace, gateDir: root });
  }
  return out;
}

// ── 設定から名前だけを抜く ───────────────────────────────────────────────────────

const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const nameOrNull = (s) => (typeof s === "string" && NAME.test(s) ? s : null);

/** hook のコマンド → 動かしているスクリプトの名前（値・引数・パスは捨てる） */
export function commandName(command) {
  if (typeof command !== "string") return "(command)";
  const tokens = command.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  const script = tokens.find((t) => HOOK_EXTS.has(extname(t)));
  const name = basename(script ?? tokens[0] ?? "");
  return nameOrNull(name) ?? "(command)";
}

/** 許可の規則 → 道具の名前（`Bash(npm run *)`→`Bash`。中身＝コマンドやパスは捨てる） */
export function permissionName(rule) {
  if (typeof rule !== "string") return null;
  return nameOrNull(rule.split("(")[0].trim());
}

/**
 * settings.json・settings.local.json・~/.claude.json → 名前の一覧（JSON 文字列）。
 * hooks＝イベント→[matcher と スクリプト名]・permissions＝道具ごとの件数・MCP と plugin の名前。値は 1 つも入れない。
 */
export function deriveSettingsNames(jsons) {
  const hooks = {};
  const permissions = { allow: {}, ask: {}, deny: {} };
  let defaultMode = null;
  const mcp = new Set();
  const plugins = new Set();
  const addMcp = (servers) => {
    if (servers && typeof servers === "object") for (const k of Object.keys(servers)) { const n = nameOrNull(k); if (n) mcp.add(n); }
  };
  for (const j of jsons) {
    if (!j || typeof j !== "object") continue;
    for (const [event, groups] of Object.entries(j.hooks && typeof j.hooks === "object" ? j.hooks : {})) {
      const ev = nameOrNull(event);
      if (!ev || !Array.isArray(groups)) continue;
      for (const g of groups) {
        const matcher = typeof g?.matcher === "string" ? (g.matcher.length <= 80 ? g.matcher : "(long)") : null;
        const scripts = (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => (h?.type === "command" ? commandName(h.command) : nameOrNull(h?.type) ?? "(hook)"));
        (hooks[ev] ??= []).push({ ...(matcher ? { matcher } : {}), scripts });
      }
    }
    const perm = j.permissions && typeof j.permissions === "object" ? j.permissions : {};
    for (const list of ["allow", "ask", "deny"]) {
      for (const rule of Array.isArray(perm[list]) ? perm[list] : []) {
        const n = permissionName(rule);
        if (n) permissions[list][n] = (permissions[list][n] ?? 0) + 1;
      }
    }
    defaultMode = nameOrNull(perm.defaultMode) ?? defaultMode;
    addMcp(j.mcpServers);
    if (j.projects && typeof j.projects === "object") for (const p of Object.values(j.projects)) addMcp(p?.mcpServers);
    if (j.enabledPlugins && typeof j.enabledPlugins === "object") {
      for (const [k, on] of Object.entries(j.enabledPlugins)) { const n = nameOrNull(k); if (n && on) plugins.add(n); }
    }
  }
  return JSON.stringify({
    hooks: sortedObject(hooks),
    permissions: { allow: sortedObject(permissions.allow), ask: sortedObject(permissions.ask), deny: sortedObject(permissions.deny), defaultMode },
    mcp_servers: [...mcp].sort(),
    plugins: [...plugins].sort(),
  }, null, 2);
}

/**
 * ~/.codex/config.toml → approval・sandbox・MCP の名前（JSON 文字列）。
 * MCP の env・コマンド・引数は読まない（秘密が入りうる）。値は単語の形のものだけ。
 */
export function deriveCodexConfig(toml) {
  const out = { approval_policy: null, sandbox_mode: null, mcp_servers: [] };
  const mcp = new Set();
  let section = null;
  for (const raw of String(toml).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const head = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (head) {
      section = head[1];
      const m = /^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/.exec(section);
      if (m) { const n = nameOrNull(m[1] ?? m[2]); if (n) mcp.add(n); }
      continue;
    }
    if (section !== null) continue; // 上の段（どのセクションにも入らない行）だけ
    const kv = /^(approval_policy|sandbox_mode)\s*=\s*"?([A-Za-z0-9_-]{1,40})"?$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  out.mcp_servers = [...mcp].sort();
  return JSON.stringify(out, null, 2);
}

// ── 中身を読む ─────────────────────────────────────────────────────────────────

/**
 * 資産 1 件の中身。返す { raw: Buffer, text: string|null, withheld: null|"too_large"|"binary"|"unreadable" }
 * derive の資産は名前の一覧を作ってから返す（raw はその一覧＝ハッシュも一覧で取る＝値だけ変わっても新しい行にしない）。
 */
export function readAsset(target, io = defaultIo) {
  try {
    if (target.derive) {
      const parsed = [];
      for (const f of target.files) {
        const body = io.read(f).toString("utf-8").replace(/^﻿/, "");
        if (target.derive === "codex_config") parsed.push(body);
        else { try { parsed.push(JSON.parse(body)); } catch { /* 壊れた設定は飛ばす */ } }
      }
      const text = target.derive === "codex_config" ? deriveCodexConfig(parsed.join("\n")) : deriveSettingsNames(parsed);
      return { raw: Buffer.from(text, "utf-8"), text, withheld: null };
    }
    const size = io.size(target.file);
    if (size > ASSET_LIMITS.maxReadBytes) return { raw: null, bytes: size, text: null, withheld: "too_large" };
    const raw = io.read(target.file);
    if (raw.subarray(0, 8192).includes(0)) return { raw, text: null, withheld: "binary" };
    const text = raw.toString("utf-8").replace(/^﻿/, "");
    if (text.length > ASSET_LIMITS.maxTextChars) return { raw, text: null, withheld: "too_large" };
    return { raw, text, withheld: null };
  } catch {
    return { raw: null, text: null, withheld: "unreadable" };
  }
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ── 送る 1 行を組み立てる ─────────────────────────────────────────────────────────

/**
 * 資産 1 件 → 送る行と、手元だけに残す判断の記録。
 * @param {object} target listTargets の 1 件
 * @param {{ raw, bytes?, text, withheld }} content readAsset の結果
 * @param {{ home, userEmail, consentVer, pluginVersion, now?: Date, uuid?: () => string, projects?: object[] }} ctx
 * @returns {{ action: "drop", reason } | { action: "pending"|"outbox", row, meta }}
 *   drop   ＝1 行も作らない（パスに hard・読めない）。reason は名前だけ
 *   pending＝本人の承認を待つ／outbox＝送ってよい
 *   meta   ＝手元の表示用（judgment の当たり＝規則・行・先頭 40 字、hard は規則の名前だけ）。外へは出さない
 */
export function buildSnapshot(target, content, ctx) {
  const check = (s) => checkText(s, { homeDir: ctx.home, projects: ctx.projects ?? [] });
  if (content.withheld === "unreadable") return { action: "drop", reason: "unreadable" };

  const pathCheck = check(target.path_rel);
  if (!pathCheck.ok) return { action: "drop", reason: "path_hard" };

  let text = null;
  let hard = 0;
  let withheld = content.withheld;
  const judgmentHits = pathCheck.hits.filter((h) => h.severity === "judgment").map((h) => ({ ...h, where: "path" }));
  let hardRules = [];
  if (content.text !== null && withheld === null) {
    const r = check(content.text);
    // 検査は名前の規則より先に回す（hard の件数＝検査器の誤検知率を測る材料を落とさない）
    if (r.ok && target.kind === "hook" && SENSITIVE_NAME.test(target.path_rel)) {
      withheld = "sensitive_name";
    } else if (r.ok && r.text !== null && r.text.length <= ASSET_LIMITS.maxTextChars) {
      text = r.text;
    } else if (r.ok) {
      withheld = "too_large";
    } else {
      hard = r.counts.hard;
      withheld = "hard";
      hardRules = Object.keys(r.byRule).filter((id) => r.hits.some((h) => h.rule === id && h.severity === "hard"));
    }
    judgmentHits.push(...r.hits.filter((h) => h.severity === "judgment").map((h) => ({ ...h, where: "text" })));
  }

  const row = {
    snapshot_id: (ctx.uuid ?? randomUUID)(),
    user_email: ctx.userEmail,
    tool: target.tool,
    kind: target.kind,
    path_rel: target.path_rel,
    workspace: target.workspace,
    sha256: content.raw ? sha256(content.raw) : sha256(Buffer.from(`size:${content.bytes ?? 0}`)),
    bytes: content.raw ? content.raw.length : content.bytes ?? 0,
    text,
    checker_ver: CHECKER_VERSION,
    checker_hard: hard,
    consent_ver: ctx.consentVer,
    plugin_version: ctx.pluginVersion ?? null,
    taken_at: (ctx.now ?? new Date()).toISOString(),
  };
  const meta = {
    key: target.key,
    withheld, // null＝本文あり／"hard"・"sensitive_name"・"too_large"・"binary"＝名前と大きさだけ
    hard_rules: hardRules,
    judgment: judgmentHits.length,
    judgment_hits: judgmentHits.slice(0, 20).map(({ rule, line, preview, where }) => ({ rule, line, preview, where })),
  };
  const needsApproval = APPROVAL === "all" || meta.judgment > 0;
  return { action: needsApproval ? "pending" : "outbox", row, meta };
}

/**
 * 資産 1 件を最後まで（送らない口 → 読む → 検査 → 行）。止まった理由は名前だけで返す。
 * @param {object} state 手元の状態（sent[key].sha256＝前に送った・捨てた中身）
 * @param {Map<string, string>} pendingSha 承認待ちの key→sha256（同じ中身なら作り直さない）
 */
export function processTarget(target, ctx, { state, pendingSha = new Map(), io = defaultIo, gateIo } = {}) {
  const gate = contentGate({ kind: "asset", cwds: [target.gateDir] }, { home: ctx.home, ...(gateIo ? { io: gateIo } : {}) });
  if (!gate.send) return { action: "gated", by: gate.by };
  const content = readAsset(target, io);
  const sha = content.raw ? sha256(content.raw) : sha256(Buffer.from(`size:${content.bytes ?? 0}`));
  if (state?.sent?.[target.key]?.sha256 === sha) return { action: "unchanged" };
  if (pendingSha.get(target.key) === sha) return { action: "unchanged" };
  return buildSnapshot(target, content, ctx);
}
