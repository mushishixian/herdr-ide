import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec, readTextFile, theme, props, closeOverlay, notify, checking, settings, window as win,
} from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const CONFLICT_DESC = {
  UU: "Both modified",
  AA: "Both added",
  DD: "Both deleted",
  DU: "Deleted by us, modified by them",
  UD: "Modified by us, deleted by them",
  AU: "Added by us, modified by them",
  UA: "Modified by us, added by them",
};

function parseConflicts(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? text.replace(/\r\n/g, "\n") : text;
  const lines = normalized.split("\n");
  const blocks = [];
  let i = 0;
  let hunkIndex = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("<<<<<<<")) {
      const currentLabel = lines[i].slice(7).trim() || "Current";
      const currentLines = [];
      const baseLines = [];
      const incomingLines = [];
      let hasBase = false;
      let inIncoming = false;
      let inBase = false;
      let incomingLabel = "Incoming";
      let end = i + 1;
      let closed = false;
      while (end < lines.length) {
        const l = lines[end];
        if (l.startsWith("|||||||")) {
          hasBase = true;
          inBase = true;
          inIncoming = false;
        } else if (l.startsWith("=======")) {
          inBase = false;
          inIncoming = true;
        } else if (l.startsWith(">>>>>>>")) {
          incomingLabel = l.slice(7).trim() || "Incoming";
          closed = true;
          break;
        } else if (inBase) {
          baseLines.push(l);
        } else if (inIncoming) {
          incomingLines.push(l);
        } else {
          currentLines.push(l);
        }
        end++;
      }
      if (closed) {
        blocks.push({
          kind: "conflict",
          id: hunkIndex++,
          startLine: i + 1,
          currentLabel,
          incomingLabel,
          currentLines,
          baseLines: hasBase ? baseLines : null,
          incomingLines,
          current: currentLines.join("\n"),
          base: hasBase ? baseLines.join("\n") : null,
          incoming: incomingLines.join("\n"),
          raw: lines.slice(i, end + 1).join("\n"),
          choice: null, // null | "current" | "incoming" | "both" | "base"
        });
        i = end + 1;
        continue;
      }
    }
    const start = i;
    while (i < lines.length && !lines[i].startsWith("<<<<<<<")) i++;
    blocks.push({ kind: "text", startLine: start + 1, lines: lines.slice(start, i), text: lines.slice(start, i).join("\n") });
  }
  return { eol, blocks };
}

