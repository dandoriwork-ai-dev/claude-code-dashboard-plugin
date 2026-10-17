#!/usr/bin/env node

/**
 * 仕組みの資産（②）を集めて送る（ナレッジ収集・段1）。設計＝docs/KNOWLEDGE_COLLECTION_DESIGN.md §4・§7.1。
 *
 * Claude Code の Stop フック（collector.mjs）が 1 日 1 回まで、切り離したプロセスでこれを起こす。
 *   1. 受け口が開いているか（告知の後か）を Ingest に聞く。閉じていれば何も読まない
 *   2. 資産を列挙 → 送らない口（contentGate）→ 読む → leak-check（assets.mjs）
 *   3. 前に送った・捨てた中身と同じなら何もしない（sha256）
 *   4. 本人の承認を待つ（pending/）。承認されたもの（outbox/）だけを /v1/assets へ送る
 * 承認待ちは次のセッションの開始で知らせ（collector.mjs session-start）、/dash-assets で見て送る・捨てる。
 *
 * 使い方:
 *   node asset-collector.mjs                    集める・送る（通常は Stop フックが起こす）
 *   node asset-collector.mjs --dry-run          読むだけ（受け口に聞かない・何も書かない・送らない）。止まった理由と件数だけを出す（本文・当たった値は出さない）
 *   node asset-collector.mjs list               承認待ちの一覧
 *   node asset-collector.mjs dash [send|discard …]  /dash-assets が呼ぶ（引数なし＝一覧）
 *   node asset-collector.mjs send <id…|all>     承認して送る
 *   node asset-collector.mjs discard <id…|all>  送らずに捨てる（中身が変わるまで聞かない）
 *
 * 手元に置くもの（~/.claude/claude-dash/assets/）＝state.json（key→送った中身の sha256）・pending/・outbox/・cwds.json（最近の作業フォルダ）。
 * 承認待ちには本文が入る（本人の PC の本人のファイル＝外へは出ていない）。error.log には理由の名前と件数だけを書く。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { APPROVAL, ASSET_LIMITS, listTargets, processTarget } from "./assets.mjs";
import {
  DASH_DIR, ensureDirs, logError, getUserEmail, codexHome, gitRoot,
  writeJsonAtomic, acquireLock, releaseLock, fetchKnowledgeStatus, postKnowledge,
} from "./shared-io.mjs";
import { PLUGIN_VERSION } from "./plugin-version.mjs";

export const ASSET_DIR = join(DASH_DIR, "assets");
const STATE_FILE = join(ASSET_DIR, "state.json");
const PENDING_DIR = join(ASSET_DIR, "pending");
const OUTBOX_DIR = join(ASSET_DIR, "outbox");
const CWDS_FILE = join(ASSET_DIR, "cwds.json");
const LOCK_FILE = join(DASH_DIR, "asset-collector.lock");
const STATE_VERSION = 1;
/** 作業フォルダを覚えておく長さ・数（リポジトリの CLAUDE.md／AGENTS.md を探す範囲） */
const CWD_KEEP_DAYS = 30;
const CWD_KEEP_MAX = 100;
/** 1 リクエストの本文の目安（受け口の上限 8MB より下） */
const MAX_REQUEST_BYTES = 6_000_000;

// ── 手元の置き場 ────────────────────────────────────────────────────────────────

function ensureAssetDirs() {
  ensureDirs();
  for (const d of [ASSET_DIR, PENDING_DIR, OUTBOX_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    if (s && s.version === STATE_VERSION && s.sent && typeof s.sent === "object") return s;
  } catch { /* 初回・壊れた＝最初から（同じ中身を送り直しても読む側のビューが 1 行にする） */ }
  return { version: STATE_VERSION, sent: {} };
}

function saveState(state) {
  ensureAssetDirs();
  writeJsonAtomic(STATE_FILE, state);
}

/** pending/・outbox/ の 1 件＝{ row, meta }。ファイル名は snapshot_id */
function readBox(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const item = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      if (item?.row?.snapshot_id && item?.meta?.key) out.push({ ...item, file: join(dir, f) });
    } catch { /* 書きかけ・壊れた */ }
  }
  return out;
}

