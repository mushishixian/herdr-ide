import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import {
  exec, readTextFile, writeTextFile, theme, settings, props,
  shared, setShared, notify, checking, window as win, run,
} from "herdr";

export default class IdeEditor extends View {
  init(p, cx) {
    this.tabs = []; // [{ key, kind: "file"|"diff", title, file, staged, untracked, ref, isStash, root, on, raw, dirty, diffLines, diffWidth, diffStats }]
    this.activeKey = null;
    this.editing = true;
    this.code = null;
    this.error = null;
    this.loadingDiff = false;
    this.lastSeq = 0;
    this.handle = cx.focus_handle();

    if (checking()) return;

    const req = shared("ide.editor.open");
    const initReq = req?.root && (req?.file || req?.ref) ? req : p;
    if (req?.seq) this.lastSeq = req.seq;
    if (initReq?.root && (initReq?.file || initReq?.ref)) {
      this.openRequest(initReq, cx);
    }
    cx.timer.every(80, (cx2) => this.pollOpenRequest(cx2));
  }

  pollOpenRequest(cx) {
    const req = shared("ide.editor.open");
    if (req?.seq && req.seq !== this.lastSeq && req.root && (req.file || req.ref)) {
      this.lastSeq = req.seq;
      this.openRequest(req, cx);
    }
  }

  tabKey(req) {
    if (req.kind === "diff") {
      return `diff:${req.on ?? "local"}:${req.root}:${req.ref || (req.untracked ? "Q" : req.staged ? "S" : "U")}:${req.file || ""}`;
    }
    return `file:${req.on ?? "local"}:${req.root}/${req.file}`;
  }

  openRequest(req, cx) {
    const kind = req.kind === "diff" ? "diff" : "file";
    const key = this.tabKey({ ...req, kind });
    let tab = this.tabs.find((t) => t.key === key);
    if (!tab) {
      tab = {
        key,
        kind,
        title: req.title || (kind === "diff" ? `Diff: ${(req.file || req.ref || "").split("/").pop()}` : (req.file || "").split("/").pop()),
        file: req.file ?? null,
        staged: Boolean(req.staged),
        untracked: Boolean(req.untracked),
        ref: req.ref ?? null,
        isStash: Boolean(req.isStash),
        root: req.root,
        on: req.on ?? null,
        raw: "",
        dirty: false,
        line: req.line ?? 1,
        diffLines: [],
        diffWidth: 400,
        diffStats: { add: 0, del: 0 },
      };
      this.tabs.push(tab);
    } else if (req.line) {
      tab.line = req.line;
    }
    this.activeKey = key;
    this.error = null;
    this.loadTab(tab, cx);
  }

