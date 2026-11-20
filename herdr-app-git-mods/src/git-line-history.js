// Git history popup — either selected-line history ("line" mode, opened by
// ide-editor Ctrl+Alt+O or relayed from Fresh via ide-sidebar) or repository
// commit history ("repo" mode, opened globally via Ctrl+Alt+H).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, props, shared, setShared, theme, settings, closeOverlay, checking } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const FORMAT = "--format=%x1e%H%x1f%h%x1f%an%x1f%ad%x1f%s";

// Parse `git log ... --format=%x1e%H%x1f%h%x1f%an%x1f%ad%x1f%s`: each record
// starts with \x1e, its header is one line of \x1f-separated fields, the patch
// follows after a blank line (when -L or -p is used).
function parseHistory(out) {
  const commits = [];
  for (const record of (out ?? "").split("\x1e").slice(1)) {
    const nl = record.indexOf("\n");
    const header = nl < 0 ? record : record.slice(0, nl);
    const patch = (nl < 0 ? "" : record.slice(nl + 1)).replace(/^\n+/, "").trimEnd();
    const f = header.split("\x1f");
    const hash = (f[0] ?? "").trim();
    if (!hash) continue;
    commits.push({ hash, short: f[1] ?? "", author: f[2] ?? "", date: f[3] ?? "", subject: f[4] ?? "", patch });
  }
  return commits;
}

export default class GitLineHistory extends View {
  init(p, cx) {
    this.mode = p?.mode === "repo" ? "repo" : "line";
    this.loading = true;
    this.patchLoading = false;
    this.error = null;
    this.commits = [];
    this.at = 0;
    this.notice = null; // { text, failed }
    this.lastSeq = 0;
    this.on = null;
    this.root = "";
    this.range = "";
    this.patchCache = new Map();
    this.handle = cx.focus_handle();
    if (checking()) return;
    this.handle.focus();
    cx.timer.after(400, () => this.handle.focus());
    if (this.mode === "line") setShared("ide.glh.open", true);
    this.run(cx);
  }

  // The request lands in shared state after this copy may have started, and a
  // second trigger while open must refresh in place, so render() re-checks.
  request() {
    if (this.mode !== "line") return null;
    const q = shared("ide.glh.request");
    return q?.root && q?.file ? q : null;
  }

  run(cx) {
    if (checking()) return;
    if (this.mode === "repo") {
      this.runRepo(cx);
      return;
    }
    const q = this.request();
    if (!q) return;
    this.lastSeq = q.seq ?? 0;
    this.on = q.on ?? null;
    this.root = q.root;
    const start = q.start ?? 1;
    const end = q.end ?? start;
    this.range = `${q.title || q.file}:${start}${end !== start ? `-${end}` : ""}`;
    this.loading = true;
    this.error = null;
    this.commits = [];
    this.at = 0;
    this.notice = null;
    cx.spawn(async (cx2) => {
      const r = await exec(
        "git",
        [...READ, "-C", q.root, "log", "-L", `${start},${end}:${q.file}`, "-n", "200", "--date=short", FORMAT],
        { on: this.on, timeout: 60000 },
      ).catch(() => null);
      this.loading = false;
      if (!r || r.code !== 0) {
        this.error = (r?.stderr || r?.stdout || "git log -L failed").trim() || "git log -L failed";
      } else {
        this.commits = parseHistory(r.stdout ?? "");
      }
      cx2.notify();
    });
  }

