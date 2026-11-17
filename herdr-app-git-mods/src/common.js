import {
  spaces, panes, terminals, focused, exec, readTextFile, writeTextFile,
  shared, setShared, run, appHome, notify, window as win, openOverlay, closeOverlay,
} from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

const DEFAULT_IDE_SETTINGS = {
  editorEngine: "fresh",          // "fresh" | "builtin" | "nvim" | "zed" | "vscode"
  editorPlacement: "center-left", // "center-left" | "center-top" | "right"
  iconTheme: "material",          // "material" | "emoji" | "minimal"
  sidebarWidth: 300,
  spacesWidth: 210,
  showHidden: false,
  gitDecorations: true,
  confirmDelete: true,
  scmTreeView: false,
  autoStashSwitch: false,
  refreshSec: 10,
  fetchSec: 60,
  coolInactiveFresh: true,
  autoRestoreFiles: false,
  autoReveal: true,
};

function classifyFileIcon(name, isDir, isOpen) {
  if (isDir) {
    const low = name.toLowerCase();
    const color = low === "src" || low === "app" ? "#3b82f6"
      : low === "tests" || low === "test" ? "#22c55e"
      : low === "config" || low === ".git" ? "#f59e0b"
      : low === "docs" ? "#38bdf8"
      : "#94a3b8";
    return { kind: "dir", badge: isOpen ? "▾" : "▸", emoji: isOpen ? "📂" : "📁", color };
  }
  const low = name.toLowerCase();
  const ext = low.includes(".") ? low.split(".").pop() : "";
  if (low === "dockerfile" || low.startsWith("dockerfile.")) return { badge: "DK", emoji: "🐳", color: "#38bdf8" };
  if (low === "cargo.toml" || ext === "rs") return { badge: "rs", emoji: "🦀", color: "#f97316" };
  if (ext === "php" || ext === "blade.php") return { badge: "php", emoji: "🐘", color: "#a855f7" };
  if (ext === "ts" || ext === "mts" || ext === "cts") return { badge: "TS", emoji: "📘", color: "#3b82f6" };
  if (ext === "tsx" || ext === "jsx") return { badge: "RX", emoji: "⚛️", color: "#38bdf8" };
  if (ext === "js" || ext === "mjs" || ext === "cjs") return { badge: "JS", emoji: "📒", color: "#eab308" };
  if (ext === "py" || ext === "pyi") return { badge: "py", emoji: "🐍", color: "#3b82f6" };
  if (ext === "go") return { badge: "go", emoji: "🐹", color: "#06b6d4" };
  if (ext === "vue") return { badge: "V", emoji: "💚", color: "#22c55e" };
  if (ext === "html" || ext === "htm" || ext === "svelte") return { badge: "<>", emoji: "🌐", color: "#f97316" };
  if (ext === "css" || ext === "scss" || ext === "less") return { badge: "#", emoji: "🎨", color: "#ec4899" };
  if (ext === "json" || ext === "jsonc") return { badge: "{}", emoji: "📋", color: "#f59e0b" };
  if (ext === "toml" || ext === "yaml" || ext === "yml" || ext === "ini") return { badge: "⚙", emoji: "⚙️", color: "#a78bfa" };
  if (ext === "md" || ext === "mdx" || ext === "markdown") return { badge: "M↓", emoji: "📝", color: "#60a5fa" };
  if (ext === "sql" || ext === "sqlite") return { badge: "db", emoji: "🗄️", color: "#14b8a6" };
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "ps1") return { badge: "$_", emoji: "💻", color: "#22c55e" };
  if (low.startsWith(".env") || low === ".gitignore" || ext === "lock") return { badge: "··", emoji: "🔒", color: "#94a3b8" };
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "svg" || ext === "gif" || ext === "webp") return { badge: "img", emoji: "🖼️", color: "#f472b6" };
  return { badge: "•", emoji: "📄", color: "#94a3b8" };
}