  loadTab(tab, cx) {
    if (tab.kind === "diff") return this.loadDiffTab(tab, cx);
    const sep = !tab.on && win()?.platform === "windows" ? "\\" : "/";
    const abs = `${tab.root}${sep}${tab.file}`;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(abs, { on: tab.on });
        if (this.activeKey !== tab.key) return;
        this.code?.release();
        if (text === null) {
          this.code = null;
          this.error = `File not found: ${tab.file}`;
          cx.notify();
          return;
        }
        if (text.includes("\0")) {
          this.code = null;
          this.error = `Binary file · no text editor (${tab.file})`;
          cx.notify();
          return;
        }
        tab.raw = text;
        tab.dirty = false;
        const t = theme();
        const ext = tab.file.includes(".") ? tab.file.split(".").pop() : "txt";
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: !this.editing,
          value: text.length > 400000 ? text.slice(0, 400000) : text,
          font_family: settings().font_family,
          font_size: 12.5,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
        });
        this.code.on?.("change", () => {
          if (this.code && tab.key === this.activeKey) {
            tab.dirty = this.code.value() !== tab.raw;
          }
        });
        if (tab.line > 1 && this.code.set_cursor) {
          this.code.set_cursor({ line: tab.line - 1, column: 0 });
        }
        this.error = null;
        cx.notify();
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  loadDiffTab(tab, cx) {
    this.code?.release();
    this.code = null;
    this.error = null;
    this.loadingDiff = true;
    cx.notify();
    const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
    cx.spawn(async (cx) => {
      try {
        let rawLines = [];
        if (tab.ref) {
          const args = tab.isStash
            ? ["stash", "show", "-p", "--no-color", tab.ref]
            : ["show", "--no-color", tab.ref];
          const r = await exec("git", [...READ, ...args], { cwd: tab.root, on: tab.on });
          if (r.code !== 0 && r.stderr) throw new Error(r.stderr.trim());
          rawLines = (r.stdout ?? "").split("\n").slice(0, 4000);
        } else if (tab.untracked && tab.file) {
          const sep = !tab.on && win()?.platform === "windows" ? "\\" : "/";
          const text = await readTextFile(`${tab.root}${sep}${tab.file}`, { on: tab.on });
          if (text === null) throw new Error(`File not found: ${tab.file}`);
          if (text.includes("\0")) {
            rawLines = ["Binary file (untracked)"];
          } else {
            const fileLines = text.split("\n");
            rawLines = [`@@ -0,0 +1,${fileLines.length} @@ ${tab.file} (untracked)`];
            for (const l of fileLines.slice(0, 4000)) rawLines.push(`+${l}`);
          }
        } else if (tab.file) {
          const args = tab.staged
            ? ["diff", "--cached", "--no-color", "--", tab.file]
            : ["diff", "--no-color", "--", tab.file];
          const r = await exec("git", [...READ, ...args], { cwd: tab.root, on: tab.on });
          if (r.code !== 0 && r.stderr) throw new Error(r.stderr.trim());
          rawLines = (r.stdout ?? "").split("\n").slice(0, 4000);
          if (!rawLines.some(Boolean)) {
            const altArgs = tab.staged
              ? ["diff", "--no-color", "--", tab.file]
              : ["diff", "--cached", "--no-color", "--", tab.file];
            const r2 = await exec("git", [...READ, ...altArgs], { cwd: tab.root, on: tab.on });
            if ((r2.stdout ?? "").trim()) rawLines = r2.stdout.split("\n").slice(0, 4000);
          }
        }
        if (this.activeKey !== tab.key) return;
        const cleanLines = rawLines.map((l) => l.replace(/\r$/, ""));
        const rows = diffRows(cleanLines);
        let add = 0, del = 0;
        for (const r of rows) {
          if (r.kind === "+") add++;
          else if (r.kind === "-") del++;
        }
        tab.diffLines = rows;
        tab.diffStats = { add, del };
        tab.diffWidth = Math.max(400, ...rows.map((row) => (row.text.length + 1) * 7.5 + 56));
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loadingDiff = false;
        cx.notify();
      }
    });
  }

  closeTab(key, cx) {
    const idx = this.tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    if (this.tabs.length === 0) {
      this.code?.release();
      this.code = null;
      this.activeKey = null;
      run("pane.close");
      return;
    }
    if (this.activeKey === key) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeKey = next.key;
      this.loadTab(next, cx);
    } else {
      cx.notify();
    }
  }

  saveActive(cx) {
    const tab = this.tabs.find((t) => t.key === this.activeKey);
    if (!tab || !this.code || !this.editing) return;
    const next = this.code.value();
    const sep = !tab.on && win()?.platform === "windows" ? "\\" : "/";
    const abs = `${tab.root}${sep}${tab.file}`;
    cx.spawn(async (cx) => {
      try {
        await saveText(abs, next, tab.raw, tab.on);
        tab.raw = next;
        tab.dirty = false;
        notify({ title: "Saved", body: tab.file, level: "success" });
        cx.notify();
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  toggleMode(cx) {
    this.editing = !this.editing;
    const tab = this.tabs.find((t) => t.key === this.activeKey);
    if (tab) this.loadTab(tab, cx);
    else cx.notify();
  }

  openLineHistory(cx) {
    const now = Date.now();
    if (this._lastHistoryAt && now - this._lastHistoryAt < 800) return; // guard a double key-down
    this._lastHistoryAt = now;
    const tab = this.tabs.find((tb) => tb.key === this.activeKey);
    if (!tab || !tab.file || tab.kind !== "file" || !this.code) return;
    const range = this.code.selected_range?.();
    const text = this.code.value();
    if (!range) return;
    const lineAt = (off) => text.slice(0, Math.max(0, Math.min(off, text.length))).split("\n").length;
    let start = lineAt(range.start);
    let end = lineAt(range.end);
    // A selection ending at column 0 of the next line excludes that line.
    if (range.end > range.start && range.end <= text.length && text[range.end - 1] === "\n") end -= 1;
    if (end < start) [start, end] = [end, start];
    if (start < 1) start = 1;
    if (end < start) end = start;
    // The popup reads this shared request (mod.json places it top-centre);
    // while it is already open a new seq refreshes it in place.
    setShared("ide.glh.request", {
      root: tab.root,
      file: tab.file,
      on: tab.on ?? null,
      start,
      end,
      title: tab.title || tab.file.split("/").pop(),
      seq: (shared("ide.glh.request")?.seq ?? 0) + 1,
    });
    if (!shared("ide.glh.open")) run("mod.open", { name: "git-line-history" });
  }

  render(cx) {
    const t = theme();
    const active = this.tabs.find((tb) => tb.key === this.activeKey);
    const isDiff = active?.kind === "diff";

    const btn = (id, label, accent, onClick) =>
      div()
        .id(id)
        .px(8)
        .py(3)
        .rounded(5)
        .text_size(11.5)
        .cursor_pointer()
        .when(accent, (el) => el.bg(t.accent).text_color("#ffffff").font_semibold())
        .when(!accent, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(onClick)
        .child(label);

    return v_flex()
      .id("ide-editor-pane")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "s" && e.modifiers.control && !isDiff) {
          this.saveActive(cx);
          cx.stop_propagation();
        } else if (e.key === "o" && e.modifiers.control && e.modifiers.alt && !isDiff) {
          this.openLineHistory(cx);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(8)
          .gap(4)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .overflow_hidden()
              .children(
                this.tabs.map((tb, idx) => {
                  const isAct = tb.key === this.activeKey;
                  const label = tb.title || (tb.file ? tb.file.split("/").pop() : tb.ref || "Untitled");
                  return h_flex()
                    .id(`ed-tab-${idx}`)
                    .h(26)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .when(isAct, (el) => el.bg(t.background).text_color(t.foreground).font_semibold())
                    .when(!isAct, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
                    .on_click((_e, cx) => {
                      this.activeKey = tb.key;
                      this.loadTab(tb, cx);
                    })
                    .when(tb.kind === "diff", (el) => el.child(div().text_size(10.5).text_color(t.accent).child("±")))
                    .child(div().max_w(180).truncate().text_size(12).child((tb.dirty ? "● " : "") + label))
                    .child(
                      div()
                        .id(`ed-close-${idx}`)
                        .px(3)
                        .rounded(4)
                        .text_size(11)
                        .text_color(t.dim)
                        .hover((s) => s.bg(t.raised).text_color(t.foreground))
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .on_click((_e, cx) => this.closeTab(tb.key, cx))
                        .child("×"),
                    );
                }),
              ),
          )
          .when(Boolean(active?.on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(10.5).text_color(t.muted).child(active.on)),
          )
          .when(Boolean(active && isDiff), (el) =>
            el
              .when(Boolean(active.file), (el2) =>
                el2.child(btn("ed-open-src", "Edit File", true, (_e, cx) => openInCenterEditor({ file: active.file, root: active.root, on: active.on, line: 1 }, cx))),
              )
              .child(btn("ed-diff-ref", "↻ Refresh", false, (_e, cx) => this.loadDiffTab(active, cx))),
          )
          .when(Boolean(active && !isDiff), (el) =>
            el
              .child(btn("ed-mode", this.editing ? "Editing" : "Read-Only", false, (_e, cx) => this.toggleMode(cx)))
              .when(this.editing, (el2) => el2.child(btn("ed-save", "Save (Ctrl+S)", true, (_e, cx) => this.saveActive(cx)))),
          ),
      )
      .when(Boolean(active), (el) =>
        el.child(
          h_flex()
            .h(24)
            .flex_none()
            .px(10)
            .gap(8)
            .items_center()
            .bg(t.surface)
            .border_b(1)
            .border_color(t.border)
            .text_size(11)
            .text_color(t.dim)
            .child(
              div()
                .flex_1()
                .truncate()
                .child(
                  isDiff
                    ? (active.ref
                        ? `${active.isStash ? "Stash" : "Commit"} ${active.ref}`
                        : `${active.file} (${active.untracked ? "Untracked" : active.staged ? "Staged" : "Working Tree"})`)
                    : active.file + (active.line > 1 ? `:${active.line}` : ""),
                ),
            )
            .when(isDiff && Boolean(active.diffStats), (el2) =>
              el2
                .child(div().text_color(t.ansi2).child(`+${active.diffStats.add}`))
                .child(div().text_color(t.ansi1).child(`−${active.diffStats.del}`)),
            ),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().p(16).text_color(t.blocked).child(this.error)))
      .when(!this.error && isDiff, (el) =>
        this.loadingDiff
          ? el.child(div().p(20).text_color(t.dim).child("Loading git diff…"))
          : active.diffLines?.length
            ? el.child(
                div()
                  .flex_1()
                  .min_h(0)
                  .relative()
                  .font_family(settings().font_family ?? "JetBrains Mono")
                  .text_size(12)
                  .child(
                    div()
                      .id("ed-diff-x")
                      .size_full()
                      .overflow_x_scrollbar()
                      .child(
                        div()
                          .w_full()
                          .min_w(active.diffWidth)
                          .h_full()
                          .child(
                            v_virtual_list("ed-diff-list", active.diffLines.length, 20, (i) => String(i), (range) =>
                              active.diffLines.slice(range.start, range.end).map((row) =>
                                row.kind === "@"
                                  ? div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.accent).child(row.text)
                                  : h_flex()
                                      .w_full()
                                      .h(20)
                                      .flex_none()
                                      .gap(10)
                                      .when(row.kind === "+", (e) => e.bg(t.ansi2 + "18"))
                                      .when(row.kind === "-", (e) => e.bg(t.ansi1 + "18"))
                                      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(row.number === undefined ? "" : String(row.number)))
                                      .child(div().w(12).flex_none().text_color(row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.dim).child(row.kind || " "))
                                      .child(div().flex_1().min_w(0).truncate().child(row.text)),
                              ),
                            ).size_full(),
                          ),
                      ),
                  )
                  .child(Scrollbar.vertical("ed-diff-list").viewport_from_layout().absolute().inset_0()),
              )
            : el.child(div().p(20).text_color(t.dim).child("No diff hunks for this item.")),
      )
      .when(!this.error && !isDiff && Boolean(this.code), (el) => el.child(Editor.new(this.code).flex_1().min_h(0)))
      .when(!this.error && !isDiff && !this.code, (el) =>
        el.child(div().p(20).text_color(t.dim).child(active ? "Loading file…" : "Select a file from Files / Ctrl+Q to open here.")),
      );
  }
}
