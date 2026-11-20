import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, ScrollHandle } from "gpui-base";
import {
  spaces, panes, terminals, focused, exec, readTextFile, writeTextFile, watchFolder,
  theme, settings, openOverlay, notify, checking, appHome, window as win,
  run, shared, setShared, nextCommand,
} from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

function locationKey() {
  const l = getContext();
  return JSON.stringify({ cwd: l.cwd, on: l.on, space: l.space?.id });
}

const NODE_LS = 'const fs=require("fs");const o={};for(const p of process.argv.slice(1)){try{o[p]=fs.readdirSync(p,{withFileTypes:true}).filter(d=>d.name!==".git").slice(0,500).map(d=>[d.name,d.isDirectory()?1:0])}catch(e){o[p]=null}}process.stdout.write(JSON.stringify(o))';

// One node spawn lists every folder at once: PowerShell takes ~1s to start, node ~150ms,
// and a refresh would otherwise spawn one shell per expanded folder.
async function listMany(paths, on) {
  if (!on && win()?.platform === "windows") {
    const r = await exec("node", ["-e", NODE_LS, ...paths], { on }).catch(() => null);
    if (r && r.code === 0) {
      try {
        const map = JSON.parse(r.stdout || "{}");
        return paths.map((path) => {
          const items = map[path];
          if (!Array.isArray(items)) throw new Error("Cannot list folder");
          return items.map(([name, dir]) => ({ name, dir: dir === 1 }));
        });
      } catch {}
    }
  }
  return Promise.all(paths.map((path) => listDirectory(path, on)));
}

