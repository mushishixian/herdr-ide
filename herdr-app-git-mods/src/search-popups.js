import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, writeTextFile,
  theme, settings, props, closeOverlay, notify, checking, window as win,
  run, shared, setShared, agents, terminals, appHome,
} from "herdr";

function subseqMatch(lowerText, lowerQ) {
  let qi = 0;
  for (let ti = 0; ti < lowerText.length && qi < lowerQ.length; ti++) {
    if (lowerText[ti] === lowerQ[qi]) qi++;
  }
  return qi === lowerQ.length;
}

const NOT_SYMBOL_NAMES = new Set([
  "if", "else", "for", "foreach", "while", "switch", "catch", "return",
  "do", "try", "new", "await", "sizeof", "typeof", "function", "case", "match",
]);

const SYMBOL_LANGUAGES = [
  {
    exts: ["rs"],
    rules: [
      { kind: "fn", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/ },
      { kind: "str", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
      { kind: "enm", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
      { kind: "trt", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/ },
      { kind: "mod", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/ },
      { kind: "typ", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/ },
      { kind: "cst", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/ },
      { kind: "mac", re: /^\s*macro_rules!\s*([A-Za-z_]\w*)/ },
    ],
  },
  {
    exts: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
    rules: [
      { kind: "cls", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
      { kind: "ifc", re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
      { kind: "enm", re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
      { kind: "typ", re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/ },
      { kind: "fn", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
      { kind: "fn", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/ },
      { kind: "fn", re: /^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::[^{;]+)?\{/ },
      { kind: "var", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
    ],
  },
  {
    exts: ["py", "pyi"],
    rules: [
      { kind: "fn", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
      { kind: "cls", re: /^\s*class\s+([A-Za-z_]\w*)/ },
    ],
  },
  {
    exts: ["go"],
    rules: [
      { kind: "fn", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
      { kind: "typ", re: /^\s*type\s+([A-Za-z_]\w*)/ },
      { kind: "var", re: /^\s*(?:var|const)\s+([A-Za-z_]\w*)/ },
    ],
  },
  {
    exts: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm"],
    rules: [
      { kind: "str", re: /^\s*(?:typedef\s+)?(?:struct|class|union|namespace|enum)\s+([A-Za-z_]\w*)/ },
      { kind: "fn", re: /^\s*(?:template\s*<[^>]*>\s*)?(?:[\w:]+[\s*&]+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/ },
    ],
  },
  {
    exts: ["java", "cs", "scala", "kt", "kts", "groovy"],
    rules: [
      { kind: "cls", re: /^\s*(?:@\w+\s+)*(?:(?:public|private|protected|internal|static|final|abstract|open|sealed|data|partial|async)\s+)*(?:class|interface|enum|record|struct|object|trait)\s+([A-Za-z_]\w*)/ },
      { kind: "fn", re: /^\s*(?:@\w+\s+)*(?:(?:public|private|protected|internal|override|suspend|inline|open|operator|static|final|abstract|virtual|async|synchronized|native)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/ },
      { kind: "fn", re: /^\s*(?:@\w+\s+)*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws[^{]*)?\{/ },
    ],
  },
  {
    exts: ["rb"],
    rules: [
      { kind: "fn", re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/ },
      { kind: "cls", re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/ },
    ],
  },
  {
    exts: ["php"],
    rules: [
      { kind: "cls", re: /^\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/ },
      { kind: "fn", re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/ },
    ],
  },
  {
    exts: ["sh", "bash", "zsh"],
    rules: [
      { kind: "fn", re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/ },
    ],
  },
  {
    exts: ["lua"],
    rules: [
      { kind: "fn", re: /^\s*(?:local\s+)?function\s+([\w.:]+)/ },
    ],
  },
  {
    exts: ["zig"],
    rules: [
      { kind: "fn", re: /^\s*(?:pub\s+)?(?:export\s+)?(?:inline\s+)?fn\s+([A-Za-z_]\w*)/ },
      { kind: "typ", re: /^\s*(?:pub\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:packed\s+)?(?:struct|union|enum|opaque)\b/ },
    ],
  },
  {
    exts: ["swift"],
    rules: [
      { kind: "fn", re: /^\s*(?:@\w+\s+)*(?:(?:public|private|internal|fileprivate|open|static|class|final|override|mutating)\s+)*func\s+([A-Za-z_]\w*)/ },
      { kind: "cls", re: /^\s*(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/ },
    ],
  },
  {
    exts: ["dart"],
    rules: [
      { kind: "cls", re: /^\s*(?:abstract\s+|sealed\s+|base\s+|final\s+)*(?:class|mixin|enum|extension|typedef)\s+([A-Za-z_]\w*)/ },
      { kind: "fn", re: /^\s*(?:static\s+)?[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:async\s*)?\{/ },
    ],
  },
  {
    exts: ["ex", "exs"],
    rules: [
      { kind: "fn", re: /^\s*def(?:p|module|macro|struct|impl|delegate|exception)?\s+([A-Za-z_]\w*[?!]?)/ },
    ],
  },
  {
    exts: ["hs", "lhs"],
    rules: [
      { kind: "fn", re: /^([a-z_]\w*)\s*::/ },
      { kind: "typ", re: /^\s*(?:data|newtype|type|class)\s+(?:[A-Za-z_]+\s+)*([A-Z]\w*)/ },
    ],
  },
  {
    exts: ["md", "markdown"],
    rules: [
      { kind: "h", re: /^#{1,6}\s+([^#\s].*?)\s*#*\s*$/ },
    ],
  },
];

const EXT_SYMBOL_RULES = new Map();
for (const lang of SYMBOL_LANGUAGES) {
  for (const ext of lang.exts) EXT_SYMBOL_RULES.set(ext, lang.rules);
}

export default class SearchPopup extends View {
  init(p, cx) {
    this.mode = p?.mode || "files";
    this.query = typeof p?.query === "string" ? p.query : "";
    this.replaceText = typeof p?.replace === "string" ? p.replace : "";
    this.caseSensitive = false;
    this.wholeWord = false;
    this.useRegex = false;
    this.at = 0;
    this.scroll = 0;
    this.items = [];
    this.symbols = [];
    this.filtered = [];
    this.loading = true;
    this.error = null;
    this.previewPath = null;
    this.previewRaw = "";
    this.code = null;
    this.handle = cx.focus_handle();

    this.input = InputState.new({ placeholder: this.placeholder() });
    if (this.query) this.input.set_value?.(this.query);
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.at = 0;
      this.scroll = 0;
      if (this.mode === "search" || this.mode === "replace") {
        this.scheduleSearch(cx);
      } else {
        this.updateFiltered();
        this.loadPreviewForCurrent(cx);
        cx.notify();
      }
    });
    this.input.on("submit", (_e, cx) => {
      if (this.mode === "search" || this.mode === "replace") {
        if (this.filtered.length && this.lastSearched === this.query) {
          this.openCurrentInCenter(cx);
        } else {
          this.runContentSearch(cx);
        }
      } else {
        this.openCurrentInCenter(cx);
      }
    });

    this.replaceInput = InputState.new({ placeholder: "Replace with…" });
    this.replaceInput.on("change", (_e, cx) => {
      this.replaceText = this.replaceInput.value();
      cx.notify();
    });

    this.input.focus();
    cx.timer.after(120, () => this.input.focus());

    if (checking()) {
      this.loading = false;
      return;
    }
    this.initContext(cx);
  }

  placeholder() {
    if (this.mode === "search") return "Search text in workspace…";
    if (this.mode === "replace") return "Search text to replace…";
    if (this.mode === "symbols") return "Go to symbol…";
    return "Quick open file…";
  }

  close() {
    this.code?.release();
    closeOverlay(props().overlay);
  }

  openCurrentInCenter(cx) {
    const cur = this.filtered[this.at];
    if (!cur?.path || !this.root) return;
    openInCenterEditor({ file: cur.path, root: this.root, on: this.on, line: cur.line ?? 1 }, cx);
    this.close();
  }

  updateFiltered() {
    if (this.mode === "search" || this.mode === "replace") {
      this.filtered = this.items;
      return;
    }
    const q = this.query.trim().toLowerCase();
    const CAP = 150;
    if (this.mode === "symbols") {
      if (!q) {
        this.filtered = this.symbols.slice(0, CAP);
        return;
      }
      const exact = [];
      for (let i = 0; i < this.symbols.length && exact.length < CAP; i++) {
        const s = this.symbols[i];
        if (s.nameLower.includes(q) || s.pathLower.includes(q)) exact.push(s);
      }
      if (exact.length < CAP) {
        const maxScan = Math.min(this.symbols.length, 4000);
        for (let i = 0; i < maxScan && exact.length < CAP; i++) {
          const s = this.symbols[i];
          if (!s.nameLower.includes(q) && !s.pathLower.includes(q) && subseqMatch(s.nameLower, q)) {
            exact.push(s);
          }
        }
      }
      this.filtered = exact;
      return;
    }

    if (!q) {
      this.filtered = this.items.slice(0, CAP);
      return;
    }
    const exact = [];
    for (let i = 0; i < this.items.length && exact.length < CAP; i++) {
      const it = this.items[i];
      if (it.pathLower.includes(q)) exact.push(it);
    }
    if (exact.length < CAP) {
      const maxScan = Math.min(this.items.length, 3000);
      for (let i = 0; i < maxScan && exact.length < CAP; i++) {
        const it = this.items[i];
        if (!it.pathLower.includes(q) && subseqMatch(it.pathLower, q)) {
          exact.push(it);
        }
      }
    }
    this.filtered = exact;
  }

  initContext(cx) {
    const { cwd, on } = getContext();
    this.on = on;
    if (!cwd) {
      this.loading = false;
      this.error = "No active folder.";
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      this.root = top?.code === 0 ? top.stdout.trim() : cwd;
      if (this.mode === "files") await this.loadFiles(cx);
      else if (this.mode === "symbols") await this.loadSymbols(cx);
      else {
        this.loading = false;
        if (this.query.trim()) this.runContentSearch(cx);
        else cx.notify();
      }
    });
  }

  async loadFiles(cx) {
    this.loading = true;
    cx.notify();
    try {
      let r = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: this.root, on: this.on }).catch(() => null);
      if (!r || r.code !== 0) {
        r = await execRg(["--files"], this.root, this.on);
      }
      const list = (r?.stdout ?? "")
        .split("\n")
        .map((s) => s.replace(/\r$/, "").trim())
        .filter((s) => s && !s.endsWith("/.DS_Store") && s !== ".DS_Store")
        .slice(0, 5000);
      this.items = list.map((path) => ({ path, pathLower: path.toLowerCase() }));
      this.updateFiltered();
      this.loading = false;
      this.loadPreviewForCurrent(cx);
      cx.notify();
    } catch (e) {
      this.loading = false;
      this.error = String(e?.message ?? e);
      cx.notify();
    }
  }

  async loadSymbols(cx) {
    this.loading = true;
    cx.notify();
    try {
      const args = [
        "--line-number", "--no-heading", "--color", "never",
        "--max-filesize", "256K", "--max-columns", "240", "--max-count", "80",
        "-g", "!vendor/**", "-g", "!node_modules/**", "-g", "!storage/**",
        "-g", "!public/**", "-g", "!dist/**", "-g", "!build/**", "-g", "!target/**",
        "-g", "!*.min.js", "-g", "!*.min.css",
        "-e", "(fn|function|func|fun|def|defp|defmodule|class|struct|enum|trait|interface|type|mod|macro_rules!|const|let|var|static|protocol|extension|actor|mixin|typedef|data|newtype)\\b",
        "-e", "^#{1,6}\\s+",
        "-e", "^[A-Za-z_][\\w-]*\\s*\\(\\)\\s*\\{",
        "-e", "^[a-z_]\\w*\\s*::",
        "-e", "\\)\\s*(const\\s*)?(noexcept\\s*)?(throws[^{]*)?(async\\s*)?\\{",
        ".",
      ];
      let r = await execRg(args, this.root, this.on);
      if (!r) {
        r = await exec("git", ["grep", "-n", "-E", "(function|class|interface|trait|enum|struct|fn |def |func |const |let |type |^#+)", "--", ":!vendor", ":!node_modules", ":!public", ":!*.min.js"], { cwd: this.root, on: this.on }).catch(() => null);
      }
      const syms = [];
      for (const rawLine of (r?.stdout ?? "").split("\n")) {
        if (!rawLine || syms.length >= 5000) break;
        const line = rawLine.replace(/\r$/, "");
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const file = m[1].replace(/^\.\//, "").replace(/\\/g, "/");
        const lineNum = Number(m[2]);
        const text = m[3];
        const ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "";
        const rules = EXT_SYMBOL_RULES.get(ext);
        if (!rules) continue;
        for (const rule of rules) {
          const sm = rule.re.exec(text);
          if (sm) {
            const name = sm[1].trim();
            if (name && !NOT_SYMBOL_NAMES.has(name)) {
              syms.push({
                name,
                nameLower: name.toLowerCase(),
                kind: rule.kind,
                path: file,
                pathLower: file.toLowerCase(),
                line: lineNum,
              });
            }
            break;
          }
        }
      }
      this.symbols = syms;
      this.updateFiltered();
      this.loading = false;
      this.loadPreviewForCurrent(cx);
      cx.notify();
    } catch (e) {
      this.loading = false;
      this.error = `Symbol search failed: ${e?.message ?? e}`;
      cx.notify();
    }
  }

  scheduleSearch(cx) {
    const token = (this.searchToken = (this.searchToken ?? 0) + 1);
    cx.timer.after(200, (cx2) => {
      if (this.searchToken === token) this.runContentSearch(cx2);
    });
  }

  runContentSearch(cx) {
    const q = this.query;
    this.lastSearched = q;
    if (!q.trim() || !this.root) {
      this.items = [];
      this.filtered = [];
      this.error = null;
      cx.notify();
      return;
    }
    this.loading = true;
    this.error = null;
    cx.notify();
    const token = (this.activeSearch = (this.activeSearch ?? 0) + 1);
    cx.spawn(async (cx) => {
      try {
        const args = [
          "--line-number", "--column", "--no-heading", "--color", "never",
          "--max-filesize", "512K", "--max-columns", "240", "--max-count", "80",
          "-g", "!vendor/**", "-g", "!node_modules/**", "-g", "!storage/**",
          "-g", "!public/**", "-g", "!dist/**", "-g", "!build/**", "-g", "!*.min.js",
        ];
        if (!this.caseSensitive) args.push("-i");
        if (this.wholeWord) args.push("-w");
        if (!this.useRegex) args.push("-F");
        args.push("--", q, ".");
        let r = await execRg(args, this.root, this.on);
        if (!r) {
          const gArgs = ["grep", "-n", "--column"];
          if (!this.caseSensitive) gArgs.push("-i");
          if (this.wholeWord) gArgs.push("-w");
          if (!this.useRegex) gArgs.push("-F");
          gArgs.push("--", q);
          r = await exec("git", gArgs, { cwd: this.root, on: this.on }).catch(() => null);
        }
        if (this.activeSearch !== token) return;
        if (r && r.code > 1) {
          this.error = (r.stderr || r.stdout || "Search error").trim();
        }
        const matches = [];
        for (const rawLine of (r?.stdout ?? "").split("\n")) {
          if (!rawLine || matches.length >= 300) break;
          const line = rawLine.replace(/\r$/, "");
          const m = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
          if (!m) continue;
          matches.push({
            path: m[1].replace(/^\.\//, "").replace(/\\/g, "/"),
            line: Number(m[2]),
            col: Number(m[3]),
            text: m[4].trim(),
          });
        }
        this.items = matches;
        this.filtered = matches;
        this.loading = false;
        this.loadPreviewForCurrent(cx);
        cx.notify();
      } catch (e) {
        if (this.activeSearch !== token) return;
        this.loading = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  loadPreviewForCurrent(cx) {
    const cur = this.filtered[this.at];
    if (!cur?.path || !this.root) return;
    if (this.previewPath === cur.path && !cur.line) return;
    const targetPath = cur.path;
    const targetLine = cur.line ?? 1;
    this.previewPath = targetPath;
    cx.spawn(async (cx) => {
      try {
        const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
        const text = await readTextFile(`${this.root}${sep}${targetPath}`, { on: this.on });
        if (this.previewPath !== targetPath) return;
        this.code?.release();
        if (text === null || text.includes("\0")) {
          this.code = null;
          this.previewRaw = "";
          cx.notify();
          return;
        }
        this.previewRaw = text;
        const t = theme();
        const ext = targetPath.includes(".") ? targetPath.split(".").pop() : "txt";
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value: text.length > 300000 ? text.slice(0, 300000) : text,
          font_family: settings().font_family,
          font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
        });
        if (targetLine > 1 && this.code.set_cursor) {
          this.code.set_cursor({ line: targetLine - 1, column: 0 });
        }
        cx.notify();
      } catch {}
    });
  }

  runReplaceAll(cx) {
    if (!this.query || !this.items.length) return;
    const files = [...new Set(this.items.map((m) => m.path))];
    const q = this.query;
    const rep = this.replaceText;
    const flags = this.caseSensitive ? "g" : "gi";
    let pattern;
    try {
      const src = this.useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(this.wholeWord ? `\\b${src}\\b` : src, flags);
    } catch (e) {
      this.error = `Invalid pattern: ${e?.message ?? e}`;
      cx.notify();
      return;
    }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let count = 0;
      const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
      for (const path of files) {
        const abs = `${this.root}${sep}${path}`;
        const raw = await readTextFile(abs, { on: this.on });
        if (!raw) continue;
        const next = raw.replace(pattern, rep);
        if (next !== raw) {
          await saveText(abs, next, raw, this.on);
          count++;
        }
      }
      this.loading = false;
      notify({ title: "Replace All", body: `Updated ${count} file(s)`, level: "success" });
      this.runContentSearch(cx);
    });
  }

  render() {
    const t = theme();
    const iconTheme = getIdeSettings().iconTheme;
    const rows = this.filtered;
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);

    const toggleBtn = (id, label, active, onClick) =>
      div()
        .id(id)
        .px(7)
        .py(3)
        .rounded(5)
        .text_size(11)
        .cursor_pointer()
        .when(active, (el) => el.bg(t.accent).text_color("#ffffff").font_semibold())
        .when(!active, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(onClick)
        .child(label);

    const H = 32;
    const height = 448;
    const total = rows.length * H;
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    if (rows.length > 0) {
      const top = this.at * H;
      if (top < this.scroll) this.scroll = top;
      if (top + H > this.scroll + height) this.scroll = top + H - height;
    }

    return v_flex()
      .id("search-popup")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "enter" && rows.length) {
          if (this.mode === "search" || this.mode === "replace") {
            if (this.filtered.length && this.lastSearched === this.query) {
              this.openCurrentInCenter(cx);
            } else {
              this.runContentSearch(cx);
            }
          } else {
            this.openCurrentInCenter(cx);
          }
          cx.stop_propagation();
          return;
        }
        if (k === "down" && rows.length) {
          this.at = (this.at + 1) % rows.length;
          this.loadPreviewForCurrent(cx);
          cx.stop_propagation();
          cx.notify();
        } else if (k === "up" && rows.length) {
          this.at = (this.at + rows.length - 1) % rows.length;
          this.loadPreviewForCurrent(cx);
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            h_flex()
              .flex_1()
              .h(34)
              .px(10)
              .gap(8)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(t.accent)
              .bg(t.background)
              .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
              .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
          )
          .when(this.mode === "search" || this.mode === "replace", (el) =>
            el
              .child(toggleBtn("sp-case", "Aa", this.caseSensitive, (_e, cx) => { this.caseSensitive = !this.caseSensitive; this.runContentSearch(cx); }))
              .child(toggleBtn("sp-word", "ab", this.wholeWord, (_e, cx) => { this.wholeWord = !this.wholeWord; this.runContentSearch(cx); }))
              .child(toggleBtn("sp-regex", ".*", this.useRegex, (_e, cx) => { this.useRegex = !this.useRegex; this.runContentSearch(cx); })),
          )
          .when(Boolean(this.on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(this.on)),
          )
          .child(toggleBtn("sp-esc", "Esc", false, () => this.close())),
      )
      .when(this.mode === "replace", (el) =>
        el.child(
          h_flex()
            .gap(8)
            .items_center()
            .child(
              h_flex()
                .flex_1()
                .h(32)
                .px(10)
                .items_center()
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .child(Input.new(this.replaceInput).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
            )
            .child(toggleBtn("sp-replace-all", "Replace All", true, (_e, cx) => this.runReplaceAll(cx))),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(
        h_flex()
          .h(460)
          .min_h(0)
          .gap(10)
          .child(
            v_flex()
              .w(340)
              .flex_none()
              .h_full()
              .min_h(0)
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .p(4)
              .child(
                v_flex()
                  .id("sp-list")
                  .h(448)
                  .min_h(0)
                  .when(fixed, (el) =>
                    el.overflow_hidden().on_scroll_wheel((e, cx) => {
                      this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
                      cx.notify();
                    }),
                  )
                  .children(
                    rows.map((r, i) => {
                      if (fixed && (i * H + H <= this.scroll || i * H >= this.scroll + height)) return null;
                      const on = i === this.at;
                      const base = h_flex()
                        .id(`sp-row-${i}`)
                        .px(8)
                        .h(H)
                        .gap(6)
                        .items_center()
                        .rounded(6)
                        .cursor_pointer()
                        .when(on, (el) => el.bg(t.selected))
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => {
                          if (this.at === i) {
                            this.openCurrentInCenter(cx);
                          } else {
                            this.at = i;
                            this.loadPreviewForCurrent(cx);
                            cx.notify();
                          }
                        });
                      const placed = fixed
                        ? base.absolute().left(0).right(0).top(i * H - this.scroll).bottom(height - (i * H + H - this.scroll))
                        : base;
                      if (this.mode === "symbols") {
                        return placed
                          .child(div().px(4).py(1).rounded(3).bg(t.raised).text_size(10).text_color(t.accent).child(r.kind))
                          .child(div().flex_1().truncate().text_color(t.foreground).child(r.name))
                          .child(div().max_w(130).truncate().text_size(11).text_color(t.dim).child(`${r.path}:${r.line}`));
                      }
                      if (this.mode === "search" || this.mode === "replace") {
                        return placed
                          .child(div().max_w(130).truncate().text_size(11).text_color(t.accent).child(`${r.path}:${r.line}`))
                          .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(r.text));
                      }
                      const name = r.path.split("/").pop();
                      return placed
                        .child(renderFileIcon(div, svg, name, false, false, iconTheme, t))
                        .child(div().flex_1().truncate().text_color(t.foreground).child(r.path));
                    }).filter(Boolean),
                  )
                  .when(!rows.length && this.loading, (el) =>
                    el.child(div().p(12).text_size(12).text_color(t.dim).child(this.mode === "symbols" ? "Indexing symbols…" : "Searching…")),
                  )
                  .when(!rows.length && !this.loading, (el) =>
                    el.child(div().p(12).text_size(12).text_color(t.dim).child(this.mode === "search" && !this.query.trim() ? "Type to search across repository…" : "No matches")),
                  ),
              ),
          )
          .child(
            v_flex()
              .flex_1()
              .h_full()
              .min_w(0)
              .min_h(0)
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .overflow_hidden()
              .child(
                h_flex()
                  .h(32)
                  .flex_none()
                  .px(10)
                  .gap(8)
                  .items_center()
                  .bg(t.chrome)
                  .border_b(1)
                  .border_color(t.border)
                  .child(div().flex_1().truncate().text_size(11.5).text_color(t.muted).child(this.previewPath || "Preview"))
                  .when(Boolean(this.previewPath), (el) =>
                    el.child(toggleBtn("sp-open-center", "Open in Editor (Enter)", true, (_e, cx) => this.openCurrentInCenter(cx))),
                  ),
              )
              .child(
                this.code
                  ? Editor.new(this.code).flex_1().min_h(0)
                  : div().p(16).text_color(t.dim).child(this.loading ? "Loading…" : "Select an item to preview"),
              ),
          ),
      );
  }
}