function writeBox(dir, item) {
  ensureAssetDirs();
  writeJsonAtomic(join(dir, `${item.row.snapshot_id}.json`), { row: item.row, meta: item.meta });
}

function removeFile(file) {
  try { unlinkSync(file); } catch { /* 消えている */ }
}

/** 承認待ちの件数（collector.mjs の session-start が知らせる） */
export function pendingCount() {
  try { return readdirSync(PENDING_DIR).filter((n) => n.endsWith(".json")).length; } catch { return 0; }
}

/** SessionStart の出力。承認待ちがあれば本人に 1 行（systemMessage＝利用者に見える・会話には入らない） */
export function sessionStartOutput(count) {
  if (!count) return {};
  return { systemMessage: `claude-dash: 仕組みの資産（CLAUDE.md・rules・skills 等）${count} 件が、送る前の確認を待っています。/dash-assets で見て、送る・送らないを選んでください。` };
}

// ── 作業フォルダ（Stop が残す） ──────────────────────────────────────────────────

/** Stop フックが呼ぶ。cwd を覚える（外へは出さない）。古いもの・多すぎる分は落とす */
export function recordCwd(cwd, now = Date.now()) {
  if (typeof cwd !== "string" || !cwd) return;
  let cwds = {};
  try { cwds = JSON.parse(readFileSync(CWDS_FILE, "utf-8")) || {}; } catch { /* 初回 */ }
  cwds[cwd] = new Date(now).toISOString();
  const keep = Object.entries(cwds)
    .filter(([, at]) => now - Date.parse(at) < CWD_KEEP_DAYS * 86_400_000)
    .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
    .slice(0, CWD_KEEP_MAX);
  ensureAssetDirs();
  writeJsonAtomic(CWDS_FILE, Object.fromEntries(keep));
}

/**
 * git の根は実体のパスで返る（ホームがシンボリックリンク経由だと /private/var/… 等）。
 * ホームの実体の下なら、ホームの表記に戻す（戻さないと「ホームの外」として読まない）
 */
export function underHome(root, home = homedir()) {
  let real = home;
  try { real = realpathSync(home); } catch { /* そのまま */ }
  return real !== home && (root === real || root.startsWith(real + sep)) ? home + root.slice(real.length) : root;
}

function repoRoots() {
  let cwds = {};
  try { cwds = JSON.parse(readFileSync(CWDS_FILE, "utf-8")) || {}; } catch { return []; }
  const roots = new Set();
  for (const cwd of Object.keys(cwds)) {
    if (!existsSync(cwd)) continue;
    const root = gitRoot(cwd);
    if (root) roots.add(underHome(resolve(root))); // resolve＝Windows の git は / 区切りで返す
  }
  return [...roots].sort();
}

// ── 集める ───────────────────────────────────────────────────────────────────

/**
 * 全資産を通し、承認待ち・送るものを作る。state は読むだけ。
 * @returns {{ made: {action,row,meta}[], tally: Record<string, number>, lines: string[] }}
 *   lines＝dry-run の表示用（パス・止まった理由・件数だけ。本文と当たった値は入れない）
 */
export function collect(state, { consentVer, home = homedir(), roots = repoRoots(), now = new Date() } = {}) {
  const userEmail = getUserEmail();
  if (!/^[^@\s]+@[^@\s]+$/.test(userEmail)) throw new Error("user_email_not_set");
  const pendingSha = new Map();
  for (const p of readBox(PENDING_DIR)) pendingSha.set(p.meta.key, p.row.sha256);
  for (const p of readBox(OUTBOX_DIR)) pendingSha.set(p.meta.key, p.row.sha256);

  const ctx = { home, userEmail, consentVer, pluginVersion: PLUGIN_VERSION, now };
  const made = [];
  const tally = {};
  const lines = [];
  for (const target of listTargets({ home, codexHome: codexHome(), repoRoots: roots })) {
    const r = processTarget(target, ctx, { state, pendingSha });
    const label = r.action === "gated" ? `gated:${r.by}` : r.action === "drop" ? `drop:${r.reason}` : r.action;
    tally[label] = (tally[label] ?? 0) + 1;
    const where = target.workspace ? `${target.path_rel} [${target.workspace}]` : target.path_rel;
    if (r.row) {
      made.push(r);
      const body = r.meta.withheld ? `名前と大きさだけ(${r.meta.withheld}${r.meta.hard_rules.length ? ":" + r.meta.hard_rules.join(",") : ""})` : "本文あり";
      lines.push(`${label.padEnd(10)} ${target.kind.padEnd(14)} ${where}  ${r.row.bytes}B  ${body}  judgment=${r.meta.judgment}`);
    } else {
      lines.push(`${label.padEnd(10)} ${target.kind.padEnd(14)} ${where}`);
    }
  }
  return { made, tally, lines };
}

