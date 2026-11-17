import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  spaces, panes, focused, exec, theme, props, closeOverlay,
  notify, checking, readTextFile, appHome,
} from "herdr";

export default class GitQuickAction extends View {
  init(p, cx) {
    this.action = p?.action || "pull";
    this.status = "Running…";
    this.detail = "";
    this.error = null;
    this.draft = "";
    this.committedMsg = null;
    this.done = false;
    this.needEdit = false;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message…" });
    this.input.on("change", (_e, cx) => {
      this.draft = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commitWithMessage(this.draft.trim(), cx));

    if (checking()) {
      this.status = `Ready (${this.action})`;
      return;
    }
    this.runAction(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  async git(args, cwd, on) {
    const r = await exec("git", args, { cwd, on });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  }

  runAction(cx) {
    const { cwd, on } = getContext();
    if (!cwd) {
      this.error = "No active folder or workspace.";
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      const top = await this.git(["rev-parse", "--show-toplevel"], cwd, on);
      if (!top.ok) {
        this.error = "Current folder is not a git repository.";
        cx.notify();
        return;
      }
      this.root = top.out;
      this.on = on;

      if (this.action === "pull" || this.action === "push") {
        this.status = this.action === "pull" ? "Pulling from remote…" : "Pushing to remote…";
        cx.notify();
        const res = await runGitSyncWithUpstream(this.action, this.root, on);
        if (res.ok) {
          this.close();
        } else {
          this.error = res.detail;
          cx.notify();
        }
        return;
      }

      if (this.action === "undo") {
        this.status = "Undoing last commit (soft reset)…";
        cx.notify();
        const head = await this.git(["rev-parse", "--short", "HEAD"], this.root, on);
        const subj = await this.git(["log", "-1", "--pretty=%s"], this.root, on);
        const r = await this.git(["reset", "--soft", "HEAD~1"], this.root, on);
        if (r.ok) {
          bumpGitDirty();
          notify({
            title: "Undo Last Commit",
            body: `Reset ${head.out} (${subj.out}). Changes kept staged.\nRecover: git reset --soft ${head.out}`,
            level: "info",
            timeout: 4500,
          });
          this.close();
        } else {
          this.error = r.err || r.out || "git reset --soft HEAD~1 failed";
          notify({ title: "Undo Failed", body: this.error, level: "error", timeout: 4500 });
          cx.notify();
        }
        return;
      }

      if (this.action === "ai-commit" || this.action === "ai-sync") {
        if (this.action === "ai-sync") {
          const unmerged = await this.git(["ls-files", "--unmerged"], this.root, on);
          if (unmerged.out) {
            this.error = "Repository has unresolved conflicts. Resolve conflicts before AI Commit & Sync.";
            notify({ title: "AI Commit & Sync Blocked", body: this.error, level: "error", timeout: 4500 });
            cx.notify();
            return;
          }
        }
        const commitOutcome = await this.runAiCommitStep(cx, this.action === "ai-sync");
        if (commitOutcome === "failed") return;
        if (this.action === "ai-sync") {
          await this.syncRemote(cx);
        }
      }
    });
  }

  async runAiCommitStep(cx, allowClean) {
    this.status = "Staging & generating AI commit…";
    cx.notify();
    const stagedCheck = await this.git(["diff", "--cached", "--name-only"], this.root, this.on);
    if (!stagedCheck.out) {
      const add = await this.git(["add", "-A"], this.root, this.on);
      if (!add.ok) {
        this.error = add.err || "git add -A failed";
        notify({ title: "AI Commit Failed", body: this.error, level: "error", timeout: 4500 });
        cx.notify();
        return "failed";
      }
    }
    const diff = await this.git(["diff", "--cached", "--stat"], this.root, this.on);
    if (!diff.out) {
      if (allowClean) {
        this.detail = "Working tree clean — checking remote sync…";
        cx.notify();
        return "clean";
      }
      this.error = "Nothing to commit (working tree clean).";
      notify({ title: "AI Commit", body: this.error, level: "info", timeout: 3500 });
      cx.notify();
      return "failed";
    }
    const summary = diff.out.split("\n").pop()?.trim() || "";
    this.detail = summary;
    this.status = "Generating AI commit message…";
    cx.notify();
    const patch = await this.git(["diff", "--cached", "--no-color"], this.root, this.on);
    const msg = await generateAiCommitMessage(diff.out, patch.out.slice(0, 6000), this.root, this.on);
    this.draft = msg;
    this.input.set_value(msg);
    const ok = await this.commitWithMessage(msg, cx, allowClean);
    return ok ? "committed" : "failed";
  }

  async syncRemote(cx) {
    const remotes = await this.git(["remote"], this.root, this.on);
    if (!remotes.ok || !remotes.out) {
      this.done = true;
      this.status = this.committedMsg ? "Committed locally ✓" : "Working tree clean ✓";
      this.detail = "No git remote configured (skipped pull/push).";
      notify({ title: "AI Commit & Sync", body: this.detail, level: "info", timeout: 3500 });
      cx.notify();
      await cx.sleep(1800);
      this.close();
      return;
    }

    const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], this.root, this.on);
    let ahead = 0;
    if (upstream.ok && upstream.out) {
      this.status = "Checking remote changes…";
      cx.notify();
      const fetched = await this.git(["fetch", "--quiet"], this.root, this.on);
      if (!fetched.ok) {
        this.error = fetched.err || fetched.out || "git fetch failed";
        notify({ title: "Git Sync Failed", body: this.error, level: "error", timeout: 4500 });
        cx.notify();
        return;
      }
      const counts = await this.git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], this.root, this.on);
      const parts = (counts.out || "").trim().split(/\s+/);
      ahead = Number(parts[0] ?? 0);
      const behind = Number(parts[1] ?? 0);
      if (behind > 0) {
        this.status = `Pulling incoming changes (↓${behind})…`;
        cx.notify();
        const pullRes = await runGitSyncWithUpstream("pull", this.root, this.on);
        if (!pullRes.ok) {
          this.error = pullRes.detail;
          cx.notify();
          return;
        }
        const afterCounts = await this.git(["rev-list", "--count", "@{u}..HEAD"], this.root, this.on);
        ahead = afterCounts.ok ? Number(afterCounts.out || 0) : ahead;
      }
      if (ahead === 0) {
        this.done = true;
        this.status = this.committedMsg ? "Committed & synced ✓" : "Already up to date ✓";
        this.detail = "No outgoing commits to push.";
        notify({
          title: "AI Commit & Sync ✓",
          body: this.committedMsg ? `${this.committedMsg.split("\n")[0]} (already in sync)` : "Working tree clean & up to date.",
          level: "success",
          timeout: 4000,
        });
        cx.notify();
        await cx.sleep(1600);
        this.close();
        return;
      }
    }

    this.status = ahead > 0 ? `Pushing to remote (↑${ahead})…` : "Pushing to remote…";
    cx.notify();
    const pushRes = await runGitSyncWithUpstream("push", this.root, this.on);
    if (pushRes.ok) {
      this.done = true;
      this.status = this.committedMsg ? "AI Commit + Sync Complete ✓" : "Pushed ✓";
      this.detail = pushRes.detail;
      cx.notify();
      await cx.sleep(1800);
      this.close();
    } else {
      this.error = pushRes.detail;
      cx.notify();
    }
  }

  async commitWithMessage(msg, cx, continueSync = false) {
    if (!msg || !this.root) return false;
    this.status = "Committing changes…";
    this.draft = msg;
    this.needEdit = false;
    this.error = null;
    cx.notify();
    const r = await this.git(["commit", "-m", msg], this.root, this.on);
    if (r.ok) {
      bumpGitDirty();
      this.status = "Committed ✓";
      this.committedMsg = msg;
      notify({ title: "AI Commit ✓", body: msg.split("\n")[0], level: "success", timeout: 7000 });
      cx.notify();
      if (!continueSync && this.action !== "ai-sync") {
        this.done = true;
        await cx.sleep(2400);
        this.close();
      } else if (!continueSync && this.action === "ai-sync") {
        await this.syncRemote(cx);
      }
      return true;
    } else {
      this.error = r.err || r.out || "git commit failed";
      notify({ title: "Git Commit Failed", body: this.error, level: "error", timeout: 5000 });
      this.needEdit = true;
      cx.notify();
      return false;
    }
  }

  render() {
    const t = theme();
    return v_flex()
      .id("git-quick-action")
      .track_focus(this.handle)
      .w_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e) => {
        if (e.key === "escape" || (e.key === "enter" && this.done)) this.close();
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/workspace-chrome/branch.svg").size(15).text_color(this.done ? t.ansi2 : t.accent))
          .child(
            div()
              .flex_1()
              .text_size(13)
              .font_semibold()
              .text_color(this.done ? t.ansi2 : t.foreground)
              .child(this.error ? "Git Action Error" : this.status),
          )
          .child(
            div()
              .id("gqa-esc")
              .px(7)
              .py(2)
              .rounded(4)
              .bg(t.raised)
              .text_size(11)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child(this.done ? "Done (Esc)" : "Esc"),
          ),
      )
      .when(Boolean(this.detail && !this.error), (el) =>
        el.child(div().text_size(11.5).text_color(t.muted).child(this.detail)),
      )
      .when(Boolean(this.committedMsg), (el) => {
        // The popup is a fixed-size overlay: size the box to the message, then scroll inside it.
        const lines = this.committedMsg.split("\n").length;
        const boxH = Math.min(210, Math.max(40, lines * 18 + 6));
        return el.child(
          v_flex()
            .p(10)
            .gap(4)
            .rounded(7)
            .bg(t.background)
            .border_1()
            .border_color(t.ansi2)
            .child(div().text_size(10.5).font_semibold().text_color(t.ansi2).child("COMMIT MESSAGE"))
            .child(
              div()
                .relative()
                .h(boxH)
                .child(
                  div()
                    .absolute()
                    .inset_0()
                    .overflow_y_scroll()
                    .child(div().text_size(12.5).text_color(t.foreground).child(this.committedMsg)),
                ),
            ),
        );
      })
      .when(Boolean(this.error), (el) =>
        el.child(div().text_size(12).text_color(t.blocked).child(this.error)),
      )
      .when(this.needEdit, (el) =>
        el
          .child(
            h_flex()
              .h(34)
              .px(10)
              .rounded(8)
              .border_1()
              .border_color(t.accent)
              .bg(t.background)
              .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
          )
          .child(
            h_flex()
              .justify_end()
              .gap(8)
              .child(
                div()
                  .id("gqa-commit")
                  .px(12)
                  .py(5)
                  .rounded(6)
                  .bg(t.accent)
                  .text_size(12)
                  .font_semibold()
                  .text_color("#ffffff")
                  .cursor_pointer()
                  .on_click((_e, cx) => this.commitWithMessage(this.draft.trim(), cx))
                  .child("Commit (Enter)"),
              ),
          ),
      );
  }
}
