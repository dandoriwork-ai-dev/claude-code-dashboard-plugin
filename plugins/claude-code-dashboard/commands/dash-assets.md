---
description: 仕組みの資産（CLAUDE.md・rules・skills 等）の送信待ちを見て、送る・送らないを選ぶ
argument-hint: "[send <id…|all> | discard <id…|all>]"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/hooks/asset-collector.mjs" dash $ARGUMENTS`

上の結果を、省かずにそのまま利用者に見せてください（「確認してほしい箇所」の行も含める）。

送る・送らないは**利用者が決めます**。あなたが選んだり、勧めたりしないでください。利用者が選んだら、次のどちらかを実行して、結果の行をそのまま伝えてください。

- 送る: `node "${CLAUDE_PLUGIN_ROOT}/hooks/asset-collector.mjs" send <id…|all>`
- 送らない: `node "${CLAUDE_PLUGIN_ROOT}/hooks/asset-collector.mjs" discard <id…|all>`

id は一覧の [ ] の 8 文字です。利用者がファイルを直したいと言ったら手伝ってかまいません。直したファイルは、次の回（1 日 1 回）に新しい中身で送信待ちに出ます。