/** 作ったものを置く。同じ資産の古い承認待ちは新しい中身で置き換える */
function store(made) {
  const old = new Map(readBox(PENDING_DIR).map((p) => [p.meta.key, p.file]));
  for (const m of made) {
    if (old.has(m.meta.key)) removeFile(old.get(m.meta.key));
    writeBox(m.action === "outbox" ? OUTBOX_DIR : PENDING_DIR, m);
  }
}

// ── 送る ────────────────────────────────────────────────────────────────────

function chunks(items) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    const size = Buffer.byteLength(JSON.stringify(it.row), "utf-8");
    if (cur.length && (cur.length >= ASSET_LIMITS.maxRowsPerRequest || bytes + size > MAX_REQUEST_BYTES)) {
      out.push(cur); cur = []; bytes = 0;
    }
    cur.push(it); bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * outbox/ を送る。入った行は state に sha256 を残して消す。受け口が落とした行も state に残す（同じ中身を毎日送り直さない）。
 * ただし「告知の版が閉じている」で落ちた行は state に残さない（新しい版で開いたら作り直す）。
 * 閉じている・届かないときは outbox に残して終わる（次の回に送る）。
 * @returns {{ sent: number, rejected: number, kept: number, status: string }}
 */
export async function flushOutbox(state, { post = postKnowledge, now = new Date() } = {}) {
  const items = readBox(OUTBOX_DIR);
  let sent = 0;
  let rejected = 0;
  let status = "ok";
  for (const chunk of chunks(items)) {
    const r = await post("assets", chunk.map((it) => it.row));
    if (r.status !== "ok") { status = r.status; if (r.status === "drop") logError("asset-send", r.reason); break; }
    chunk.forEach((it, i) => {
      const reason = r.rejected.get(i);
      if (reason === "consent_ver_not_open") delete state.sent[it.meta.key];
      else state.sent[it.meta.key] = { sha256: it.row.sha256, status: reason ? "rejected" : "sent", at: now.toISOString(), ...(reason ? { reason } : {}) };
      if (reason) { rejected++; logError("asset-send", `rejected:${reason}`); } else sent++;
      removeFile(it.file);
    });
    saveState(state);
  }
  return { sent, rejected, kept: items.length - sent - rejected, status };
}

// ── 承認（/dash-assets） ─────────────────────────────────────────────────────────

const shortId = (id) => id.slice(0, 8);

function pick(items, ids) {
  if (ids.length === 1 && ids[0] === "all") return items;
  const want = new Set(ids.map((s) => s.toLowerCase()));
  return items.filter((it) => want.has(shortId(it.row.snapshot_id)));
}

export function listPending() {
  const items = readBox(PENDING_DIR);
  if (!items.length) return "送信待ちの資産はありません。";
  const out = [`送信待ちの仕組みの資産 ${items.length} 件（送ると社内のダッシュボードの「みんなの仕組み」に並びます。送った後も /me で消せます）`, ""];
  for (const it of items) {
    const { row, meta } = it;
    const where = row.workspace ? `${row.path_rel}（${row.workspace}）` : row.path_rel;
    const body = meta.withheld === null ? "本文を送る" : `名前と大きさだけ（${{ hard: "秘密らしいものが見つかったので本文は送らない", sensitive_name: "名前が秘密を扱うものらしいので本文は送らない", too_large: "大きすぎるので本文は送らない", binary: "文字のファイルでないので本文は送らない" }[meta.withheld] ?? meta.withheld}${meta.hard_rules.length ? "：" + meta.hard_rules.join("・") : ""}）`;
    out.push(`- [${shortId(row.snapshot_id)}] ${row.kind}  ${where}  ${row.bytes} バイト  ${body}`);
    if (meta.judgment > 0) {
      out.push(`    確認してほしい箇所 ${meta.judgment} 件（人名・社名・社員のメール等。顧客名なら送らないか、直してから次の回に）`);
      for (const h of meta.judgment_hits) out.push(`      ${h.where === "path" ? "パス" : `${h.line} 行目`}  ${h.rule}  「${h.preview}」`);
    }
  }
  out.push("", "送る: send <id…|all>／送らない: discard <id…|all>（捨てたものは中身が変わるまで聞きません）");
  return out.join("\n");
}