function renderFileIcon(divFn, svgFn, name, isDir, isOpen, iconTheme, t) {
  if (iconTheme === "minimal") {
    return svgFn(`mods/files/${isDir ? "folder" : "file"}.svg`).size(13).text_color(t.muted);
  }
  const info = classifyFileIcon(name, isDir, isOpen);
  if (iconTheme === "emoji") {
    return divFn().w(16).flex_none().text_size(12).child(info.emoji);
  }
  if (isDir) {
    return svgFn("mods/files/folder.svg").size(14).flex_none().text_color(info.color);
  }
  return divFn()
    .w(18)
    .flex_none()
    .text_center()
    .text_size(9.5)
    .font_bold()
    .text_color(info.color)
    .child(info.badge);
}

async function execRg(args, cwd, on) {
  for (const bin of ["rg", "/usr/bin/rg", "/home/xian/.local/bin/rg"]) {
    try {
      const r = await exec(bin, args, { cwd, on });
      if (r && r.code !== 127) return r;
    } catch {}
  }
  return null;
}

function getIdeSettings() {
  const s = shared("ide.settings");
  return { ...DEFAULT_IDE_SETTINGS, ...(s && typeof s === "object" ? s : {}) };
}

function updateIdeSettings(patch) {
  const next = { ...getIdeSettings(), ...patch };
  setShared("ide.settings", next);
  try {
    const path = `${appHome()}/ide-settings.json`;
    readTextFile(path).then((prev) => writeTextFile(path, JSON.stringify(next, null, 2), prev)).catch(() => {});
  } catch {}
  return next;
}

function getContext() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const allPanes = panes();
  const activeTab = space?.tabs?.find((t) => t.active)?.id;
  const tabPanes = activeTab ? allPanes.filter((p) => p.tab === activeTab) : [];
  const trackedEdId = activeTab ? shared("ide.editor.paneByTab")?.[activeTab] : null;
  const pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null
    ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null)
    : (space?.machine ?? null);

  let rawCwd = null;
  if (pane?.cwd && !isEditorPane(pane, trackedEdId)) {
    rawCwd = pane.cwd;
  } else if (f?.pane === null && f?.cwd) {
    rawCwd = f.cwd;
  } else {
    const rememberedId = activeTab ? shared("ide.workPaneByTab")?.[activeTab] : null;
    const isWorkPane = (p) => Boolean(p?.cwd) && !isEditorPane(p, trackedEdId);
    const workPane =
      (rememberedId && tabPanes.find((p) => p.pane === rememberedId && isWorkPane(p))) ||
      tabPanes.find((p) => p.focused && isWorkPane(p)) ||
      tabPanes.find((p) => isWorkPane(p) && (p.status || p.app || p.program?.agent)) ||
      tabPanes.find((p) => isWorkPane(p)) ||
      tabPanes.find((p) => p.cwd) ||
      (() => {
        const spaceTabs = new Set((space?.tabs ?? []).map((t) => t.id));
        const spacePanes = allPanes.filter((p) => spaceTabs.has(p.tab) && p.cwd);
        return spacePanes.find((p) => !isEditorPane(p, shared("ide.editor.paneByTab")?.[p.tab])) ?? spacePanes[0] ?? null;
      })();
    rawCwd = workPane?.cwd || pane?.cwd || f?.cwd || space?.folder || null;
  }
  const cwd = rawCwd ? rawCwd.replace(/ \(deleted\)$/, "") : null;
  return { cwd, on, space };
}

function wsHistoryKey(space, root) {
  const loc = root || space?.folder || space?.name || "default";
  return `${space?.machine ?? "local"}:${loc}`;
}

function shortHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function sq(s) {
  return String(s).replace(/'/g, "'\\''");
}

function recordWorkspaceSnapshot(space, root, activeView) {
  if (!space) return null;
  const key = wsHistoryKey(space, root);
  const all = { ...(shared("ide.ws.history") ?? {}) };
  const prev = all[key] ?? {};
  const cwd = root || space.folder || prev.cwd || null;

  const next = {
    ...prev,
    key,
    spaceName: space.name,
    machine: space.machine ?? null,
    cwd,
    lastView: activeView ?? prev.lastView ?? "scm",
    updatedAt: Date.now(),
  };
  all[key] = next;
  setShared("ide.ws.history", all);
  return next;
}

function publishActiveFile(file, root, on) {
  if (!file || !root) return;
  setShared("ide.explorer.reveal", {
    seq: (shared("ide.explorer.reveal")?.seq ?? 0) + 1,
    file,
    root,
    on: on ?? null,
    ts: Date.now(),
  });
}

function rememberOpenedFile(space, root, file, line) {
  if (!space || !file) return;
  const key = wsHistoryKey(space, root);
  const all = { ...(shared("ide.ws.history") ?? {}) };
  const prev = all[key] ?? {};
  const files = (prev.lastFiles ?? []).filter((f) => f.file !== file);
  files.unshift({ file, line: line ?? 1 });
  all[key] = { ...prev, key, cwd: root || space.folder, lastFiles: files.slice(0, 8), updatedAt: Date.now() };
  setShared("ide.ws.history", all);
}

function isEditorPane(p, trackedPaneId) {
  if (!p) return false;
  if (trackedPaneId && p.pane === trackedPaneId) return true;
  if (p.mod === "ide-editor") return true;
  const prog = (p.program?.name || p.program?.id || "").toLowerCase();
  const title = (p.title || "").toLowerCase();
  return prog === "fresh" || prog === "nvim" || prog === "hx" || title.includes("fresh") || title.includes("nvim");
}

function findNonEditorTerminal(tabPanes, trackedId) {
  return tabPanes.find((p) => p.terminal && !isEditorPane(p, trackedId)) ?? tabPanes.find((p) => !isEditorPane(p, trackedId));
}

function enforceTabEditorOrderAndMouse(tabId, cfg) {
  if (!tabId) return false;
  const tabPanes = panes().filter((p) => p.tab === tabId);
  if (!tabPanes.length) return false;
  const paneMap = { ...(shared("ide.editor.paneByTab") ?? {}) };
  const trackedId = paneMap[tabId] ?? null;
  const edPane = tabPanes.find((p) => isEditorPane(p, trackedId));
  if (!edPane) return false;

  if (paneMap[tabId] !== edPane.pane) {
    paneMap[tabId] = edPane.pane;
    setShared("ide.editor.paneByTab", paneMap);
  }

  // Automatically enable direct right-click context menu on terminal editors (Fresh / Nvim).
  if (edPane.terminal) {
    const term = terminals().find((t) => t.address === edPane.terminal);
    if (term && term.labels?.["herdr.right-click"] !== "program") {
      run("terminal.right_click", { terminal: edPane.terminal, to: "program" });
    }
  }

  // Keep Editor left/top of AI Agent & shell panes so AI Agent stays on the right.
  if (cfg.editorPlacement === "center-left" || cfg.editorPlacement === "center-top") {
    const edIdx = tabPanes.findIndex((p) => p.pane === edPane.pane);
    const nonEdIdx = tabPanes.findIndex((p) => p.pane !== edPane.pane && !isEditorPane(p, trackedId));
    if (edIdx > nonEdIdx && nonEdIdx >= 0) {
      run("pane.swap", { pane: edPane.pane, target: tabPanes[nonEdIdx].pane });
      return true;
    }
  }
  return false;
}

function swapToCenter(cfg, cx, tabId) {
  const targetTab = tabId || spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id;
  if (!targetTab) return;
  enforceTabEditorOrderAndMouse(targetTab, cfg);
  if (cx?.spawn) {
    cx.spawn(async (asyncCx) => {
      for (const waitMs of [120, 260, 550]) {
        await asyncCx.sleep(waitMs);
        enforceTabEditorOrderAndMouse(targetTab, cfg);
      }
    });
  } else if (cx?.timer?.after) {
    cx.timer.after(180, () => enforceTabEditorOrderAndMouse(targetTab, cfg));
    cx.timer.after(550, () => enforceTabEditorOrderAndMouse(targetTab, cfg));
  }
}

function openExternalEditor(engine, file, root, on, line) {
  const absLinux = file.startsWith("/") ? file : `${root.replace(/\/+$/, "")}/${file}`;
  const ln = line && line > 1 ? `:${line}` : "";
  if (engine === "vscode") {
    if (on) {
      exec("code", ["--remote", "wsl+ubuntu", "--reuse-window", "--goto", `${absLinux}${ln}`], { cwd: root, on }).catch(() => {
        const winPath = absLinux.startsWith("/mnt/") ? `${absLinux[5].toUpperCase()}:${absLinux.slice(6).replace(/\//g, "\\")}` : `\\\\wsl.localhost\\ubuntu${absLinux.replace(/\//g, "\\")}`;
        exec("cmd", ["/c", "code", "--reuse-window", "--goto", `${winPath}${ln}`], {}).catch(() => {});
      });
    } else {
      exec("cmd", ["/c", "code", "--reuse-window", "--goto", `${root}\\${file}${ln}`], {}).catch(() => {});
    }
    return;
  }
  if (engine === "zed") {
    const winTarget = on
      ? (absLinux.startsWith("/mnt/") ? `${absLinux[5].toUpperCase()}:${absLinux.slice(6).replace(/\//g, "\\")}` : `\\\\wsl.localhost\\ubuntu${absLinux.replace(/\//g, "\\")}`)
      : `${root}\\${file}`;
    exec("zed", [`${winTarget}${ln}`], {}).catch(() => {
      exec("cmd", ["/c", "start", "", "Zed", `${winTarget}${ln}`], {}).catch(() => {});
    });
  }
}

function freshLaunchBash(root, daemonName, target) {
  return `cd '${sq(root)}' && export FRESH_IDE_DAEMON='${daemonName}' && F="$HOME/.local/share/fresh-editor/fresh"; [ -x "$F" ] || F=fresh; exec "$F" --no-upgrade-check -a '${daemonName}' '${sq(target)}'`;
}

async function wakeFreshDaemon(daemonName, on) {
  if (!daemonName) return;
  const script = `
    for p in /proc/[0-9]*/cmdline; do
      pid=\${p#/proc/}; pid=\${pid%/cmdline}
      args=$(tr '\\0' ' ' < "$p" 2>/dev/null || true)
      bin=\${args%% *}
      case "$bin" in */fresh|fresh) ;; *) continue ;; esac
      case "$args" in
        *"--server --session-name $1 "*|*"--server --session-name $1"|*" -a $1 "*|*" -a $1")
          pgid=$(awk '{print $5}' "/proc/$pid/stat" 2>/dev/null || true)
          if [ "$pgid" = "$pid" ]; then kill -CONT -- "-$pid" 2>/dev/null || true
          else kill -CONT "$pid" 2>/dev/null || true; fi ;;
      esac
    done
  `;
  await exec("bash", ["-c", script, "fresh-wake", daemonName], { on }).catch(() => {});
}

// One exec for the whole open: scan /proc for a Fresh TUI attached to this daemon
// (SIGCONTing what cooling stopped), then run open-file. `fresh --cmd session
// open-file` exits 0 even with no daemon — it then starts a detached one and the
// file opens where no pane shows it — so with no TUI attached we exit 75 and the
// caller rebuilds the pane instead. The scan reads cmdline with bash builtins
// only: a fork per process costs ~250ms on a busy WSL, builtins ~60ms.
async function runFreshOpenAttached(daemonName, target, root, on) {
  const cache = shared("ide.freshBinByHost") ?? {};
  const known = cache[on || "local"] ?? "";
  const script = `
    attached=""
    for p in /proc/[0-9]*/cmdline; do
      pid=\${p%/cmdline}; pid=\${pid#/proc/}
      args=""
      while IFS= read -r -d "" arg; do args="$args$arg "; done 2>/dev/null < "$p"
      bin=\${args%% *}
      case "$bin" in */fresh|fresh) ;; *) continue ;; esac
      case "$args" in
        *" --server --session-name $1 "*|*" --server --session-name $1")
          read -r _ _ _ _ pgid _ 2>/dev/null < "/proc/$pid/stat"
          if [ "$pgid" = "$pid" ]; then kill -CONT -- "-$pid" 2>/dev/null || true
          else kill -CONT "$pid" 2>/dev/null || true; fi ;;
        *" -a $1 "*|*" -a $1")
          kill -CONT "$pid" 2>/dev/null || true
          attached=a ;;
      esac
    done
    [ -n "$attached" ] || exit 75
    F="$3"; [ -x "$F" ] || F="$HOME/.local/share/fresh-editor/fresh"; [ -x "$F" ] || F="$(command -v fresh || echo fresh)"
    printf '%s\\n' "$F"
    exec "$F" --no-upgrade-check --cmd session open-file "$1" "$2"
  `;
  const r = await exec("bash", ["-c", script, "fresh-open", daemonName, target, known], { cwd: root, on, timeout: 2500 }).catch(() => null);
  if (r?.stdout) {
    const bin = r.stdout.split("\n")[0]?.trim();
    if (bin && !bin.includes(" ") && bin !== known) {
      setShared("ide.freshBinByHost", { ...cache, [on || "local"]: bin });
    }
  }
  return r;
}

async function syncFreshCooling(activeDaemonName, enableCooling, on) {
  const script = `
    keep="$1"; cool="$2"
    for p in /proc/[0-9]*/cmdline; do
      pid=\${p#/proc/}; pid=\${pid%/cmdline}
      args=$(tr '\\0' ' ' < "$p" 2>/dev/null || true)
      bin=\${args%% *}
      case "$bin" in */fresh|fresh) ;; *) continue ;; esac
      name=""
      case "$args" in
        *"--server --session-name ide-"*) name=\${args##*--session-name }; name=\${name%% *} ;;
        *" -a ide-"*) name=\${args##* -a }; name=\${name%% *} ;;
        *) continue ;;
      esac
      pgid=$(awk '{print $5}' "/proc/$pid/stat" 2>/dev/null || true)
      if [ "$cool" != "1" ] || { [ -n "$keep" ] && [ "$name" = "$keep" ]; }; then
        if [ "$pgid" = "$pid" ]; then kill -CONT -- "-$pid" 2>/dev/null || true
        else kill -CONT "$pid" 2>/dev/null || true; fi
      else
        if [ "$pgid" = "$pid" ]; then kill -STOP -- "-$pid" 2>/dev/null || true
        else kill -STOP "$pid" 2>/dev/null || true; fi
      fi
    done
  `;
  await exec("bash", ["-c", script, "fresh-cool", activeDaemonName || "", enableCooling ? "1" : "0"], { on }).catch(() => {});
}

async function execTerminalEditorJump(job, cx) {
  const cfg = getIdeSettings();
  run("pane.focus", { pane: job.pane });

  if (job.kind === "nvim") {
    const res = await exec("nvim", ["--server", job.sock, "--remote-silent", `+${job.line}`, job.absPath], { cwd: job.root, on: job.on, timeout: 2500 }).catch(() => null);
    if (res && res.code === 0) {
      enforceTabEditorOrderAndMouse(job.activeTab, cfg);
      return;
    }
    run("pane.close", { pane: job.pane });
    const tp = findNonEditorTerminal(panes().filter((p) => !job.activeTab || p.tab === job.activeTab), null);
    if (tp) {
      const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
      setShared("ide.editor.spawning", { tab: job.activeTab, at: Date.now() });
      run("pane.split", { direction: dir, pane: tp.pane, argv: ["bash", "-lc", `cd '${sq(job.root)}' && rm -f '${job.sock}' && exec nvim --listen '${job.sock}' +${job.line} '${sq(job.absPath)}'`] });
      swapToCenter(cfg, cx, job.activeTab);
    }
    return;
  }

  // One exec checks a TUI is attached to this daemon and opens the file (exit 75:
  // none attached — open-file would start a detached daemon no pane shows).
  let res = await runFreshOpenAttached(job.daemonName, job.target, job.root, job.on);
  let out = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
  const opened = () => res && res.code === 0 && !out.includes("Version mismatch");
  if (!opened() && res?.code !== 75) {
    // Slow fallback: wake if SIGSTOPped and retry once before respawning.
    await wakeFreshDaemon(job.daemonName, job.on);
    res = await runFreshOpenAttached(job.daemonName, job.target, job.root, job.on);
    out = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
  }
  if (opened()) {
    enforceTabEditorOrderAndMouse(job.activeTab, cfg);
    return;
  }

  run("pane.close", { pane: job.pane });
  const tp = findNonEditorTerminal(panes().filter((p) => !job.activeTab || p.tab === job.activeTab), null);
  if (tp) {
    const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
    setShared("ide.editor.spawning", { tab: job.activeTab, at: Date.now() });
    run("pane.split", { direction: dir, pane: tp.pane, argv: ["bash", "-lc", freshLaunchBash(job.root, job.daemonName, job.target)] });
    swapToCenter(cfg, cx, job.activeTab);
  }
}

function openInCenterEditor({ file, root, on, line, direct }, cx) {
  const cfg = getIdeSettings();
  const diffOverlay = shared("ide.diff.overlay");
  if (diffOverlay) {
    setShared("ide.diff.overlay", null);
    closeOverlay(diffOverlay);
  }
  const space = spaces().find((s) => s.active);
  const activeTab = space?.tabs?.find((t) => t.active)?.id;
  const tabPanes = panes().filter((p) => !activeTab || p.tab === activeTab);

  rememberOpenedFile(space, root, file, line);
  publishActiveFile(file, root, on ?? null);

  if (cfg.editorEngine === "vscode" || cfg.editorEngine === "zed") {
    openExternalEditor(cfg.editorEngine, file, root, on, line);
    return;
  }

  const paneMap = { ...(shared("ide.editor.paneByTab") ?? {}) };
  const trackedId = activeTab ? paneMap[activeTab] : null;
  const editorPanes = tabPanes.filter((p) => isEditorPane(p, trackedId));

  // Enforce strictly ONE editor pane per tab: close any extra duplicates immediately.
  for (let i = 1; i < editorPanes.length; i++) {
    run("pane.close", { pane: editorPanes[i].pane });
  }
  const existingEd = editorPanes[0] ?? null;
  const targetPane = findNonEditorTerminal(tabPanes, trackedId) ?? tabPanes[0];

  const spawning = shared("ide.editor.spawning");
  if (!existingEd && spawning && spawning.tab === activeTab && Date.now() - spawning.at < 1500) {
    return;
  }

  const absPath = file.startsWith("/") ? file : `${root.replace(/\/+$/, "")}/${file}`;
  const ln = line && line > 1 ? line : 1;
  const target = ln > 1 ? `${absPath}:${ln}` : absPath;
  const wantFresh = cfg.editorEngine === "fresh" && (on !== null || win()?.platform !== "windows");
  const wantNvim = cfg.editorEngine === "nvim" && (on !== null || win()?.platform !== "windows");

  // 1. Neovim (WSL2 / Linux + LSP via ~/.config/nvim)
  if (wantNvim) {
    const sock = `/tmp/herdr-nvim-${shortHash(`${activeTab ?? "t"}:${root}`)}.sock`;
    if (existingEd && existingEd.terminal) {
      const job = {
        seq: (shared("ide.terminalEditor.jump")?.seq ?? 0) + 1,
        kind: "nvim",
        sock,
        absPath,
        line: ln,
        root,
        on: on ?? null,
        activeTab,
        pane: existingEd.pane,
      };
      if (direct || !shared("ide.sidebar.alive")) {
        cx?.spawn?.((cx2) => execTerminalEditorJump(job, cx2));
      } else {
        setShared("ide.terminalEditor.jump", job);
      }
      return;
    }
    if (existingEd && existingEd.mod === "ide-editor") {
      run("pane.close", { pane: existingEd.pane });
    }
    if (targetPane) {
      const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
      setShared("ide.editor.spawning", { tab: activeTab, at: Date.now() });
      run("pane.split", {
        direction: dir,
        pane: targetPane.pane,
        argv: ["bash", "-lc", `cd '${sq(root)}' && rm -f '${sock}' && exec nvim --listen '${sock}' +${ln} '${sq(absPath)}'`],
      });
      swapToCenter(cfg, cx, activeTab);
      return;
    }
  }

  // 2. Fresh (WSL2 / Linux + LSP)
  if (wantFresh) {
    const daemonName = `ide-${shortHash(`${activeTab ?? "t"}:${root}`)}`;
    if (existingEd && existingEd.terminal) {
      const job = {
        seq: (shared("ide.terminalEditor.jump")?.seq ?? 0) + 1,
        kind: "fresh",
        daemonName,
        target,
        root,
        on: on ?? null,
        activeTab,
        pane: existingEd.pane,
      };
      if (direct || !shared("ide.sidebar.alive")) {
        cx?.spawn?.((cx2) => execTerminalEditorJump(job, cx2));
      } else {
        setShared("ide.terminalEditor.jump", job);
      }
      return;
    }
    if (existingEd && existingEd.mod === "ide-editor") {
      run("pane.close", { pane: existingEd.pane });
    }
    if (targetPane) {
      const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
      setShared("ide.editor.spawning", { tab: activeTab, at: Date.now() });
      run("pane.split", {
        direction: dir,
        pane: targetPane.pane,
        argv: ["bash", "-lc", freshLaunchBash(root, daemonName, target)],
      });
      swapToCenter(cfg, cx, activeTab);
      return;
    }
  }

  // 3. Built-in GPUI ide-editor (strictly single instance per tab)
  const seq = (shared("ide.editor.open")?.seq ?? 0) + 1;
  const payload = { kind: "file", file, root, on: on ?? null, line: ln, seq };
  openBuiltinPane(payload, cfg, tabPanes, paneMap, activeTab, existingEd, targetPane, cx);
}

function openBuiltinPane(payload, cfg, tabPanes, paneMap, activeTab, existingEd, targetPane, cx) {
  setShared("ide.editor.open", payload);
  if (existingEd && existingEd.mod === "ide-editor") {
    if (activeTab) {
      paneMap[activeTab] = existingEd.pane;
      setShared("ide.editor.paneByTab", paneMap);
    }
    swapToCenter(cfg, cx, activeTab);
    run("pane.focus", { pane: existingEd.pane });
    return;
  }
  if (existingEd && existingEd.terminal) {
    run("pane.close", { pane: existingEd.pane });
  }
  if (targetPane) {
    const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
    setShared("ide.editor.spawning", { tab: activeTab, at: Date.now() });
    run("pane.split", { direction: dir, pane: targetPane.pane, mod: "ide-editor", props: payload });
    swapToCenter(cfg, cx);
  } else {
    setShared("ide.editor.spawning", { tab: activeTab, at: Date.now() });
    run("pane.split", { direction: "right", mod: "ide-editor", props: payload });
  }
}

function openDiffInCenterEditor({ title, file, staged, untracked, ref, isStash, root, on }, cx) {
  const cfg = getIdeSettings();
  const seq = (shared("ide.editor.open")?.seq ?? 0) + 1;
  const payload = {
    kind: "diff",
    title: title || (file ? `Diff: ${file.split("/").pop()}` : `Diff: ${ref}`),
    file: file ?? null,
    staged: Boolean(staged),
    untracked: Boolean(untracked),
    ref: ref ?? null,
    isStash: Boolean(isStash),
    root,
    on: on ?? null,
    seq,
  };
  // Keep external terminal editors (Fresh/Nvim) alive in the center pane instead
  // of closing and re-splitting panes on every file <-> diff switch.
  if (cfg.editorEngine !== "builtin") {
    setShared("ide.editor.open", payload);
    if (!shared("ide.diff.overlay")) {
      openOverlay({ mod: "ide-editor", kind: "popup", at: "top", offset: 24, width: 0.78, height: 0.88, props: payload });
    }
    return;
  }
  const space = spaces().find((s) => s.active);
  const activeTab = space?.tabs?.find((t) => t.active)?.id;
  const tabPanes = panes().filter((p) => !activeTab || p.tab === activeTab);
  const paneMap = { ...(shared("ide.editor.paneByTab") ?? {}) };
  const trackedId = activeTab ? paneMap[activeTab] : null;
  const editorPanes = tabPanes.filter((p) => isEditorPane(p, trackedId));
  for (let i = 1; i < editorPanes.length; i++) {
    run("pane.close", { pane: editorPanes[i].pane });
  }
  const existingEd = editorPanes[0] ?? null;
  const targetPane = findNonEditorTerminal(tabPanes, trackedId) ?? tabPanes[0];
  openBuiltinPane(payload, cfg, tabPanes, paneMap, activeTab, existingEd, targetPane, cx);
}

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: untab(line) };
  });
}

