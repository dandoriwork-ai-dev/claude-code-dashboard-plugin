/**
 * 送らない口（ナレッジ収集・段0）。設計＝docs/KNOWLEDGE_COLLECTION_DESIGN.md §6.1。
 *
 * ②資産の本文・③学びの要約を「作る前」に、ここで送ってよいかを決める（作ってから捨てるのではない。要約器にも渡さない）。
 * ①量と型（raw_events）はここを通さない＝使った量は今まで通り数える。止まるのは中身だけ。
 *
 *   人        ＝~/.claude/claude-dash/config.json の content が "on" 以外（"off" 等）→ その人の②③すべて
 *   フォルダ  ＝作業フォルダかその親に .dash-private（中身は空でよい）→ そのフォルダのセッションの③と、そのフォルダの CLAUDE.md／AGENTS.md の②
 *   セッション＝~/.claude/claude-dash/private/<session_id> がある、または人の発話に dash-private の印がある → そのセッションの③
 *
 * fail-closed: 設定が読めない・壊れている・判定が例外を投げた、はすべて「送らない」（by="error"）。
 * 迷ったら送らない側に倒す＝送らなかった分は本人の画面に件数で出す（失うのは学び 1 件、漏れは戻せない）。
 * 依存なし（プラグインは node だけで動く）。fs は差し替えられる（テスト用）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

export const FOLDER_MARK = ".dash-private";
/** 人の発話に現れたら、そのセッションを送らない印。`/dash-private`（Claude Code のコマンド）・Codex で打った `dash-private` の行。 */
export const SESSION_MARK = /(?:^|[\s>/:#[])dash-private(?=$|[\s<\]])/m;

const defaultIo = {
  exists: (p) => existsSync(p),
  readText: (p) => readFileSync(p, "utf-8"),
};

export function dashDir(home = homedir()) {
  return join(home, ".claude", "claude-dash");
}

/** 人の段。config.json が無い＝告知どおり送る（opt-out）。content が書いてあって "on" でなければ止める。 */
function personOff(home, io) {
  const file = join(dashDir(home), "config.json");
  if (!io.exists(file)) return false;
  const cfg = JSON.parse(io.readText(file).replace(/^﻿/, ""));
  if (cfg === null || typeof cfg !== "object") throw new Error("config.json is not an object");
  return "content" in cfg && cfg.content !== "on";
}

/** フォルダの段。cwd から根まで上がって .dash-private を探す。 */
function folderMarked(cwd, io) {
  let dir = resolve(cwd);
  for (;;) {
    if (io.exists(join(dir, FOLDER_MARK))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * 送ってよいか。
 * @param {object} p
 * @param {string[]} [p.cwds]       セッションが使った作業フォルダ（1 つでも印の下なら止める）。②の資産ならその資産のフォルダ
 * @param {string}   [p.sessionId]  ③のとき
 * @param {string[]} [p.userTexts]  ③のとき＝そのセッションの人の発話（印を探す）
 * @param {"asset"|"note"} p.kind   ②＝asset／③＝note。セッションの段は③だけに効く
 * @returns {{ send: boolean, by: null|"person"|"folder"|"session"|"error" }}
 */
export function contentGate({ cwds = [], sessionId, userTexts = [], kind }, { home = homedir(), io = defaultIo } = {}) {
  try {
    if (kind !== "asset" && kind !== "note") throw new Error(`unknown kind: ${kind}`);
    if (!Array.isArray(cwds) || !Array.isArray(userTexts)) throw new Error("cwds / userTexts must be arrays");
    if (personOff(home, io)) return { send: false, by: "person" };
    if (cwds.some((c) => typeof c !== "string" || !c || folderMarked(c, io))) return { send: false, by: "folder" };
    if (kind === "note") {
      if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) throw new Error("sessionId required for note");
      if (io.exists(join(dashDir(home), "private", sessionId))) return { send: false, by: "session" };
      if (userTexts.some((t) => typeof t !== "string" || SESSION_MARK.test(t))) return { send: false, by: "session" };
    }
    return { send: true, by: null };
  } catch {
    return { send: false, by: "error" };
  }
}
