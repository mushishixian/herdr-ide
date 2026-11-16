import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  spaces, panes, focused, exec, theme, props, closeOverlay,
  notify, checking, readTextFile, appHome,
} from "herdr";

function summarizeDiffStat(statOut) {
  const lines = statOut.split("\n").map((l) => l.trim()).filter(Boolean);
  const files = lines
    .filter((l) => l.includes("|"))
    .map((l) => l.split("|")[0].trim().split("/").pop())
    .slice(0, 4);
  if (!files.length) return "chore: update repository files";
  return `chore: update ${files.join(", ")}`;
}

export default class GitQuickAction extends View {
  init(p, cx) {
    this.action = p?.action || "pull";
    this.status = "Running…";
    this.detail = "";
    this.error = null;
    this.draft = "";
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

      if (this.action === "pull") {
        this.status = "Pulling from remote…";
        cx.notify();
        const r = await this.git(["pull"], this.root, on);
        if (r.ok) {
          notify({ title: "Git Pull", body: r.out || "Already up to date.", level: "success" });
          this.close();
        } else {
          this.error = r.err || r.out || "git pull failed";
          notify({ title: "Git Pull Failed", body: this.error, level: "error" });
          cx.notify();
        }
        return;
      }

      if (this.action === "push") {
        this.status = "Pushing to remote…";
        cx.notify();
        let r = await this.git(["push"], this.root, on);
        if (!r.ok && (r.err.includes("no upstream") || r.err.includes("set-upstream"))) {
          const br = await this.git(["symbolic-ref", "--short", "HEAD"], this.root, on);
          if (br.ok) {
            r = await this.git(["push", "-u", "origin", br.out], this.root, on);
          }
        }
        if (r.ok) {
          notify({ title: "Git Push", body: r.err || r.out || "Push complete.", level: "success" });
          this.close();
        } else {
          this.error = r.err || r.out || "git push failed";
          notify({ title: "Git Push Failed", body: this.error, level: "error" });
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
          notify({
            title: "Undo Last Commit",
            body: `Reset ${head.out} (${subj.out}). Changes kept staged.\nRecover: git reset --soft ${head.out}`,
            level: "info",
          });
          this.close();
        } else {
          this.error = r.err || r.out || "git reset --soft HEAD~1 failed";
          cx.notify();
        }
        return;
      }

      if (this.action === "ai-commit") {
        this.status = "Staging & drafting AI commit message…";
        cx.notify();
        const add = await this.git(["add", "-A"], this.root, on);
        if (!add.ok) {
          this.error = add.err || "git add -A failed";
          cx.notify();
          return;
        }
        const diff = await this.git(["diff", "--cached", "--stat"], this.root, on);
        if (!diff.out) {
          this.error = "Nothing to commit (working tree clean).";
          cx.notify();
          return;
        }
        const patch = await this.git(["diff", "--cached", "--no-color"], this.root, on);
        const msg = await this.generateAiMessage(diff.out, patch.out.slice(0, 6000));
        this.draft = msg;
        this.input.set_value(msg);
        this.needEdit = true;
        this.status = "Review AI commit message (Enter to commit):";
        this.input.focus();
        cx.notify();
      }
    });
  }

  async generateAiMessage(stat, patch) {
    // 1. Try OpenAI-compatible config in ~/.config/herdr-app/ai-commit.json
    try {
      const raw = await readTextFile(`${appHome()}/ai-commit.json`);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg.api_key) {
          const base = (cfg.api_url || "https://api.openai.com/v1").replace(/\/+$/, "");
          const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
          const payload = JSON.stringify({
            model: cfg.model || "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "Write a concise Conventional Commit subject line (max 72 chars, imperative mood, no quotes or markdown) summarizing the git diff.",
              },
              { role: "user", content: `Stat:\n${stat}\n\nDiff:\n${patch}` },
            ],
          });
          const resp = await exec("curl", [
            "-sS", "-X", "POST", url,
            "-H", "Content-Type: application/json",
            "-H", `Authorization: Bearer ${cfg.api_key}`,
            "-d", payload,
          ], { timeout: 15000 });
          if (resp.code === 0 && resp.stdout) {
            const data = JSON.parse(resp.stdout);
            const text = data?.choices?.[0]?.message?.content?.trim();
            if (text) return text.split("\n")[0].replace(/^["'`]+|["'`]+$/g, "");
          }
        }
      }
    } catch {}

    // 2. Fallback to claude CLI if installed on target machine
    try {
      const claude = await exec(
        "claude",
        ["-p", `Write ONE concise Conventional Commit message line (max 72 chars, no markdown) for:\n${stat}\n\n${patch.slice(0, 3500)}`],
        { cwd: this.root, on: this.on, timeout: 15000 },
      );
      if (claude.code === 0 && claude.stdout.trim()) {
        return claude.stdout.trim().split("\n")[0].replace(/^["'`]+|["'`]+$/g, "");
      }
    } catch {}

    // 3. Deterministic fallback from changed filenames
    return summarizeDiffStat(stat);
  }

  commitWithMessage(msg, cx) {
    if (!msg || !this.root) return;
    this.status = "Committing…";
    this.needEdit = false;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.git(["commit", "-m", msg], this.root, this.on);
      if (r.ok) {
        notify({ title: "Git Commit", body: msg, level: "success" });
        this.close();
      } else {
        this.error = r.err || r.out || "git commit failed";
        this.needEdit = true;
        cx.notify();
      }
    });
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
      .text_size(13)
      .on_key_down((e) => {
        if (e.key === "escape") this.close();
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/workspace-chrome/branch.svg").size(15).text_color(t.accent))
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(this.error ? "Git Action Error" : this.status))
          .child(
            div()
              .id("gqa-esc")
              .px(6)
              .py(2)
              .rounded(4)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
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