async function listDirectory(path, on) {
  if (!on && win()?.platform === "windows") {
    const r = await exec(
      "powershell",
      ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 500 | ForEach-Object { @{ name=$_.Name; dir=$_.PSIsContainer } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"],
      { on },
    );
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list folder");
    const res = JSON.parse(r.stdout || "[]");
    return Array.isArray(res) ? res : [res];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class IdeSidebar extends View {
  init(p, cx) {
    this.view = p?.view || "scm"; // "explorer" | "search" | "scm" | "settings"
    this.entries = new Map();
    this.folders = new Set();
    this.pendingFolders = new Set();
    this.marks = {};
    this.newPrompt = null; // null | "file" | "dir"
    this.confirmDel = null;
    this.confirmGit = null; // { prompt, args, title }
    this.renameFrom = null;
    this.clipboard = null; // { mode: "copy" | "cut", path }
    this.lastMenuSeq = shared("ide.menu.action")?.seq ?? 0;
    this.lastDirtySeq = shared("ide.git.dirtySeq") ?? 0;
    this.lastJumpSeq = shared("ide.terminalEditor.jump")?.seq ?? 0;
    this.lastRevealSeq = shared("ide.explorer.reveal")?.seq ?? 0;
    this.treeScroll = ScrollHandle.new();
    this.activeFile = null;
    this.lastAutoRevealedFile = null;
    this.pendingRevealPath = null;
    this.lastHerdrRevealAt = 0;
    this.lastFreshRaw = null;
    this.lastFreshFile = null;
    this.probingFreshActive = false;
    this.lastFreshProbeAt = 0;
    this.loadSeq = 0;
    this.explorerSeq = 0;
    this.bgJobsByRepo = new Map();
    this.seenTabPanes = new Map();
    this.lastStatusRaw = null;

    // SCM state
    this.branch = null;
    this.ahead = 0;
    this.behind = 0;
    this.hasUpstream = false;
    this.lastCoolKey = null;
    this.lastFetchAt = 0;
    this.fetching = false;
    this.conflicts = [];
    this.staged = [];
    this.unstaged = [];
    this.commits = [];
    this.stashes = [];
    this.showCommits = false;
    this.showStashes = false;
    this.busy = false;
    this.error = null;
    this.note = null;
    this.aiNotice = null;
    this.message = "";
    this.thinking = "off";
    this.autoTriedSpaces = new Set();

    // Search state
    this.searchResults = [];
    this.searchBusy = false;

    this.handle = cx.focus_handle();
    this.commitInput = InputState.new({ placeholder: "Commit message (Ctrl+Enter)…" });
    this.commitInput.on("change", (_e, cx) => { this.message = this.commitInput.value(); cx.notify(); });
    this.commitInput.on("submit", (_e, cx) => this.commit(cx));

    this.newNameInput = InputState.new({ placeholder: "Relative path (e.g. src/foo.ts)…" });
    this.newNameInput.on("submit", (_e, cx) => this.createItem(cx));

    this.renameInput = InputState.new({ placeholder: "New path…" });
    this.renameInput.on("submit", (_e, cx) => this.finishRename(cx));

    this.searchInput = InputState.new({ placeholder: "Search in repo…" });
    this.searchInput.on("submit", (_e, cx) => this.runInlineSearch(cx));

    this.aiUrlInput = InputState.new({ placeholder: "https://api.openai.com/v1" });
    this.aiKeyInput = InputState.new({ placeholder: "API Key (sk-…)" });
    this.aiModelInput = InputState.new({ placeholder: "gpt-4o-mini" });

    if (checking()) return;
    setShared("ide.sidebar.alive", true);
    setShared("ide.recent.overlay", null);
    setShared("ide.glh.open", null);
    setShared("ide.diff.overlay", null);
    // Global keystrokes reach the sidebar (always shown) as <mod>.<command>
    // via keys.json: ctrl-tab switches recent files, and ctrl-alt-o relays the
    // Fresh editor's line-history request (git_line_history.ts writes it and
    // runs `herdr-app.exe do ide-sidebar.lineHistory`).
    cx.spawn(async (cx2) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "recent") this.switchRecentFile(cx2);
        else if (cmd === "lineHistory") this.openFreshLineHistory(cx2);
        else if (cmd === "aiCommit") this.startBgGitJob("ai-commit", cx2);
        else if (cmd === "aiSync") this.startBgGitJob("ai-sync", cx2);
        else if (cmd === "sync") this.startBgGitJob("sync", cx2);
        else if (cmd === "toggleTerminal") toggleBottomTerminal(cx2);
        cx2.notify();
      }
    });
    this.bootPromise = this.bootSettings(cx);
    this.refresh(cx);
    cx.spawn(async (cx2) => syncAgentSessions(cx2));
    cx.timer.every(25, (cx2) => this.pollSharedSignals(cx2));
    cx.timer.every(1500, (cx) => {
      if (!checking()) {
        this.syncWorkPane();
        cx.spawn(async (cx2) => syncAgentSessions(cx2));
      }
      if (locationKey() !== this.context) {
        this.refresh(cx);
      } else if (this.view === "scm" && this.root && !this.loading && !this.probing) {
        this.probeStatus(cx);
      }
      const cfg = getIdeSettings();
      const now = Date.now();
      if (!this.lastTick || now - this.lastTick >= cfg.refreshSec * 1000) {
        this.lastTick = now;
        this.refresh(cx);
      }
      const { space, on: ctxOn } = getContext();
      if (space) {
        recordWorkspaceSnapshot(space, this.root, this.view);
        const activeTab = space.tabs?.find((t) => t.active)?.id;
        if (activeTab) {
          const sig = panes().filter((p) => p.tab === activeTab).map((p) => p.pane).join(",");
          if (this.seenTabPanes.get(activeTab) !== sig) {
            this.seenTabPanes.set(activeTab, sig);
            enforceTabEditorOrderAndMouse(activeTab, cfg);
          } else {
            for (const p of panes().filter((x) => x.tab === activeTab && x.terminal && editorEngineOf(x) !== "")) {
              syncEditorRightClick(p);
            }
          }
          const edRoot = this.root || this.cwd || space.folder;
          if ((ctxOn !== null || win()?.platform !== "windows") && edRoot) {
            const daemonName = `ide-${shortHash(`${activeTab}:${edRoot}`)}`;
            const coolKey = `${daemonName}:${cfg.coolInactiveFresh ? 1 : 0}`;
            if (coolKey !== this.lastCoolKey) {
              this.lastCoolKey = coolKey;
              cx.spawn(async () => syncFreshCooling(daemonName, cfg.coolInactiveFresh, ctxOn));
            }
          }
        }
      }
      if (cfg.fetchSec > 0 && this.root && this.hasUpstream && !this.fetching && (!this.lastFetchAt || now - this.lastFetchAt >= cfg.fetchSec * 1000)) {
        this.lastFetchAt = now;
        this.fetching = true;
        const fRoot = this.root;
        const fOn = this.on;
        cx.spawn(async (cx2) => {
          try {
            await exec("git", ["fetch", "--quiet"], { cwd: fRoot, on: fOn, timeout: 15000 }).catch(() => {});
            this.probeStatus(cx2);
          } finally {
            this.fetching = false;
          }
        });
      }
    });
  }

  startBgGitJob(action, cx) {
    const { cwd, on } = getContext();
    if (!cwd) {
      notify({ title: "Git", body: "No active folder or workspace.", level: "warning", timeout: 3000 });
      return;
    }
    cx.spawn(async (cx2) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      if (!top || top.code !== 0 || !top.stdout.trim()) {
        notify({ title: "Git", body: "Current folder is not a git repository.", level: "warning", timeout: 3000 });
        return;
      }
      const jobRoot = top.stdout.trim();
      const jobKey = `${on ?? "local"}:${jobRoot}`;
      if (this.bgJobsByRepo.has(jobKey)) {
        notify({
          title: "Git 任务进行中",
          body: `${jobRoot.split(/[\\/]/).pop()} 正在执行 ${this.bgJobsByRepo.get(jobKey)}，请稍候…`,
          level: "info",
          timeout: 2500,
        });
        return;
      }
      const initialLabel = action === "ai-sync" ? "AI Sync…" : action === "ai-commit" ? "AI Commit…" : "Syncing…";
      this.bgJobsByRepo.set(jobKey, initialLabel);
      if (action === "ai-commit" || action === "ai-sync") {
        notify({
          title: action === "ai-sync" ? "AI Commit & Sync" : "AI Commit",
          body: "已在后台开始执行（切换窗口或按 Esc 不会打断）…",
          level: "info",
          timeout: 2500,
        });
      }
      cx2.notify();
      try {
        await runAiSyncPipeline({
          action,
          root: jobRoot,
          on,
          onProgress: (patch) => {
            if (patch?.status) {
              const shortLabel = patch.status.includes("Pull") ? "Pulling…"
                : patch.status.includes("Push") ? "Pushing…"
                : patch.status.includes("Generating") ? "AI…"
                : patch.status.includes("Commit") ? "Committing…"
                : initialLabel;
              this.bgJobsByRepo.set(jobKey, shortLabel);
              cx2.notify();
            }
          },
        });
      } finally {
        this.bgJobsByRepo.delete(jobKey);
        if ((this.root || this.cwd) === jobRoot && this.on === on) {
          this.refresh(cx2);
        } else {
          cx2.notify();
        }
      }
    });
  }

  // Ctrl+Tab: a popup list of the active tab's recent files (ide.ws.history,
  // written by openInCenterEditor for every engine). Another ctrl-tab while
  // the list is up cycles the selection; Enter or a click reopens the file.
  switchRecentFile(cx) {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active);
    const tabPanes = panes().filter((p) => !tab || p.tab === tab.id);
    const editorPane = tabPanes.find((p) => isEditorPane(p, shared("ide.editor.paneByTab")?.[tab?.id]));
    const root = editorPane?.cwd || space?.folder || "";
    const files = shared("ide.ws.history")?.[wsHistoryKey(space, root)]?.lastFiles ?? [];
    if (!files.length) {
      notify({ title: "Recent files", body: "Open a file first.", level: "info", timeout: 2500 });
      return;
    }
    if (shared("ide.recent.overlay")) return run("ide-recent.cycle");
    run("mod.open", { name: "ide-recent" });
  }

  // Ctrl+Alt+O from the Fresh editor: its plugin writes the selected range to
  // <state>/fresh-ide/line-history-request.json and runs
  // `herdr-app.exe do ide-sidebar.lineHistory`. Show the popup from that file;
  // without a fresh request, hand a built-in editor pane its own selection.
  async openFreshLineHistory(cx) {
    const space = spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    let req = null;
    try {
      const r = await exec("sh", ["-c", 'p="${XDG_STATE_HOME:-$HOME/.local/state}/fresh-ide/line-history-request.json"; [ -f "$p" ] && cat "$p"'], { on, timeout: 5000 });
      const raw = r.code === 0 ? r.stdout : null;
      const q = raw ? JSON.parse(raw) : null;
      const age = Date.now() - (q?.ts ?? 0);
      if (q?.file && q.start >= 1 && age >= -10000 && age < 300000) req = q;
    } catch {}
    if (req) {
      const file = String(req.file);
      const slash = file.lastIndexOf("/");
      const name = slash >= 0 ? file.slice(slash + 1) : file;
      // The popup reads this shared request (mod.json places it top-centre);
      // while it is already open a new seq refreshes it in place.
      setShared("ide.glh.request", {
        root: slash > 0 ? file.slice(0, slash) : "/",
        file: `./${name}`,
        on,
        start: req.start,
        end: req.end ?? req.start,
        title: name,
        seq: (shared("ide.glh.request")?.seq ?? 0) + 1,
      });
      if (!shared("ide.glh.open")) run("mod.open", { name: "git-line-history" });
      return;
    }
    notify({ title: "Line history", body: "Select lines in the editor first.", level: "info", timeout: 2500 });
  }

  pollSharedSignals(cx) {
    const act = shared("ide.menu.action");
    if (act?.seq && act.seq !== this.lastMenuSeq) {
      this.lastMenuSeq = act.seq;
      this.handleMenuAction(act, cx);
    }
    const dirtySeq = shared("ide.git.dirtySeq") ?? 0;
    if (dirtySeq !== this.lastDirtySeq) {
      this.lastDirtySeq = dirtySeq;
      this.refresh(cx, { force: true });
    }
    const jump = shared("ide.terminalEditor.jump");
    if (jump?.seq && jump.seq !== this.lastJumpSeq) {
      this.lastJumpSeq = jump.seq;
      enqueueTerminalEditorJump(jump, cx);
    }
    const rev = shared("ide.explorer.reveal");
    if (rev?.seq && rev.seq !== this.lastRevealSeq) {
      this.lastRevealSeq = rev.seq;
      this.lastHerdrRevealAt = Date.now();
      const base = this.root || this.cwd;
      if (base && (!rev.on || rev.on === this.on)) {
        const rel = this.normalizeRelPath(rev.file, rev.root);
        if (rel) {
          this.activeFile = rel;
          if (getIdeSettings().autoReveal !== false) {
            this.revealFileInExplorer(rel, cx, { scroll: true, rootOverride: rev.root });
          } else {
            cx.notify();
          }
        }
      }
    }
    const spawning = shared("ide.editor.spawning");
    if (spawning?.beforeIds && Date.now() - spawning.at < 3000) {
      enforceTabEditorOrderAndMouse(spawning.tab, getIdeSettings());
    }
    const now = Date.now();
    if (
      this.view === "explorer" &&
      !this.probingFreshActive &&
      now - (this.lastFreshProbeAt ?? 0) >= 550 &&
      (this.on !== null || win()?.platform !== "windows") &&
      getIdeSettings().autoReveal !== false
    ) {
      this.lastFreshProbeAt = now;
      this.probeFreshActiveFile(cx);
    }
  }

  probeStatus(cx) {
    if (!this.root || this.probing || this.loading) return;
    this.probing = true;
    const root = this.root;
    const on = this.on;
    const targetContext = this.context;
    const myLoadSeq = this.loadSeq;
    const seqAtStart = shared("ide.git.dirtySeq") ?? 0;
    cx.spawn(async (cx) => {
      try {
        const st = await exec("git", [...READ, "status", "--porcelain=v1", "--branch", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        if (this.context !== targetContext || myLoadSeq !== this.loadSeq || this.root !== root) return;
        if (st.code === 0 && st.stdout !== this.lastStatusRaw) {
          this.applyStatusOutput(st.stdout, { seqAtStart });
          cx.notify();
        }
      } catch {}
      finally {
        if (myLoadSeq === this.loadSeq) this.probing = false;
      }
    });
  }

  syncWorkPane() {
    const space = spaces().find((s) => s.active);
    const activeTab = space?.tabs?.find((t) => t.active)?.id;
    const f = focused();
    const fp = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    if (activeTab && fp?.cwd && !isEditorPane(fp, shared("ide.editor.paneByTab")?.[activeTab])) {
      const wp = shared("ide.workPaneByTab") ?? {};
      if (wp[activeTab] !== fp.pane) {
        setShared("ide.workPaneByTab", { ...wp, [activeTab]: fp.pane });
      }
    }
  }

  applyStatusOutput(raw, opts = {}) {
    this.lastStatusRaw = raw;
    const conflicts = [], staged = [], unstaged = [], marks = {};
    let ahead = 0, behind = 0, hasUpstream = false;
    let headerBranch = null;
    for (const entry of (raw ?? "").split("\0").filter(Boolean)) {
      if (entry.startsWith("## ")) {
        hasUpstream = entry.includes("...");
        ahead = Number(/ahead (\d+)/.exec(entry)?.[1] ?? 0);
        behind = Number(/behind (\d+)/.exec(entry)?.[1] ?? 0);
        const hdr = entry.slice(3).trim();
        if (hdr.startsWith("HEAD (")) {
          headerBranch = "HEAD";
        } else if (hdr.startsWith("No commits yet on ") || hdr.startsWith("Initial commit on ")) {
          headerBranch = hdr.replace(/^(?:No commits yet|Initial commit) on /, "").trim() || null;
        } else if (hdr) {
          const dotIdx = hdr.indexOf("...");
          headerBranch = (dotIdx >= 0 ? hdr.slice(0, dotIdx) : hdr.replace(/ \[(?:ahead|behind|gone).*$/, "")).trim() || null;
        }
        continue;
      }
      const x = entry[0], y = entry[1], path = entry.slice(3);
      const full = `${this.root}/${path}`;
      if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
        conflicts.push({ path, status: "!" });
        marks[full] = "U";
      } else {
        if (x !== " " && x !== "?") {
          staged.push({ path, status: x });
          marks[full] = x;
        }
        if (y !== " ") {
          const s = x === "?" && y === "?" ? "?" : y;
          unstaged.push({ path, status: s });
          if (!marks[full]) marks[full] = s === "?" ? "A" : s;
        }
      }
    }
    this.conflicts = conflicts;
    this.staged = staged;
    this.unstaged = unstaged;
    this.marks = marks;
    this.ahead = ahead;
    this.behind = behind;
    this.hasUpstream = hasUpstream;
    if (headerBranch) this.branch = headerBranch;
    const activeSp = spaces().find((s) => s.active);
    if (activeSp?.id) {
      if (headerBranch && headerBranch !== "HEAD" && (opts.seqAtStart == null || (shared("ide.git.dirtySeq") ?? 0) === opts.seqAtStart)) {
        const bySpace = { ...(shared("ide.branchBySpace") ?? {}) };
        if (bySpace[activeSp.id] !== headerBranch) {
          bySpace[activeSp.id] = headerBranch;
          setShared("ide.branchBySpace", bySpace);
        }
      }
      setShared("ide.gitSyncBySpace", {
        ...(shared("ide.gitSyncBySpace") ?? {}),
        [activeSp.id]: { ahead, behind, hasUpstream },
      });
    }
  }

  async bootSettings(cx) {
    try {
      const rawIde = await readTextFile(`${appHome()}/ide-settings.json`);
      if (rawIde) {
        const parsed = JSON.parse(rawIde);
        setShared("ide.settings", { ...DEFAULT_IDE_SETTINGS, ...parsed });
      }
    } catch {}
    try {
      const rawWs = await readTextFile(`${appHome()}/ws-history.json`);
      if (rawWs) {
        const disk = JSON.parse(rawWs);
        if (disk && typeof disk === "object") {
          const cur = shared("ide.ws.history") ?? {};
          const merged = { ...disk, ...cur };
          for (const [k, v] of Object.entries(disk)) {
            if (!cur[k]?.lastFiles?.length && v?.lastFiles?.length) {
              merged[k] = { ...(cur[k] ?? {}), ...v };
            }
          }
          setShared("ide.ws.history", merged);
        }
      }
    } catch {}
    try {
      const raw = await readTextFile(`${appHome()}/ai-commit.json`);
      if (raw) {
        const cfg = JSON.parse(raw);
        this.aiUrlInput.set_value(cfg.api_url ?? "");
        this.aiKeyInput.set_value(cfg.api_key ?? "");
        this.aiModelInput.set_value(cfg.model ?? "");
        this.thinking = cfg.thinking ?? "off";
      }
    } catch {}
    cx.notify();
  }

  async saveAiSettings(cx) {
    try {
      const path = `${appHome()}/ai-commit.json`;
      const prev = await readTextFile(path);
      const data = JSON.stringify({
        api_url: this.aiUrlInput.value().trim(),
        api_key: this.aiKeyInput.value().trim(),
        model: this.aiModelInput.value().trim(),
        thinking: this.thinking,
      }, null, 2);
      await writeTextFile(path, data, prev);
      notify({ title: "AI Commit Settings", body: "Saved ai-commit.json", level: "success" });
      cx.notify();
    } catch (e) {
      this.error = String(e?.message ?? e);
      cx.notify();
    }
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  refresh(cx, opts = {}) {
    if (!checking()) this.syncWorkPane();
    const { cwd, on, space } = getContext();
    const k = locationKey();
    const cfg = getIdeSettings();
    const switched = k !== this.context;
    if (switched) {
      this.context = k;
      cx.spawn(async (cx2) => syncAgentSessions(cx2));
      this.cwd = cwd;
      this.on = on;
      this.root = null;
      this.entries = new Map();
      this.folders = new Set();
      this.pendingFolders = new Set();
      this.marks = {};
      this.watched = null;
      this.error = null;
      this.note = null;
      this.confirmDel = null;
      this.activeFile = null;
      this.lastAutoRevealedFile = null;
      this.pendingRevealPath = null;
      this.lastFreshRaw = null;
      this.lastFreshFile = null;
      this.loadSeq += 1;
      this.explorerSeq += 1;
      this.loading = false;
      this.loadingExplorer = false;
      this.probing = false;
    } else if (opts?.force) {
      this.loadSeq += 1;
      this.loading = false;
      this.probing = false;
      if (this.view === "explorer") {
        this.explorerSeq += 1;
        this.loadingExplorer = false;
      }
    }
    if (!cwd) return;
    if (this.view === "explorer" && !this.loadingExplorer) {
      this.loadingExplorer = true;
      const targetContext = this.context;
      const myExpSeq = this.explorerSeq;
      const myLoadSeq = this.loadSeq;
      cx.spawn(async (cx) => {
        try {
          const top = this.root ? null : await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
          if (this.context !== targetContext || myExpSeq !== this.explorerSeq || myLoadSeq !== this.loadSeq) return;
          const rootPath = this.root || (top?.code === 0 ? top.stdout.trim() : null);
          if (rootPath) this.root = rootPath;
          const base = this.root || cwd;
          const cfgNow = getIdeSettings();
          const folderList = ["", ...this.folders];
          const listed = await listMany(folderList.map((folder) => (folder ? `${base}/${folder}` : base)), on);
          const results = folderList.map((folder, i) => ({ folder, items: listed[i] }));
          if (this.context !== targetContext || myExpSeq !== this.explorerSeq || myLoadSeq !== this.loadSeq) return;
          for (const { folder, items } of results) {
            this.entries.set(
              folder,
              items
                .filter((e) => cfgNow.showHidden || !e.name.startsWith("."))
                .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
            );
          }
        } catch (e) {
          if (this.context === targetContext && myExpSeq === this.explorerSeq) {
            this.error = String(e?.message ?? e);
          }
        } finally {
          if (myExpSeq === this.explorerSeq) {
            this.loadingExplorer = false;
            cx.notify();
          }
        }
      });
    }
    if (this.loading) return;
    this.loading = true;
    const targetContext = this.context;
    const myLoadSeq = this.loadSeq;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        await this.bootPromise?.catch(() => {});
        if (this.context !== targetContext || myLoadSeq !== this.loadSeq) return;
        const cfgNow = getIdeSettings();
        this.root = top?.code === 0 ? top.stdout.trim() : null;
        const base = this.root || cwd;
        this.watch(base, cx);

        const prevSnap = shared("ide.ws.history")?.[wsHistoryKey(space, this.root)] ?? null;
        let restoredExplorerView = false;
        const firstVisit = Boolean(switched && space && !this.autoTriedSpaces.has(space.id));
        if (firstVisit) {
          this.autoTriedSpaces.add(space.id);
          if (prevSnap?.lastView && this.view !== prevSnap.lastView) {
            this.view = prevSnap.lastView;
            restoredExplorerView = this.view === "explorer";
          }
        }
        const snap = recordWorkspaceSnapshot(space, this.root, this.view);
        if (restoredExplorerView && !this.entries.size && !this.loadingExplorer) {
          this.refresh(cx);
        }
        if (firstVisit && cfgNow.autoRestoreFiles) {
          const activeTab = space?.tabs?.find((t) => t.active)?.id;
          const sp = shared("ide.editor.spawning");
          const tabPanes = activeTab ? panes().filter((p) => p.tab === activeTab) : [];
          const alreadyActive = activeTab && (
            (sp && sp.tab === activeTab && Date.now() - sp.at < 3000) ||
            tabPanes.some((p) => isLiveEditor(p))
          );
          if (!alreadyActive) {
            const first = snap?.lastFiles?.[0] ?? null;
            if (first?.file) {
              openInCenterEditor({ file: first.file, root: base, on, line: first.line ?? 1, direct: true }, cx);
            } else if (tabPanes.length) {
              const termsByAddr = terminalMap();
              const deadTerm = tabPanes
                .map((p) => (p.terminal && isDeadEditorShell(p, termsByAddr) ? termsByAddr.get(p.terminal) : null))
                .find(Boolean);
              const lblFile = deadTerm?.labels?.["ide.editor_file"];
              if (lblFile) {
                openInCenterEditor({
                  file: lblFile,
                  root: deadTerm.labels["ide.editor_root"] || base,
                  on,
                  line: Number(deadTerm.labels["ide.editor_line"] || 1) || 1,
                  direct: true,
                }, cx);
              }
            }
          }
        }
        const lastFile = snap?.lastFiles?.[0]?.file;
        if (!this.activeFile && lastFile) {
          const rel = this.normalizeRelPath(lastFile, base);
          if (rel) {
            this.activeFile = rel;
            if (cfgNow.autoReveal !== false) {
              this.revealFileInExplorer(rel, cx, { scroll: this.view === "explorer", rootOverride: base });
            }
          }
        }

        if (this.root) {
          const seqAtStart = shared("ide.git.dirtySeq") ?? 0;
          const git = (args) => exec("git", [...READ, ...args], { cwd: this.root, on });
          const [br, st, logR, stashR] = await Promise.all([
            git(["symbolic-ref", "--short", "HEAD"]),
            git(["status", "--porcelain=v1", "--branch", "-z", "--no-renames", "--untracked-files=all"]),
            git(["log", "-n", "12", "--pretty=%h%x09%s%x09%cr"]),
            git(["stash", "list", "--pretty=%gd%x09%s"]),
          ]);
          if (this.context !== targetContext || myLoadSeq !== this.loadSeq) return;
          this.branch = br.code === 0 ? br.stdout.trim() : "HEAD";
          const activeSp = spaces().find((s) => s.active);
          if (activeSp?.id && this.branch && this.branch !== "HEAD" && (shared("ide.git.dirtySeq") ?? 0) === seqAtStart) {
            const bySpace = { ...(shared("ide.branchBySpace") ?? {}) };
            if (bySpace[activeSp.id] !== this.branch) {
              bySpace[activeSp.id] = this.branch;
              setShared("ide.branchBySpace", bySpace);
            }
          }
          this.applyStatusOutput(st.stdout ?? "", { seqAtStart });
          this.commits = (logR.stdout ?? "").split("\n").filter(Boolean).map((l) => {
            const [hash, subject, rel] = l.split("\t");
            return { hash, subject, rel };
          });
          this.stashes = (stashR.stdout ?? "").split("\n").filter(Boolean).map((l) => {
            const [ref, msg] = l.split("\t");
            return { ref, msg };
          });
        }
        if (this.context === targetContext && myLoadSeq === this.loadSeq) this.error = null;
      } catch (e) {
        if (this.context === targetContext && myLoadSeq === this.loadSeq) {
          this.error = String(e?.message ?? e);
        }
      } finally {
        if (myLoadSeq === this.loadSeq) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }

  loadSingleFolder(folder, cx) {
    const base = this.root || this.cwd;
    if (!base || this.pendingFolders.has(folder)) return;
    const on = this.on;
    const targetContext = this.context;
    this.pendingFolders.add(folder);
    cx.spawn(async (cx) => {
      try {
        const [items] = await listMany([folder ? `${base}/${folder}` : base], on);
        if (this.context !== targetContext) return;
        const cfgNow = getIdeSettings();
        this.entries.set(
          folder,
          items
            .filter((e) => cfgNow.showHidden || !e.name.startsWith("."))
            .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
        );
      } catch (e) {
        if (this.context === targetContext) this.error = String(e?.message ?? e);
      } finally {
        this.pendingFolders.delete(folder);
        cx.notify();
      }
    });
  }

  toggleFolder(path, cx) {
    if (this.folders.has(path)) {
      this.folders.delete(path);
    } else {
      this.folders.add(path);
      this.loadSingleFolder(path, cx);
    }
    cx.notify();
  }

  openFile(path, line, cx) {
    const base = this.root || this.cwd;
    if (!base) return;
    openInCenterEditor({ file: path, root: base, on: this.on, line: typeof line === "number" ? line : 1, direct: true }, cx);
  }

  normalizeRelPath(file, rootOverride) {
    const base = (this.root || this.cwd || "").replace(/[\\/]+$/, "");
    if (!file || !base) return null;
    let raw = String(file).replace(/\\/g, "/").replace(/\/+$/, "");
    const normBase = base.replace(/\\/g, "/");
    if (rootOverride) {
      const normOv = String(rootOverride).replace(/\\/g, "/").replace(/\/+$/, "");
      if (normOv !== normBase && (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw))) return null;
    }
    if (raw === normBase) return null;
    if (raw.startsWith(normBase + "/")) {
      raw = raw.slice(normBase.length + 1);
    } else if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
      return null;
    }
    raw = raw.replace(/^\.\//, "");
    return raw || null;
  }

  async probeFreshActiveFile(cx, forceReveal = false) {
    const base = this.root || this.cwd;
    if (!base || this.probingFreshActive) return;
    if (!forceReveal && Date.now() - (this.lastHerdrRevealAt ?? 0) < 800) return;
    this.probingFreshActive = true;
    const targetContext = this.context;
    const targetOn = this.on;
    const activeTab = spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id;
    const daemonName = activeTab ? `ide-${shortHash(`${activeTab}:${base}`)}` : "";
    try {
      let raw = daemonName ? await readTextFile(`/tmp/fresh-ide-active-${daemonName}.json`, { on: targetOn }).catch(() => null) : null;
      if (!raw) raw = await readTextFile("/tmp/fresh-ide-active.json", { on: targetOn }).catch(() => null);
      if (!raw || this.context !== targetContext) return;
      if (!forceReveal && raw === this.lastFreshRaw) return;
      this.lastFreshRaw = raw;
      const data = JSON.parse(raw);
      if (!data?.file) return;
      const rel = this.normalizeRelPath(data.file, null);
      if (!rel) return;
      if (this.lastHerdrRevealAt && data.ts && data.ts < this.lastHerdrRevealAt - 200) return;
      const changed = rel !== this.lastFreshFile || rel !== this.activeFile;
      this.lastFreshFile = rel;
      this.activeFile = rel;
      if (changed) {
        const { space } = getContext();
        rememberOpenedFile(space, base, rel, 1);
      }
      if (getIdeSettings().autoReveal !== false && (changed || forceReveal)) {
        this.revealFileInExplorer(rel, cx, { scroll: this.view === "explorer", force: forceReveal });
      } else if (changed) {
        cx.notify();
      }
    } catch {} finally {
      this.probingFreshActive = false;
    }
  }

  revealFileInExplorer(rawFile, cx, { scroll = true, rootOverride = null, force = false } = {}) {
    const rel = this.normalizeRelPath(rawFile, rootOverride);
    if (!rel) return;
    const base = this.root || this.cwd;
    if (!base) return;
    this.activeFile = rel;
    if (!force && rel === this.lastAutoRevealedFile) {
      if (scroll && this.view === "explorer") cx.notify();
      return;
    }
    this.lastAutoRevealedFile = rel;

    const parts = rel.split("/").filter(Boolean);
    const ancestors = [];
    for (let i = 0; i < parts.length - 1; i++) {
      ancestors.push(parts.slice(0, i + 1).join("/"));
    }
    let expandedAny = false;
    for (const dir of ancestors) {
      if (!this.folders.has(dir)) {
        this.folders.add(dir);
        expandedAny = true;
      }
    }
    const toLoad = ["", ...ancestors].filter((f) => !this.entries.has(f) && !this.pendingFolders.has(f));
    if (scroll) this.pendingRevealPath = rel;

    if (toLoad.length === 0) {
      if (expandedAny || scroll) cx.notify();
      return;
    }

    const on = this.on;
    const targetContext = this.context;
    for (const f of toLoad) this.pendingFolders.add(f);
    cx.spawn(async (cx2) => {
      try {
        const listed = await listMany(toLoad.map((f) => (f ? `${base}/${f}` : base)), on);
        if (this.context !== targetContext) return;
        const cfgNow = getIdeSettings();
        toLoad.forEach((folder, idx) => {
          const items = listed[idx] ?? [];
          this.entries.set(
            folder,
            items
              .filter((e) => cfgNow.showHidden || !e.name.startsWith("."))
              .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
          );
        });
      } catch {}
      finally {
        for (const f of toLoad) this.pendingFolders.delete(f);
        cx2.notify();
      }
    });
    cx.notify();
  }

  revealActiveNow(cx) {
    if (this.activeFile) {
      this.revealFileInExplorer(this.activeFile, cx, { scroll: true, force: true });
      return;
    }
    const { space } = getContext();
    const base = this.root || this.cwd;
    const last = base ? shared("ide.ws.history")?.[wsHistoryKey(space, base)]?.lastFiles?.[0]?.file : null;
    if (last) {
      this.revealFileInExplorer(last, cx, { scroll: true, rootOverride: base, force: true });
    } else {
      this.probeFreshActiveFile(cx, true);
    }
  }

  createItem(cx) {
    const rel = this.newNameInput.value().trim();
    if (!rel) return;
    const base = this.root || this.cwd;
    const kind = this.newPrompt;
    this.newPrompt = null;
    this.newNameInput.set_value("");
    cx.spawn(async (cx) => {
      try {
        const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
        const abs = `${base}${sep}${rel}`;
        if (kind === "dir") {
          if (!this.on && win()?.platform === "windows") {
            await exec("powershell", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${abs.replace(/'/g, "''")}'`], { on: this.on });
          } else {
            await exec("mkdir", ["-p", abs], { on: this.on });
          }
        } else {
          await saveText(abs, "", null, this.on);
        }
        this.refresh(cx);
      } catch (e) {
        this.note = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  deleteItem(rel, cx) {
    const base = this.root || this.cwd;
    if (!base) return;
    this.confirmDel = null;
    cx.spawn(async (cx) => {
      try {
        const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
        const abs = `${base}${sep}${rel}`;
        if (!this.on && win()?.platform === "windows") {
          await exec("powershell", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${abs.replace(/'/g, "''")}' -Recurse -Force`], { on: this.on });
        } else {
          await exec("rm", ["-rf", abs], { on: this.on });
        }
        notify({ title: "Deleted", body: rel, level: "info" });
        this.refresh(cx);
      } catch (e) {
        this.note = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  async copyTextToClipboard(text) {
    const b64 = toBase64Utf8(text);
    if (!this.on && win()?.platform === "windows") {
      await exec("powershell", ["-NoProfile", "-Command", `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | Set-Clipboard`], {}).catch(() => {});
    } else {
      await exec("sh", ["-c", 'printf %s "$1" | base64 -d | clip.exe 2>/dev/null || printf %s "$1" | base64 -d | xclip -selection clipboard 2>/dev/null || true', "clip", b64], { on: this.on }).catch(() => {});
    }
    notify({ title: "Copied", body: text, level: "info" });
  }

  finishRename(cx) {
    const from = this.renameFrom;
    const to = this.renameInput.value().trim();
    this.renameFrom = null;
    if (!from || !to || from === to) {
      cx.notify();
      return;
    }
    const base = this.root || this.cwd;
    const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
    cx.spawn(async (cx) => {
      try {
        if (!this.on && win()?.platform === "windows") {
          await exec("powershell", ["-NoProfile", "-Command", `Move-Item -LiteralPath '${base}${sep}${from}' -Destination '${base}${sep}${to}'`], {});
        } else {
          await exec("mv", [`${base}/${from}`, `${base}/${to}`], { on: this.on });
        }
        notify({ title: "Renamed", body: `${from} → ${to}`, level: "success" });
        this.refresh(cx);
      } catch (e) {
        this.note = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  async pasteInto(targetDir, cx) {
    if (!this.clipboard?.path) return;
    const base = this.root || this.cwd;
    const srcRel = this.clipboard.path;
    const name = srcRel.split("/").pop();
    const destRel = targetDir ? `${targetDir}/${name}` : name;
    const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
    const srcAbs = `${base}${sep}${srcRel}`;
    let destAbs = `${base}${sep}${destRel}`;
    if (srcAbs === destAbs) destAbs = `${base}${sep}${targetDir ? `${targetDir}/` : ""}copy-${name}`;
    try {
      if (!this.on && win()?.platform === "windows") {
        const cmd = this.clipboard.mode === "cut"
          ? `Move-Item -LiteralPath '${srcAbs}' -Destination '${destAbs}'`
          : `Copy-Item -LiteralPath '${srcAbs}' -Destination '${destAbs}' -Recurse`;
        await exec("powershell", ["-NoProfile", "-Command", cmd], {});
      } else {
        if (this.clipboard.mode === "cut") await exec("mv", [srcAbs, destAbs], { on: this.on });
        else await exec("cp", ["-r", srcAbs, destAbs], { on: this.on });
      }
      if (this.clipboard.mode === "cut") this.clipboard = null;
      this.refresh(cx);
    } catch (e) {
      this.note = String(e?.message ?? e);
      cx.notify();
    }
  }

  async addToGitignore(rel, cx) {
    if (!this.root) return;
    const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
    const gi = `${this.root}${sep}.gitignore`;
    const cur = (await readTextFile(gi, { on: this.on })) ?? "";
    const line = `/${rel}`;
    if (!cur.split("\n").some((l) => l.trim() === line || l.trim() === rel)) {
      const next = (cur && !cur.endsWith("\n") ? `${cur}\n` : cur) + `${line}\n`;
      await saveText(gi, next, cur, this.on);
    }
    notify({ title: ".gitignore", body: `Added ${line}`, level: "info" });
    this.refresh(cx);
  }

  openExplorerMenu(entry, path) {
    const parentDir = entry.dir ? path : (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    const items = [];
    if (!entry.dir) {
      items.push({ id: "open", label: "Open in Editor", hint: "Enter" });
      items.push({ sep: true });
    }
    items.push({ id: "new_file", label: "New File…" });
    items.push({ id: "new_folder", label: "New Folder…" });
    items.push({ sep: true });
    items.push({ id: "cut", label: "Cut" });
    items.push({ id: "copy", label: "Copy" });
    if (this.clipboard) items.push({ id: "paste", label: `Paste (${this.clipboard.path.split("/").pop()})` });
    if (!entry.dir) items.push({ id: "duplicate", label: "Duplicate" });
    items.push({ sep: true });
    items.push({ id: "rename", label: "Rename…" });
    items.push({ id: "delete", label: "Delete", danger: true });
    items.push({ sep: true });
    items.push({ id: "copy_path", label: "Copy Path" });
    items.push({ id: "copy_rel", label: "Copy Relative Path" });
    if (this.root) {
      items.push({ sep: true });
      items.push({ id: "stage", label: "Git: Stage (git add)" });
      items.push({ id: "gitignore", label: "Add to .gitignore" });
    }
    openOverlay({
      mod: "ide-menu",
      kind: "popup",
      at: "pointer",
      width: 220,
      props: { items, payload: { source: "explorer", path, dir: entry.dir, parentDir } },
    });
  }

  openScmMenu(f, kind) {
    const staged = kind === "staged";
    const conflict = kind === "conflict";
    const items = [];
    if (conflict) {
      items.push({ id: "resolve", label: "Resolve Conflicts (3-Way)" });
      items.push({ sep: true });
    }
    items.push({ id: "open", label: "Open in Editor" });
    if (!conflict) items.push({ id: "diff", label: "View Diff" });
    items.push({ sep: true });
    if (staged) {
      items.push({ id: "unstage", label: "Unstage Changes" });
    } else if (!conflict) {
      items.push({ id: "stage", label: "Stage Changes" });
      if (f.status === "?") {
        items.push({ id: "delete", label: "Delete Untracked File", danger: true });
      } else {
        items.push({ id: "discard", label: "Discard Changes", danger: true });
      }
    }
    items.push({ sep: true });
    items.push({ id: "copy_rel", label: "Copy Relative Path" });
    items.push({ id: "gitignore", label: "Add to .gitignore" });
    openOverlay({
      mod: "ide-menu",
      kind: "popup",
      at: "pointer",
      width: 230,
      props: { items, payload: { source: "scm", path: f.path, staged, status: f.status, untracked: f.status === "?" } },
    });
  }

  openCommitMenu(c) {
    const items = [
      { id: "show_ref", label: "Show Changes" },
      { sep: true },
      { id: "cherry_pick", label: "Cherry-Pick" },
      { id: "revert", label: "Revert Commit" },
      { id: "checkout_ref", label: "Checkout (Detached HEAD)" },
      { sep: true },
      { id: "reset_soft", label: "Soft Reset Here…", danger: true },
      { id: "reset_mixed", label: "Mixed Reset Here…", danger: true },
      { sep: true },
      { id: "copy_hash", label: "Copy Commit Hash" },
      { id: "copy_msg", label: "Copy Commit Message" },
    ];
    openOverlay({
      mod: "ide-menu",
      kind: "popup",
      at: "pointer",
      width: 230,
      props: { items, payload: { source: "commit", hash: c.hash, subject: c.subject } },
    });
  }

  openStashMenu(s) {
    const items = [
      { id: "show_stash", label: "Show Stash Diff" },
      { sep: true },
      { id: "stash_apply", label: "Apply Stash" },
      { id: "stash_pop", label: "Pop Stash" },
      { id: "stash_drop", label: "Drop Stash…", danger: true },
    ];
    openOverlay({
      mod: "ide-menu",
      kind: "popup",
      at: "pointer",
      width: 210,
      props: { items, payload: { source: "stash", ref: s.ref, msg: s.msg } },
    });
  }

  showRefDiff(ref, isStash, cx) {
    const base = this.root || this.cwd;
    if (!base || !ref) return;
    openDiffInCenterEditor({
      title: isStash ? `Stash: ${ref}` : `Commit: ${ref}`,
      ref,
      isStash,
      root: base,
      on: this.on,
    }, cx);
  }

  handleMenuAction(act, cx) {
    const p = act.payload ?? {};
    if (p.source === "commit") {
      if (act.id === "show_ref") return this.showRefDiff(p.hash, false, cx);
      if (act.id === "cherry_pick") return this.runGit(["cherry-pick", "--", p.hash], `Cherry-picked ${p.hash}`, cx);
      if (act.id === "revert") return this.runGit(["revert", "--no-edit", "--", p.hash], `Reverted ${p.hash}`, cx);
      if (act.id === "checkout_ref") return this.runGit(["checkout", p.hash], `Checked out ${p.hash}`, cx);
      if (act.id === "reset_soft") {
        this.confirmGit = { prompt: `Soft reset HEAD to ${p.hash}?`, args: ["reset", "--soft", p.hash], title: `Soft reset to ${p.hash}` };
        cx.notify();
        return;
      }
      if (act.id === "reset_mixed") {
        this.confirmGit = { prompt: `Mixed reset HEAD to ${p.hash}?`, args: ["reset", "--mixed", p.hash], title: `Mixed reset to ${p.hash}` };
        cx.notify();
        return;
      }
      if (act.id === "copy_hash") return cx.spawn(async () => this.copyTextToClipboard(p.hash));
      if (act.id === "copy_msg") return cx.spawn(async () => this.copyTextToClipboard(p.subject));
      return;
    }
    if (p.source === "stash") {
      if (act.id === "show_stash") return this.showRefDiff(p.ref, true, cx);
      if (act.id === "stash_apply") return this.runGit(["stash", "apply", "--", p.ref], `Applied ${p.ref}`, cx);
      if (act.id === "stash_pop") return this.runGit(["stash", "pop", "--", p.ref], `Popped ${p.ref}`, cx);
      if (act.id === "stash_drop") {
        this.confirmGit = { prompt: `Drop ${p.ref} (${p.msg})?`, args: ["stash", "drop", "--", p.ref], title: `Dropped ${p.ref}` };
        cx.notify();
      }
      return;
    }
    const path = p.path;
    const base = this.root || this.cwd;
    if (!path && act.id !== "new_file" && act.id !== "new_folder") return;

    if (act.id === "open") return this.openFile(path, 1, cx);
    if (act.id === "diff") return this.showDiff(path, Boolean(p.staged), Boolean(p.untracked || p.status === "?"), cx);
    if (act.id === "resolve") {
      return openOverlay({ mod: "merge-editor", kind: "popup", at: "top", offset: 24, width: 0.76, height: 0.90, props: { file: path } });
    }
    if (act.id === "new_file" || act.id === "new_folder") {
      this.view = "explorer";
      this.newPrompt = act.id === "new_folder" ? "dir" : "file";
      const prefix = p.parentDir ? `${p.parentDir}/` : "";
      this.newNameInput.set_value(prefix);
      this.newNameInput.focus();
      cx.notify();
      return;
    }
    if (act.id === "cut" || act.id === "copy") {
      this.clipboard = { mode: act.id, path };
      notify({ title: act.id === "cut" ? "Cut" : "Copied", body: path, level: "info" });
      return;
    }
    if (act.id === "paste") {
      cx.spawn(async (cx) => this.pasteInto(p.parentDir ?? "", cx));
      return;
    }
    if (act.id === "duplicate") {
      this.clipboard = { mode: "copy", path };
      cx.spawn(async (cx) => this.pasteInto(p.parentDir ?? "", cx));
      return;
    }
    if (act.id === "rename") {
      this.renameFrom = path;
      this.renameInput.set_value(path);
      this.renameInput.focus();
      cx.notify();
      return;
    }
    if (act.id === "delete") {
      if (getIdeSettings().confirmDelete) {
        this.confirmDel = path;
        cx.notify();
      } else {
        this.deleteItem(path, cx);
      }
      return;
    }
    if (act.id === "copy_path") {
      const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
      cx.spawn(async () => this.copyTextToClipboard(`${base}${sep}${path}`));
      return;
    }
    if (act.id === "copy_rel") {
      cx.spawn(async () => this.copyTextToClipboard(path));
      return;
    }
    if (act.id === "stage") return this.runGit(["add", "--", path], null, cx);
    if (act.id === "unstage") return this.runGit(["reset", "HEAD", "--", path], null, cx);
    if (act.id === "discard") return this.runGit(["checkout", "--", path], null, cx);
    if (act.id === "gitignore") {
      cx.spawn(async (cx) => this.addToGitignore(path, cx));
    }
  }

  runGit(args, title, cx) {
    if (!this.root || this.busy) return;
    this.busy = true;
    this.note = null;
    this.syncLabel = args.length === 1 && (args[0] === "pull" || args[0] === "push" || args[0] === "sync")
      ? (args[0] === "sync" ? "Syncing…" : args[0] === "pull" ? "Pulling…" : "Pushing…")
      : null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (args.length === 1 && (args[0] === "pull" || args[0] === "push" || args[0] === "sync")) {
          const res = await runGitSyncWithUpstream(args[0], this.root, this.on);
          if (!res.ok) this.note = res.detail;
          this.refresh(cx, { force: true });
          return;
        }
        const r = await exec("git", args, { cwd: this.root, on: this.on });
        if (r.code !== 0) {
          this.note = (r.stderr || r.stdout || "git command failed").trim();
          if (title) notify({ title: `${title} Failed`, body: this.note, level: "error", timeout: 4500 });
        } else {
          bumpGitDirty();
          if (title) notify({ title, body: r.stdout.trim() || r.stderr.trim() || "Done", level: "success", timeout: 4500 });
        }
        this.refresh(cx, { force: true });
      } catch (e) {
        this.note = String(e?.message ?? e);
        if (title) notify({ title: `${title} Failed`, body: this.note, level: "error", timeout: 4500 });
        cx.notify();
      } finally {
        this.busy = false;
        this.syncLabel = null;
        cx.notify();
      }
    });
  }

  runUndoLastCommit(cx) {
    if (!this.root || this.busy) return;
    this.busy = true;
    this.note = null;
    this.syncLabel = "Undoing…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await undoLastCommit(this.root, this.on);
        if (res.ok) {
          notify({ title: "Undo Last Commit", body: res.detail, level: "info", timeout: 4500 });
        } else {
          this.note = res.error;
          notify({ title: "Undo Failed", body: this.note, level: "error", timeout: 4500 });
        }
        this.refresh(cx, { force: true });
      } catch (e) {
        this.note = String(e?.message ?? e);
        notify({ title: "Undo Failed", body: this.note, level: "error", timeout: 4500 });
        cx.notify();
      } finally {
        this.busy = false;
        this.syncLabel = null;
        cx.notify();
      }
    });
  }

  showDiff(path, staged, untracked, cx) {
    const base = this.root || this.cwd;
    if (!base || !path) return;
    openDiffInCenterEditor({
      title: `Diff: ${path.split("/").pop()}`,
      file: path,
      staged: Boolean(staged),
      untracked: Boolean(untracked),
      root: base,
      on: this.on,
    }, cx);
  }

  commit(cx) {
    const msg = this.message.trim();
    if (!msg || !this.root || this.busy) return;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.staged.length === 0) {
          const add = await exec("git", ["add", "-A"], { cwd: this.root, on: this.on });
          if (add.code !== 0) {
            this.note = (add.stderr || add.stdout || "git add failed").trim();
            cx.notify();
            return;
          }
        }
        const r = await exec("git", ["commit", "-m", msg], { cwd: this.root, on: this.on });
        if (r.code === 0) {
          this.message = "";
          this.commitInput.set_value("");
          bumpGitDirty();
          notify({ title: "Git Commit", body: msg, level: "success" });
          this.refresh(cx, { force: true });
        } else {
          this.note = (r.stderr || r.stdout).trim();
          cx.notify();
        }
      } catch (e) {
        this.note = String(e?.message ?? e);
        cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }

  draftAi(cx) {
    if (!this.root || this.busy) return;
    this.busy = true;
    this.note = null;
    this.aiNotice = "Generating AI commit message…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.staged.length === 0) {
          const add = await exec("git", ["add", "-A"], { cwd: this.root, on: this.on });
          if (add.code !== 0) {
            this.note = (add.stderr || add.stdout || "git add failed").trim();
            this.aiNotice = null;
            notify({ title: "AI Commit Failed", body: this.note, level: "error", timeout: 5000 });
            return;
          }
        }
        const stat = await exec("git", [...READ, "diff", "--cached", "--stat"], { cwd: this.root, on: this.on });
        const diffStat = stat.stdout.trim();
        if (!diffStat) {
          this.note = "Nothing to commit (working tree clean).";
          this.aiNotice = null;
          notify({ title: "AI Commit", body: this.note, level: "info", timeout: 3500 });
          return;
        }
        const summaryLine = diffStat.split("\n").pop()?.trim() || "";
        const patch = (await exec("git", [...READ, "diff", "--cached", "--no-color"], { cwd: this.root, on: this.on })).stdout.slice(0, 6000);
        const msg = await generateAiCommitMessage(diffStat, patch, this.root, this.on);
        this.message = msg;
        this.commitInput.set_value(msg.split("\n")[0]);
        this.aiNotice = summaryLine ? `${msg}\n${summaryLine}` : msg;
        cx.notify();
        const r = await exec("git", ["commit", "-m", msg], { cwd: this.root, on: this.on });
        if (r.code === 0) {
          this.message = "";
          this.commitInput.set_value("");
          bumpGitDirty();
          notify({ title: "AI Commit ✓", body: msg.split("\n")[0], level: "success", timeout: 7000 });
          this.refresh(cx);
          const shown = this.aiNotice;
          cx.timer.after(9000, (cx2) => {
            if (this.aiNotice === shown) {
              this.aiNotice = null;
              cx2.notify();
            }
          });
        } else {
          this.note = (r.stderr || r.stdout || "git commit failed").trim();
          notify({ title: "AI Commit Failed", body: this.note, level: "error", timeout: 5000 });
        }
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  runInlineSearch(cx) {
    const q = this.searchInput.value().trim();
    const base = this.root || this.cwd;
    if (!q || !base) return;
    this.searchBusy = true;
    this.searchQueried = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let r = await execRg([
        "--line-number", "--no-heading", "--color", "never", "-i", "-F",
        "--max-filesize", "512K", "--max-columns", "240", "--max-count", "50",
        "-g", "!vendor/**", "-g", "!node_modules/**", "-g", "!public/**", "-g", "!*.min.js",
        "--", q, ".",
      ], base, this.on);
      if (!r) {
        r = await exec("git", ["grep", "-n", "-i", "-F", "--", q], { cwd: base, on: this.on }).catch(() => null);
      }
      this.searchBusy = false;
      this.searchResults = (r?.stdout ?? "").split("\n").filter(Boolean).slice(0, 120).map((rawLine) => {
        const line = rawLine.replace(/\r$/, "");
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        return m ? { path: m[1].replace(/^\.\//, "").replace(/\\/g, "/"), line: Number(m[2]), text: m[3].trim() } : null;
      }).filter(Boolean);
      cx.notify();
    });
  }

  formatPathTooltip(relPath, base, leafOverride) {
    const sep = !this.on && win()?.platform === "windows" ? "\\" : "/";
    const relDisp = sep === "\\" ? relPath.replace(/\//g, "\\") : relPath;
    const absDisp = base ? `${base.replace(/[\\/]+$/, "")}${sep}${relDisp}` : relDisp;
    const leaf = leafOverride || relPath.split(/[\\/]/).pop() || relPath;
    return absDisp === leaf ? absDisp : `${leaf} — ${absDisp}`;
  }

  renderExplorer(t, cx) {
    const cfg = getIdeSettings();
    const base = this.root || this.cwd;
    const rows = [];
    let activeRowIdx = -1;
    const walk = (prefix, depth) => {
      if (rows.length >= 800 || depth > 25) return;
      for (const entry of this.entries.get(prefix) ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const open = this.folders.has(path);
        const isActive = !entry.dir && this.activeFile === path;
        const mark = cfg.gitDecorations ? this.marks[`${base}/${path}`] : null;
        if (this.pendingRevealPath && this.pendingRevealPath === path) {
          activeRowIdx = rows.length;
        }
        rows.push(
          h_flex()
            .id(`ide-f-${path}`)
            .h(21)
            .flex_none()
            .pl(6 + depth * 12)
            .pr(4)
            .gap(5)
            .items_center()
            .rounded(4)
            .cursor_pointer()
            .tooltip(this.formatPathTooltip(path, base, entry.name))
            .when(isActive, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
            .when(!isActive, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => (entry.dir ? this.toggleFolder(path, cx) : this.openFile(path, 1, cx)))
            .on_mouse_down("right", () => this.openExplorerMenu(entry, path))
            .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(10).text_color(t.dim) : div().w(10))
            .child(renderFileIcon(div, svg, entry.name, entry.dir, open, cfg.iconTheme, t))
            .child(div().flex_1().min_w(0).truncate().text_size(12).child(entry.name))
            .when(entry.dir && this.pendingFolders.has(path), (el) => el.child(div().text_size(10.5).text_color(t.dim).child("…")))
            .when(Boolean(mark), (el) =>
              el.child(div().text_size(10.5).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)),
            ),
        );
        if (entry.dir && open) walk(path, depth + 1);
      }
    };
    walk("", 0);
    if (this.pendingRevealPath) {
      if (activeRowIdx >= 0) {
        this.treeScroll.scroll_to_item(activeRowIdx);
        this.pendingRevealPath = null;
      } else if (!this.loadingExplorer && this.pendingFolders.size === 0 && this.entries.has("")) {
        this.pendingRevealPath = null;
      }
    }

    const tinyBtn = (id, label, active, onClick) =>
      div().id(id).px(6).py(2).rounded(4).text_size(11).text_color(active ? t.accent : t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .h(28)
          .px(8)
          .gap(3)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().flex_1().truncate().text_size(12).font_semibold().child(base?.split(/[\\/]/).pop() ?? "Explorer"))
          .child(tinyBtn("ide-exp-rev", "⌖", Boolean(this.activeFile), (_e, cx) => this.revealActiveNow(cx)))
          .child(tinyBtn("ide-exp-col", "⊟", false, (_e, cx) => { this.folders.clear(); this.pendingRevealPath = null; cx.notify(); }))
          .child(tinyBtn("ide-exp-newf", "+F", false, (_e, cx) => { this.newPrompt = "file"; this.newNameInput.focus(); cx.notify(); }))
          .child(tinyBtn("ide-exp-newd", "+D", false, (_e, cx) => { this.newPrompt = "dir"; this.newNameInput.focus(); cx.notify(); }))
          .child(tinyBtn("ide-exp-hid", ".*", cfg.showHidden, (_e, cx) => { updateIdeSettings({ showHidden: !cfg.showHidden }); this.refresh(cx); }))
          .child(tinyBtn("ide-exp-ref", "↻", false, (_e, cx) => this.refresh(cx))),
      )
      .when(Boolean(this.confirmDel), (el) =>
        el.child(
          h_flex().p(8).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.blocked)
            .child(div().flex_1().truncate().text_size(11.5).child(`Delete ${this.confirmDel}?`))
            .child(tinyBtn("ide-del-yes", "Delete", true, (_e, cx) => this.deleteItem(this.confirmDel, cx)))
            .child(tinyBtn("ide-del-no", "Cancel", false, (_e, cx) => { this.confirmDel = null; cx.notify(); })),
        ),
      )
      .when(Boolean(this.renameFrom), (el) =>
        el.child(
          h_flex().p(6).gap(6).border_b(1).border_color(t.accent)
            .child(div().text_size(11).text_color(t.dim).child("Rename:"))
            .child(div().flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).child(Input.new(this.renameInput).h_full().text_size(12)))
            .child(tinyBtn("ide-ren-cancel", "×", false, (_e, cx) => { this.renameFrom = null; cx.notify(); })),
        ),
      )
      .when(Boolean(this.newPrompt), (el) =>
        el.child(
          h_flex().p(6).gap(6).border_b(1).border_color(t.border)
            .child(div().flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).child(Input.new(this.newNameInput).h_full().text_size(12)))
            .child(tinyBtn("ide-new-cancel", "×", false, (_e, cx) => { this.newPrompt = null; cx.notify(); })),
        ),
      )
      .child(
        div().flex_1().min_h(0).relative()
          .child(
            v_flex().id("ide-exp-tree").track_scroll(this.treeScroll).absolute().inset_0().overflow_y_scroll().p(2)
              .children(rows)
              .when(rows.length === 0, (el) => el.child(div().p(10).text_size(12).text_color(t.dim).child(this.error || (this.loadingExplorer ? "Loading files…" : "No files")))),
          )
          .child(Scrollbar.vertical("ide-exp-tree").absolute().inset_0()),
      );
  }

  renderSearch(t, cx) {
    const popBtn = (id, label, modName) =>
      div()
        .id(id)
        .px(7)
        .py(3)
        .rounded(5)
        .bg(t.raised)
        .text_size(11)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => openOverlay({ mod: modName, kind: "popup", at: "top", offset: 32, width: 940, height: 0.80 }))
        .child(label);

    return v_flex()
      .flex_1()
      .min_h(0)
      .p(8)
      .gap(8)
      .child(
        h_flex().gap(4).flex_wrap()
          .child(popBtn("ide-qo", "Files (Ctrl+Q)", "quick-open"))
          .child(popBtn("ide-cs", "Search (Ctrl+Shift+F)", "content-search"))
          .child(popBtn("ide-rp", "Replace (Ctrl+Shift+R)", "replace-popup"))
          .child(popBtn("ide-sy", "Symbols (Ctrl+Alt+Q)", "symbol-search")),
      )
      .child(
        h_flex().h(32).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.border).bg(t.surface)
          .child(svg("mods/workspace-chrome/search.svg").size(13).text_color(t.dim))
          .child(Input.new(this.searchInput).flex_1().h_full().text_size(12).text_color(t.foreground)),
      )
      .child(
        div().flex_1().min_h(0).relative().child(
          v_flex().id("ide-sr-list").absolute().inset_0().overflow_y_scroll().gap(1)
            .when(this.searchBusy, (el) => el.child(div().p(8).text_color(t.dim).child("Searching…")))
            .when(!this.searchBusy && this.searchQueried && this.searchResults.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child("No matches found")))
            .children(
              this.searchResults.map((m, i) => {
                const base = this.root || this.cwd;
                const leaf = `${m.path.split(/[\\/]/).pop() || m.path}:${m.line}`;
                return v_flex()
                  .id(`ide-sr-${i}`)
                  .px(5)
                  .py(3)
                  .rounded(4)
                  .cursor_pointer()
                  .tooltip(this.formatPathTooltip(m.path, base, leaf))
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.openFile(m.path, m.line, cx))
                  .child(div().text_size(11).text_color(t.accent).truncate().child(`${m.path}:${m.line}`))
                  .child(div().text_size(11.5).text_color(t.foreground).truncate().child(m.text));
              }),
            ),
        ).child(Scrollbar.vertical("ide-sr-list").absolute().inset_0()),
      );
  }

  renderScm(t, cx) {
    const cfg = getIdeSettings();
    const base = this.root || this.cwd;
    const miniBtn = (id, label, tip, onClick) =>
      div().id(id).flex_none().h(20).px(6).flex().items_center().justify_center().rounded(4).text_size(11).text_color(t.muted).cursor_pointer().tooltip(tip).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);

    const fileRow = (f, kind, idx, labelOverride) => {
      const staged = kind === "staged";
      const conflict = kind === "conflict";
      const actBtn = (suffix, txt, tip, fn) =>
        div().id(`scm-${kind}-${suffix}-${idx}`).px(4).py(0.5).rounded(4).text_size(11).text_color(t.dim).tooltip(tip).hover((s) => s.bg(t.raised).text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(fn).child(txt);

      const fileName = f.path.split(/[\\/]/).pop() || f.path;
      return h_flex()
        .id(`scm-row-${kind}-${idx}`)
        .h(21)
        .pl(labelOverride ? 12 : 5)
        .pr(5)
        .gap(4)
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .tooltip(this.formatPathTooltip(f.path, base))
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("right", () => this.openScmMenu(f, kind))
        .on_click((_e, cx) => {
          if (conflict) {
            openOverlay({ mod: "merge-editor", kind: "popup", at: "top", offset: 24, width: 0.76, height: 0.90, props: { file: f.path } });
          } else {
            this.showDiff(f.path, staged, f.status === "?", cx);
          }
        })
        .child(div().w(11).flex_none().text_size(10.5).font_semibold().text_color(conflict || f.status === "D" ? t.ansi1 : f.status === "A" || f.status === "?" ? t.ansi2 : t.blocked).child(f.status))
        .child(renderFileIcon(div, svg, fileName, false, false, cfg.iconTheme, t))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(labelOverride ?? fileName))
        .when(conflict, (el) => el.child(actBtn("res", "Resolve", "Open 3-way merge editor", () => openOverlay({ mod: "merge-editor", kind: "popup", at: "top", offset: 24, width: 0.76, height: 0.90, props: { file: f.path } }))))
        .when(staged, (el) =>
          el
            .child(actBtn("open", "↗", "Open in Editor", (_e, cx) => this.openFile(f.path, 1, cx)))
            .child(actBtn("un", "-", "Unstage", (_e, cx) => this.runGit(["reset", "HEAD", "--", f.path], null, cx))),
        )
        .when(!staged && !conflict, (el) =>
          el
            .child(actBtn("open", "↗", "Open in Editor", (_e, cx) => this.openFile(f.path, 1, cx)))
            .child(actBtn("st", "+", "Stage", (_e, cx) => this.runGit(["add", "--", f.path], null, cx)))
            .when(f.status !== "?", (el2) => el2.child(actBtn("dis", "↩", "Discard changes", (_e, cx) => this.runGit(["checkout", "--", f.path], null, cx)))),
        );
    };

    const renderGroup = (list, kind) => {
      if (!cfg.scmTreeView) return list.map((f, i) => fileRow(f, kind, i));
      const groups = new Map();
      for (const f of list) {
        const idx = f.path.lastIndexOf("/");
        const dir = idx >= 0 ? f.path.slice(0, idx) : ".";
        const name = idx >= 0 ? f.path.slice(idx + 1) : f.path;
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push({ ...f, name });
      }
      const out = [];
      for (const [dir, items] of groups.entries()) {
        out.push(
          div()
            .id(`scm-dir-${kind}-${dir}`)
            .px(6)
            .pt(3)
            .text_size(10.5)
            .text_color(t.dim)
            .truncate()
            .tooltip(dir === "." ? (base || ".") : this.formatPathTooltip(dir, base, dir))
            .child(dir),
        );
        items.forEach((it, idx) => out.push(fileRow(it, kind, `${dir}-${idx}`, it.name)));
      }
      return out;
    };
    const curSyncBadge = this.currentSyncBadge();

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex()
          .h(28)
          .px(8)
          .gap(3)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .id("scm-br")
              .px(6)
              .py(2)
              .rounded(5)
              .gap(5)
              .items_center()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => openOverlay({ mod: "git-branch", kind: "popup", at: "top", offset: 40, width: 540, height: 0.72 }))
              .child(svg("mods/workspace-chrome/branch.svg").size(12).text_color(t.accent))
              .child(div().max_w(100).truncate().text_size(12).font_semibold().child(this.branch || "git")),
          )
          .when(this.behind > 0 && this.ahead > 0, (el) =>
            el.child(
              div()
                .id("scm-sync-badge")
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.accent + "24")
                .text_size(11)
                .text_color(t.accent)
                .cursor_pointer()
                .tooltip(`Sync: Pull ${this.behind} & Push ${this.ahead}`)
                .on_click((_e, cx) => this.runGit(["sync"], "Git Sync", cx))
                .child(`↓${this.behind} ↑${this.ahead}`),
            ),
          )
          .when(this.behind > 0 && this.ahead === 0, (el) =>
            el.child(
              div()
                .id("scm-behind-badge")
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.blocked + "28")
                .text_size(11)
                .text_color(t.blocked)
                .cursor_pointer()
                .tooltip(`${this.behind} commit(s) behind upstream — click to Pull`)
                .on_click((_e, cx) => this.runGit(["pull"], "Git Pull", cx))
                .child(`↓${this.behind}`),
            ),
          )
          .when(this.ahead > 0 && this.behind === 0, (el) =>
            el.child(
              div()
                .id("scm-ahead-badge")
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.ansi2 + "28")
                .text_size(11)
                .text_color(t.ansi2)
                .cursor_pointer()
                .tooltip(`${this.ahead} commit(s) ahead — click to Push`)
                .on_click((_e, cx) => this.runGit(["push"], "Git Push", cx))
                .child(`↑${this.ahead}`),
            ),
          )
          .when(Boolean(curSyncBadge), (el) =>
            el.child(div().px(5).py(1).rounded(4).bg(t.accent + "22").text_size(10.5).text_color(t.accent).child(curSyncBadge)),
          )
          .child(div().flex_1())
          .child(miniBtn("scm-tree", cfg.scmTreeView ? "Tree" : "List", "Toggle List/Tree view", (_e, cx) => { updateIdeSettings({ scmTreeView: !cfg.scmTreeView }); cx.notify(); }))
          .when(this.behind > 0 && this.ahead > 0, (el) =>
            el.child(miniBtn("scm-sync", `↓${this.behind} ↑${this.ahead}`, `Sync: Pull ${this.behind} & Push ${this.ahead}`, (_e, cx) => this.runGit(["sync"], "Git Sync", cx))),
          )
          .when(!(this.behind > 0 && this.ahead > 0), (el) =>
            el
              .child(miniBtn("scm-pull", this.behind > 0 ? `↓${this.behind}` : "↓", "Pull (Ctrl+Alt+P)", (_e, cx) => this.runGit(["pull"], "Git Pull", cx)))
              .child(miniBtn("scm-push", this.ahead > 0 ? `↑${this.ahead}` : "↑", "Push (Ctrl+Alt+K)", (_e, cx) => this.runGit(["push"], "Git Push", cx))),
          )
          .child(miniBtn("scm-undo", "↶", "Undo last commit (Ctrl+Alt+Z)", (_e, cx) => this.runUndoLastCommit(cx)))
          .child(miniBtn("scm-ref", "↻", "Refresh", (_e, cx) => this.refresh(cx, { force: true }))),
      )
      .when(!this.root, (el) => el.child(div().p(12).text_color(t.dim).child("Not a git repository")))
      .when(Boolean(this.root), (el) =>
        el
          .when(Boolean(this.confirmGit), (el2) =>
            el2.child(
              h_flex().mx(4).mt(4).p(7).gap(6).items_center().rounded(6).bg(t.raised).border_1().border_color(t.blocked)
                .child(div().flex_1().truncate().text_size(11.5).child(this.confirmGit.prompt))
                .child(miniBtn("scm-git-yes", "Confirm", "Run git action", (_e, cx) => {
                  const g = this.confirmGit;
                  this.confirmGit = null;
                  this.runGit(g.args, g.title, cx);
                }))
                .child(miniBtn("scm-git-no", "Cancel", "Cancel", (_e, cx) => { this.confirmGit = null; cx.notify(); })),
            ),
          )
          .child(
            div().flex_1().min_h(0).relative().child(
              v_flex().id("scm-scroll").absolute().inset_0().overflow_y_scroll().p(4).gap(1)
                .when(this.conflicts.length > 0, (el2) =>
                  el2
                    .child(
                      h_flex().px(4).pb(1).gap(4).items_center()
                        .child(div().flex_1().text_size(11).font_semibold().text_color(t.blocked).child(`MERGE CONFLICTS (${this.conflicts.length})`))
                        .child(miniBtn("scm-merge-ed", "Merge Editor", "Open 3-Way Merge Editor (Ctrl+Alt+U)", () => openOverlay({ mod: "merge-editor", kind: "popup", at: "top", offset: 24, width: 0.76, height: 0.90 })))
                        .child(miniBtn("scm-merge-abort", "Abort", "Abort merge", (_e, cx) => {
                          this.confirmGit = { prompt: "Abort current merge (git merge --abort)?", args: ["merge", "--abort"], title: "Merge Aborted" };
                          cx.notify();
                        })),
                    )
                    .children(this.conflicts.map((f, i) => fileRow(f, "conflict", i))),
                )
                .child(
                  h_flex().px(4).pt(2).pb(1).items_center()
                    .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(`STAGED (${this.staged.length})`))
                    .when(this.staged.length > 0, (el2) => el2.child(miniBtn("scm-unstage-all", "− All", "Unstage all", (_e, cx) => this.runGit(["reset", "HEAD"], null, cx)))),
                )
                .children(renderGroup(this.staged, "staged"))
                .child(
                  h_flex().px(4).pt(6).pb(1).gap(4).items_center()
                    .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(`CHANGES (${this.unstaged.length})`))
                    .when(this.unstaged.length > 0, (el2) =>
                      el2
                        .child(miniBtn("scm-discard-all", "↩ All", "Discard all tracked unstaged changes", (_e, cx) => {
                          this.confirmGit = { prompt: "Discard all unstaged tracked changes?", args: ["checkout", "--", "."], title: "Discarded Changes" };
                          cx.notify();
                        }))
                        .child(miniBtn("scm-stash-all", "Stash", "Stash all changes (git stash push -u)", (_e, cx) => this.runGit(["stash", "push", "-u"], "Stashed All", cx)))
                        .child(miniBtn("scm-stage-all", "+ All", "Stage all (git add -A)", (_e, cx) => this.runGit(["add", "-A"], null, cx))),
                    ),
                )
                .children(renderGroup(this.unstaged, "unstaged"))
                .child(
                  h_flex().id("scm-commits-hdr").pt(7).pb(1).px(4).items_center().cursor_pointer().on_click((_e, cx) => { this.showCommits = !this.showCommits; cx.notify(); })
                    .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(`${this.showCommits ? "▾" : "▸"} COMMITS (${this.commits.length})`)),
                )
                .when(this.showCommits, (el2) =>
                  el2.children(
                    this.commits.map((c, i) =>
                      h_flex()
                        .id(`scm-c-${i}`)
                        .h(21)
                        .px(5)
                        .gap(5)
                        .items_center()
                        .rounded(4)
                        .text_size(11.5)
                        .cursor_pointer()
                        .tooltip(`${c.hash} — ${c.subject} (${c.rel})`)
                        .hover((s) => s.bg(t.hover))
                        .on_mouse_down("right", () => this.openCommitMenu(c))
                        .on_click((_e, cx) => this.showRefDiff(c.hash, false, cx))
                        .child(div().text_color(t.accent).child(c.hash))
                        .child(div().flex_1().truncate().text_color(t.foreground).child(c.subject))
                        .child(div().text_size(10.5).text_color(t.dim).child(c.rel)),
                    ),
                  ),
                )
                .child(
                  h_flex().id("scm-stash-hdr").pt(6).pb(1).px(4).items_center().cursor_pointer().on_click((_e, cx) => { this.showStashes = !this.showStashes; cx.notify(); })
                    .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(`${this.showStashes ? "▾" : "▸"} STASHES (${this.stashes.length})`))
                    .child(miniBtn("scm-stash-push", "+ Stash", "git stash push", (_e, cx) => this.runGit(["stash", "push"], "Stashed", cx))),
                )
                .when(this.showStashes, (el2) =>
                  el2.children(
                    this.stashes.map((s, i) =>
                      h_flex()
                        .id(`scm-st-${i}`)
                        .h(21)
                        .px(5)
                        .gap(5)
                        .rounded(4)
                        .text_size(11.5)
                        .items_center()
                        .cursor_pointer()
                        .hover((s2) => s2.bg(t.hover))
                        .on_mouse_down("right", () => this.openStashMenu(s))
                        .on_click((_e, cx) => this.showRefDiff(s.ref, true, cx))
                        .child(div().flex_1().truncate().text_color(t.foreground).child(`${s.ref}: ${s.msg}`))
                        .child(miniBtn(`scm-st-pop-${i}`, "Pop", "git stash pop", (_e, cx) => this.runGit(["stash", "pop", s.ref], "Stash Popped", cx))),
                    ),
                  ),
                ),
            ).child(Scrollbar.vertical("scm-scroll").absolute().inset_0()),
          )
          .when(Boolean(this.aiNotice), (el) =>
            el.child(
              h_flex()
                .mx(8)
                .mb(4)
                .px(8)
                .py(6)
                .gap(6)
                .items_start()
                .rounded(6)
                .bg(t.raised)
                .border_1()
                .border_color(t.ansi2)
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(2)
                    .child(div().text_size(11).font_semibold().text_color(t.ansi2).child(this.busy ? "AI Commit…" : "AI Commit ✓"))
                    .child((() => {
                      const lines = String(this.aiNotice ?? "").split("\n").length;
                      const h = Math.min(150, Math.max(30, lines * 16 + 6));
                      return div()
                        .relative()
                        .h(h)
                        .child(
                          div()
                            .absolute()
                            .inset_0()
                            .overflow_y_scroll()
                            .child(div().text_size(11.5).text_color(t.foreground).child(this.aiNotice)),
                        );
                    })()),
                )
                .child(
                  div()
                    .id("scm-ai-close")
                    .px(4)
                    .py(1)
                    .rounded(4)
                    .text_size(11.5)
                    .text_color(t.dim)
                    .cursor_pointer()
                    .on_click((_e, cx) => { this.aiNotice = null; cx.notify(); })
                    .child("×"),
                ),
            ),
          )
          .when(Boolean(this.note), (el) => el.child(div().px(10).py(4).text_size(11).text_color(t.ansi1).child(this.note)))
          .child(
            h_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
              .child(div().flex_1().h(30).px(8).rounded(7).border_1().border_color(t.border).child(Input.new(this.commitInput).h_full().text_size(12)))
              .child(miniBtn("scm-ai", "✧", "AI Commit (Generate & Commit)", (_e, cx) => this.draftAi(cx)))
              .child(
                div().id("scm-commit-btn").h(30).px(10).flex().items_center().rounded(7).bg(this.message.trim() ? t.accent : t.raised).text_color(this.message.trim() ? "#ffffff" : t.dim).text_size(12).cursor_pointer()
                  .on_click((_e, cx) => this.commit(cx))
                  .child(this.busy ? "…" : "Commit"),
              ),
          ),
      );
  }

  renderSettings(t, cx) {
    const cfg = getIdeSettings();
    const section = (title) => div().pt(5).pb(1).px(4).text_size(10).font_semibold().text_color(t.accent).child(title);
    const row = (id, label, valueText, onClick) =>
      h_flex()
        .id(id)
        .px(6)
        .py(3)
        .rounded(5)
        .items_center()
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(label))
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.accent).child(valueText));

    const field = (label, state) =>
      h_flex().px(4).gap(6).items_center()
        .child(div().w(72).flex_none().truncate().text_size(10.5).text_color(t.muted).child(label))
        .child(div().flex_1().h(24).px(6).rounded(5).border_1().border_color(t.border).bg(t.surface).child(Input.new(state).h_full().text_size(11).text_color(t.foreground)));

    const cycle = (val, arr) => arr[(arr.indexOf(val) + 1) % arr.length];

    return div().flex_1().min_h(0).relative()
      .child(
        v_flex()
          .id("ide-settings-scroll")
          .absolute()
          .inset_0()
          .overflow_y_scroll()
          .p(6)
          .gap(1)
          .child(section("WORKSPACE & AGENT MEMORY"))
          .child(row("set-auto-res", "Auto-reconnect agent session", cfg.autoResumeAgent ? "On" : "Off", (_e, cx) => { updateIdeSettings({ autoResumeAgent: !cfg.autoResumeAgent }); cx.notify(); }))
          .child(row("set-auto-files", "Auto-restore open files", cfg.autoRestoreFiles ? "On" : "Off", (_e, cx) => { updateIdeSettings({ autoRestoreFiles: !cfg.autoRestoreFiles }); cx.notify(); }))

          .child(section("EDITOR & LAYOUT"))
          .child(row("set-ed-eng", "Editor Engine", {
            fresh: "Fresh (LSP)",
            nvim: "Neovim (LSP)",
            builtin: "Built-in (GPUI)",
            zed: "Zed (External)",
            vscode: "VS Code (External)",
          }[cfg.editorEngine] ?? cfg.editorEngine, (_e, cx) => {
            updateIdeSettings({ editorEngine: cycle(cfg.editorEngine, ["fresh", "nvim", "builtin", "zed", "vscode"]) });
            cx.notify();
          }))
          .child(row("set-ed-pos", "Editor Placement", cfg.editorPlacement, (_e, cx) => { updateIdeSettings({ editorPlacement: cycle(cfg.editorPlacement, ["center-left", "center-top", "right"]) }); cx.notify(); }))
          .child(row("set-cool-fresh", "Cool Inactive Fresh/LSP", cfg.coolInactiveFresh ? "On" : "Off", (_e, cx) => {
            const nextCool = !cfg.coolInactiveFresh;
            updateIdeSettings({ coolInactiveFresh: nextCool });
            this.lastCoolKey = null;
            if (!nextCool && (this.on !== null || win()?.platform !== "windows")) {
              cx.spawn(async () => syncFreshCooling("", false, this.on));
            }
            cx.notify();
          }))
          .child(row("set-sb-w", "Sidebar Width", `${cfg.sidebarWidth}px`, (_e, cx) => {
            const w = cycle(cfg.sidebarWidth, [260, 300, 360, 420]);
            updateIdeSettings({ sidebarWidth: w });
            run("layout.resize", { id: "sidebar", px: w });
            cx.notify();
          }))
          .child(row("set-sp-w", "Spaces Rail Width", `${cfg.spacesWidth}px`, (_e, cx) => {
            const w = cycle(cfg.spacesWidth, [180, 210, 250]);
            updateIdeSettings({ spacesWidth: w });
            run("layout.resize", { id: "spaces-rail", px: w });
            cx.notify();
          }))

          .child(section("EXPLORER"))
          .child(row("set-autoreveal", "Auto Reveal Active File", cfg.autoReveal !== false ? "On" : "Off", (_e, cx) => {
            const next = cfg.autoReveal === false;
            updateIdeSettings({ autoReveal: next });
            if (next && this.activeFile) this.revealFileInExplorer(this.activeFile, cx, { scroll: true, force: true });
            else cx.notify();
          }))
          .child(row("set-icons", "File Icon Theme", { material: "Material", emoji: "Emoji", minimal: "Minimal" }[cfg.iconTheme] ?? cfg.iconTheme, (_e, cx) => { updateIdeSettings({ iconTheme: cycle(cfg.iconTheme, ["material", "emoji", "minimal"]) }); cx.notify(); }))
          .child(row("set-hidden", "Show Hidden Files (.)", cfg.showHidden ? "On" : "Off", (_e, cx) => { updateIdeSettings({ showHidden: !cfg.showHidden }); this.refresh(cx); }))
          .child(row("set-gitdec", "Git Decorations", cfg.gitDecorations ? "On" : "Off", (_e, cx) => { updateIdeSettings({ gitDecorations: !cfg.gitDecorations }); cx.notify(); }))
          .child(row("set-delconf", "Confirm Delete", cfg.confirmDelete ? "On" : "Off", (_e, cx) => { updateIdeSettings({ confirmDelete: !cfg.confirmDelete }); cx.notify(); }))

          .child(section("SOURCE CONTROL"))
          .child(row("set-scm-view", "SCM View Mode", cfg.scmTreeView ? "Tree" : "List", (_e, cx) => { updateIdeSettings({ scmTreeView: !cfg.scmTreeView }); cx.notify(); }))
          .child(row("set-ref", "Auto Refresh", `${cfg.refreshSec}s`, (_e, cx) => { updateIdeSettings({ refreshSec: cycle(cfg.refreshSec, [5, 10, 30]) }); cx.notify(); }))
          .child(row("set-fetch", "Remote Fetch (Sync)", cfg.fetchSec > 0 ? `${cfg.fetchSec}s` : "Off", (_e, cx) => { updateIdeSettings({ fetchSec: cycle(cfg.fetchSec, [60, 120, 300, 0]) }); cx.notify(); }))

          .child(section("AI COMMIT"))
          .child(field("Base URL", this.aiUrlInput))
          .child(field("API Key", this.aiKeyInput))
          .child(field("Model", this.aiModelInput))
          .child(row("set-think", "Thinking", this.thinking, (_e, cx) => { this.thinking = cycle(this.thinking, ["off", "low", "medium", "high"]); cx.notify(); }))
          .child(
            h_flex().px(4).pt(2).justify_end()
              .child(
                div().id("ide-ai-save").px(8).py(3).rounded(5).bg(t.accent).text_color("#ffffff").text_size(11).font_semibold().cursor_pointer()
                  .on_click((_e, cx) => this.saveAiSettings(cx))
                  .child("Save AI Settings"),
              ),
          )

          .child(section("CONFIG FILES"))
          .child(row("set-cfg-keys", "Edit keys.json", "Open", (_e, cx) => openInCenterEditor({ file: "keys.json", root: appHome(), on: null, line: 1, direct: true }, cx)))
          .child(row("set-cfg-lay", "Edit terminals-git.json", "Open", (_e, cx) => openInCenterEditor({ file: "layouts/terminals-git.json", root: appHome(), on: null, line: 1, direct: true }, cx)))
          .child(row("set-cfg-app", "App Settings", "Open", () => run("app.settings"))),
      )
      .child(Scrollbar.vertical("ide-settings-scroll").absolute().inset_0());
  }

  currentSyncBadge() {
    const curJobKey = this.root ? `${this.on ?? "local"}:${this.root}` : null;
    return (curJobKey && this.bgJobsByRepo?.get(curJobKey)) || this.syncLabel;
  }

  render(cx) {
    if (!checking()) this.syncWorkPane();
    if (locationKey() !== this.context) this.refresh(cx);
    const t = theme();
    const tabBtn = (id, label) => {
      const active = this.view === id;
      return div()
        .id(`ide-tab-${id}`)
        .px(9)
        .py(4)
        .rounded(6)
        .text_size(11.5)
        .cursor_pointer()
        .when(active, (el) => el.bg(t.accent).text_color("#ffffff").font_semibold())
        .when(!active, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => {
          if (id === "settings" && this.view === "settings") {
            this.view = this.prevView || "scm";
          } else {
            if (this.view !== "settings") this.prevView = this.view;
            this.view = id;
          }
          if (this.view === "explorer") {
            if (getIdeSettings().autoReveal !== false && this.activeFile) {
              this.revealFileInExplorer(this.activeFile, cx, { scroll: true, force: true });
            }
            this.probeFreshActiveFile(cx, getIdeSettings().autoReveal !== false);
          }
          this.refresh(cx);
          cx.notify();
        })
        .child(label);
    };
    const curSyncBadge = this.currentSyncBadge();

    return v_flex()
      .id("ide-sidebar")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(8)
          .gap(4)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(tabBtn("explorer", "Files"))
          .child(tabBtn("search", "Search"))
          .child(tabBtn("scm", `Git${this.staged.length + this.unstaged.length ? ` (${this.staged.length + this.unstaged.length})` : ""}`))
          .when(Boolean(curSyncBadge), (el) =>
            el.child(div().px(5).py(1).rounded(4).bg(t.accent + "22").text_size(10.5).text_color(t.accent).child(curSyncBadge)),
          )
          .child(div().flex_1())
          .child(tabBtn("settings", "⚙")),
      )
      .when(this.view === "explorer", (el) => el.child(this.renderExplorer(t, cx)))
      .when(this.view === "search", (el) => el.child(this.renderSearch(t, cx)))
      .when(this.view === "scm", (el) => el.child(this.renderScm(t, cx)))
      .when(this.view === "settings", (el) => el.child(this.renderSettings(t, cx)));
  }
}