  runRepo(cx) {
    const { cwd, on } = getContext();
    this.on = on ?? null;
    this.loading = true;
    this.patchLoading = false;
    this.error = null;
    this.commits = [];
    this.at = 0;
    this.notice = null;
    this.patchCache.clear();
    if (!cwd) {
      this.loading = false;
      this.error = "No active folder or workspace.";
      return;
    }
    cx.spawn(async (cx2) => {
      const top = await exec("git", [...READ, "-C", cwd, "rev-parse", "--show-toplevel"], { on: this.on, timeout: 10000 }).catch(() => null);
      if (!top || top.code !== 0) {
        this.loading = false;
        this.error = "Current folder is not a git repository.";
        cx2.notify();
        return;
      }
      this.root = (top.stdout ?? "").trim();
      const repoName = this.root.split(/[\\/]/).filter(Boolean).pop() || this.root;
      const br = await exec("git", [...READ, "-C", this.root, "rev-parse", "--abbrev-ref", "HEAD"], { on: this.on, timeout: 5000 }).catch(() => null);
      const branch = (br?.stdout ?? "").trim();
      this.range = branch ? `${repoName} (${branch})` : repoName;

      const r = await exec(
        "git",
        [...READ, "-C", this.root, "log", "-n", "200", "--date=short", FORMAT],
        { on: this.on, timeout: 30000 },
      ).catch(() => null);
      this.loading = false;
      if (!r || r.code !== 0) {
        this.error = (r?.stderr || r?.stdout || "git log failed").trim() || "git log failed";
      } else {
        this.commits = parseHistory(r.stdout ?? "");
        if (this.commits.length) this.loadCommitPatch(0, cx2);
      }
      cx2.notify();
    });
  }

  loadCommitPatch(i, cx) {
    const c = this.commits[i];
    if (!c || !this.root) return;
    if (this.patchCache.has(c.hash)) {
      c.patch = this.patchCache.get(c.hash);
      this.patchLoading = false;
      return;
    }
    const targetHash = c.hash;
    this.patchLoading = true;
    cx.spawn(async (cx2) => {
      const r = await exec(
        "git",
        [...READ, "-C", this.root, "show", "--format=", "--patch", "--no-color", targetHash],
        { on: this.on, timeout: 30000 },
      ).catch(() => null);
      const patch = r && r.code === 0 ? (r.stdout ?? "").replace(/^\n+/, "").trimEnd() : "";
      this.patchCache.set(targetHash, patch);
      const hit = this.commits.find((x) => x.hash === targetHash);
      if (hit) hit.patch = patch;
      if (this.commits[this.at]?.hash === targetHash) this.patchLoading = false;
      cx2.notify();
    });
  }

  select(i, cx) {
    const next = Math.max(0, Math.min(i, this.commits.length - 1));
    if (next !== this.at) {
      this.at = next;
      if (this.mode === "repo") this.loadCommitPatch(next, cx);
      cx.notify();
    }
  }

  close() {
    if (this.mode === "line") setShared("ide.glh.open", null);
    closeOverlay(props()?.overlay);
  }