export async function approve(ids, { post = postKnowledge, status = fetchKnowledgeStatus } = {}) {
  const items = pick(readBox(PENDING_DIR), ids);
  if (!items.length) return "該当する送信待ちがありません（id は一覧の [ ] の 8 文字）。";
  for (const it of items) {
    writeBox(OUTBOX_DIR, it);
    removeFile(it.file);
  }
  const s = await status();
  if (!s?.open) return `${items.length} 件を送る側に移しました。受け口が今は開いていない（または届かない）ので、次の回（1 日 1 回）に送ります。`;
  const state = loadState();
  const r = await flushOutbox(state, { post });
  return `${items.length} 件を承認しました。送った ${r.sent} 件・受け口が受けなかった ${r.rejected} 件・次の回に送る ${r.kept} 件。`;
}

export function discard(ids, { now = new Date() } = {}) {
  const items = pick(readBox(PENDING_DIR), ids);
  if (!items.length) return "該当する送信待ちがありません（id は一覧の [ ] の 8 文字）。";
  const state = loadState();
  for (const it of items) {
    state.sent[it.meta.key] = { sha256: it.row.sha256, status: "discarded", at: now.toISOString() };
    removeFile(it.file);
  }
  saveState(state);
  return `${items.length} 件を送らずに捨てました（中身が変わるまで聞きません）。`;
}

// ── 本体 ────────────────────────────────────────────────────────────────────

export async function run({ status = fetchKnowledgeStatus, post = postKnowledge } = {}) {
  const lock = acquireLock(LOCK_FILE);
  if (lock === null) return { skipped: "locked" };
  try {
    const s = await status();
    if (!s) return { skipped: "unreachable" };
    if (!s.open) return { skipped: "closed" }; // 告知の前＝何も読まない
    const state = loadState();
    const { made, tally } = collect(state, { consentVer: s.consent_ver });
    store(made);
    const sent = await flushOutbox(state, { post });
    state.last_run_at = new Date().toISOString();
    saveState(state);
    if (made.length || sent.rejected) logError("asset-collector", `approval=${APPROVAL} ${Object.entries(tally).map(([k, v]) => `${k}:${v}`).join(" ")} sent=${sent.sent} rejected=${sent.rejected}`);
    return { tally, ...sent };
  } finally {
    releaseLock(LOCK_FILE, lock);
  }
}

function dryRun() {
  const state = loadState();
  const started = Date.now();
  const { tally, lines } = collect(state, { consentVer: "dry-run" });
  console.log(lines.join("\n"));
  console.log(JSON.stringify({ approval: APPROVAL, tally, elapsed_ms: Date.now() - started }, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "--dry-run") dryRun();
    else if (cmd === "list" || (cmd === "dash" && rest.length === 0)) console.log(listPending());
    else if (cmd === "dash" && (rest[0] === "send" || rest[0] === "discard")) {
      const ids = rest.slice(1);
      if (!ids.length) console.log("id を指定してください（all で全部）。");
      else console.log(rest[0] === "send" ? await approve(ids) : discard(ids));
    }
    else if (cmd === "send") console.log(rest.length ? await approve(rest) : "送る id を指定してください（all で全部）。");
    else if (cmd === "discard") console.log(rest.length ? discard(rest) : "捨てる id を指定してください（all で全部）。");
    else if (cmd === undefined) await run();
    else { console.error(`unknown command: ${cmd}`); process.exitCode = 2; }
  } catch (err) {
    logError("asset-collector", err);
    if (cmd !== undefined) { console.error(`失敗しました: ${err.message}`); process.exitCode = 1; }
  }
}

// 他のファイルから import されたときは動かない（collector.mjs・テスト）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
