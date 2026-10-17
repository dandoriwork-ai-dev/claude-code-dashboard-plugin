/**
 * 送る前の検査器（ナレッジ収集・段0）。設計＝docs/KNOWLEDGE_COLLECTION_DESIGN.md §5。
 *
 * PC から外へ出す文字列（②資産の本文・③学びの要約・将来の自動生成）は、全部ここを通す。
 *   - hard     ＝決定論で「漏れ」と言えるもの（鍵・接続文字列・社外メール・電話・番地までの住所・カード・マイナンバー）。
 *                1 件でもあれば、その単位（資産 1 件／要約 1 件）を丸ごと送らない。
 *   - judgment ＝意味の判断が要るもの（顧客名・社名・様付きの呼び名・社員のメール）。初期は本人が見て決める。
 *
 * fail-closed: 入力が文字列でない・大きすぎる・規則が例外を投げた、はすべて hard として返す。
 * 値は外へ出さない: 結果に載るのは規則・種類・件数・行番号と、伏せた先頭だけ。error.log へは formatCounts の形で書く。
 *
 * 移植元＝dandori-pages packages/shared/src/leak-policy.ts の hard 規則（鍵の形式・JWT の構造判定・プレースホルダの除外）。
 * 納品物向けの規則（ツール痕跡・HTML コメント・console・localhost・Chatwork の ID・AI 署名）は移さない＝社内の学びでは中身そのもの。
 * 依存なし（プラグインは node だけで動く）。
 */

export const CHECKER_VERSION = "lc-v1";
export const MAX_INPUT_CHARS = 2_000_000;
/** 自社ドメイン。ここのメールは社員＝judgment（社外は hard）。2 系統が併存している（R↔L・末尾の s）。 */
export const COMPANY_EMAIL_DOMAINS = ["dandori-work.com", "dandoli-works.com"];
/** judgment から外す語の既定（自社名）。呼び出し側の allow に足される。 */
export const DEFAULT_ALLOW = ["ダンドリワーク", "Dandori Work", "DandoriWork"];

// ── 共通 ──────────────────────────────────────────────────────────────────────

/** 例示・伏せ字・変数参照（実値ではないもの）。 */
const PLACEHOLDER =
  /x{4,}|\*{3,}|•{3,}|your[-_ ]?(?:key|token|secret|password|pass)|example|placeholder|redacted|dummy|sample|<[^>]*>|\$\{[^}]*\}|^\$[A-Za-z_]|伏せ|ここに|変更してください/i;

