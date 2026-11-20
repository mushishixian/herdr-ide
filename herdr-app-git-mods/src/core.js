import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, theme, props, closeOverlay, openOverlay, notify } from "herdr";

const MODES = [
  { id: "switch", label: "Switch", key: "Ctrl+Alt+C" },
  { id: "merge", label: "Merge", key: "Ctrl+Alt+X" },
  { id: "rename", label: "Rename", key: "Ctrl+Alt+R" },
  { id: "new", label: "New", key: "Ctrl+Alt+N" },
];

function isLocalChangesError(msg) {
  const s = (msg || "").toLowerCase();
  return (
    s.includes("local changes") ||
    s.includes("uncommitted changes") ||
    s.includes("overwritten by checkout") ||
    s.includes("please commit your changes or stash them")
  );
}

function isUnmergedDeleteError(msg) {
  const s = (msg || "").toLowerCase();
  return s.includes("not fully merged") || s.includes("git branch -d");
}

export default class GitBranch extends View {
  init(p, cx) {
    this.mode = p?.mode || "switch";
    this.filter = "";
    this.at = 0;
    this.scroll = 0;
    this.loading = true;
    this.busy = false;
    this.error = null;
    this.result = null;
    this.stashConfirm = null;
    this.forceDeleteConfirm = null;
    this.mergeFlipped = false;
    this.root = null;
    this.on = null;
    this.currentBranch = null;
    this.branches = [];

    this.input = InputState.new({ placeholder: this.placeholder() });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.scroll = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.handleSubmit(cx));
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
    this.handle = cx.focus_handle();

