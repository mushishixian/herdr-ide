import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import {
  spaces, panes, focused, exec, readTextFile, writeTextFile,
  theme, props, closeOverlay, notify, checking, window as win,
} from "herdr";

function parseConflicts(text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  let hunkIndex = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const currentLabel = lines[i].slice(7).trim() || "Current";
      const currentLines = [];
      const incomingLines = [];
      let inIncoming = false;
      let inBase = false;
      let incomingLabel = "Incoming";
      let end = i + 1;
      let closed = false;
      while (end < lines.length) {
        const l = lines[end];
        if (l.startsWith("|||||||")) {
          inBase = true;
        } else if (l.startsWith("=======")) {
          inBase = false;
          inIncoming = true;
        } else if (l.startsWith(">>>>>>>")) {
          incomingLabel = l.slice(7).trim() || "Incoming";
          closed = true;
          break;
        } else if (!inBase) {
          if (inIncoming) incomingLines.push(l);
          else currentLines.push(l);
        }
        end++;
      }
      if (closed) {
        blocks.push({
          kind: "conflict",
          id: hunkIndex++,
          currentLabel,
          incomingLabel,
          current: currentLines.join("\n"),
          incoming: incomingLines.join("\n"),
          raw: lines.slice(i, end + 1).join("\n"),
          choice: null, // null | "current" | "incoming" | "both"
        });
        i = end + 1;
        continue;
      }
    }
    const start = i;
    while (i < lines.length && !lines[i].startsWith("<<<<<<<")) i++;
    blocks.push({ kind: "text", text: lines.slice(start, i).join("\n") });
  }
  return blocks;
}

function resolveHunkText(b) {
  if (b.choice === "current") return b.current;
  if (b.choice === "incoming") return b.incoming;
  if (b.choice === "both") {
    if (!b.current) return b.incoming;
    if (!b.incoming) return b.current;
    return `${b.current}\n${b.incoming}`;
  }
  return b.raw;
}

