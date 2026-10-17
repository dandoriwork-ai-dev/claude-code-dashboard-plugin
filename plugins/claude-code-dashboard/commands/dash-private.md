---
description: このセッションの中身（学びの要約）をダッシュボードに送らない
allowed-tools: Bash(node:*)
---
[dash-private] このセッションは学びの要約を作らず、送りません（使った量と型は今まで通り数えます）。

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/mark-private.mjs" "${CLAUDE_SESSION_ID}"`

上の結果の行をそのまま 1 行で利用者に伝えてください。ほかの作業はしないでください。
