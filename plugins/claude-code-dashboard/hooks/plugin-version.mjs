/**
 * 動いているプラグインの版（v0.8.1〜 送る行の plugin_version）。
 *
 * 版はインストール先のフォルダ名から読む（`~/.claude/plugins/cache/<marketplace>/<plugin>/<版>/hooks/`）。
 * そのフォルダは Claude Code が実際に読み込んだ版なので、コードに版を書いて上げ忘れる、が起きない。
 * 古い版のまま開いているプロセスは古いフォルダから動く＝その行には古い版が載る（10/13 濱口さん＝
 * 「更新した」と思っていたが 0.5.0 のままだった。自己申告では確かめられなかった）。
 * リポジトリから直接動かしたとき（テスト・手元の確認）はフォルダ名が版の形でないので "dev"。
 */

import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** hooks フォルダの中のファイルの URL → 版。版の形でなければ "dev" */
export function pluginVersionFrom(moduleUrl) {
  const root = dirname(dirname(fileURLToPath(moduleUrl)));
  const name = basename(root);
  return VERSION_DIR.test(name) ? name : "dev";
}

export const PLUGIN_VERSION = pluginVersionFrom(import.meta.url);