function toBase64Utf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2] + alphabet[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? alphabet[b2 & 63] : "=";
  }
  return out;
}

function bumpGitDirty() {
  setShared("ide.git.dirtySeq", (shared("ide.git.dirtySeq") ?? 0) + 1);
}

function summarizeDiffStatFallback(statOut) {
  const files = (statOut || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|"))
    .map((l) => l.split("|")[0].trim().split("/").pop())
    .slice(0, 4);
  return files.length ? `chore: update ${files.join(", ")}` : "chore: update repository files";
}

function cleanAiCommitText(rawText) {
  const lines = (rawText || "")
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/```$/gm, "")
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return "";
  lines[0] = lines[0].trim().replace(/^["'`]+|["'`]+$/g, "");
  return lines.slice(0, 6).join("\n").trim();
}

async function generateAiCommitMessage(stat, patch, root, on) {
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
              content: "Write a Conventional Commit message: 1 clear subject line (<=72 chars), optionally followed by a blank line and 1-3 short bullet points summarizing key changes. Plain text only, no markdown fences or quotes.",
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
          const text = JSON.parse(resp.stdout)?.choices?.[0]?.message?.content?.trim();
          const cleaned = cleanAiCommitText(text);
          if (cleaned) return cleaned;
        }
      }
    }
  } catch {}

  try {
    const claude = await exec(
      "claude",
      ["-p", `Write a Conventional Commit message (1 subject line + optional 1-3 short bullet lines, plain text, no markdown):\n${stat}\n\n${patch.slice(0, 3500)}`],
      { cwd: root, on, timeout: 15000 },
    );
    if (claude.code === 0 && claude.stdout.trim()) {
      const cleaned = cleanAiCommitText(claude.stdout);
      if (cleaned) return cleaned;
    }
  } catch {}

  return summarizeDiffStatFallback(stat);
}