/** 代入の右辺に来ても秘密ではない語（型名・変数参照・既定値）。 */
const NOT_A_VALUE =
  /^(?:undefined|null|none|nil|true|false|string|number|boolean|required|optional|process\.env|os\.environ|getenv|env\.|config\.|settings\.|import\.meta|secrets\.|vars\.|\$\{\{)/i;

/** パスワードの右辺に来ても値ではない語（保管場所・手順の説明）。 */
const NOT_A_PASSWORD = /1password|bitwarden|keychain|キーチェーン|別途|伏せ|共有済|変更|設定|再設定|リセット|不要|なし|未設定|空/i;

/** ホームのパスの「ユーザー名」の位置に来る例示（/Users/.../・/Users/<name>/・C:\Users\username\）。置換も検査もしない。 */
const HOME_SEG_EXAMPLE = String.raw`(?!(?:Shared|yourname|username|user|name|you|me|USERNAME)(?![^\\/\s"'\x60])|\.{2,}|…|<|\*|\{|\$|%|x{3,})`;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function* matchAll(text, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  for (const m of text.matchAll(re)) yield m;
}

function hitsOf(text, pattern, keep = () => true) {
  const out = [];
  for (const m of matchAll(text, pattern)) {
    if (keep(m)) out.push({ index: m.index ?? 0, value: m[0] });
  }
  return out;
}

const notPlaceholder = (m) => !PLACEHOLDER.test(m[0]);

function digitsOf(s) {
  return s.replace(/\D/g, "");
}

function luhnOk(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** マイナンバー（個人番号）の検査用数字。番号法施行規則 5 条の計算。 */
export function myNumberCheckOk(digits) {
  if (!/^\d{12}$/.test(digits)) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = digits.charCodeAt(11 - n) - 48;
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const r = sum % 11;
  const check = r <= 1 ? 0 : 11 - r;
  return check === digits.charCodeAt(11) - 48;
}

function decodeBase64UrlJson(seg) {
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const obj = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// ── 規則 ──────────────────────────────────────────────────────────────────────
// find(text, opts) は NFKC 済み・パス置換済みの文字列を受け、{ index, value } の配列を返す。

export const RULES = [
  // ── 鍵・トークン（hard） ─────────────────────────────────────────────────
  {
    id: "secret-private-key",
    category: "秘密",
    severity: "hard",
    find: (t) => hitsOf(t, /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g),
  },
  {
    id: "secret-anthropic",
    category: "秘密",
    severity: "hard",
    find: (t) => hitsOf(t, /\bsk-ant-[a-z]{3,6}\d{2}-[A-Za-z0-9_-]{20,}/g, notPlaceholder),
  },
  {
    id: "secret-openai",
    category: "秘密",
    severity: "hard",
    // base64 画像の偶然一致を弾く: T3BlbkFJ の印か、本体にハイフン・アンダースコアが混ざるものだけ（leak-policy と同じ）
    find: (t) =>
      hitsOf(t, /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, (m) => {
        if (PLACEHOLDER.test(m[0])) return false;
        const body = m[0].replace(/^sk-(?:proj-|svcacct-|admin-)?/, "");
        return m[0].includes("T3BlbkFJ") || /[-_]/.test(body);
      }),
  },
  {
    id: "secret-token-prefix",
    category: "秘密",
    severity: "hard",
    find: (t) => {
      const pats = [
        /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API キー
        /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS アクセスキー
        /\bgh[pousr]_[A-Za-z0-9]{36}\b/g, // GitHub
        /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
        /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
        /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, // Stripe
        /\bwhsec_[A-Za-z0-9]{20,}\b/g,
        /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, // SendGrid
        /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g, // Google OAuth クライアントシークレット
        /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
        /\bnpm_[A-Za-z0-9]{36}\b/g,
        /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g, // Supabase の秘密キー
        /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
        /\bya29\.[A-Za-z0-9_-]{30,}\b/g, // Google OAuth アクセストークン
        /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g, // Slack の Webhook URL
      ];
      return pats.flatMap((p) => hitsOf(t, p, notPlaceholder));
    },
  },
  {
    id: "secret-jwt",
    category: "秘密",
    severity: "hard",
    // ドット 2 個＋ヘッダが JSON で alg/typ を持つものだけ（eyJ で始まる断片は弾く）
    find: (t) =>
      hitsOf(t, /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, (m) => {
        const header = decodeBase64UrlJson(m[0].split(".")[0]);
        return !!header && ("alg" in header || "typ" in header);
      }),
  },
  {
    id: "secret-url-credential",
    category: "秘密",
    severity: "hard",
    // 「スキーム://ユーザー:パスワード@ホスト」の形（パスワード部が実値のもの。postgres・https 等）
    find: (t) =>
      hitsOf(t, /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'`]+:([^\s@/"'`]+)@[^\s/"'`]+/gi, (m) => {
        const pass = m[1] ?? "";
        return pass.length >= 3 && !PLACEHOLDER.test(pass) && !NOT_A_VALUE.test(pass) && !/^\[|^\$|^%/.test(pass);
      }),
  },
  {
    id: "secret-assignment",
    category: "秘密",
    severity: "hard",
    // 秘密らしい名前への代入（.env・JSON・YAML）。右辺が 8 字以上の実値のものだけ。
    find: (t) =>
      hitsOf(
        t,
        /["']?\b([A-Za-z][A-Za-z0-9_.-]*(?:secret|token|passwd|password|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|webhook[_-]?url|credentials?))["']?\s*[:=]\s*["']?([^\s"'`,;)}\]]{8,})/gi,
        (m) => {
          const key = m[1] ?? "";
          const val = m[2] ?? "";
          if (/tokens$|_count$|_ttl$|_expires?/i.test(key)) return false; // max_tokens 等の数
          if (/^\d+$/.test(val)) return false;
          if (PLACEHOLDER.test(val) || NOT_A_VALUE.test(val)) return false;
          if (/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_]/.test(val) && !/[:/@]/.test(val)) return false; // obj.prop の参照
          // 実値らしさ: 英字と数字が混ざる、または 24 字以上で大文字小文字が混ざる（apiKeyFromEnv のような変数名を弾く）
          return (/\d/.test(val) && /[A-Za-z]/.test(val)) || (val.length >= 24 && /[A-Z]/.test(val) && /[a-z]/.test(val));
        },
      ),
  },
  {
    id: "secret-password-jp",
    category: "秘密",
    severity: "hard",
    // 「パスワード: xxx」「PW は xxx」「合言葉=xxx」（NFKC 済みなので全角のコロンも ":" になっている）。英語の password=… は secret-assignment
    find: (t) =>
      hitsOf(t, /(?:パスワード|暗証番号|合言葉|\bPW\b)\s*(?:は|:|=)\s*[「"']?([A-Za-z0-9!#$%&()*+\-./:;<=>?@[\]^_{|}~]{4,})/gi, (m) => {
        // 値は ASCII の並びだけ（「パスワードは本人に伝える」のような説明文を弾く）
        const val = m[1] ?? "";
        return !PLACEHOLDER.test(val) && !NOT_A_PASSWORD.test(val) && !NOT_A_VALUE.test(val);
      }),
  },
  // ── 個人情報（hard） ─────────────────────────────────────────────────────
  {
    id: "pii-email-external",
    category: "個人情報",
    severity: "hard",
    find: (t) =>
      hitsOf(t, /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, (m) => {
        const local = m[0].split("@")[0].toLowerCase();
        const domain = (m[1] ?? "").toLowerCase();
        if (COMPANY_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return false;
        if (/^(?:no-?reply|do-?not-?reply|noreply\+.*)$/.test(local)) return false;
        if (/(?:^|\.)(?:example|test|invalid|localhost)(?:\.[a-z]+)?$/.test(domain)) return false;
        if (domain.endsWith("users.noreply.github.com")) return false;
        if (/\.(?:png|jpe?g|gif|svg|webp)$/.test(domain)) return false; // 画像名の @2x 等
        return !PLACEHOLDER.test(m[0]);
      }),
  },
  {
    id: "pii-phone-jp",
    category: "個人情報",
    severity: "hard",
    find: (t) => {
      const out = [];
      // 0X-XXXX-XXXX（10〜11 桁）／ハイフンなしの携帯／+81 形式。フリーダイヤル（0120・0800）は事業者なので除外。
      for (const h of hitsOf(t, /(?<![\d-])0\d{1,4}[-(]\d{1,4}[-)]\d{3,4}(?![\d-])/g)) {
        const d = digitsOf(h.value);
        if ((d.length === 10 || d.length === 11) && !/^0120|^0800/.test(d)) out.push(h);
      }
      out.push(...hitsOf(t, /(?<!\d)0[789]0\d{8}(?!\d)/g));
      out.push(...hitsOf(t, /\+81[- ]?\(?0?\d{1,4}\)?[- ]?\d{1,4}[- ]?\d{3,4}(?!\d)/g));
      return out;
    },
  },
  {
    id: "pii-postal-jp",
    category: "個人情報",
    severity: "hard",
    find: (t) => hitsOf(t, /(?:〒|郵便番号\s*:?)\s*\d{3}-?\d{4}(?!\d)/g),
  },
  {
    id: "pii-address-jp",
    category: "個人情報",
    severity: "hard",
    // 番地まである住所（市区町村だけ・都道府県だけは業務の文脈として残す）
    // ①「丁目」か「番地」がある ②ハイフンだけの番地は都道府県から書いてあるとき（「全区間で 1-2 回」のような偶然一致を弾く）
    find: (t) => {
      const pref = "(?:東京都|北海道|京都府|大阪府|[一-龥]{2,3}県)";
      const city = "[一-龥ァ-ヶ]{1,8}(?:市|区|郡|町|村)";
      const town = "[一-龥ぁ-んァ-ヶ]{0,12}";
      return [
        ...hitsOf(t, new RegExp(`(?:${pref})?${city}${town}\\d{1,4}丁目\\d{0,4}`, "g")),
        ...hitsOf(t, new RegExp(`(?:${pref})?${city}${town}\\d{1,5}番地`, "g")),
        ...hitsOf(t, new RegExp(`${pref}${city}${town}\\d{1,4}-\\d{1,4}(?:-\\d{1,4})?`, "g")),
      ];
    },
  },
  {
    id: "pii-card",
    category: "個人情報",
    severity: "hard",
    find: (t) =>
      hitsOf(t, /(?<![\d-])[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{1,7}(?![\d-])/g, (m) => {
        const d = digitsOf(m[0]);
        return d.length >= 13 && d.length <= 19 && luhnOk(d);
      }),
  },
  {
    id: "pii-mynumber",
    category: "個人情報",
    severity: "hard",
    // 検査用数字が合い、かつ 4-4-4 の形か「マイナンバー／個人番号」の語が近くにあるもの
    find: (t) =>
      hitsOf(t, /(?<![\d-])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g, (m) => {
        if (!myNumberCheckOk(digitsOf(m[0]))) return false;
        const grouped = /\d{4}[ -]\d{4}[ -]\d{4}/.test(m[0]);
        const near = t.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0);
        return grouped || /マイナンバー|個人番号|my\s*number/i.test(near);
      }),
  },
  {
    id: "abs-home-path",
    category: "パス",
    severity: "hard",
    // ~ への置換を抜けたホームの絶対パス（全角で書かれていた等）。置換が効いていれば 0 件。
    find: (t) =>
      hitsOf(t, new RegExp(String.raw`(?:\/Users\/|\/home\/|\b[A-Za-z]:[\\/]Users[\\/])` + HOME_SEG_EXAMPLE + String.raw`[^\\/\s"'\x60]+`, "g")),
  },
  // ── 判断が要るもの（judgment） ─────────────────────────────────────────────
  {
    id: "name-deny",
    category: "固有名",
    severity: "judgment",
    // 呼び出し側が渡す辞書（顧客名・社員名・社内固有名）。PJ への置換を抜けた表記揺れもここで当たる。
    find: (t, opts) => {
      const terms = [...(opts.deny ?? []), ...(opts.projects ?? []).flatMap((p) => p.terms ?? [])].filter(
        (s) => typeof s === "string" && s.trim().length >= 2,
      );
      const out = [];
      for (const term of new Set(terms)) {
        const norm = term.normalize("NFKC");
        const p = /^[A-Za-z0-9]/.test(norm) ? new RegExp("\\b" + escapeRe(norm) + "\\b", "gi") : new RegExp(escapeRe(norm), "g");
        out.push(...hitsOf(t, p));
      }
      return out;
    },
  },
  {
    id: "name-sama",
    category: "固有名",
    severity: "judgment",
    // 「〇〇様」＝顧客の呼び名であることが多い（社員は「さん」）
    // 「仕様」「同様」「模様」「お客様」「担当者様」のような語は除く（様の直前の 1 字で見る）
    find: (t) => hitsOf(t, /[一-龥ァ-ヶA-Za-z]{1,8}様(?![式々子相])/g, (m) => !/[仕同模多異一有左上外文紋両別今斯何如貴奥殿皆各神仏王客者員方主生]様$/.test(m[0])),
  },
  {
    id: "name-company",
    category: "固有名",
    severity: "judgment",
    find: (t) =>
      hitsOf(t, /(?:株式会社|有限会社|合同会社|\(株\)|\(有\))\s?[一-龥ァ-ヶA-Za-z0-9ー・]{2,16}|[一-龥ァ-ヶA-Za-z0-9ー・]{2,16}\s?(?:株式会社|有限会社|合同会社|\(株\))/g),
  },
  {
    id: "email-company",
    category: "固有名",
    severity: "judgment",
    find: (t) => {
      const doms = COMPANY_EMAIL_DOMAINS.map(escapeRe).join("|");
      return hitsOf(t, new RegExp(`\\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\\.)*(?:${doms})\\b`, "gi"));
    },
  },
];

// ── 置換（送る文字列そのものを変える・決定論） ───────────────────────────────────

/**
 * ホームの絶対パスを ~ に置き換える。資産は ~/.claude/... を参照し合うので、パスを hard にすると全部止まる。
 * 消えるのはユーザー名だけ。残ったパスに顧客名があれば judgment で当たる。
 */
export function normalizeHomePaths(text, homeDir) {
  let out = text;
  if (homeDir && homeDir.length > 1) {
    const h = homeDir.replace(/[\\/]+$/, "");
    out = out.replace(new RegExp(escapeRe(h) + "(?=[\\\\/]|\\b|$)", "g"), "~");
  }
  const seg = HOME_SEG_EXAMPLE + String.raw`[^\\/\s"'\x60]+`;
  out = out.replace(new RegExp(String.raw`\/(?:Users|home)\/` + seg, "g"), "~");
  out = out.replace(new RegExp(String.raw`\b[A-Za-z]:[\\/]Users[\\/]` + seg, "g"), "~");
  return out;
}

/** 顧客名を PJ の印に置き換える（社長決定 2026-10-15）。印は〔PJ:<project_id>〕＝表示名は画面がマスタで引く。 */
export function replaceProjectNames(text, projects = []) {
  const pairs = [];
  for (const p of projects) {
    if (!p || typeof p.id !== "string") continue;
    for (const term of p.terms ?? []) if (typeof term === "string" && term.trim().length >= 2) pairs.push([term, p.id]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length); // 長い語から（短い語が長い語の一部だけを先に置き換えないように）
  let out = text;
  for (const [term, id] of pairs) {
    const p = /^[A-Za-z0-9]/.test(term) ? new RegExp("\\b" + escapeRe(term) + "\\b", "gi") : new RegExp(escapeRe(term), "g");
    out = out.replace(p, `〔PJ:${id}〕`);
  }
  return out;
}

// ── 公開 API ──────────────────────────────────────────────────────────────────

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function preview(rule, value) {
  if (rule.severity === "judgment") return value.slice(0, 40);
  return `${value.slice(0, Math.min(4, value.length))}…(${value.length}字・伏字)`;
}

function failClosed(reason, extra = {}) {
  const hit = { rule: reason, category: "検査器", severity: "hard", line: 0, preview: "" };
  return {
    version: CHECKER_VERSION,
    ok: false,
    text: null,
    counts: { hard: 1, judgment: 0 },
    byRule: { [reason]: 1 },
    hits: [hit],
    ...extra,
  };
}

/**
 * 送る候補の文字列を検査する。
 * @param {string} input 送る候補（資産の本文・要約の JSON 文字列）
 * @param {{ homeDir?: string, projects?: {id:string,terms:string[]}[], deny?: string[], allow?: string[] }} opts
 * @returns {{ version, ok, text, counts:{hard,judgment}, byRule, hits }}
 *   ok   ＝hard が 0（judgment は本人承認で解決する＝ok でも見せる）
 *   text ＝送るならこの文字列（パスと PJ 名を置換済み）。ok=false のときは null
 */
export function checkText(input, opts = {}) {
  if (typeof input !== "string") return failClosed("checker-not-text");
  if (input.length > MAX_INPUT_CHARS) return failClosed("checker-too-large");

  const text = replaceProjectNames(normalizeHomePaths(input, opts.homeDir), opts.projects);
  // PJ の印の中（project_id）は検査しない＝id に顧客名の語が入っていても judgment にしない
  const scan = text.normalize("NFKC").replace(/〔PJ:[^〕\n]*〕/g, "〔PJ〕");

  const allow = [...DEFAULT_ALLOW, ...(opts.allow ?? [])].map((s) => String(s).normalize("NFKC").toLowerCase()).filter(Boolean);
  const hits = [];
  const byRule = {};
  for (const rule of RULES) {
    let found;
    try {
      found = rule.find(scan, opts);
    } catch {
      found = null;
    }
    if (found === null || !Array.isArray(found)) {
      hits.push({ rule: "checker-rule-error", category: "検査器", severity: "hard", line: 0, preview: rule.id });
      byRule["checker-rule-error"] = (byRule["checker-rule-error"] ?? 0) + 1;
      continue;
    }
    const seen = new Set();
    for (const h of found) {
      const key = `${h.index}:${h.value.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (rule.severity === "judgment" && allow.some((a) => h.value.toLowerCase().includes(a))) continue;
      hits.push({ rule: rule.id, category: rule.category, severity: rule.severity, line: lineAt(scan, h.index), preview: preview(rule, h.value) });
      byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
    }
  }
  const hard = hits.filter((h) => h.severity === "hard").length;
  const judgment = hits.length - hard;
  return { version: CHECKER_VERSION, ok: hard === 0, text: hard === 0 ? text : null, counts: { hard, judgment }, byRule, hits };
}

/** error.log・状態ファイルに書く形。規則と件数だけ（値・行の中身は書かない）。 */
export function formatCounts(result) {
  const parts = Object.entries(result.byRule)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, n]) => `${id}:${n}`);
  return `${result.version} hard=${result.counts.hard} judgment=${result.counts.judgment}${parts.length ? " " + parts.join(" ") : ""}`;
}

// ── CLI（手元の確認用・送らない） ───────────────────────────────────────────────
// node packages/plugin/hooks/leak-check.mjs <file>...  → ファイルごとに formatCounts の形だけを出す（値は出さない）

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { readFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const home = homedir();
  let blocked = 0;
  for (const f of process.argv.slice(2)) {
    let r;
    try {
      r = checkText(readFileSync(f, "utf8"), { homeDir: home });
    } catch {
      r = failClosed("checker-read-error");
    }
    if (!r.ok) blocked++;
    const shown = f.startsWith(home) ? "~" + f.slice(home.length) : f;
    process.stdout.write(`${r.ok ? "ok   " : "BLOCK"} ${shown}  ${formatCounts(r)}\n`);
  }
  process.exitCode = blocked > 0 ? 1 : 0;
}