    this.loadRepo(cx);
  }

  placeholder() {
    if (this.mode === "rename") return "New branch name…";
    if (this.mode === "new") return "Create branch from HEAD…";
    if (this.mode === "merge") return "Filter branch to merge…";
    return "Filter or type new branch name…";
  }

  close() {
    closeOverlay(props().overlay);
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.error = null;
    this.result = null;
    this.stashConfirm = null;
    this.forceDeleteConfirm = null;
    this.mergeFlipped = false;
    this.at = 0;
    this.scroll = 0;
    this.input.set_placeholder?.(this.placeholder());
    if (mode === "rename" && this.currentBranch) {
      this.filter = this.currentBranch;
      this.input.set_value(this.currentBranch);
    } else {
      this.filter = "";
      this.input.set_value("");
    }
    this.input.focus();
    cx.notify();
  }

  async git(args) {
    const res = await exec("git", args, { cwd: this.root, on: this.on });
    return {
      ok: res.code === 0,
      stdout: (res.stdout ?? "").trim(),
      stderr: (res.stderr ?? "").trim(),
    };
  }

  loadRepo(cx) {
    const { cwd, on } = getContext();
    this.on = on;
    if (!cwd) {
      this.loading = false;
      this.error = "No active folder or workspace.";
      cx.notify();
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) {
          this.loading = false;
          this.error = "Current folder is not a git repository.";
          cx.notify();
          return;
        }
        this.root = top.stdout.trim();

        const head = await this.git(["symbolic-ref", "--short", "HEAD"]);
        this.currentBranch = head.ok ? head.stdout : null;

        const refs = await this.git([
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname)%09%(refname:short)%09%(HEAD)",
          "refs/heads",
          "refs/remotes",
        ]);
        const locals = new Set();
        const list = [];
        for (const line of refs.stdout.split("\n")) {
          if (!line) continue;
          const [full, name, headMark] = line.split("\t");
          if (!full || !name || name.endsWith("/HEAD")) continue;
          const remote = full.startsWith("refs/remotes/");
          if (!remote) locals.add(name);
          list.push({ name, remote, current: headMark === "*" });
        }
        const localRows = list.filter((b) => !b.remote);
        const remoteRows = list.filter((b) => b.remote && !locals.has(b.name.replace(/^[^/]+\//, "")));
        this.branches = [...localRows, ...remoteRows];

        if (this.mode === "rename" && this.currentBranch) {
          this.filter = this.currentBranch;
          this.input.set_value(this.currentBranch);
        }
        this.loading = false;
        cx.notify();
      } catch (err) {
        this.loading = false;
        this.error = String(err?.message ?? err);
        cx.notify();
      }
    });
  }

  rows() {
    if (this.mode === "rename" || this.mode === "new") return [];
    const q = this.filter.trim().toLowerCase();
    let list = this.branches;
    if (this.mode === "merge") {
      list = list.filter((b) => !b.current && (!this.mergeFlipped || !b.remote));
    }
    const filtered = q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list;
    const out = filtered.map((b) => ({ kind: "branch", branch: b }));
    if (this.mode === "switch") {
      const typed = this.filter.trim();
      if (typed && !this.branches.some((b) => !b.remote && b.name === typed)) {
        out.push({ kind: "create", name: typed });
      } else if (!typed) {
        out.unshift({ kind: "new_prompt" });
      }
    }
    return out;
  }

  handleSubmit(cx) {
    if (this.busy || this.loading) return;
    if (this.stashConfirm) {
      this.runCheckoutStashing(this.stashConfirm, cx);
      return;
    }
    if (this.forceDeleteConfirm) {
      this.runDeleteBranch(this.forceDeleteConfirm, true, cx);
      return;
    }
    if (this.mode === "new") {
      const name = this.filter.trim();
      if (name) this.runCreate(name, cx);
      return;
    }
    if (this.mode === "rename") {
      const name = this.filter.trim();
      if (name && name !== this.currentBranch) this.runRename(name, cx);
      return;
    }
    const rows = this.rows();
    const row = rows[this.at];
    if (!row) return;
    this.activateRow(row, cx);
  }

  activateRow(row, cx) {
    if (row.kind === "new_prompt") {
      this.setMode("new", cx);
      return;
    }
    if (row.kind === "create") {
      this.runCreate(row.name, cx);
      return;
    }
    if (row.kind === "branch") {
      if (this.mode === "switch") this.runCheckout(row.branch, cx);
      else if (this.mode === "merge") this.runMerge(row.branch, cx);
    }
  }

  syncBranchUi(newBranch, isRemote = false) {
    const space = spaces().find((s) => s.active);
    const firstTab = space?.tabs?.[0];
    const clean = isRemote ? newBranch?.replace(/^[^/]+\//, "") : newBranch;
    if (space?.id && clean) {
      setShared("ide.branchBySpace", { ...(shared("ide.branchBySpace") ?? {}), [space.id]: clean });
    }
    if (firstTab && clean) {
      const autoMap = { ...(shared("ide.tabAutoBranch") ?? {}) };
      const prev = autoMap[firstTab.id];
      if (firstTab.name === "1" || firstTab.name === this.currentBranch || (prev && firstTab.name === prev)) {
        autoMap[firstTab.id] = clean;
        setShared("ide.tabAutoBranch", autoMap);
        run("tab.rename", { id: firstTab.id, name: clean });
      }
    }
    setShared("ide.git.dirtySeq", (shared("ide.git.dirtySeq") ?? 0) + 1);
  }

  runCreate(name, cx) {
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await this.git(["checkout", "-b", name]);
      this.busy = false;
      if (res.ok) {
        this.syncBranchUi(name);
        notify({ title: "Git Branch", body: `Created and switched to ${name}`, level: "success" });
        this.close();
      } else {
        this.error = res.stderr || res.stdout || "Failed to create branch";
        cx.notify();
      }
    });
  }

  runRename(name, cx) {
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await this.git(["branch", "-m", name]);
      this.busy = false;
      if (res.ok) {
        this.syncBranchUi(name);
        notify({ title: "Git Branch", body: `Renamed branch to ${name}`, level: "success" });
        this.close();
      } else {
        this.error = res.stderr || res.stdout || "Failed to rename branch";
        cx.notify();
      }
    });
  }

  runDeleteBranch(branch, force, cx) {
    this.busy = true;
    this.forceDeleteConfirm = null;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await this.git(["branch", force ? "-D" : "-d", branch.name]);
      this.busy = false;
      if (res.ok) {
        notify({ title: "Git Branch", body: `Deleted branch ${branch.name}`, level: "info" });
        this.loadRepo(cx);
      } else if (!force && isUnmergedDeleteError(res.stderr || res.stdout)) {
        this.forceDeleteConfirm = branch;
        cx.notify();
      } else {
        this.error = res.stderr || res.stdout || "Failed to delete branch";
        cx.notify();
      }
    });
  }

  runCheckout(branch, cx) {
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const args = branch.remote ? ["checkout", "-t", branch.name] : ["checkout", branch.name];
      const res = await this.git(args);
      this.busy = false;
      if (res.ok) {
        this.syncBranchUi(branch.name, branch.remote);
        notify({ title: "Git Branch", body: `Switched to ${branch.name}`, level: "success" });
        this.close();
      } else if (isLocalChangesError(res.stderr || res.stdout)) {
        this.stashConfirm = branch;
        cx.notify();
      } else {
        this.error = res.stderr || res.stdout || "Checkout failed";
        cx.notify();
      }
    });
  }

  runCheckoutStashing(branch, cx) {
    this.busy = true;
    this.stashConfirm = null;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const stash = await this.git(["stash", "push", "-m", `herdr: switch to ${branch.name}`]);
      if (!stash.ok) {
        this.busy = false;
        this.error = stash.stderr || "Failed to stash local changes";
        cx.notify();
        return;
      }
      const args = branch.remote ? ["checkout", "-t", branch.name] : ["checkout", branch.name];
      const co = await this.git(args);
      if (!co.ok) {
        await this.git(["stash", "pop"]);
        this.busy = false;
        this.error = co.stderr || "Checkout failed (stash restored)";
        cx.notify();
        return;
      }
      const pop = await this.git(["stash", "pop"]);
      this.busy = false;
      this.syncBranchUi(branch.name, branch.remote);
      if (pop.ok) {
        notify({ title: "Git Branch", body: `Switched to ${branch.name} (stashed changes restored)`, level: "success" });
        this.close();
      } else {
        this.error = `Switched to ${branch.name}, but stash pop had conflicts:\n${pop.stderr || pop.stdout}`;
        cx.notify();
      }
    });
  }

  runMerge(branch, cx) {
    this.busy = true;
    this.error = null;
    this.result = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let res;
      if (this.mergeFlipped) {
        const src = this.currentBranch;
        if (!src) {
          this.busy = false;
          this.error = "Cannot flip-merge from detached HEAD.";
          cx.notify();
          return;
        }
        const co = await this.git(["checkout", branch.name]);
        if (!co.ok) {
          this.busy = false;
          this.error = co.stderr || `Failed to checkout ${branch.name}`;
          cx.notify();
          return;
        }
        this.syncBranchUi(branch.name, branch.remote);
        res = await this.git(["merge", src]);
      } else {
        res = await this.git(["merge", branch.name]);
      }
      this.busy = false;
      if (res.ok) {
        bumpGitDirty();
        notify({ title: "Git Merge", body: res.stdout || `Merged ${branch.name}`, level: "success" });
        this.close();
      } else {
        bumpGitDirty();
        const status = await this.git(["diff", "--name-only", "--diff-filter=U"]);
        const conflicts = status.stdout ? status.stdout.split("\n").filter(Boolean) : [];
        this.result = {
          conflicts,
          message: res.stderr || res.stdout || "Merge failed",
        };
        cx.notify();
      }
    });
  }

  openMergeEditor() {
    this.close();
    openOverlay({ mod: "merge-editor", kind: "popup", at: "top", offset: 24, width: 0.76, height: 0.90 });
  }

  runMergeAbort(cx) {
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await this.git(["merge", "--abort"]);
      this.busy = false;
      if (res.ok) {
        bumpGitDirty();
        notify({ title: "Git Merge", body: "Merge aborted", level: "info" });
        this.close();
      } else {
        this.error = res.stderr || "Failed to abort merge";
        cx.notify();
      }
    });
  }

  runSync(kind, cx) {
    if (!this.root || this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const res = await runGitSyncWithUpstream(kind, this.root, this.on);
      this.busy = false;
      if (res.ok) {
        this.loadRepo(cx);
      } else {
        this.error = res.detail;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const sel = rows[this.at];

    const H = 32;
    const height = Math.min(288, rows.length * H);
    const total = rows.length * H;
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    if (rows.length > 0) {
      const top = this.at * H;
      if (top < this.scroll) this.scroll = top;
      if (top + H > this.scroll + height) this.scroll = top + H - height;
    }

    const headerBtn = (id, label, tip, onClick) =>
      div()
        .id(id)
        .px(7)
        .py(2)
        .rounded(5)
        .text_size(11)
        .text_color(t.muted)
        .cursor_pointer()
        .tooltip(tip)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(onClick)
        .child(label);

    const header = h_flex()
      .items_center()
      .gap(6)
      .child(svg("mods/workspace-chrome/branch.svg").size(15).text_color(t.accent))
      .child(div().font_semibold().text_size(14).text_color(t.foreground).child(this.currentBranch || "Git"))
      .when(Boolean(this.on), (el) =>
        el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(this.on)),
      )
      .child(div().flex_1())
      .when(Boolean(this.root), (el) => {
        const activeSp = spaces().find((s) => s.active);
        const sync = activeSp ? (shared("ide.gitSyncBySpace")?.[activeSp.id] ?? { ahead: 0, behind: 0 }) : { ahead: 0, behind: 0 };
        if (sync.behind > 0 && sync.ahead > 0) {
          return el.child(headerBtn("gb-sync", `↓${sync.behind} ↑${sync.ahead} Sync`, `Pull ${sync.behind} & Push ${sync.ahead}`, (_e, cx) => this.runSync("sync", cx)));
        }
        return el
          .child(headerBtn("gb-pull", sync.behind > 0 ? `↓${sync.behind} Pull` : "↓ Pull", "git pull (Ctrl+Alt+P)", (_e, cx) => this.runSync("pull", cx)))
          .child(headerBtn("gb-push", sync.ahead > 0 ? `↑${sync.ahead} Push` : "↑ Push", "git push (Ctrl+Alt+K)", (_e, cx) => this.runSync("push", cx)));
      })
      .child(headerBtn("gb-esc", "Esc", "Close", () => this.close()));

    const tabs = h_flex()
      .gap(4)
      .children(
        MODES.map((m) => {
          const active = this.mode === m.id;
          return div()
            .id(`gb-mode-${m.id}`)
            .px(10)
            .py(4)
            .rounded(6)
            .text_size(12)
            .cursor_pointer()
            .when(active, (el) => el.bg(t.accent).text_color("#ffffff").font_semibold())
            .when(!active, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .on_click((_e, cx) => this.setMode(m.id, cx))
            .child(m.label);
        }),
      );

    const mergeBanner =
      this.mode === "merge"
        ? h_flex()
            .id("gb-merge-dir")
            .px(10)
            .py(6)
            .rounded(7)
            .bg(t.hover)
            .items_center()
            .gap(8)
            .cursor_pointer()
            .on_click((_e, cx) => {
              this.mergeFlipped = !this.mergeFlipped;
              this.at = 0;
              cx.notify();
            })
            .child(svg("mods/workspace-chrome/git-compare.svg").size(13).text_color(t.accent))
            .child(
              div()
                .flex_1()
                .text_size(12)
                .text_color(t.foreground)
                .child(
                  this.mergeFlipped
                    ? `Merge ${this.currentBranch ?? "HEAD"} → ${sel?.branch?.name ?? "<selected>"}`
                    : `Merge ${sel?.branch?.name ?? "<selected>"} → ${this.currentBranch ?? "HEAD"}`,
                ),
            )
            .child(div().text_size(11).text_color(t.dim).child("Tab to flip"))
        : null;

    const inputBox = h_flex()
      .h(36)
      .flex_none()
      .px(10)
      .gap(8)
      .items_center()
      .rounded(9)
      .border_1()
      .border_color(t.accent)
      .bg(t.background)
      .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
      .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground));

    const confirmBox = (text, okLabel, onCancel, onOk) =>
      v_flex()
        .p(12)
        .gap(10)
        .rounded(8)
        .border_1()
        .border_color(t.blocked)
        .bg(t.background)
        .child(div().text_size(12.5).text_color(t.foreground).child(text))
        .child(
          h_flex()
            .gap(8)
            .justify_end()
            .child(
              div()
                .id("gb-confirm-cancel")
                .px(10)
                .py(5)
                .rounded(6)
                .text_size(12)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(onCancel)
                .child("Cancel"),
            )
            .child(
              div()
                .id("gb-confirm-ok")
                .px(12)
                .py(5)
                .rounded(6)
                .bg(t.accent)
                .text_size(12)
                .font_semibold()
                .text_color("#ffffff")
                .cursor_pointer()
                .on_click(onOk)
                .child(okLabel),
            ),
        );

    const stashBox = this.stashConfirm
      ? confirmBox(
          `Local uncommitted changes block switching to "${this.stashConfirm.name}". Stash changes, switch, and pop?`,
          "Stash & Switch (Enter)",
          (_e, cx) => {
            this.stashConfirm = null;
            cx.notify();
          },
          (_e, cx) => this.runCheckoutStashing(this.stashConfirm, cx),
        )
      : null;

    const forceDeleteBox = this.forceDeleteConfirm
      ? confirmBox(
          `Branch "${this.forceDeleteConfirm.name}" is not fully merged. Force delete (git branch -D)?`,
          "Force Delete (Enter)",
          (_e, cx) => {
            this.forceDeleteConfirm = null;
            cx.notify();
          },
          (_e, cx) => this.runDeleteBranch(this.forceDeleteConfirm, true, cx),
        )
      : null;

    const conflictBox = this.result
      ? v_flex()
          .p(12)
          .gap(8)
          .rounded(8)
          .border_1()
          .border_color(t.blocked)
          .bg(t.background)
          .child(div().font_semibold().text_size(12.5).text_color(t.blocked).child("Merge stopped with conflicts / error"))
          .when(this.result.conflicts.length > 0, (el) =>
            el.child(
              v_flex()
                .gap(2)
                .children(this.result.conflicts.slice(0, 8).map((f) => div().text_size(11.5).text_color(t.foreground).child(`! ${f}`))),
            ),
          )
          .child(div().text_size(11.5).text_color(t.muted).child(this.result.message))
          .when(this.result.conflicts.length > 0, (el) =>
            el.child(
              h_flex()
                .justify_end()
                .gap(8)
                .child(
                  div()
                    .id("gb-merge-resolve")
                    .px(10)
                    .py(5)
                    .rounded(6)
                    .bg(t.accent)
                    .text_size(12)
                    .font_semibold()
                    .text_color("#ffffff")
                    .cursor_pointer()
                    .on_click(() => this.openMergeEditor())
                    .child("Resolve Conflicts (r)"),
                )
                .child(
                  div()
                    .id("gb-merge-abort")
                    .px(10)
                    .py(5)
                    .rounded(6)
                    .bg(t.blocked)
                    .text_size(12)
                    .font_semibold()
                    .text_color("#ffffff")
                    .cursor_pointer()
                    .on_click((_e, cx) => this.runMergeAbort(cx))
                    .child("Abort Merge (a)"),
                ),
            ),
          )
      : null;

    const rowEl = (r, i) => {
      const on = i === this.at;
      const base = h_flex()
        .id(`gb-row-${i}`)
        .mx(2)
        .px(10)
        .h(H)
        .rounded(7)
        .gap(8)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.activateRow(r, cx));

      const placed = fixed
        ? base.absolute().left(0).right(0).top(i * H - this.scroll).bottom(height - (i * H + H - this.scroll))
        : base;

      if (r.kind === "new_prompt") {
        return placed
          .text_color(t.accent)
          .child(div().w(14).font_bold().child("+"))
          .child(div().flex_1().font_semibold().child("New branch…"));
      }
      if (r.kind === "create") {
        return placed
          .text_color(t.accent)
          .child(div().w(14).font_bold().child("+"))
          .child(div().flex_1().font_semibold().child(`Create branch "${r.name}"`));
      }
      const b = r.branch;
      return placed
        .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(b.current ? t.accent : t.dim))
        .child(div().flex_1().truncate().text_color(t.foreground).when(b.current, (d) => d.font_semibold()).child(b.name))
        .when(b.current, (el) => el.child(div().text_size(11).text_color(t.accent).child("current")))
        .when(b.remote, (el) => el.child(div().text_size(11).text_color(t.dim).child("remote")))
        .when(!b.current && !b.remote && this.mode === "switch", (el) =>
          el.child(
            div()
              .id(`gb-del-${i}`)
              .px(5)
              .py(1)
              .rounded(4)
              .text_size(11)
              .text_color(t.dim)
              .tooltip(`Delete ${b.name}`)
              .hover((s) => s.bg(t.raised).text_color(t.ansi1))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => this.runDeleteBranch(b, false, cx))
              .child("×"),
          ),
        );
    };

    const listEl =
      rows.length > 0
        ? v_flex()
            .id("gb-list")
            .h(height)
            .min_h(0)
            .when(fixed, (el) =>
              el.overflow_hidden().on_scroll_wheel((e, cx) => {
                this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
                while (this.at < rows.length - 1 && this.at * H < this.scroll) this.at++;
                while (this.at > 0 && this.at * H + H > this.scroll + height) this.at--;
                cx.notify();
              }),
            )
            .children(
              rows
                .map((r, i) => {
                  if (fixed && (i * H + H <= this.scroll || i * H >= this.scroll + height)) return null;
                  return rowEl(r, i);
                })
                .filter(Boolean),
            )
        : null;

    const actionFooter =
      this.mode === "new" || this.mode === "rename"
        ? h_flex()
            .justify_end()
            .gap(8)
            .child(
              div()
                .id("gb-submit")
                .px(14)
                .py(6)
                .rounded(7)
                .bg(t.accent)
                .text_size(12.5)
                .font_semibold()
                .text_color("#ffffff")
                .cursor_pointer()
                .on_click((_e, cx) => this.handleSubmit(cx))
                .child(this.mode === "new" ? "Create & Switch (Enter)" : "Rename Branch (Enter)"),
            )
        : null;

    return v_flex()
      .id("git-branch-popup")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") {
          if (this.stashConfirm || this.forceDeleteConfirm) {
            this.stashConfirm = null;
            this.forceDeleteConfirm = null;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          return this.close();
        }
        if (k === "tab" && this.mode === "merge") {
          this.mergeFlipped = !this.mergeFlipped;
          this.at = 0;
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (k === "a" && this.result?.conflicts?.length && !this.busy) {
          this.runMergeAbort(cx);
          cx.stop_propagation();
          return;
        }
        if (k === "r" && this.result?.conflicts?.length && !this.busy) {
          this.openMergeEditor();
          cx.stop_propagation();
          return;
        }
        if (k === "down" && rows.length) {
          this.at = (this.at + 1) % rows.length;
          cx.stop_propagation();
          cx.notify();
        } else if (k === "up" && rows.length) {
          this.at = (this.at + rows.length - 1) % rows.length;
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(header)
      .child(tabs)
      .when(Boolean(mergeBanner), (el) => el.child(mergeBanner))
      .child(inputBox)
      .when(this.loading, (el) => el.child(div().text_size(12).text_color(t.muted).child("Loading git branches…")))
      .when(this.busy, (el) => el.child(div().text_size(12).text_color(t.accent).child("Running git command…")))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(stashBox), (el) => el.child(stashBox))
      .when(Boolean(forceDeleteBox), (el) => el.child(forceDeleteBox))
      .when(Boolean(conflictBox), (el) => el.child(conflictBox))
      .when(Boolean(listEl), (el) => el.child(listEl))
      .when(Boolean(actionFooter), (el) => el.child(actionFooter));
  }
}