function summarizeGitSyncText(rawText, fallback) {
  const lines = (rawText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^To\s+https?:\/\//i.test(l) && !/^From\s+https?:\/\//i.test(l));
  return lines.join(" · ") || (rawText || "").trim() || fallback;
}

async function runGitSyncWithUpstream(kind, root, on) {
  notify({
    title: kind === "pull" ? "Git Pull" : "Git Push",
    body: kind === "pull" ? "正在从远程拉取代码…" : "正在推送代码到远程仓库…",
    level: "info",
    timeout: 2500,
  });
  let r = await exec("git", [kind], { cwd: root, on });
  let out = (r.stdout ?? "").trim();
  let err = (r.stderr ?? "").trim();
  if (r.code !== 0 && kind === "push" && (err.includes("no upstream") || err.includes("set-upstream"))) {
    const br = await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root, on });
    if (br.code === 0 && br.stdout.trim()) {
      r = await exec("git", ["push", "-u", "origin", br.stdout.trim()], { cwd: root, on });
      out = (r.stdout ?? "").trim();
      err = (r.stderr ?? "").trim();
    }
  }
  const ok = r.code === 0;
  const rawDetail = ok ? (out || err) : (err || out);
  const detail = summarizeGitSyncText(
    rawDetail,
    ok ? (kind === "pull" ? "Already up to date." : "Push complete.") : `git ${kind} failed`,
  );
  notify({
    title: kind === "pull" ? (ok ? "Git Pull 完成" : "Git Pull 失败") : (ok ? "Git Push 完成" : "Git Push 失败"),
    body: detail,
    level: ok ? "success" : "error",
    timeout: 4500,
  });
  if (ok) bumpGitDirty();
  return { ok, detail };
}

async function saveText(absPath, content, prevRaw, on) {
  if (!on) {
    await writeTextFile(absPath, content, prevRaw);
  } else {
    const b64 = toBase64Utf8(content);
    const res = await exec("sh", ["-c", 'printf %s "$1" | base64 -d > "$2"', "write", b64, absPath], { on });
    if (res.code !== 0) throw new Error(res.stderr || "Failed to write file");
  }
  setShared("ide.git.dirtySeq", (shared("ide.git.dirtySeq") ?? 0) + 1);
}