function resolveHunkText(b) {
  if (b.choice === "current") return b.current;
  if (b.choice === "incoming") return b.incoming;
  if (b.choice === "base") return b.base ?? "";
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
    this.files = []; // [{ path, code }]
    this.activeFile = null;
    this.blocks = [];
    this.eol = "\n";
    this.hunkAt = 0;
    this.topScroll = 0;
    this.botScroll = 0;
    this.pendingScrollToHunk = false;
    this.rawText = "";
    this.fileMissing = false;
    this.hadConflicts = false;
    this.lastResolvedFile = null;
    this.opState = null; // null | "merge" | "rebase" | "cherry-pick" | "revert"
    this.loading = true;
    this.busy = false;
    this.error = null;
    this.handle = cx.focus_handle();

    if (checking()) {
      this.loading = false;
      return;
    }
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.loadConflicts(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  async detectOpState(root, on) {
    const check = (ref) =>
      exec("git", [...READ, "-C", root, "rev-parse", "-q", "--verify", ref], { on, timeout: 4000 })
        .then((r) => r.code === 0)
        .catch(() => false);
    const [merge, rebase, cherry, revert] = await Promise.all([
      check("MERGE_HEAD"),
      check("REBASE_HEAD"),
      check("CHERRY_PICK_HEAD"),
      check("REVERT_HEAD"),
    ]);
    if (merge) return "merge";
    if (rebase) return "rebase";
    if (cherry) return "cherry-pick";
    if (revert) return "revert";
    return null;
  }

  loadConflicts(cx, opts = {}) {
    const { cwd, on } = getContext();
    this.on = on;
    if (!cwd) {
      this.loading = false;
      this.error = "No active folder.";
      cx.notify();
      return;
    }
    const silent = Boolean(opts.silent);
    if (!silent) this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const root = this.root || (await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on })).stdout?.trim();
        if (!root) {
          this.loading = false;
          this.error = "Not a git repository.";
          cx.notify();
          return;
        }
        this.root = root;
        const stPromise = exec("git", [...READ, "-C", this.root, "status", "--porcelain=v1", "-z", "--no-renames"], { on });
        const opPromise = !silent || !this.opState ? this.detectOpState(this.root, on) : Promise.resolve(this.opState);
        const [st, op] = await Promise.all([stPromise, opPromise]);
        const files = [];
        for (const entry of (st.stdout ?? "").split("\0").filter(Boolean)) {
          const x = entry[0], y = entry[1], path = entry.slice(3);
          if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
            files.push({ path, code: `${x}${y}` });
          }
        }
        const finalOp = files.length === 0 ? await this.detectOpState(this.root, on) : op;
        const pick = this.initialFile && files.some((f) => f.path === this.initialFile)
          ? this.initialFile
          : typeof opts.prevIdx === "number" && files.length > 0
            ? files[Math.min(opts.prevIdx, files.length - 1)].path
            : files[0]?.path ?? null;

        let nextState = null;
        if (pick) {
          nextState = await this.readConflictFile(pick);
        }

        this.opState = finalOp;
        this.files = files;
        if (files.length > 0) this.hadConflicts = true;
        this.loading = false;
        this.busy = false;

        if (pick && nextState) {
          this.applyOpenedFile(pick, nextState);
        } else {
          this.activeFile = null;
          this.blocks = [];
        }
        this.error = opts.preserveError ?? nextState?.error ?? null;

        if (this.lastResolvedFile) {
          const doneFile = this.lastResolvedFile;
          this.lastResolvedFile = null;
          if (files.length === 0) {
            notify({
              title: "所有冲突已解决",
              body: finalOp ? `已解决 ${doneFile}，所有冲突已暂存，可点击完成 ${finalOp}` : `已解决 ${doneFile}，当前没有剩余冲突`,
              level: "success",
              timeout: 5000,
            });
          } else {
            notify({
              title: "已解决并暂存",
              body: `${doneFile} 已完成，还剩 ${files.length} 个冲突文件`,
              level: "success",
              timeout: 3000,
            });
          }
        }
        cx.notify();
      } catch (e) {
        this.loading = false;
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  async readConflictFile(path) {
    try {
      const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
      const abs = `${this.root}${sep}${path}`;
      const text = await readTextFile(abs, { on: this.on });
      if (text === null) {
        return { fileMissing: true, rawText: "", eol: "\n", blocks: [], error: null };
      }
      const parsed = parseConflicts(text);
      return { fileMissing: false, rawText: text, eol: parsed.eol, blocks: parsed.blocks, error: null };
    } catch (e) {
      return { fileMissing: false, rawText: "", eol: "\n", blocks: [], error: `Cannot read ${path}: ${e?.message ?? e}` };
    }
  }

  applyOpenedFile(path, state) {
    this.activeFile = path;
    this.hunkAt = 0;
    this.topScroll = 0;
    this.botScroll = 0;
    this.pendingScrollToHunk = true;
    this.fileMissing = state.fileMissing;
    this.rawText = state.rawText;
    this.eol = state.eol;
    this.blocks = state.blocks;
    this.error = state.error;
  }

  async openFile(path, cx) {
    const state = await this.readConflictFile(path);
    this.applyOpenedFile(path, state);
    cx.notify();
  }

  conflicts() {
    return this.blocks.filter((b) => b.kind === "conflict");
  }

  unresolvedCount() {
    return this.conflicts().filter((b) => b.choice === null).length;
  }

  notifyIfFileResolved(prevUnresolved) {
    const nowUnresolved = this.unresolvedCount();
    const total = this.conflicts().length;
    if (prevUnresolved > 0 && nowUnresolved === 0 && total > 0 && this.activeFile) {
      notify({
        title: "当前文件冲突已全部解决",
        body: `${this.activeFile}（共 ${total} 处）已全部选择，按 s 或点击「Save & Stage」保存并暂存`,
        level: "success",
        timeout: 3500,
      });
    }
  }

  setHunkChoice(hunk, choice, cx) {
    if (!hunk) return;
    const prev = this.unresolvedCount();
    hunk.choice = choice;
    this.hunkAt = hunk.id;
    this.notifyIfFileResolved(prev);
    cx?.notify?.();
  }

  setAll(choice, cx) {
    const prev = this.unresolvedCount();
    for (const b of this.blocks) {
      if (b.kind === "conflict") b.choice = choice;
    }
    this.notifyIfFileResolved(prev);
    cx.notify();
  }

  selectHunk(idx, cx) {
    const hunks = this.conflicts();
    if (!hunks.length) return;
    this.hunkAt = ((idx % hunks.length) + hunks.length) % hunks.length;
    this.pendingScrollToHunk = true;
    cx?.notify?.();
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
        if (!this.fileMissing) {
          const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
          const abs = `${this.root}${sep}${this.activeFile}`;
          const joined = this.blocks.map((b) => (b.kind === "text" ? b.text : resolveHunkText(b))).join("\n");
          const out = this.eol === "\r\n" ? joined.replace(/\n/g, "\r\n") : joined;
          if (out !== this.rawText) {
            await saveText(abs, out, this.rawText, this.on);
          }
          const add = await exec("git", ["-C", this.root, "add", "--", this.activeFile], { on: this.on });
          if (add.code !== 0) throw new Error(add.stderr || "git add failed");
        } else {
          const rm = await exec("git", ["-C", this.root, "rm", "--", this.activeFile], { on: this.on });
          if (rm.code !== 0) throw new Error(rm.stderr || "git rm failed");
        }
        const prevIdx = Math.max(0, this.files.findIndex((f) => f.path === this.activeFile));
        bumpGitDirty();
        this.lastResolvedFile = this.activeFile;
        this.initialFile = null;
        this.loadConflicts(cx, { silent: true, prevIdx });
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  resolveSideCheckout(side, cx) {
    if (!this.activeFile || this.busy) return;
    const file = this.activeFile;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const flag = side === "ours" ? "--ours" : "--theirs";
        const co = await exec("git", ["-C", this.root, "checkout", flag, "--", file], { on: this.on });
        if (co.code === 0) {
          const add = await exec("git", ["-C", this.root, "add", "--", file], { on: this.on });
          if (add.code !== 0) throw new Error(add.stderr || "git add failed");
        } else {
          const rm = await exec("git", ["-C", this.root, "rm", "--", file], { on: this.on });
          if (rm.code !== 0) throw new Error(co.stderr || rm.stderr || `Failed to resolve ${side}`);
        }
        const prevIdx = Math.max(0, this.files.findIndex((f) => f.path === file));
        bumpGitDirty();
        this.lastResolvedFile = file;
        this.initialFile = null;
        this.loadConflicts(cx, { silent: true, prevIdx });
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  removeConflictedFile(cx) {
    if (!this.activeFile || this.busy) return;
    const file = this.activeFile;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const rm = await exec("git", ["-C", this.root, "rm", "-f", "--", file], { on: this.on });
        if (rm.code !== 0) throw new Error(rm.stderr || "git rm failed");
        const prevIdx = Math.max(0, this.files.findIndex((f) => f.path === file));
        bumpGitDirty();
        this.lastResolvedFile = file;
        this.initialFile = null;
        this.loadConflicts(cx, { silent: true, prevIdx });
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  runOpAction(kind, cx) {
    if (!this.root || !this.opState || this.busy) return;
    const op = this.opState;
    const args = kind === "abort"
      ? [op, "--abort"]
      : op === "merge"
        ? ["commit", "--no-edit"]
        : ["-c", "core.editor=true", op, "--continue"];
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["-C", this.root, ...args], { on: this.on, timeout: 30000 });
        this.busy = false;
        if (r.code !== 0) {
          const msg = (r.stderr || r.stdout || `git ${args.join(" ")} failed`).trim();
          this.loadConflicts(cx, { silent: true, preserveError: msg });
          return;
        }
        bumpGitDirty();
        const label = kind === "abort" ? `Aborted ${op}` : `Completed ${op}`;
        notify({ title: "Git", body: (r.stdout || label).trim().split("\n")[0], level: kind === "abort" ? "info" : "success" });
        if (kind === "abort") {
          this.close();
        } else {
          this.loadConflicts(cx, { silent: true });
        }
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  openInEditor(cx) {
    if (!this.activeFile || !this.root) return;
    const hunks = this.conflicts();
    const line = hunks[this.hunkAt]?.startLine ?? 1;
    const file = this.activeFile;
    const root = this.root;
    const on = this.on ?? null;
    this.close();
    openInCenterEditor({ file, root, on, line, direct: true }, cx);
  }

  buildAlignedViews() {
    const LINE_H = 21;
    const HDR_H = 30;
    const topRows = [];
    const botRows = [];
    let topY = 0;
    let botY = 0;
    let curLine = 1;
    let incLine = 1;
    let resLine = 1;
    const lastIdx = this.blocks.length - 1;

    for (let bi = 0; bi < this.blocks.length; bi++) {
      const b = this.blocks[bi];
      if (b.kind === "text") {
        const lines = bi === lastIdx && b.lines.length > 0 && b.lines[b.lines.length - 1] === ""
          ? b.lines.slice(0, -1)
          : b.lines;
        for (const ln of lines) {
          topRows.push({ kind: "ctx", y: topY, h: LINE_H, curNo: curLine++, incNo: incLine++, text: ln });
          topY += LINE_H;
          botRows.push({ kind: "ctx", y: botY, h: LINE_H, no: resLine++, text: ln });
          botY += LINE_H;
        }
        continue;
      }

      b._topY = topY;
      topRows.push({ kind: "hdr", y: topY, h: HDR_H, hunk: b });
      topY += HDR_H;

      const curCount = b.currentLines.length;
      const incCount = b.incomingLines.length;
      const span = Math.max(1, curCount, incCount);
      for (let j = 0; j < span; j++) {
        const hasCur = j < curCount;
        const hasInc = j < incCount;
        topRows.push({
          kind: "diff",
          y: topY,
          h: LINE_H,
          hunk: b,
          curNo: hasCur ? curLine++ : null,
          curText: hasCur ? b.currentLines[j] : null,
          incNo: hasInc ? incLine++ : null,
          incText: hasInc ? b.incomingLines[j] : null,
        });
        topY += LINE_H;
      }

      b._botY = botY;
      botRows.push({ kind: "hdr", y: botY, h: 26, hunk: b });
      botY += 26;

      if (b.choice) {
        const resolved = resolveHunkText(b);
        const rLines = resolved === "" ? [] : resolved.split("\n");
        if (rLines.length === 0) {
          botRows.push({ kind: "empty", y: botY, h: LINE_H, hunk: b, text: "(empty — removed)" });
          botY += LINE_H;
        } else {
          for (const ln of rLines) {
            botRows.push({ kind: "res", y: botY, h: LINE_H, hunk: b, no: resLine++, text: ln });
            botY += LINE_H;
          }
        }
      } else {
        const rawLines = b.raw.split("\n");
        for (const ln of rawLines) {
          botRows.push({ kind: "unresolved", y: botY, h: LINE_H, hunk: b, no: resLine++, text: ln });
          botY += LINE_H;
        }
      }
    }

    return { topRows, topTotal: topY, botRows, botTotal: botY };
  }

  render(cx) {
    const t = theme();
    const iconTheme = getIdeSettings().iconTheme;
    const monoFont = settings().font_family ?? "JetBrains Mono";
    const vpH = cx?.viewport_size?.()?.height ?? 900;
    const bodyH = Math.max(480, Math.round(vpH * 0.90) - 98);
    const hunks = this.conflicts();
    const unresolved = this.unresolvedCount();
    const activeEntry = this.files.find((f) => f.path === this.activeFile) ?? null;
    if (hunks.length && this.hunkAt >= hunks.length) this.hunkAt = hunks.length - 1;
    const curHunk = hunks[this.hunkAt] ?? null;

    const topPaneH = Math.round((bodyH - 8) * 0.62);
    const botPaneH = bodyH - 8 - topPaneH;
    const topViewH = Math.max(120, topPaneH - 30);
    const botViewH = Math.max(90, botPaneH - 28);

    const { topRows, topTotal, botRows, botTotal } = hunks.length
      ? this.buildAlignedViews()
      : { topRows: [], topTotal: 0, botRows: [], botTotal: 0 };

    if (this.pendingScrollToHunk && curHunk) {
      this.pendingScrollToHunk = false;
      const ty = curHunk._topY ?? 0;
      if (ty < this.topScroll + 24 || ty > this.topScroll + topViewH - 110) {
        this.topScroll = Math.max(0, ty - 105);
      }
      const by = curHunk._botY ?? 0;
      if (by < this.botScroll + 20 || by > this.botScroll + botViewH - 90) {
        this.botScroll = Math.max(0, by - 84);
      }
    }

    const maxTopScroll = Math.max(0, topTotal - topViewH);
    const maxBotScroll = Math.max(0, botTotal - botViewH);
    this.topScroll = Math.max(0, Math.min(this.topScroll, maxTopScroll));
    this.botScroll = Math.max(0, Math.min(this.botScroll, maxBotScroll));

    const btn = (id, label, active, color, onClick) =>
      div()
        .id(id)
        .px(7)
        .py(2)
        .rounded(5)
        .text_size(11)
        .cursor_pointer()
        .when(active, (el) => el.bg(color ?? t.accent).text_color("#ffffff").font_semibold())
        .when(!active, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(onClick)
        .child(label);

    const renderSideRow = (r, side, paneTag) => {
      if (r.kind === "hdr") {
        const b = r.hunk;
        const active = b.id === this.hunkAt;
        const headerBg = active ? t.selected : t.chrome;
        const titleColor = active ? t.accent : b.choice ? t.ansi2 : t.blocked;
        if (side === "incoming") {
          return h_flex()
            .px(8)
            .gap(6)
            .items_center()
            .bg(headerBg)
            .border_y(1)
            .border_color(active ? t.accent : t.border)
            .on_mouse_down("left", (_e, cx2) => {
              this.hunkAt = b.id;
              cx2.notify();
            })
            .child(div().text_size(11).font_semibold().text_color(t.ansi2).child(`Incoming (${b.incomingLabel})`))
            .child(div().flex_1())
            .child(btn(`me-inc-${b.id}`, "Accept Incoming (2)", b.choice === "incoming", t.ansi2, (_e, cx2) => {
              this.setHunkChoice(b, "incoming", cx2);
            }));
        }
        return h_flex()
          .px(8)
          .gap(5)
          .items_center()
          .bg(headerBg)
          .border_y(1)
          .border_color(active ? t.accent : t.border)
          .on_mouse_down("left", (_e, cx2) => {
            this.hunkAt = b.id;
            cx2.notify();
          })
          .child(
            div()
              .text_size(11)
              .font_semibold()
              .text_color(titleColor)
              .child(`${active ? "▸ " : ""}#${b.id + 1} (${b.currentLabel})`),
          )
          .child(div().flex_1())
          .child(btn(`me-cur-${b.id}`, "Current (1)", b.choice === "current", t.ansi4, (_e, cx2) => {
            this.setHunkChoice(b, "current", cx2);
          }))
          .child(btn(`me-both-${b.id}`, "Both (3)", b.choice === "both", t.accent, (_e, cx2) => {
            this.setHunkChoice(b, "both", cx2);
          }))
          .when(b.base !== null, (el2) =>
            el2.child(btn(`me-base-${b.id}`, "Base (4)", b.choice === "base", t.ansi3, (_e, cx2) => {
              this.setHunkChoice(b, "base", cx2);
            })),
          )
          .when(Boolean(b.choice), (el2) =>
            el2.child(btn(`me-rst-${b.id}`, "Reset", false, null, (_e, cx2) => {
              this.setHunkChoice(b, null, cx2);
            })),
          );
      }

      if (r.kind === "ctx") {
        const no = side === "current" ? r.curNo : r.incNo;
        return h_flex()
          .px(6)
          .gap(8)
          .items_center()
          .font_family(monoFont)
          .text_size(12)
          .child(div().w(36).flex_none().text_right().text_size(11).text_color(t.dim).child(String(no)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.text || " "));
      }

      const isCur = side === "current";
      const no = isCur ? r.curNo : r.incNo;
      const text = isCur ? r.curText : r.incText;
      const picked = isCur
        ? r.hunk.choice === "current" || r.hunk.choice === "both"
        : r.hunk.choice === "incoming" || r.hunk.choice === "both";
      const rowBg = text === null
        ? t.surface
        : isCur
          ? (picked ? t.ansi4 + "28" : t.ansi4 + "14")
          : (picked ? t.ansi2 + "28" : t.ansi2 + "14");
      return h_flex()
        .id(`me-${paneTag}-${r.y}`)
        .px(6)
        .gap(8)
        .items_center()
        .bg(rowBg)
        .font_family(monoFont)
        .text_size(12)
        .on_mouse_down("left", (_e, cx2) => {
          this.hunkAt = r.hunk.id;
          cx2.notify();
        })
        .child(div().w(36).flex_none().text_right().text_size(11).text_color(t.dim).child(no !== null ? String(no) : ""))
        .child(div().flex_1().min_w(0).truncate().text_color(text !== null ? t.foreground : t.dim).child(text !== null ? (text || " ") : " "));
    };

    const renderBotRow = (r) => {
      if (r.kind === "hdr") {
        const b = r.hunk;
        const active = b.id === this.hunkAt;
        return h_flex()
          .px(8)
          .gap(6)
          .items_center()
          .bg(active ? t.selected : t.chrome)
          .border_y(1)
          .border_color(active ? t.accent : t.border)
          .on_mouse_down("left", (_e, cx2) => {
            this.selectHunk(b.id, cx2);
          })
          .child(
            div()
              .text_size(11)
              .font_semibold()
              .text_color(b.choice ? t.ansi2 : t.blocked)
              .child(b.choice ? `✓ Conflict #${b.id + 1} resolved (${b.choice})` : `! Conflict #${b.id + 1} unresolved — click or press 1/2/3`),
          );
      }
      const bg = r.kind === "res"
        ? t.ansi2 + "18"
        : r.kind === "unresolved" || r.kind === "empty"
          ? t.blocked + "18"
          : null;
      const fg = r.kind === "ctx" ? t.muted : r.kind === "empty" ? t.dim : t.foreground;
      return h_flex()
        .px(6)
        .gap(8)
        .items_center()
        .when(Boolean(bg), (el) => el.bg(bg))
        .when(Boolean(r.hunk), (el) =>
          el.on_mouse_down("left", (_e, cx2) => {
            this.selectHunk(r.hunk.id, cx2);
          }),
        )
        .font_family(monoFont)
        .text_size(12)
        .child(div().w(36).flex_none().text_right().text_size(11).text_color(t.dim).child(r.no !== undefined ? String(r.no) : ""))
        .child(div().flex_1().min_w(0).truncate().text_color(fg).child(r.text || " "));
    };

    const placeRow = (el, r, scroll, viewH) =>
      el.absolute().left(0).right(0).top(r.y - scroll).bottom(viewH - (r.y + r.h - scroll));

    const visibleTop = topRows.filter((r) => r.y + r.h > this.topScroll && r.y < this.topScroll + topViewH);
    const visibleBot = botRows.filter((r) => r.y + r.h > this.botScroll && r.y < this.botScroll + botViewH);

    return v_flex()
      .id("merge-editor-popup")
      .track_focus(this.handle)
      .w_full()
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .on_key_down((e, cx2) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "e" && this.activeFile) {
          this.openInEditor(cx2);
          cx2.stop_propagation();
          return;
        }
        if ((k === "[" || k === "]") && this.files.length > 1) {
          const curIdx = Math.max(0, this.files.findIndex((f) => f.path === this.activeFile));
          const nextIdx = (curIdx + (k === "]" ? 1 : this.files.length - 1)) % this.files.length;
          cx2.spawn(async (cx3) => this.openFile(this.files[nextIdx].path, cx3));
          cx2.stop_propagation();
          return;
        }
        if (k === "s" && this.activeFile && (hunks.length === 0 || unresolved === 0)) {
          this.saveAndStage(cx2);
          cx2.stop_propagation();
          return;
        }
        if (!hunks.length) return;
        if (k === "down" || k === "j") {
          this.selectHunk(this.hunkAt + 1, cx2);
          cx2.stop_propagation();
          return;
        }
        if (k === "up" || k === "k") {
          this.selectHunk(this.hunkAt - 1, cx2);
          cx2.stop_propagation();
          return;
        }
        if (k === "1") this.setHunkChoice(hunks[this.hunkAt], "current", cx2);
        else if (k === "2") this.setHunkChoice(hunks[this.hunkAt], "incoming", cx2);
        else if (k === "3") this.setHunkChoice(hunks[this.hunkAt], "both", cx2);
        else if (k === "4" && hunks[this.hunkAt].base !== null) this.setHunkChoice(hunks[this.hunkAt], "base", cx2);
        else if (k === "0" || k === "r") this.setHunkChoice(hunks[this.hunkAt], null, cx2);
        else return;
        cx2.stop_propagation();
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/workspace-chrome/git-compare.svg").size(15).text_color(t.accent))
          .child(div().font_semibold().text_size(14).text_color(t.foreground).child("3-Way Merge Editor"))
          .when(Boolean(this.opState), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.blocked + "26").text_size(11).font_semibold().text_color(t.blocked).child(this.opState.toUpperCase())),
          )
          .when(Boolean(this.on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(this.on)),
          )
          .when(this.files.length > 0, (el) =>
            el.child(
              div()
                .px(7)
                .py(2)
                .rounded(4)
                .bg((hunks.length > 0 && unresolved === 0 ? t.ansi2 : t.blocked) + "24")
                .text_size(11)
                .font_semibold()
                .text_color(hunks.length > 0 && unresolved === 0 ? t.ansi2 : t.blocked)
                .child(
                  hunks.length > 0
                    ? (unresolved === 0
                        ? `✓ 本文件已解决 (${hunks.length}/${hunks.length}) · 剩 ${this.files.length} 个文件`
                        : `本文件剩 ${unresolved}/${hunks.length} 处 · 共 ${this.files.length} 个文件`)
                    : `待处理文件 · 共 ${this.files.length} 个`,
                ),
            ),
          )
          .when(hunks.length > 0, (el) =>
            el
              .child(btn("me-prev-hunk", "↑ Prev", false, null, (_e, cx2) => this.selectHunk(this.hunkAt - 1, cx2)))
              .child(div().text_size(11).text_color(t.dim).child(`${this.hunkAt + 1}/${hunks.length}`))
              .child(btn("me-next-hunk", "↓ Next", false, null, (_e, cx2) => this.selectHunk(this.hunkAt + 1, cx2))),
          )
          .child(div().flex_1())
          .when(Boolean(this.activeFile), (el) =>
            el
              .when(hunks.length > 0, (el2) =>
                el2
                  .child(btn("me-all-cur", "All Current", false, t.ansi4, (_e, cx2) => this.setAll("current", cx2)))
                  .child(btn("me-all-inc", "All Incoming", false, t.ansi2, (_e, cx2) => this.setAll("incoming", cx2)))
                  .child(btn("me-all-both", "All Both", false, t.accent, (_e, cx2) => this.setAll("both", cx2))),
              )
              .when(!this.fileMissing, (el2) =>
                el2.child(btn("me-open-ed", "Editor (e)", false, null, (_e, cx2) => this.openInEditor(cx2))),
              )
              .when(hunks.length > 0 || !this.fileMissing, (el2) =>
                el2.child(
                  btn(
                    "me-save",
                    this.busy ? "Saving…" : unresolved === 0 ? "Save & Stage (s)" : `${unresolved} unresolved`,
                    unresolved === 0,
                    t.accent,
                    (_e, cx2) => this.saveAndStage(cx2),
                  ),
                ),
              ),
          )
          .when(Boolean(this.opState), (el) =>
            el.child(btn("me-abort-op", `Abort ${this.opState}`, false, t.blocked, (_e, cx2) => this.runOpAction("abort", cx2))),
          )
          .child(btn("me-esc", "Esc", false, null, () => this.close())),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(this.loading, (el) =>
        el.child(
          v_flex()
            .w_full()
            .h(bodyH)
            .items_center()
            .justify_center()
            .rounded(8)
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .child(div().text_color(t.muted).child("Scanning conflicted files…")),
        ),
      )
      .when(!this.loading && this.files.length === 0, (el) =>
        el.child(
          v_flex()
            .w_full()
            .h(bodyH)
            .items_center()
            .justify_center()
            .gap(10)
            .rounded(8)
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .child(div().text_size(15).font_semibold().text_color(this.hadConflicts || this.opState ? t.ansi2 : t.foreground).child(this.hadConflicts || this.opState ? "✓ 所有冲突已解决" : "No merge conflicts found"))
            .child(
              div()
                .text_size(12)
                .text_color(t.dim)
                .child(
                  this.opState
                    ? `所有冲突文件已暂存，可以完成 ${this.opState}。`
                    : this.hadConflicts
                      ? "所有冲突已解决并暂存，可以关闭窗口。"
                      : "Working tree has no unmerged (U) paths.",
                ),
            )
            .when(Boolean(this.opState), (el2) =>
              el2.child(
                h_flex()
                  .pt(6)
                  .gap(8)
                  .child(
                    btn(
                      "me-finish-op",
                      this.opState === "merge" ? "Complete Merge (Commit)" : `Continue ${this.opState}`,
                      true,
                      t.ansi2,
                      (_e, cx2) => this.runOpAction("continue", cx2),
                    ),
                  )
                  .child(btn("me-abort-done", `Abort ${this.opState}`, false, t.blocked, (_e, cx2) => this.runOpAction("abort", cx2))),
              ),
            )
            .when(!this.opState && this.hadConflicts, (el2) =>
              el2.child(btn("me-done-close", "完成并关闭 (Esc)", true, t.ansi2, () => this.close())),
            ),
        ),
      )
      .when(!this.loading && this.files.length > 0, (el) =>
        el.child(
          h_flex()
            .w_full()
            .h(bodyH)
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
                .gap(4)
                .child(div().px(6).py(4).text_size(11).font_semibold().text_color(t.dim).child(`CONFLICTED (${this.files.length})`))
                .child(
                  div()
                    .flex_1()
                    .min_h(0)
                    .relative()
                    .child(
                      div()
                        .absolute()
                        .inset_0()
                        .overflow_y_scroll()
                        .child(
                          v_flex().gap(2).children(
                            this.files.map((f, idx) => {
                              const name = f.path.split(/[\\/]/).pop();
                              const isSel = f.path === this.activeFile;
                              return h_flex()
                                .id(`me-file-${idx}`)
                                .px(8)
                                .py(5)
                                .gap(6)
                                .items_center()
                                .rounded(6)
                                .cursor_pointer()
                                .when(isSel, (el2) => el2.bg(t.selected).text_color(t.foreground).font_semibold())
                                .when(!isSel, (el2) => el2.text_color(t.muted).hover((s) => s.bg(t.hover)))
                                .on_click((_e, cx2) => {
                                  cx2.spawn(async (cx3) => this.openFile(f.path, cx3));
                                })
                                .child(renderFileIcon(div, svg, name, false, false, iconTheme, t))
                                .child(div().flex_1().min_w(0).truncate().text_size(12).child(f.path))
                                .child(div().flex_none().px(4).py(1).rounded(3).bg(t.blocked + "26").text_size(10).text_color(t.blocked).child(f.code));
                            }),
                          ),
                        ),
                    ),
                ),
            )
            .when(hunks.length === 0 && Boolean(activeEntry), (el2) =>
              el2.child(
                v_flex()
                  .flex_1()
                  .h_full()
                  .min_w(0)
                  .rounded(8)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .p(16)
                  .gap(12)
                  .child(
                    h_flex()
                      .items_center()
                      .gap(8)
                      .child(div().px(6).py(2).rounded(4).bg(t.blocked + "26").text_size(11).font_semibold().text_color(t.blocked).child(activeEntry.code))
                      .child(div().font_semibold().text_size(13.5).text_color(t.foreground).child(`${this.activeFile} — ${CONFLICT_DESC[activeEntry.code] ?? "Unmerged file without conflict markers"}`)),
                  )
                  .child(
                    div()
                      .text_size(12)
                      .text_color(t.muted)
                      .child(
                        this.fileMissing
                          ? "This file is not present in the working tree. Keep the other side or delete and stage the removal."
                          : "No <<<<<<< conflict markers were found in this file. Choose a side, stage the current working file, or delete it.",
                      ),
                  )
                  .child(
                    h_flex()
                      .pt(4)
                      .gap(8)
                      .child(btn("me-side-ours", "Use Current (--ours)", true, t.ansi4, (_e, cx2) => this.resolveSideCheckout("ours", cx2)))
                      .child(btn("me-side-theirs", "Use Incoming (--theirs)", true, t.ansi2, (_e, cx2) => this.resolveSideCheckout("theirs", cx2)))
                      .when(!this.fileMissing, (el3) =>
                        el3.child(btn("me-stage-plain", "Stage Current File (git add)", false, t.accent, (_e, cx2) => this.saveAndStage(cx2))),
                      )
                      .child(btn("me-rm-plain", "Delete File (git rm)", false, t.blocked, (_e, cx2) => this.removeConflictedFile(cx2))),
                  ),
              ),
            )
            .when(hunks.length > 0, (el2) =>
              el2.child(
                v_flex()
                  .flex_1()
                  .h_full()
                  .min_w(0)
                  .gap(8)
                  .child(
                    h_flex()
                      .w_full()
                      .h(topPaneH)
                      .gap(8)
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
                              .h(28)
                              .flex_none()
                              .px(10)
                              .gap(8)
                              .items_center()
                              .bg(t.chrome)
                              .border_b(1)
                              .border_color(t.border)
                              .child(div().text_size(11.5).font_semibold().text_color(t.ansi4).child(`Current (${curHunk?.currentLabel ?? "HEAD"})`))
                              .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(this.activeFile ?? "")),
                          )
                          .child(
                            div()
                              .id("me-top-cur")
                              .w_full()
                              .h(topViewH)
                              .relative()
                              .overflow_hidden()
                              .on_scroll_wheel((e, cx2) => {
                                this.topScroll = Math.max(0, Math.min(this.topScroll - e.delta.y, maxTopScroll));
                                cx2.notify();
                              })
                              .children(visibleTop.map((r) => placeRow(renderSideRow(r, "current", "c"), r, this.topScroll, topViewH))),
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
                              .h(28)
                              .flex_none()
                              .px(10)
                              .gap(8)
                              .items_center()
                              .bg(t.chrome)
                              .border_b(1)
                              .border_color(t.border)
                              .child(div().text_size(11.5).font_semibold().text_color(t.ansi2).child(`Incoming (${curHunk?.incomingLabel ?? "incoming"})`))
                              .child(div().flex_1()),
                          )
                          .child(
                            div()
                              .id("me-top-inc")
                              .w_full()
                              .h(topViewH)
                              .relative()
                              .overflow_hidden()
                              .on_scroll_wheel((e, cx2) => {
                                this.topScroll = Math.max(0, Math.min(this.topScroll - e.delta.y, maxTopScroll));
                                cx2.notify();
                              })
                              .children(visibleTop.map((r) => placeRow(renderSideRow(r, "incoming", "i"), r, this.topScroll, topViewH))),
                          ),
                      ),
                  )
                  .child(
                    v_flex()
                      .w_full()
                      .h(botPaneH)
                      .rounded(8)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.background)
                      .overflow_hidden()
                      .child(
                        h_flex()
                          .h(26)
                          .flex_none()
                          .px(10)
                          .gap(8)
                          .items_center()
                          .bg(t.chrome)
                          .border_b(1)
                          .border_color(t.border)
                          .child(div().text_size(11.5).font_semibold().text_color(unresolved === 0 ? t.ansi2 : t.foreground).child("Result"))
                          .child(
                            div()
                              .text_size(11)
                              .font_semibold()
                              .text_color(unresolved === 0 ? t.ansi2 : t.blocked)
                              .child(
                                unresolved === 0
                                  ? `✓ 当前文件所有冲突已解决（${hunks.length}/${hunks.length}）— 按 s 或点击「Save & Stage」保存并暂存`
                                  : `还剩 ${unresolved} 个冲突需要解决（共 ${hunks.length} 处）`,
                              ),
                          ),
                      )
                      .child(
                        div()
                          .id("me-bot-res")
                          .w_full()
                          .h(botViewH)
                          .relative()
                          .overflow_hidden()
                          .on_scroll_wheel((e, cx2) => {
                            this.botScroll = Math.max(0, Math.min(this.botScroll - e.delta.y, maxBotScroll));
                            cx2.notify();
                          })
                          .children(visibleBot.map((r) => placeRow(renderBotRow(r), r, this.botScroll, botViewH))),
                      ),
                  ),
              ),
            ),
        ),
      )
      .child(
        h_flex()
          .text_size(11)
          .text_color(t.dim)
          .child(div().flex_1().truncate().child("↑↓/jk hunk · 1 Current · 2 Incoming · 3 Both · 4 Base · [/] file · e Editor · s Save & Stage · Scroll anywhere · Esc close")),
      );
  }
}
