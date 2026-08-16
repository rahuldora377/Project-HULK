/**
 * viewer.js
 * ---------------------------------------------------------------------------
 * Script viewer for inline <script> blocks found by the JS Files tab.
 *
 * Clicking an inline script in the popup opens viewer.html with the script
 * beautified (indentation + line breaks) and colorized (syntax highlighting).
 *
 * Everything here is hand-rolled and dependency-free on purpose:
 *   - one linear tokenizer pass (strings/comments protected),
 *   - a small beautifier that re-emits tokens with newlines/indentation,
 *   - a highlighter that wraps the SAME token stream in <span>s.
 * No bundled prettier/prism/highlight.js, no workers — just O(n) string work,
 * so even a 1 MiB script renders instantly with zero extra resources.
 *
 * The pure helpers are exposed on window.HulkViewer and module.exports so the
 * `node --test` suite can cover them (see tests/viewer.test.mjs).
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const STORAGE_KEY = "hulkViewer";

  /* ------------------------------------------------------------------ *
   * Tokenizer
   * ------------------------------------------------------------------ */

  /** ECMAScript reserved words + common globals worth coloring. */
  const KEYWORDS = new Set([
    "var", "let", "const", "function", "return", "if", "else", "for", "while",
    "do", "switch", "case", "default", "break", "continue", "new", "delete",
    "typeof", "instanceof", "in", "of", "this", "class", "extends", "super",
    "import", "export", "from", "try", "catch", "finally", "throw", "async",
    "await", "yield", "void", "null", "true", "false", "undefined", "static",
    "get", "set", "debugger", "with"
  ]);

  /** Multi-char operators, longest first (so `===` wins over `==`). */
  const OPS = [
    ">>>=", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??=",
    "...", "=>", "++", "--", "+=", "-=", "*=", "/=", "%=", "&&", "||",
    "??", "?.", "**", "<<", ">>", ">>>", "<=", ">=", "==", "!="
  ];

  /**
   * Split JS source into typed tokens: { t, v } where t is one of
   * "ws" | "str" | "cmt" | "num" | "word" | "op".
   * Whitespace is kept as tokens so the highlighter can re-emit formatted
   * text verbatim. Minified code (no whitespace at all) still splits into
   * granular tokens because punctuation/operators break up each run.
   * Note: template-literal `${...}` interpolation is treated as plain string
   * text (acceptable for a lightweight viewer).
   */
  function tokenize(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;

    while (i < n) {
      const c = src[i];

      if (/\s/.test(c)) {
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        tokens.push({ t: "ws", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // Strings ('...', "...", `...`) — escape-aware.
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        let j = i + 1;
        let str = c;
        while (j < n) {
          const ch = src[j];
          str += ch;
          if (ch === "\\") {
            j++;
            if (j < n) str += src[j];
            j++;
            continue;
          }
          j++;
          if (ch === quote) break;
        }
        tokens.push({ t: "str", v: str });
        i = j;
        continue;
      }

      // Line comment.
      if (c === "/" && src[i + 1] === "/") {
        let j = i + 2;
        while (j < n && src[j] !== "\n") j++;
        tokens.push({ t: "cmt", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // Block comment.
      if (c === "/" && src[i + 1] === "*") {
        let j = i + 2;
        while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j = Math.min(j + 2, n);
        tokens.push({ t: "cmt", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // Numbers (decimals, hex/octal/binary, floats — letters allowed so
      // `0xFF` and `1e5` stay intact; `1-2` splits correctly).
      if (/[0-9]/.test(c)) {
        let j = i;
        while (j < n && /[0-9a-zA-Z._]/.test(src[j])) j++;
        tokens.push({ t: "num", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // Identifiers / keywords.
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
        tokens.push({ t: "word", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // Operators / punctuation.
      let op = null;
      for (const m of OPS) {
        if (src.startsWith(m, i)) { op = m; break; }
      }
      if (op) {
        tokens.push({ t: "op", v: op });
        i += op.length;
        continue;
      }
      tokens.push({ t: "op", v: c });
      i++;
    }
    return tokens;
  }

  /* ------------------------------------------------------------------ *
   * Beautifier
   * ------------------------------------------------------------------ */

  /** Keywords that take a space before their opening paren (`if (x)`). */
  const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);

  /** Tokens that may hug a closing `}` (no line break: `} else {`). */
  const JOIN_AFTER_BRACE = new Set(["else", "catch", "finally", "while", ",", ";", ")", "]", ".", "?.", "}"]);

  /** Operators that get surrounding spaces (`a = b`). */
  const BIN_OPS = new Set([
    "=", "==", "===", "!=", "!==", "<", ">", "<=", ">=", "+", "-", "*", "/",
    "%", "&&", "||", "??", "**", "<<", ">>", ">>>", "=>", "?",
    "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&&=", "||=", "??="
  ]);

  /** A token that ends a value (so an operator before it gets a space). */
  function isValueEnd(t) {
    return t && (t.t === "word" || t.t === "num" || t.t === "str" ||
      (t.t === "op" && (t.v === ")" || t.v === "]" || t.v === "}")));
  }

  /** A token that starts a value (space goes AFTER the operator). */
  function isValueStart(t) {
    return t && (t.t === "word" || t.t === "num" || t.t === "str" ||
      (t.t === "op" && (t.v === "(" || t.v === "[" || t.v === "{")));
  }

  /** Prefix operators that may follow `=`, `(`, `,`… unary minus/plus etc. */
  const UNARY_PREFIX = new Set(["-", "+", "!", "~", "++", "--"]);

  /** Keywords after which `-`/`+` is unary (`return -1`, `case -1:`). */
  const OP_KEYWORDS = new Set([
    "return", "typeof", "case", "in", "of", "delete", "void", "new",
    "yield", "throw", "await", "instanceof", "else", "do"
  ]);

  /**
   * Is `tk` used as a binary operator (spaces on both sides)?
   * `a - b` yes; `return -1` no (the minus hugs its operand).
   */
  function isBinaryOp(tk, prev) {
    return isValueEnd(prev) && !(prev.t === "word" && OP_KEYWORDS.has(prev.v));
  }

  /** Should a space be emitted AFTER this binary operator? */
  function wantsSpaceAfter(next) {
    return isValueStart(next) || (next.t === "op" && UNARY_PREFIX.has(next.v));
  }

  /**
   * Re-indent / re-wrap minified JS. Keeps strings, comments and operator
   * tokens intact — it only adds whitespace and line breaks.
   */
  function beautify(src) {
    const sig = tokenize(src).filter((t) => t.t !== "ws");
    let out = "";
    let indent = 0;
    let paren = 0;
    let sq = 0;
    let brace = 0;
    let lineHasContent = false;

    const newline = () => {
      out = out.replace(/[ \t]+$/, "");
      if (!out.endsWith("\n")) out += "\n";
      out += "  ".repeat(indent);
      lineHasContent = false;
    };

    for (let i = 0; i < sig.length; i++) {
      const tk = sig[i];
      const v = tk.v;
      const next = sig[i + 1];
      const prev = i > 0 ? sig[i - 1] : null;

      if (tk.t === "cmt") {
        if (lineHasContent) newline();
        out += v;
        newline();
        continue;
      }

      if (tk.t === "str") {
        if (lineHasContent && /[A-Za-z0-9_$)\]]$/.test(out)) out += " ";
        out += v;
        lineHasContent = true;
        continue;
      }

      if (v === "{") {
        if (lineHasContent && !/[ \t(\[]$/.test(out)) out += " ";
        out += "{";
        indent++;
        brace++;
        newline();
        continue;
      }

      if (v === "}") {
        indent = Math.max(0, indent - 1);
        brace = Math.max(0, brace - 1);
        // Drop any dangling indentation, then close the previous line
        // (even when the last statement had no trailing `;`) and indent the
        // closing brace itself.
        out = out.replace(/[ \t]+$/, "");
        if (lineHasContent || !out.endsWith("\n")) out += "\n";
        out += "  ".repeat(indent);
        out += "}";
        lineHasContent = true;
        if (next && JOIN_AFTER_BRACE.has(next.v)) {
          if (/[A-Za-z0-9_$]/.test(next.v[0])) out += " ";
        } else {
          newline();
        }
        continue;
      }

      if (v === ";") {
        out += ";";
        if (paren === 0) newline();
        else if (!(next && next.v === ")")) out += " ";
        continue;
      }

      if (v === ",") {
        out += ",";
        if (paren > 0) out += " ";
        else if (sq > 0 || brace > 0) newline();
        else out += " ";
        continue;
      }

      if (v === ":") {
        out += ":";
        if (next && isValueStart(next)) out += " ";
        lineHasContent = true;
        continue;
      }

      if (v === "(") {
        paren++;
        if (lineHasContent && prev && prev.t === "word" && CONTROL.has(prev.v) && !/[ \t]$/.test(out)) out += " ";
        out += v;
        lineHasContent = true;
        continue;
      }

      if (v === ")") { paren = Math.max(0, paren - 1); out += v; lineHasContent = true; continue; }
      if (v === "[") { sq++; out += v; lineHasContent = true; continue; }
      if (v === "]") { sq = Math.max(0, sq - 1); out += v; lineHasContent = true; continue; }

      // Generic word / num / op token.
      if (lineHasContent) {
        const last = out.slice(-1);
        if (tk.t === "op" && BIN_OPS.has(v)) {
          if (isValueEnd(prev)) out += " "; // space before a binary op
        } else if (/[A-Za-z0-9_$]/.test(last) && /[A-Za-z0-9_$]/.test(v[0])) {
          out += " "; // keep adjacent identifiers/numbers apart
        }
      }
      out += v;
      if (tk.t === "op" && BIN_OPS.has(v) && isBinaryOp(tk, prev) && next && wantsSpaceAfter(next)) {
        out += " ";
      }
      lineHasContent = true;
    }

    return out.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n");
  }

  /* ------------------------------------------------------------------ *
   * Highlighter
   * ------------------------------------------------------------------ */

  /** Escape HTML metacharacters so script text can never break the page. */
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /**
   * Colorize JS source by wrapping each token in a semantic <span>.
   * Safe: every token value is escapeHtml()'d before being embedded.
   */
  function highlight(src) {
    const tokens = tokenize(src);
    let html = "";
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.t === "ws") {
        html += escapeHtml(tk.v);
        continue;
      }
      let cls = null;
      if (tk.t === "str") cls = "tok-str";
      else if (tk.t === "cmt") cls = "tok-cmt";
      else if (tk.t === "num") cls = "tok-num";
      else if (tk.t === "word") {
        if (KEYWORDS.has(tk.v)) {
          cls = "tok-kw";
        } else {
          let k = i + 1;
          while (k < tokens.length && tokens[k].t === "ws") k++;
          if (k < tokens.length && tokens[k].v === "(") cls = "tok-fn";
        }
      }
      html += (cls ? `<span class="${cls}">` : "") + escapeHtml(tk.v) + (cls ? "</span>" : "");
    }
    return html;
  }

  /* ------------------------------------------------------------------ *
   * Page init
   * ------------------------------------------------------------------ */

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function safeHost(source) {
    if (!source) return "";
    try {
      return new URL(source).hostname || "";
    } catch (err) {
      return "";
    }
  }

  async function init() {
    const title = document.getElementById("v-title");
    const meta = document.getElementById("v-meta");
    const code = document.getElementById("v-code");

    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const payload = data && data[STORAGE_KEY];
      // Consume the payload — the key is one-shot so stale scripts don't linger.
      await chrome.storage.local.remove(STORAGE_KEY).catch(() => {});

      if (!payload || typeof payload.text !== "string" || !payload.text.trim()) {
        title.textContent = "Nothing to display";
        code.textContent = "No inline script was passed to the viewer. Re-scan the page and click an inline script again.";
        return;
      }

      const host = safeHost(payload.source);
      title.textContent = host ? "Inline script — " + host : "Inline script";
      document.title = title.textContent;

      const parts = [formatBytes(payload.text.length)];
      if (payload.truncated) parts.push("truncated to 1 MiB");
      meta.textContent = parts.join(" · ");

      // innerHTML is safe here: highlight() escapes every token.
      code.innerHTML = highlight(beautify(payload.text));
    } catch (err) {
      title.textContent = "Viewer error";
      code.textContent = (err && err.message) ? err.message : String(err);
    }
  }

  /* ------------------------------------------------------------------ *
   * Exports (window for the extension page, module for `node --test`)
   * ------------------------------------------------------------------ */

  const api = { tokenize, beautify, highlight, escapeHtml };

  if (typeof window !== "undefined" && typeof window.chrome !== "undefined") {
    window.HulkViewer = api;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