  render(cx) {
    const q = this.request();
    if (q && (q.seq ?? 0) !== this.lastSeq) this.run(cx);
    const t = theme();
    const commits = this.commits;
    const cur = commits[this.at];
    const isLine = this.mode === "line";

    const rows = commits.map((c, i) => {
      const on = i === this.at;
      return v_flex()
        .id(`lh-c-${i}`)
        .px(10)
        .py(6)
        .gap(2)
        .rounded(6)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.select(i, cx))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().w(58).flex_none().font_semibold().text_size(11.5).text_color(t.accent).child(c.short))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).when(on, (d) => d.font_semibold()).child(c.subject)),
        )
        .child(div().pl(66).truncate().text_size(10.5).text_color(t.dim).child(`${c.date} · ${c.author}`));
    });

    const patchRows = cur?.patch ? diffRows(cur.patch.split("\n").map((l) => l.replace(/\r$/, ""))) : [];
    const patchWidth = Math.max(300, ...patchRows.map((row) => (row.text.length + 1) * 7.5 + 72));
    const patchLine = (row) => renderDiffLine(div, h_flex, row, t, { h: 19, numW: 0, prefixW: 14, gap: 4 });

    return v_flex()
      .id("git-line-history")
      .track_focus(this.handle)
      .w_full()
      .h(560)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.select(this.at + 1, cx);
        else if (k === "up") this.select(this.at - 1, cx);
        else if (k === "home" && commits.length) this.select(0, cx);
        else if (k === "end" && commits.length) this.select(commits.length - 1, cx);
        else if (k === "y" && cur) {
          cx.write_to_clipboard(cur.hash);
          this.notice = { text: `copied ${cur.short}`, failed: false };
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/workspace-chrome/branch.svg").size(14).text_color(t.accent))
          .child(div().font_semibold().text_size(13.5).text_color(t.foreground).child(isLine ? "Line history" : "Commit history"))
          .when(Boolean(this.range), (el) =>
            el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${this.range} · ${commits.length} commit${commits.length === 1 ? "" : "s"}`)),
          )
          .when(!this.range, (el) => el.child(div().flex_1()))
          .when(Boolean(this.on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(this.on)),
          )
          .child(
            div()
              .id("lh-esc")
              .px(7).py(2).rounded(5).bg(t.raised).text_size(11).text_color(t.muted)
              .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      .when(this.loading, (el) => el.child(div().px(14).py(12).text_size(12).text_color(t.dim).child("Loading git history…")))
      .when(!this.loading && Boolean(this.error), (el) =>
        el.child(
          v_flex().px(14).py(10).gap(6)
            .child(div().font_semibold().text_size(12.5).text_color(t.accent).child(isLine ? "No committed history for these lines — is the file committed and saved?" : "Unable to load git commit history"))
            .child(div().text_size(11.5).text_color(t.dim).child(String(this.error).split("\n")[0])),
        ),
      )
      .when(!this.loading && !this.error && commits.length === 0, (el) =>
        el.child(div().px(14).py(12).text_size(12).text_color(t.dim).child("No commits found.")),
      )
      .when(!this.loading && !this.error && commits.length > 0, (el) =>
        el.child(
          // Vertical flex_1 collapses inside a content-sized popup: every
          // vertical size here is explicit, horizontal fills stay flex_1.
          h_flex()
            .w_full()
            .h(466)
            .gap(10)
            .child(
              v_flex()
                .w(320)
                .h_full()
                .flex_none()
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .p(4)
                .child(
                  div()
                    .relative()
                    .w_full()
                    .h_full()
                    .child(
                      div()
                        .absolute()
                        .inset_0()
                        .overflow_y_scroll()
                        .child(v_flex().gap(2).children(rows)),
                    ),
                ),
            )
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .h_full()
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .overflow_hidden()
                .child(
                  h_flex()
                    .h(30)
                    .flex_none()
                    .px(10)
                    .gap(8)
                    .items_center()
                    .bg(t.chrome)
                    .border_b(1)
                    .border_color(t.border)
                    .child(div().flex_none().font_semibold().text_size(11.5).text_color(t.accent).child(cur?.short ?? ""))
                    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(cur?.subject ?? "Diff")),
                )
                .child(
                  div()
                    .flex_1()
                    .min_h(0)
                    .w_full()
                    .relative()
                    .font_family(settings().font_family ?? "JetBrains Mono")
                    .text_size(11.5)
                    .child(
                      cur?.patch
                        ? div()
                            .id("lh-diff-x")
                            .size_full()
                            .overflow_x_scrollbar()
                            .child(
                              div()
                                .w_full()
                                .min_w(patchWidth)
                                .h_full()
                                .child(
                                  v_virtual_list("lh-diff-list", patchRows.length, 19, (i) => String(i), (range) =>
                                    patchRows.slice(range.start, range.end).map(patchLine),
                                  ).size_full(),
                                ),
                            )
                        : div().size_full().p(10).text_size(11.5).text_color(t.dim).child(this.patchLoading ? "Loading commit diff…" : "(no patch for this commit)"),
                    )
                    .when(Boolean(cur?.patch), (el2) => el2.child(Scrollbar.vertical("lh-diff-list").viewport_from_layout().absolute().inset_0())),
                ),
            ),
        ),
      )
      .child(
        h_flex()
          .gap(10)
          .when(Boolean(this.notice), (el) =>
            el.child(div().text_size(11).text_color(this.notice.failed ? t.blocked : t.done).child(this.notice.text)),
          )
          .when(!this.notice, (el) =>
            el.child(div().text_size(11).text_color(t.dim).child("↑↓ or click to select · Home/End jump · y copy hash · Esc close")),
          ),
      );
  }
}
