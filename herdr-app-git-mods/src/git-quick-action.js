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

      if (this.action === "pull" || this.action === "push" || this.action === "sync") {
        this.status = this.action === "sync"
          ? "Syncing (Pull → Push)…"
          : this.action === "pull" ? "Pulling from remote…" : "Pushing to remote…";
        cx.notify();
        const res = await runGitSyncWithUpstream(this.action, this.root, on);
        if (res.ok) {
          this.done = true;
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
          this.done = true;
          this.close();
        } else {
          this.error = r.err || r.out || "git reset --soft HEAD~1 failed";
          notify({ title: "Undo Failed", body: this.error, level: "error", timeout: 4500 });
          cx.notify();
        }
        return;
      }

      if (this.action === "ai-commit" || this.action === "ai-sync") {
        const res = await runAiSyncPipeline({
          action: this.action,
          root: this.root,
          on,
          onProgress: (patch) => {
            if (patch.status) this.status = patch.status;
            if (patch.detail !== undefined) this.detail = patch.detail;
            if (patch.draft !== undefined) {
              this.draft = patch.draft;
              this.input.set_value(patch.draft);
            }
            if (patch.committedMsg !== undefined) this.committedMsg = patch.committedMsg;
            cx.notify();
          },
        });
        if (res.ok) {
          this.done = true;
          this.status = res.status || "Done ✓";
          if (res.detail !== undefined) this.detail = res.detail;
          if (res.committedMsg !== undefined) this.committedMsg = res.committedMsg;
          cx.notify();
          await cx.sleep(1800);
          this.close();
        } else {
          this.error = res.error || "Action failed";
          this.needEdit = Boolean(res.needEdit);
          if (res.draft !== undefined) {
            this.draft = res.draft;
            this.input.set_value(res.draft);
          }
          cx.notify();
        }
      }
    });
  }

  async commitWithMessage(msg, cx) {
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
      notify({ title: "AI Commit ✓", body: msg.split("\n")[0], level: "success", timeout: 6000 });
      cx.notify();
      if (this.action === "ai-sync") {
        const syncRes = await runAiSyncPipeline({
          action: "sync",
          root: this.root,
          on: this.on,
          onProgress: (patch) => {
            if (patch.status) this.status = patch.status;
            cx.notify();
          },
        });
        if (!syncRes.ok) {
          this.error = syncRes.error;
          cx.notify();
          return false;
        }
      }
      this.done = true;
      await cx.sleep(1800);
      this.close();
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
