#!/usr/bin/env node

/**
 * セッションに「送らない」印を付ける（送らない口のセッションの段・設計 §6.1）。
 * Claude Code のコマンド /dash-private が呼ぶ: node mark-private.mjs <session_id>
 * 印＝~/.claude/claude-dash/private/<session_id>（中身は付けた時刻だけ）。content-gate.mjs が読む。
 *
 * 印を付けられなかったときは、失敗をはっきり出して exit 1（コマンドの本文に結果が載る＝本人が気づける）。
 * コマンド本文の「dash-private」の文字そのものも会話の中の印になる＝ここが失敗してもセッションは送られない。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dashDir } from "./content-gate.mjs";

export function markPrivate(sessionId, home = homedir()) {
  if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) {
    throw new Error("セッションの id を受け取れなかった");
  }
  const dir = join(dashDir(home), "private");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, sessionId);
  writeFileSync(file, new Date().toISOString() + "\n", "utf-8");
  return file;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    markPrivate(process.argv[2]);
    console.log("✅ このセッションに「送らない」印を付けた（学びの要約は作らない・送らない。使った量と型は今まで通り数える）");
  } catch (e) {
    console.log(`❌ 印のファイルを付けられなかった（${e.message}）。会話の中の印で止まるが、念のため作業フォルダに .dash-private を置くと確実`);
    process.exit(1);
  }
}