export default class MergeEditor extends View {
  init(p, cx) {
    this.initialFile = p?.file || null;
    this.files = [];
    this.activeFile = null;
    this.blocks = [];
    this.hunkAt = 0;
    this.rawText = "";
    this.loading = true;
    this.busy = false;
    this.error = null;
    this.handle = cx.focus_handle();

    if (checking()) {
      this.loading = false;
      return;
    }
    this.loadConflicts(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  loadConflicts(cx) {
    const { cwd, on } = getContext();
    this.on = on;
    if (!cwd) {
      this.loading = false;
      this.error = "No active folder.";
      cx.notify();
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) {
          this.loading = false;
          this.error = "Not a git repository.";
          cx.notify();
          return;
        }
        this.root = top.stdout.trim();
        const r = await exec("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: this.root, on });
        this.files = (r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        this.loading = false;
        const pick = this.initialFile && this.files.includes(this.initialFile) ? this.initialFile : this.files[0];
        if (pick) await this.openFile(pick, cx);
        else cx.notify();
      } catch (e) {
        this.loading = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  async openFile(path, cx) {
    this.activeFile = path;
    this.error = null;
    try {
      const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
      const abs = `${this.root}${sep}${path}`;
      const text = await readTextFile(abs, { on: this.on });
      this.rawText = text ?? "";
      this.blocks = parseConflicts(this.rawText);
    } catch (e) {
      this.error = `Cannot read ${path}: ${e?.message ?? e}`;
      this.blocks = [];
    }
    cx.notify();
  }

  conflicts() {
    return this.blocks.filter((b) => b.kind === "conflict");
  }

  unresolvedCount() {
    return this.conflicts().filter((b) => b.choice === null).length;
  }

  setAll(choice, cx) {
    for (const b of this.blocks) {
      if (b.kind === "conflict") b.choice = choice;
    }
    cx.notify();
  }

  saveAndStage(cx) {
    if (!this.activeFile || this.busy) return;
    if (this.unresolvedCount() > 0) {
      this.error = `Resolve all ${this.unresolvedCount()} remaining conflict(s) first.`;
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
        const abs = `${this.root}${sep}${this.activeFile}`;
        const out = this.blocks.map((b) => (b.kind === "text" ? b.text : resolveHunkText(b))).join("\n");
        await saveText(abs, out, this.rawText, this.on);
        const add = await exec("git", ["add", "--", this.activeFile], { cwd: this.root, on: this.on });
        if (add.code !== 0) throw new Error(add.stderr || "git add failed");
        notify({ title: "Merge Editor", body: `Resolved and staged ${this.activeFile}`, level: "success" });
        this.busy = false;
        this.initialFile = null;
        this.loadConflicts(cx);
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const hunks = this.conflicts();
    const unresolved = this.unresolvedCount();

    const btn = (id, label, active, color, onClick) =>
      div()
        .id(id)
        .px(8)
        .py(3)
        .rounded(5)
        .text_size(11.5)
        .cursor_pointer()
        .when(active, (el) => el.bg(color ?? t.accent).text_color("#ffffff").font_semibold())
        .when(!active, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(onClick)
        .child(label);

    return v_flex()
      .id("merge-editor-popup")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (!hunks.length) return;
        if (this.hunkAt >= hunks.length) this.hunkAt = hunks.length - 1;
        if (k === "down" || k === "j") {
          this.hunkAt = (this.hunkAt + 1) % hunks.length;
          cx.stop_propagation();
          cx.notify();
        } else if (k === "up" || k === "k") {
          this.hunkAt = (this.hunkAt + hunks.length - 1) % hunks.length;
          cx.stop_propagation();
          cx.notify();
        } else if (k === "1") {
          hunks[this.hunkAt].choice = "current";
          cx.stop_propagation();
          cx.notify();
        } else if (k === "2") {
          hunks[this.hunkAt].choice = "incoming";
          cx.stop_propagation();
          cx.notify();
        } else if (k === "3") {
          hunks[this.hunkAt].choice = "both";
          cx.stop_propagation();
          cx.notify();
        } else if (k === "s") {
          this.saveAndStage(cx);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/workspace-chrome/git-compare.svg").size(15).text_color(t.accent))
          .child(div().font_semibold().text_size(14).text_color(t.foreground).child("3-Way Merge Editor"))
          .when(Boolean(this.on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(this.on)),
          )
          .child(div().flex_1())
          .when(Boolean(this.activeFile && hunks.length), (el) =>
            el
              .child(btn("me-all-cur", "All Current", false, t.ansi4, (_e, cx) => this.setAll("current", cx)))
              .child(btn("me-all-inc", "All Incoming", false, t.ansi2, (_e, cx) => this.setAll("incoming", cx)))
              .child(
                btn(
                  "me-save",
                  this.busy ? "Saving…" : unresolved === 0 ? "Save & Stage (git add)" : `${unresolved} unresolved`,
                  unresolved === 0,
                  t.accent,
                  (_e, cx) => this.saveAndStage(cx),
                ),
              ),
          )
          .child(btn("me-esc", "Esc", false, null, () => this.close())),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(this.loading, (el) => el.child(div().text_color(t.muted).child("Scanning conflicted files…")))
      .when(!this.loading && this.files.length === 0, (el) =>
        el.child(
          v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap(6)
            .child(div().text_size(14).text_color(t.foreground).child("No merge conflicts found"))
            .child(div().text_size(12).text_color(t.dim).child("Working tree has no unmerged (U) paths.")),
        ),
      )
      .when(!this.loading && this.files.length > 0, (el) =>
        el.child(
          h_flex()
            .h(480)
            .min_h(0)
            .gap(10)
            .child(
              v_flex()
                .w(210)
                .flex_none()
                .h_full()
                .min_h(0)
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .p(6)
                .gap(3)
                .child(div().px(6).py(4).text_size(11).font_semibold().text_color(t.dim).child(`CONFLICTED (${this.files.length})`))
                .children(
                  this.files.map((f, idx) =>
                    div()
                      .id(`me-file-${idx}`)
                      .px(8)
                      .py(5)
                      .rounded(6)
                      .truncate()
                      .text_size(12)
                      .cursor_pointer()
                      .when(f === this.activeFile, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
                      .when(f !== this.activeFile, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
                      .on_click((_e, cx) => {
                        cx.spawn(async (cx) => this.openFile(f, cx));
                      })
                      .child(`! ${f}`),
                  ),
                ),
            )
            .child(
              div()
                .flex_1()
                .h_full()
                .min_w(0)
                .min_h(0)
                .relative()
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .child(
                  v_flex()
                    .id("me-hunks")
                    .absolute()
                    .inset_0()
                    .overflow_y_scroll()
                    .p(10)
                    .gap(12)
                    .children(
                      hunks.map((b) =>
                        v_flex()
                          .rounded(8)
                          .border_1()
                          .border_color(b.id === this.hunkAt ? t.accent : b.choice ? t.ansi2 : t.blocked)
                          .overflow_hidden()
                          .on_mouse_down("left", (_e, cx) => {
                            this.hunkAt = b.id;
                            cx.notify();
                          })
                          .child(
                            h_flex()
                              .px(10)
                              .py(6)
                              .gap(6)
                              .items_center()
                              .bg(t.chrome)
                              .border_b(1)
                              .border_color(t.border)
                              .child(
                                div()
                                  .font_semibold()
                                  .text_size(11.5)
                                  .text_color(b.id === this.hunkAt ? t.accent : t.foreground)
                                  .child(b.id === this.hunkAt ? `▸ Conflict #${b.id + 1}` : `Conflict #${b.id + 1}`),
                              )
                              .child(div().flex_1())
                              .child(btn(`me-cur-${b.id}`, "Accept Current", b.choice === "current", t.ansi4, (_e, cx) => { b.choice = "current"; cx.notify(); }))
                              .child(btn(`me-inc-${b.id}`, "Accept Incoming", b.choice === "incoming", t.ansi2, (_e, cx) => { b.choice = "incoming"; cx.notify(); }))
                              .child(btn(`me-both-${b.id}`, "Both", b.choice === "both", t.accent, (_e, cx) => { b.choice = "both"; cx.notify(); }))
                              .when(Boolean(b.choice), (el) =>
                                el.child(btn(`me-rst-${b.id}`, "Reset", false, null, (_e, cx) => { b.choice = null; cx.notify(); })),
                              ),
                          )
                          .child(
                            h_flex()
                              .gap(1)
                              .bg(t.border)
                              .child(
                                v_flex()
                                  .flex_1()
                                  .min_w(0)
                                  .bg(t.background)
                                  .p(8)
                                  .gap(4)
                                  .child(div().text_size(11).font_semibold().text_color(t.ansi4).child(`Current (${b.currentLabel})`))
                                  .child(div().text_size(11.5).text_color(t.foreground).child(b.current || "(empty)")),
                              )
                              .child(
                                v_flex()
                                  .flex_1()
                                  .min_w(0)
                                  .bg(t.background)
                                  .p(8)
                                  .gap(4)
                                  .child(div().text_size(11).font_semibold().text_color(t.ansi2).child(`Incoming (${b.incomingLabel})`))
                                  .child(div().text_size(11.5).text_color(t.foreground).child(b.incoming || "(empty)")),
                              ),
                          )
                          .when(Boolean(b.choice), (el) =>
                            el.child(
                              v_flex()
                                .border_t(1)
                                .border_color(t.border)
                                .bg(t.surface)
                                .p(8)
                                .gap(4)
                                .child(div().text_size(11).font_semibold().text_color(t.ansi2).child(`Result (${b.choice})`))
                                .child(div().text_size(11.5).text_color(t.foreground).child(resolveHunkText(b) || "(empty)")),
                            ),
                          ),
                      ),
                    )
                    .when(hunks.length === 0, (el) =>
                      el.child(div().p(16).text_color(t.dim).child("No conflict markers found in this file.")),
                    ),
                )
                .child(Scrollbar.vertical("me-hunks").absolute().inset_0()),
            ),
        ),
      );
  }
}
