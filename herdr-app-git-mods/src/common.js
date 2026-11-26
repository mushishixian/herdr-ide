import {
  spaces, panes, terminals, focused, exec, hc, layout, readTextFile, writeTextFile,
  shared, setShared, run, appHome, notify, window as win, openOverlay, closeOverlay,
} from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

const DEFAULT_IDE_SETTINGS = {
  editorEngine: "fresh",          // "fresh" | "builtin" | "nvim" | "zed" | "vscode"
  editorPlacement: "center-left", // "center-left" | "center-top" | "right"
  iconTheme: "material",          // "material" | "emoji" | "minimal"
  sidebarWidth: 300,
  spacesWidth: 210,
  bottomTermHeight: 160,
  showHidden: false,
  gitDecorations: true,
  confirmDelete: true,
  scmTreeView: false,
  autoStashSwitch: false,
  refreshSec: 10,
  fetchSec: 60,
  coolInactiveFresh: true,
  autoRestoreFiles: true,
  autoResumeAgent: true,
  autoReveal: true,
  uiScale: 1,                     // chrome scale factor; 1080p reference is 1, 2K screens use ~1.33
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
  const termsByAddr = terminalMap();
  const activeTab = space?.tabs?.find((t) => t.active)?.id;
  const tabPanes = activeTab ? allPanes.filter((p) => p.tab === activeTab) : [];
  const trackedEdId = activeTab ? shared("ide.editor.paneByTab")?.[activeTab] : null;
  const pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null
    ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null)
    : (space?.machine ?? null);

  let rawCwd = null;
  if (pane?.cwd && !isEditorPane(pane, trackedEdId, termsByAddr)) {
    rawCwd = pane.cwd;
  } else if (f?.pane === null && f?.cwd) {
    rawCwd = f.cwd;
  } else {
    const rememberedId = activeTab ? shared("ide.workPaneByTab")?.[activeTab] : null;
    const isWorkPane = (p) => Boolean(p?.cwd) && !isEditorPane(p, trackedEdId, termsByAddr);
    const workPane =
      (rememberedId && tabPanes.find((p) => p.pane === rememberedId && isWorkPane(p))) ||
      tabPanes.find((p) => p.focused && isWorkPane(p)) ||
      tabPanes.find((p) => isWorkPane(p) && (p.status || p.app || p.program?.agent)) ||
      tabPanes.find((p) => isWorkPane(p)) ||
      tabPanes.find((p) => p.cwd) ||
      (() => {
        const spaceTabs = new Set((space?.tabs ?? []).map((t) => t.id));
        const spacePanes = allPanes.filter((p) => spaceTabs.has(p.tab) && p.cwd);
        return spacePanes.find((p) => !isEditorPane(p, shared("ide.editor.paneByTab")?.[p.tab], termsByAddr)) ?? spacePanes[0] ?? null;
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

let wsHistoryWriteChain = Promise.resolve();
const lastEditorFileLabel = new Map();

function persistWsHistory(all) {
  wsHistoryWriteChain = wsHistoryWriteChain
    .then(async () => {
      const path = `${appHome()}/ws-history.json`;
      const prev = await readTextFile(path).catch(() => null);
      const next = JSON.stringify(all, null, 2);
      if (prev !== next) await writeTextFile(path, next, prev);
    })
    .catch(() => {});
}

function recordWorkspaceSnapshot(space, root, activeView) {
  if (!space) return null;
  const key = wsHistoryKey(space, root);
  const all = { ...(shared("ide.ws.history") ?? {}) };
  const prev = all[key] ?? {};
  const cwd = root || space.folder || prev.cwd || null;
  const viewChanged = (activeView ?? prev.lastView ?? "scm") !== prev.lastView;
  const metaChanged = !prev.key || prev.cwd !== cwd || prev.spaceName !== space.name;

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
  if (viewChanged || metaChanged) persistWsHistory(all);
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

function labelEditorTerminalFile(space, root, file, line) {
  const activeTab = space?.tabs?.find((t) => t.active)?.id;
  if (!activeTab || !file) return;
  const tabPanes = panes().filter((p) => p.tab === activeTab);
  const trackedId = shared("ide.editor.paneByTab")?.[activeTab] ?? null;
  const ed = tabPanes.find((p) => p.terminal && isEditorPane(p, trackedId));
  if (!ed?.terminal) return;
  const ln = String(line ?? 1);
  const sig = `${file}\0${root || ""}\0${ln}`;
  if (lastEditorFileLabel.get(ed.terminal) === sig) return;
  lastEditorFileLabel.set(ed.terminal, sig);
  const args = ["label", ed.terminal, `ide.editor_file=${file}`, `ide.editor_line=${ln}`];
  if (root) args.push(`ide.editor_root=${root}`);
  hc(args).catch(() => {
    lastEditorFileLabel.delete(ed.terminal);
  });
}

function rememberOpenedFile(space, root, file, line) {
  if (!space || !file) return;
  const key = wsHistoryKey(space, root);
  const all = { ...(shared("ide.ws.history") ?? {}) };
  const prev = all[key] ?? {};
  const ln = line ?? 1;
  const top = prev.lastFiles?.[0];
  const sameTop = top && top.file === file && (top.line ?? 1) === ln;
  const files = (prev.lastFiles ?? []).filter((f) => f.file !== file);
  files.unshift({ file, line: ln });
  all[key] = { ...prev, key, spaceName: space.name, machine: space.machine ?? null, cwd: root || space.folder, lastFiles: files.slice(0, 8), updatedAt: Date.now() };
  setShared("ide.ws.history", all);
  if (!sameTop) persistWsHistory(all);
  labelEditorTerminalFile(space, root || space.folder, file, ln);
}

const labeledEditorTerms = new Set();
const jumpingByTab = new Map();
let bottomToggleBusy = false;

async function ensureBottomTerminalForSpace(space, cwd, on) {
  const bareSpaceId = String(space?.id || "default").split("/").pop();
  const bySpace = { ...(shared("ide.bottomTerm.bySpace") ?? {}) };
  const remembered = bySpace[space?.id] ?? null;
  const terms = terminals();
  const live = terms.find(
    (t) =>
      t.state === "live" &&
      (t.labels?.["ide.bottom-space"] === bareSpaceId || (remembered && t.address === remembered)),
  );
  if (live) {
    if (space?.id && bySpace[space.id] !== live.address) {
      bySpace[space.id] = live.address;
      setShared("ide.bottomTerm.bySpace", bySpace);
    }
    return live.address;
  }
  const args = ["run", "--json", "--bg", "--keep", "--no-parent", "--no-notify", "--outlive-parent"];
  if (on) args.push("--on", on);
  if (cwd) args.push("--cwd", cwd);
  args.push("--label", `ide.bottom-space=${bareSpaceId}`);
  const r = await hc(args).catch(() => null);
  if (!r || r.code !== 0 || !r.stdout) return null;
  let addr = null;
  try { addr = JSON.parse(r.stdout)?.address ?? null; } catch {}
  if (!addr) return null;
  if (on && !addr.includes("/")) addr = `${on}/${addr}`;
  if (space?.id) {
    bySpace[space.id] = addr;
    setShared("ide.bottomTerm.bySpace", bySpace);
  }
  return addr;
}

// terminal.park and terminal.keep finish in the background, and panes() keeps
// listing the old tree until they land. Both branches therefore wait for the
// layout to show the change they asked for before returning: a toggle pressed
// right after the other one used to see the stale pane, park it again and do
// nothing visible (the "first alt+f12 does nothing, the second works" report).
async function waitForPane(cx, addr, wantShown, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const pane = panes().find((p) => p.terminal === addr) ?? null;
    if (Boolean(pane) === wantShown) return pane;
    await cx.sleep(100);
  }
  return panes().find((p) => p.terminal === addr) ?? null;
}

// `hc run` answers before the app's own terminal table has the new terminal, so a
// terminal.keep sent right after it is refused ("no running terminal"). Wait for
// the core terminal to show up in terminals(), and retry the keep a few times.
async function keepBottomTerminal(cx, addr) {
  for (let i = 0; i < 12; i++) {
    if (terminals().some((t) => t.address === addr)) break;
    await cx.sleep(100);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    run("terminal.keep", { terminal: addr, place: "down" });
    const pane = await waitForPane(cx, addr, true, 15);
    if (pane) return pane;
    await cx.sleep(150);
  }
  return null;
}

async function toggleBottomTerminal(cx) {
  if (bottomToggleBusy) return;
  const space = spaces().find((s) => s.active);
  if (!space) return;
  const { cwd, on } = getContext();
  const addr = await ensureBottomTerminalForSpace(space, cwd || space.folder, on ?? space.machine ?? null);
  if (!addr) return;

  const shown = panes().find((p) => p.terminal === addr);
  if (shown) {
    bottomToggleBusy = true;
    try {
      run("terminal.park", { terminal: addr });
      await waitForPane(cx, addr, false);
      const trackedId = shared("ide.editor.paneByTab")?.[shown.tab];
      const ed = trackedId ? panes().find((p) => p.pane === trackedId) : null;
      if (ed) run("pane.focus", { pane: ed.pane });
    } finally {
      bottomToggleBusy = false;
    }
    return;
  }

  bottomToggleBusy = true;
  try {
    // Split below the tracked editor pane, where the old floating terminal sat.
    const activeTab = space.tabs?.find((t) => t.active)?.id;
    const trackedId = activeTab ? shared("ide.editor.paneByTab")?.[activeTab] : null;
    const host = (trackedId && panes().find((p) => p.pane === trackedId)) || panes().find((p) => p.tab === activeTab);
    if (host && !host.focused) run("pane.focus", { pane: host.pane });
    const pane = await keepBottomTerminal(cx, addr);
    if (pane) {
      const height = Number(getIdeSettings().bottomTermHeight) || 160;
      run("layout.resize", { id: pane.pane, px: height });
      run("pane.focus", { pane: pane.pane });
    }
  } finally {
    bottomToggleBusy = false;
  }
}

function terminalMap() {
  const map = new Map();
  for (const t of terminals()) map.set(t.address, t);
  return map;
}

function isLiveEditor(p) {
  if (!p || p.program?.agent) return false;
  if (p.mod === "ide-editor") return true;
  if (p.program && editorEngineOf(p) !== "") return true;
  return / — fresh$/i.test(p.title || "");
}

function isDeadEditorShell(p, termsByAddr) {
  if (!p || !p.terminal || p.program?.agent || isLiveEditor(p)) return false;
  const term = termsByAddr ? termsByAddr.get(p.terminal) : terminals().find((t) => t.address === p.terminal);
  if (!term?.labels) return false;
  if (term.labels["ide.editor"] === "1") return !p.program || Boolean(p.program.shell);
  if (term.labels["ide.fresh-ctx"] === "1" && !term.labels["ide.agent"] && !term.labels["ide.agent_session"]) {
    return !p.program || Boolean(p.program.shell);
  }
  return false;
}

function isEditorPane(p, trackedPaneId, termsByAddr) {
  if (!p) return false;
  // Decide by the program when herdr knows it: an agent (Claude Code etc.) is never the
  // editor, even if its title mentions "fresh" (closing it as a duplicate kills the agent).
  if (p.program?.agent) return false;
  if (trackedPaneId && p.pane === trackedPaneId) return true;
  if (isLiveEditor(p)) return true;
  // After herdr-core restarts, kept editor panes resurrect as shells and shared.json may be
  // missing/corrupt; core terminal labels still identify them so we replace rather than duplicate.
  return isDeadEditorShell(p, termsByAddr);
}

// "fresh" | "nvim" | "hx" for a terminal editor pane, else "". Program.key is the table key
// ("nvim", or "program" when unlisted); Program.name is the label or the process name.
function editorEngineOf(p) {
  for (const v of [p?.program?.key, p?.program?.name]) {
    const s = String(v || "").toLowerCase();
    if (s === "fresh") return "fresh";
    if (s === "nvim" || s === "neovim") return "nvim";
    if (s === "hx" || s === "helix") return "hx";
  }
  return "";
}

function editorPaneScore(p, cfg, spawningHere, beforeIds, trackedId) {
  if (!p) return -1;
  const eng = editorEngineOf(p);
  if (eng && eng === cfg?.editorEngine) return 5;
  if (p.mod === "ide-editor" && cfg?.editorEngine === "builtin") return 5;
  if (eng || / — fresh$/i.test(p.title || "")) return 4;
  if (p.mod === "ide-editor") return 3;
  if (spawningHere && Array.isArray(beforeIds) && !beforeIds.includes(p.pane)) return 2;
  if (trackedId && p.pane === trackedId) return 1;
  return 0;
}

function pickEditorPanes(tabPanes, trackedId, cfg, termsByAddr, spawning) {
  const spawningHere = Boolean(spawning && Array.isArray(spawning.beforeIds) && Date.now() - spawning.at < 4000);
  const beforeIds = spawningHere ? spawning.beforeIds : null;
  return tabPanes
    .filter((p) => isEditorPane(p, trackedId, termsByAddr))
    .sort((a, b) => editorPaneScore(b, cfg, spawningHere, beforeIds, trackedId) - editorPaneScore(a, cfg, spawningHere, beforeIds, trackedId));
}

function findNonEditorTerminal(tabPanes, trackedId, termsByAddr) {
  const isNotBottom = (p) => !p.terminal || !termsByAddr?.get(p.terminal)?.labels?.["ide.bottom-for"];
  return (
    tabPanes.find((p) => p.terminal && isNotBottom(p) && !isEditorPane(p, trackedId, termsByAddr)) ??
    tabPanes.find((p) => p.terminal && !isEditorPane(p, trackedId, termsByAddr)) ??
    tabPanes.find((p) => !isEditorPane(p, trackedId, termsByAddr))
  );
}

function ensureEditorTerminalLabel(edPane, termsByAddr) {
  if (!edPane?.terminal || labeledEditorTerms.has(edPane.terminal)) return;
  const term = termsByAddr ? termsByAddr.get(edPane.terminal) : terminals().find((t) => t.address === edPane.terminal);
  if (term?.labels?.["ide.editor"] === "1") {
    labeledEditorTerms.add(edPane.terminal);
    return;
  }
  labeledEditorTerms.add(edPane.terminal);
  hc(["label", edPane.terminal, "ide.editor=1"]).catch(() => {
    labeledEditorTerms.delete(edPane.terminal);
  });
}

// Sets where an editor pane's right-clicks go: Fresh -> "menu" (ide-term-menu runs Fresh
// actions through context_menu.ts), Nvim/Helix -> "program". Only runs the command when the
// terminal's current mode differs, so calling it every tick is cheap and does not flap.
function syncEditorRightClick(p, termsByAddr) {
  if (!p?.terminal) return;
  const term = termsByAddr ? termsByAddr.get(p.terminal) : terminals().find((t) => t.address === p.terminal);
  if (!term) return;
  const engine = editorEngineOf(p) || String(term.foreground?.name || "").toLowerCase();
  // context_menu.ts switches Fresh between "menu" (text area) and "program" (tab bar, menu
  // bar, explorer) as the pointer moves, and marks the terminal ide.fresh-ctx: leave it be.
  if (engine === "fresh" && term.labels?.["ide.fresh-ctx"]) return;
  const to = engine === "fresh" ? "menu" : "program";
  if ((term.labels?.["herdr.right-click"] ?? "menu") !== to) {
    run("terminal.right_click", { terminal: p.terminal, to });
  }
}

function enforceTabEditorOrderAndMouse(tabId, cfg) {
  if (!tabId) return false;
  const tabPanes = panes().filter((p) => p.tab === tabId);
  if (!tabPanes.length) return false;
  const termsByAddr = terminalMap();
  const paneMap = { ...(shared("ide.editor.paneByTab") ?? {}) };
  const trackedId = paneMap[tabId] ?? null;

  const spawning = shared("ide.editor.spawning");
  const spawningHere = spawning && spawning.tab === tabId && Date.now() - spawning.at < 4000 && Array.isArray(spawning.beforeIds);
  const spawnedEd = spawningHere ? tabPanes.find((p) => !spawning.beforeIds.includes(p.pane)) : null;

  const ranked = pickEditorPanes(tabPanes, trackedId, cfg, termsByAddr, spawningHere ? spawning : null);
  const edPane = spawnedEd ?? ranked[0] ?? null;
  if (!edPane) return false;

  if (paneMap[tabId] !== edPane.pane) {
    paneMap[tabId] = edPane.pane;
    setShared("ide.editor.paneByTab", paneMap);
  }
  if (spawnedEd) {
    setShared("ide.editor.spawning", { tab: tabId, at: spawning.at, pane: spawnedEd.pane });
  }

  // Persist editor identity in herdr-core terminal labels so it survives shared.json resets.
  if (spawnedEd || isLiveEditor(edPane) || edPane.pane === trackedId) {
    ensureEditorTerminalLabel(edPane, termsByAddr);
  }

  // Clean up any leftover dead editor shells once a live editor pane exists in the tab.
  if (!spawningHere && isLiveEditor(edPane)) {
    for (const extra of ranked) {
      if (extra.pane !== edPane.pane && isDeadEditorShell(extra, termsByAddr)) {
        run("pane.close", { pane: extra.pane });
      }
    }
  }

  // Terminal editors take right-clicks themselves. The engine is the pane's program name
  // (editorEngineOf: "fresh", "nvim", "hx"). Fresh goes to herdr's
  // terminal menu ("menu": the ide-term-menu mod, layout root terminal_menu), so its items
  // can run Fresh actions. Nvim/Helix keep "program", so the program gets the right-click.
  if (!spawnedEd || editorEngineOf(edPane) !== "") {
    syncEditorRightClick(edPane, termsByAddr);
  }

  // Keep Editor left/top of AI Agent & shell panes so AI Agent stays on the right.
  if (cfg.editorPlacement === "center-left" || cfg.editorPlacement === "center-top") {
    const edIdx = tabPanes.findIndex((p) => p.pane === edPane.pane);
    const nonEdIdx = tabPanes.findIndex((p) => p.pane !== edPane.pane && !isEditorPane(p, trackedId, termsByAddr));
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
  if (enforceTabEditorOrderAndMouse(targetTab, cfg)) return;
  if (cx?.spawn) {
    cx.spawn(async (asyncCx) => {
      for (const waitMs of [16, 40, 80, 160, 350]) {
        await asyncCx.sleep(waitMs);
        if (enforceTabEditorOrderAndMouse(targetTab, cfg)) return;
      }
    });
  } else if (cx?.timer?.after) {
    for (const waitMs of [20, 70, 180, 380]) {
      cx.timer.after(waitMs, () => enforceTabEditorOrderAndMouse(targetTab, cfg));
    }
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
  const arg = target ? `'${sq(target)}'` : "--restore";
  return `cd '${sq(root)}' && export FRESH_IDE_DAEMON='${daemonName}' && F="$HOME/.local/share/fresh-editor/fresh"; [ -x "$F" ] || F=fresh; exec "$F" --no-upgrade-check -a '${daemonName}' ${arg}`;
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
        git_busy=0
        if [ "$pgid" = "$pid" ]; then
          for gp in /proc/[0-9]*/stat; do
            read -r gpid grest < "$gp" 2>/dev/null || continue
            grest=\${grest#*) }
            gstate=\${grest%% *}
            [ "$gstate" = "Z" ] && continue
            set -- $grest
            [ "$3" = "$pgid" ] || continue
            gcomm=$(cat "/proc/$gpid/comm" 2>/dev/null || true)
            [ "$gcomm" = "git" ] || continue
            [ "$gstate" = "T" ] && kill -CONT "$gpid" 2>/dev/null || true
            git_busy=1
          done
        fi
        if [ "$git_busy" = "0" ]; then
          if [ "$pgid" = "$pid" ]; then kill -STOP -- "-$pid" 2>/dev/null || true
          else kill -STOP "$pid" 2>/dev/null || true; fi
        fi
      fi
    done
  `;
  await exec("bash", ["-c", script, "fresh-cool", activeDaemonName || "", enableCooling ? "1" : "0"], { on }).catch(() => {});
}

function enqueueTerminalEditorJump(job, cx) {
  if (!cx?.spawn) {
    execTerminalEditorJump(job, cx);
    return;
  }
  const tabKey = job.activeTab || "__default__";
  let slot = jumpingByTab.get(tabKey);
  if (!slot) {
    slot = { running: false, pending: null };
    jumpingByTab.set(tabKey, slot);
  }
  if (slot.running) {
    slot.pending = job;
    return;
  }
  slot.running = true;
  cx.spawn(async (cx2) => {
    try {
      let current = job;
      while (current) {
        slot.pending = null;
        await execTerminalEditorJump(current, cx2);
        current = slot.pending;
      }
    } finally {
      slot.running = false;
      if (slot.pending) {
        const next = slot.pending;
        slot.pending = null;
        enqueueTerminalEditorJump(next, cx2);
      }
    }
  });
}

async function respawnEditorPane(job, deadPane, cfg, cx) {
  const tabPanes = panes().filter((p) => !job.activeTab || p.tab === job.activeTab);
  const termsByAddr = terminalMap();
  const trackedId = job.activeTab ? shared("ide.editor.paneByTab")?.[job.activeTab] : null;
  const dead = deadPane && tabPanes.some((p) => p.pane === deadPane.pane) ? deadPane : null;
  const otherPanes = dead ? tabPanes.filter((p) => p.pane !== dead.pane) : tabPanes;
  const tp = findNonEditorTerminal(otherPanes, trackedId, termsByAddr) ?? otherPanes[0] ?? null;
  if (!tp && !dead) return;
  const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
  const beforeIds = tabPanes.map((p) => p.pane);
  const launchCmd = job.kind === "nvim"
    ? `cd '${sq(job.root)}' && rm -f '${job.sock}' && exec nvim --listen '${job.sock}' +${job.line} '${sq(job.absPath)}'`
    : freshLaunchBash(job.root, job.daemonName, job.target);
  setShared("ide.editor.spawning", { tab: job.activeTab, at: Date.now(), beforeIds });
  if (dead && tp && dead.pane !== tp.pane) {
    run("pane.close", { pane: dead.pane });
    run("pane.split", { direction: dir, pane: tp.pane, argv: ["bash", "-lc", launchCmd] });
  } else {
    const host = tp ?? dead;
    run("pane.split", { direction: dir, pane: host.pane, argv: ["bash", "-lc", launchCmd] });
    if (dead) run("pane.close", { pane: dead.pane });
  }
  swapToCenter(cfg, cx, job.activeTab);
  if (cx?.sleep) {
    for (const waitMs of [40, 60, 100, 150, 250]) {
      await cx.sleep(waitMs);
      const after = panes().filter((p) => !job.activeTab || p.tab === job.activeTab);
      if (after.some((p) => !beforeIds.includes(p.pane))) {
        enforceTabEditorOrderAndMouse(job.activeTab, cfg);
        break;
      }
    }
  }
}

async function execTerminalEditorJump(job, cx) {
  const cfg = getIdeSettings();
  const resolveEditorPane = () => {
    const tabPanes = panes().filter((p) => !job.activeTab || p.tab === job.activeTab);
    const termsByAddr = terminalMap();
    const trackedId = job.activeTab ? shared("ide.editor.paneByTab")?.[job.activeTab] : null;
    const sp = shared("ide.editor.spawning");
    const spHere = sp && sp.tab === job.activeTab && Date.now() - sp.at < 3500 ? sp : null;
    const spawned = spHere && Array.isArray(spHere.beforeIds)
      ? tabPanes.find((p) => !spHere.beforeIds.includes(p.pane))
      : null;
    const ranked = pickEditorPanes(tabPanes, trackedId, cfg, termsByAddr, spHere);
    return {
      pane: spawned ?? ranked[0] ?? (job.pane ? tabPanes.find((p) => p.pane === job.pane) : null),
      termsByAddr,
      spHere,
      spawned: Boolean(spawned || (spHere?.pane && ranked[0]?.pane === spHere.pane)),
    };
  };

  let cur = resolveEditorPane();
  // If a split was just triggered and the new pane hasn't materialized in panes() yet, wait briefly.
  if (!cur.pane && cur.spHere && cx?.sleep) {
    for (const waitMs of [40, 60, 100, 160, 240]) {
      await cx.sleep(waitMs);
      cur = resolveEditorPane();
      if (cur.pane) break;
    }
  }

  const edPane = cur.pane;
  if (!edPane || !edPane.terminal) {
    await respawnEditorPane(job, edPane, cfg, cx);
    return;
  }

  run("pane.focus", { pane: edPane.pane });

  // A resurrected shell from a closed herdr-core session cannot hold a live editor TUI.
  if (!cur.spawned && isDeadEditorShell(edPane, cur.termsByAddr) && edPane.program?.shell) {
    await respawnEditorPane(job, edPane, cfg, cx);
    return;
  }

  if (job.kind === "nvim") {
    const tryNvim = () => exec("nvim", ["--server", job.sock, "--remote-silent", `+${job.line}`, job.absPath], { cwd: job.root, on: job.on, timeout: 2500 }).catch(() => null);
    let res = await tryNvim();
    while ((!res || res.code !== 0) && cur.spHere && Date.now() - cur.spHere.at < 3000 && cx?.sleep) {
      await cx.sleep(150);
      res = await tryNvim();
    }
    if (res && res.code === 0) {
      enforceTabEditorOrderAndMouse(job.activeTab, cfg);
      return;
    }
    await respawnEditorPane(job, edPane, cfg, cx);
    return;
  }

  // One exec checks a TUI is attached to this daemon and opens the file (exit 75:
  // none attached — open-file would start a detached daemon no pane shows).
  let res = await runFreshOpenAttached(job.daemonName, job.target, job.root, job.on);
  let out = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
  const opened = () => res && res.code === 0 && !out.includes("Version mismatch");
  while (!opened() && cur.spHere && Date.now() - cur.spHere.at < 3000 && cx?.sleep) {
    await cx.sleep(150);
    res = await runFreshOpenAttached(job.daemonName, job.target, job.root, job.on);
    out = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
  }
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

  await respawnEditorPane(job, edPane, cfg, cx);
}

function resolveReplaceAndTarget(tabPanes, activeTab, existingEd, trackedId, termsByAddr) {
  let replaceShell = null;
  if (!existingEd && tabPanes.length >= 2) {
    const rememberedWorkId = activeTab ? shared("ide.workPaneByTab")?.[activeTab] : null;
    const isIdleShell = (p) => {
      if (!p.terminal || p.program?.agent) return false;
      if (p.program && !p.program.shell) return false;
      const lbl = termsByAddr.get(p.terminal)?.labels;
      return !(lbl?.["ide.agent"] || lbl?.["ide.agent_session"] || lbl?.["ide.bottom-space"]);
    };
    const idleList = tabPanes.filter(isIdleShell);
    replaceShell =
      idleList.find((p) => p.pane !== rememberedWorkId && !p.focused) ??
      idleList.find((p) => p.pane !== rememberedWorkId) ??
      idleList[0] ??
      null;
  }
  const remainingPanes = replaceShell ? tabPanes.filter((p) => p.pane !== replaceShell.pane) : tabPanes;
  const targetPane = findNonEditorTerminal(remainingPanes, trackedId, termsByAddr) ?? remainingPanes[0] ?? tabPanes.find((p) => p.pane !== existingEd?.pane) ?? tabPanes[0];
  return { replaceShell, targetPane };
}

function replacePaneAndSplit({ victim, survivor, dir, splitOpts, tabPanes, activeTab, cfg, cx }) {
  setShared("ide.editor.spawning", { tab: activeTab, at: Date.now(), beforeIds: tabPanes.map((p) => p.pane) });
  if (victim && survivor && victim.pane !== survivor.pane) {
    // Close victim BEFORE splitting survivor so survivor returns to 1.0 first and splits cleanly 50/50.
    run("pane.close", { pane: victim.pane });
    run("pane.split", { direction: dir, pane: survivor.pane, ...splitOpts });
  } else if (survivor || victim) {
    const host = survivor ?? victim;
    run("pane.split", { direction: dir, pane: host.pane, ...splitOpts });
    if (victim) run("pane.close", { pane: victim.pane });
  } else {
    run("pane.split", { direction: "right", ...splitOpts });
  }
  swapToCenter(cfg, cx, activeTab);
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
  const termsByAddr = terminalMap();

  rememberOpenedFile(space, root, file, line);
  publishActiveFile(file, root, on ?? null);

  if (cfg.editorEngine === "vscode" || cfg.editorEngine === "zed") {
    openExternalEditor(cfg.editorEngine, file, root, on, line);
    return;
  }

  const paneMap = { ...(shared("ide.editor.paneByTab") ?? {}) };
  const trackedId = activeTab ? paneMap[activeTab] : null;
  const spawning = shared("ide.editor.spawning");
  const spawningHere = Boolean(spawning && spawning.tab === activeTab && Date.now() - spawning.at < 3000);
  const editorPanes = pickEditorPanes(tabPanes, trackedId, cfg, termsByAddr, spawningHere ? spawning : null);

  // Enforce strictly ONE editor pane per tab: close any extra duplicates immediately,
  // keeping the highest-ranked (live) editor pane.
  for (let i = 1; i < editorPanes.length; i++) {
    run("pane.close", { pane: editorPanes[i].pane });
  }
  const existingEd = editorPanes[0] ?? null;
  const { replaceShell, targetPane } = resolveReplaceAndTarget(tabPanes, activeTab, existingEd, trackedId, termsByAddr);

  const absPath = file.startsWith("/") ? file : `${root.replace(/\/+$/, "")}/${file}`;
  const ln = line && line > 1 ? line : 1;
  const target = ln > 1 ? `${absPath}:${ln}` : absPath;
  const wantFresh = cfg.editorEngine === "fresh" && (on !== null || win()?.platform !== "windows");
  const wantNvim = cfg.editorEngine === "nvim" && (on !== null || win()?.platform !== "windows");

  if (!existingEd && spawningHere) {
    if (wantFresh || wantNvim) {
      const daemonName = `ide-${shortHash(`${activeTab ?? "t"}:${root}`)}`;
      const sock = `/tmp/herdr-nvim-${shortHash(`${activeTab ?? "t"}:${root}`)}.sock`;
      const job = wantNvim
        ? { seq: (shared("ide.terminalEditor.jump")?.seq ?? 0) + 1, kind: "nvim", sock, absPath, line: ln, root, on: on ?? null, activeTab, pane: null }
        : { seq: (shared("ide.terminalEditor.jump")?.seq ?? 0) + 1, kind: "fresh", daemonName, target, root, on: on ?? null, activeTab, pane: null };
      if (direct || !shared("ide.sidebar.alive")) {
        enqueueTerminalEditorJump(job, cx);
      } else {
        setShared("ide.terminalEditor.jump", job);
      }
    }
    return;
  }

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
        enqueueTerminalEditorJump(job, cx);
      } else {
        setShared("ide.terminalEditor.jump", job);
      }
      return;
    }
    const victim = (existingEd?.mod === "ide-editor" ? existingEd : null) ?? replaceShell;
    if (victim || targetPane) {
      const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
      replacePaneAndSplit({
        victim,
        survivor: targetPane,
        dir,
        splitOpts: { argv: ["bash", "-lc", `cd '${sq(root)}' && rm -f '${sock}' && exec nvim --listen '${sock}' +${ln} '${sq(absPath)}'`] },
        tabPanes,
        activeTab,
        cfg,
        cx,
      });
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
        enqueueTerminalEditorJump(job, cx);
      } else {
        setShared("ide.terminalEditor.jump", job);
      }
      return;
    }
    const victim = (existingEd?.mod === "ide-editor" ? existingEd : null) ?? replaceShell;
    if (victim || targetPane) {
      const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
      replacePaneAndSplit({
        victim,
        survivor: targetPane,
        dir,
        splitOpts: { argv: ["bash", "-lc", freshLaunchBash(root, daemonName, target)] },
        tabPanes,
        activeTab,
        cfg,
        cx,
      });
      return;
    }
  }

  // 3. Built-in GPUI ide-editor (strictly single instance per tab)
  const seq = (shared("ide.editor.open")?.seq ?? 0) + 1;
  const payload = { kind: "file", file, root, on: on ?? null, line: ln, seq };
  openBuiltinPane(payload, cfg, tabPanes, paneMap, activeTab, existingEd ?? replaceShell, targetPane, cx);
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
  const dir = cfg.editorPlacement === "center-top" ? "down" : "right";
  const victim = existingEd?.terminal ? existingEd : null;
  replacePaneAndSplit({
    victim,
    survivor: targetPane,
    dir,
    splitOpts: { mod: "ide-editor", props: payload },
    tabPanes,
    activeTab,
    cfg,
    cx,
  });
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
      openOverlay({ mod: "ide-editor", kind: "popup", at: "top", offset: 24, width: 0.90, height: 0.88, props: payload });
    }
    return;
  }
  const space = spaces().find((s) => s.active);
  const activeTab = space?.tabs?.find((t) => t.active)?.id;
  const tabPanes = panes().filter((p) => !activeTab || p.tab === activeTab);
  const termsByAddr = terminalMap();
  const paneMap = { ...(shared("ide.editor.paneByTab") ?? {}) };
  const trackedId = activeTab ? paneMap[activeTab] : null;
  const editorPanes = pickEditorPanes(tabPanes, trackedId, cfg, termsByAddr, null);
  for (let i = 1; i < editorPanes.length; i++) {
    run("pane.close", { pane: editorPanes[i].pane });
  }
  const existingEd = editorPanes[0] ?? null;
  const { replaceShell, targetPane } = resolveReplaceAndTarget(tabPanes, activeTab, existingEd, trackedId, termsByAddr);
  openBuiltinPane(payload, cfg, tabPanes, paneMap, activeTab, existingEd ?? replaceShell, targetPane, cx);
}

const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

function diffRows(lines) {
  let old = 0, next = 0;
  let inFileHeader = false;
  let seenDiff = false;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      seenDiff = true;
      inFileHeader = true;
      let status = "M";
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const l = lines[j];
        if (l.startsWith("@@") || l.startsWith("diff --git ")) break;
        if (l.startsWith("new file mode ")) { status = "A"; break; }
        if (l.startsWith("deleted file mode ")) { status = "D"; break; }
        if (l.startsWith("rename from ") || l.startsWith("copy from ") || l.startsWith("similarity index ")) { status = "R"; break; }
      }
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      rows.push({ kind: "file", status, filePath: m ? m[1] : line.slice(11), text: untab(line) });
      continue;
    }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      seenDiff = true;
      inFileHeader = false;
      rows.push({ kind: "@", text: untab(line) });
      continue;
    }
    if (!seenDiff && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      inFileHeader = true;
    }
    if (inFileHeader) {
      if (
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("index ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("rename ") ||
        line.startsWith("copy ") ||
        line.startsWith("similarity ") ||
        line.startsWith("Binary files ")
      ) {
        rows.push({ kind: "hdr", text: untab(line) });
        continue;
      }
    }
    if (!seenDiff) {
      rows.push({ kind: "meta", text: untab(line) });
      continue;
    }
    const kind = line[0];
    if (kind === "-") { rows.push({ kind, number: old++, text: untab(line.slice(1)) || " " }); continue; }
    if (kind === "+") { rows.push({ kind, number: next++, text: untab(line.slice(1)) || " " }); continue; }
    if (kind === " ") { old++; rows.push({ kind, number: next++, text: untab(line.slice(1)) || " " }); continue; }
    if (kind === "\\") { rows.push({ kind: "note", text: untab(line) }); continue; }
    rows.push({ kind: "", text: untab(line) });
  }
  return rows;
}

const DIFF_FILE_STATUS = {
  A: { tag: "A 新增", key: "ansi2" },
  D: { tag: "D 删除", key: "ansi1" },
  R: { tag: "R 重命名", key: "blocked" },
  M: { tag: "M 修改", key: "blocked" },
};

function charDisplayCols(cp) {
  return cp > 0x2e7f ? 2 : 1;
}

function splitWrapText(text, maxCols) {
  if (!text) return [" "];
  const limit = Math.max(24, maxCols | 0);
  const out = [];
  let cur = "";
  let cols = 0;
  let lastBreakIdx = -1;
  let lastBreakCols = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const chLen = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + chLen);
    const cw = charDisplayCols(cp);
    if (cols + cw > limit && cur.length > 0) {
      if (lastBreakIdx > 0 && cols - lastBreakCols <= 18) {
        const head = cur.slice(0, lastBreakIdx + 1);
        const rest = cur.slice(lastBreakIdx + 1);
        out.push(head);
        cur = rest;
        cols = 0;
        for (const rch of cur) cols += charDisplayCols(rch.codePointAt(0));
        lastBreakIdx = -1;
        lastBreakCols = 0;
        if (cols + cw <= limit) {
          cur += ch;
          cols += cw;
          if (" ,.;:()[]{}/=-+>&|".includes(ch)) { lastBreakIdx = cur.length - 1; lastBreakCols = cols; }
          i += chLen;
          continue;
        }
      }
      out.push(cur);
      cur = "";
      cols = 0;
      lastBreakIdx = -1;
      lastBreakCols = 0;
    }
    cur += ch;
    cols += cw;
    if (" ,.;:()[]{}/=-+>&|".includes(ch)) {
      lastBreakIdx = cur.length - 1;
      lastBreakCols = cols;
    }
    i += chLen;
  }
  if (cur) out.push(cur);
  return out.length ? out : [" "];
}

function wrapDiffRows(rows, maxCols) {
  const limit = Math.max(24, maxCols | 0);
  const out = [];
  for (const row of rows) {
    if (!row || row.kind === "file") {
      out.push(row);
      continue;
    }
    const text = row.text ?? "";
    let totalCols = 0;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i);
      totalCols += charDisplayCols(cp);
      i += cp > 0xffff ? 2 : 1;
      if (totalCols > limit) break;
    }
    if (totalCols <= limit) {
      out.push(row);
      continue;
    }
    const parts = splitWrapText(text, limit);
    for (let p = 0; p < parts.length; p++) {
      if (p === 0) out.push({ ...row, text: parts[p] });
      else out.push({ ...row, number: undefined, cont: true, text: parts[p] });
    }
  }
  return out;
}

function renderDiffLine(divFn, hFlexFn, row, t, opts = {}) {
  const h = opts.h ?? 20;
  const numW = opts.numW ?? 36;
  const prefixW = opts.prefixW ?? 14;
  const gap = opts.gap ?? 8;

  if (row.kind === "file") {
    const meta = DIFF_FILE_STATUS[row.status] ?? DIFF_FILE_STATUS.M;
    const col = t[meta.key] ?? t.accent;
    return hFlexFn()
      .w_full()
      .h(h + 3)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .bg(t.raised)
      .border_l(3)
      .border_color(col)
      .child(divFn().px(5).py(0.5).rounded(3).bg(col + "30").text_size(10.5).font_bold().text_color(col).child(meta.tag))
      .child(divFn().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(row.filePath || row.text));
  }
  if (row.kind === "hdr") {
    const txt = row.text;
    const col = txt.startsWith("+++") || txt.startsWith("new file") || txt.startsWith("rename to")
      ? t.ansi2
      : txt.startsWith("---") || txt.startsWith("deleted file") || txt.startsWith("rename from")
        ? t.ansi1
        : t.dim;
    return hFlexFn()
      .w_full()
      .h(h)
      .flex_none()
      .px(8)
      .items_center()
      .bg(t.surface)
      .border_l(3)
      .border_color(col + "80")
      .child(divFn().flex_1().min_w(0).truncate().text_color(col).child(txt));
  }
  if (row.kind === "@") {
    return hFlexFn()
      .w_full()
      .h(h)
      .flex_none()
      .px(8)
      .items_center()
      .bg(t.accent + "22")
      .border_l(3)
      .border_color(t.accent)
      .child(divFn().flex_1().min_w(0).truncate().font_semibold().text_color(t.accent).child(row.text));
  }
  if (row.kind === "meta") {
    const isCommitHdr = row.text.startsWith("commit ");
    return hFlexFn()
      .w_full()
      .h(h)
      .flex_none()
      .px(8)
      .items_center()
      .border_l(3)
      .border_color(isCommitHdr ? t.accent : "#00000000")
      .when(isCommitHdr, (e) => e.bg(t.chrome))
      .child(
        divFn()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_color(isCommitHdr ? t.accent : t.foreground)
          .when(isCommitHdr, (e) => e.font_semibold())
          .child(row.text || " "),
      );
  }
  if (row.kind === "+" || row.kind === "-") {
    const isAdd = row.kind === "+";
    const col = isAdd ? t.ansi2 : t.ansi1;
    const foc = Boolean(row.focused);
    const cont = Boolean(row.cont);
    let el = hFlexFn()
      .w_full()
      .h(h)
      .flex_none()
      .items_center()
      .gap(gap)
      .bg(col + (foc ? "4c" : "38"))
      .border_l(3)
      .border_color(foc ? t.accent : col);
    if (numW > 0) {
      el = el.child(divFn().w(numW).flex_none().text_right().text_color(foc ? t.foreground : col + "cc").when(foc && !cont, (e) => e.font_bold()).child(cont || row.number === undefined ? "" : String(row.number)));
    }
    return el
      .child(divFn().w(prefixW).flex_none().text_center().font_bold().text_color(cont ? col + "99" : foc ? t.accent : col).child(cont ? "↳" : foc ? `▶${row.kind}` : row.kind))
      .child(divFn().flex_1().min_w(0).truncate().text_color(col).when(foc, (e) => e.font_semibold()).child(row.text));
  }

  const foc = Boolean(row.focused);
  const cont = Boolean(row.cont);
  const isNote = row.kind === "note";
  let el = hFlexFn()
    .w_full()
    .h(h)
    .flex_none()
    .items_center()
    .gap(gap)
    .when(foc, (e) => e.bg(t.accent + "24"))
    .border_l(3)
    .border_color(foc ? t.accent : "#00000000");
  if (numW > 0) {
    el = el.child(divFn().w(numW).flex_none().text_right().text_color(foc ? t.accent : t.dim).when(foc && !cont, (e) => e.font_bold()).child(cont || row.number === undefined ? "" : String(row.number)));
  }
  return el
    .child(divFn().w(prefixW).flex_none().text_center().text_color(cont ? t.dim : foc ? t.accent : isNote ? t.accent : t.dim).child(cont ? "↳" : foc ? "▶" : isNote ? "•" : " "))
    .child(divFn().flex_1().min_w(0).truncate().text_color(foc ? t.foreground : isNote ? t.dim : t.muted).when(foc, (e) => e.font_semibold()).child(row.text));
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

async function postAiCommitJson(url, apiKey, bodyObj) {
  const isWin = win()?.platform === "windows";
  const sep = isWin ? "\\" : "/";
  const reqPath = `${appHome()}${sep}.ai-req-${Date.now()}-${Math.floor(Math.random() * 10000)}.json`;
  const payload = JSON.stringify(bodyObj);
  await writeTextFile(reqPath, payload, null);
  try {
    const t0 = Date.now();
    const resp = await exec(
      "curl",
      [
        "-sS",
        "-w", "\n__HTTP__%{http_code}",
        "-X", "POST", url,
        "-H", "Content-Type: application/json",
        "-H", `Authorization: Bearer ${apiKey}`,
        "--data-binary", `@${reqPath}`,
      ],
      { timeout: 35000 },
    );
    const ms = Date.now() - t0;
    const rawOut = String(resp.stdout ?? "");
    const markerIdx = rawOut.lastIndexOf("\n__HTTP__");
    const httpCode = markerIdx >= 0 ? Number(rawOut.slice(markerIdx + 9).trim()) : 0;
    const bodyText = markerIdx >= 0 ? rawOut.slice(0, markerIdx).trim() : rawOut.trim();
    return { code: resp.code, stderr: (resp.stderr ?? "").trim(), httpCode, bodyText, bytes: payload.length, ms };
  } finally {
    if (isWin) exec("cmd", ["/c", "del", "/f", "/q", reqPath], {}).catch(() => {});
    else exec("rm", ["-f", reqPath], {}).catch(() => {});
  }
}

async function generateAiCommitMessage(stat, patch, root, on) {
  const logs = [];
  let apiReason = "";
  let hasApiConfig = false;

  try {
    const cfgPath = `${appHome()}/ai-commit.json`;
    const raw = await readTextFile(cfgPath);
    if (!raw) {
      logs.push(`[config] ${cfgPath} 不存在或为空`);
    } else {
      const cfg = JSON.parse(raw);
      if (!cfg.api_key) {
        logs.push("[config] ai-commit.json 未配置 api_key，尝试 claude CLI…");
      } else {
        hasApiConfig = true;
        const base = (cfg.api_url || "https://api.openai.com/v1").replace(/\/+$/, "");
        const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
        const model = cfg.model || "gpt-4o-mini";
        const thinking = cfg.thinking ?? "off";
        logs.push(`[config] url=${url} model=${model} thinking=${thinking}`);

        const makeBody = (withThinkingFlag) => {
          const body = {
            model,
            messages: [
              {
                role: "system",
                content: "Write a Conventional Commit message: 1 clear subject line (<=72 chars), optionally followed by a blank line and 1-3 short bullet points summarizing key changes. Plain text only, no markdown fences or quotes.",
              },
              { role: "user", content: `Stat:\n${stat}\n\nDiff:\n${patch}` },
            ],
          };
          if (withThinkingFlag && thinking === "off") body.enable_thinking = false;
          return body;
        };

        let r = await postAiCommitJson(url, cfg.api_key, makeBody(true));
        logs.push(`[api] curl exit=${r.code} http=${r.httpCode} bytes=${r.bytes} elapsed=${r.ms}ms`);
        if (r.httpCode === 400 && /enable_thinking|unknown|extra/i.test(r.bodyText)) {
          logs.push(`[api] 服务端不支持 enable_thinking 参数，回退重试…`);
          r = await postAiCommitJson(url, cfg.api_key, makeBody(false));
          logs.push(`[api retry] curl exit=${r.code} http=${r.httpCode} elapsed=${r.ms}ms`);
        }

        if (r.code !== 0) {
          apiReason = `curl 失败 (exit=${r.code}): ${r.stderr || r.bodyText || "请求超时或网络错误"}`;
          logs.push(`[api error] ${apiReason}`);
        } else if (r.httpCode >= 400 || !r.bodyText) {
          let apiErr = r.bodyText;
          try {
            const j = JSON.parse(r.bodyText);
            apiErr = j?.error?.message || j?.message || r.bodyText;
          } catch {}
          apiReason = `HTTP ${r.httpCode}: ${apiErr || "(empty response)"}`;
          logs.push(`[api error] ${apiReason.slice(0, 600)}`);
        } else {
          try {
            const j = JSON.parse(r.bodyText);
            if (j?.error) {
              apiReason = `API Error: ${j.error.message || JSON.stringify(j.error)}`;
              logs.push(`[api error] ${apiReason}`);
            } else {
              const text = j?.choices?.[0]?.message?.content?.trim();
              const cleaned = cleanAiCommitText(text);
              if (cleaned) {
                logs.push(`[api ok] 生成成功: ${cleaned.split("\n")[0]}`);
                return { ok: true, msg: cleaned, source: "api", logs };
              }
              apiReason = `API 返回内容为空或不可用: ${r.bodyText.slice(0, 300)}`;
              logs.push(`[api error] ${apiReason}`);
            }
          } catch (pe) {
            apiReason = `解析响应 JSON 失败: ${pe?.message ?? pe} | body=${r.bodyText.slice(0, 300)}`;
            logs.push(`[api error] ${apiReason}`);
          }
        }
      }
    }
  } catch (e) {
    apiReason = `AI 配置或请求异常: ${e?.message ?? e}`;
    logs.push(`[api exception] ${apiReason}`);
  }

  try {
    const t0 = Date.now();
    const claude = await exec(
      "claude",
      ["-p", `Write a Conventional Commit message (1 subject line + optional 1-3 short bullet lines, plain text, no markdown):\n${stat}\n\n${patch.slice(0, 3500)}`],
      { cwd: root, on, timeout: 20000 },
    );
    logs.push(`[claude] exit=${claude.code} elapsed=${Date.now() - t0}ms`);
    if (claude.code === 0 && claude.stdout.trim()) {
      const cleaned = cleanAiCommitText(claude.stdout);
      if (cleaned) {
        logs.push(`[claude ok] 生成成功: ${cleaned.split("\n")[0]}`);
        return { ok: true, msg: cleaned, source: "claude", logs };
      }
    } else if (claude.stderr?.trim()) {
      logs.push(`[claude stderr] ${claude.stderr.trim().slice(0, 300)}`);
    }
  } catch (e) {
    logs.push(`[claude skip] ${e?.message ?? e}`);
  }

  const fallback = summarizeDiffStatFallback(stat);
  if (hasApiConfig) {
    return {
      ok: false,
      error: apiReason || "AI Commit 生成失败",
      msg: fallback,
      logs,
    };
  }
  logs.push(`[fallback] 使用 diff stat 兜底提交信息: ${fallback}`);
  return { ok: true, msg: fallback, source: "fallback", logs };
}

function showAiCommitLogPopup({ title, status, error, logs, draft, needEdit, root, on }) {
  const prev = shared("ide.aiCommitLog")?.seq ?? 0;
  setShared("ide.aiCommitLog", {
    seq: prev + 1,
    title: title || "AI Commit 失败日志",
    status: status || "AI Commit Failed",
    error: error || "未知错误",
    logs: Array.isArray(logs) ? logs : [],
    draft: draft || "",
    needEdit: Boolean(needEdit),
    root: root || "",
    on: on ?? null,
  });
  if (!shared("ide.aiLog.open")) {
    openOverlay({ mod: "git-ai-log", kind: "popup", at: "top", offset: 40, width: 660, height: 480 });
  }
}

function summarizeGitSyncText(rawText, fallback) {
  const lines = (rawText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^To\s+https?:\/\//i.test(l) && !/^From\s+https?:\/\//i.test(l));
  return lines.join(" · ") || (rawText || "").trim() || fallback;
}

async function runGitSyncWithUpstream(kind, root, on) {
  if (kind === "sync") {
    const pullRes = await runGitSyncWithUpstream("pull", root, on);
    if (!pullRes.ok) return pullRes;
    return runGitSyncWithUpstream("push", root, on);
  }
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

async function runAiSyncPipeline({ action, root, on, onProgress }) {
  const logs = [];
  const git = async (args) => {
    const r = await exec("git", args, { cwd: root, on });
    return { ok: r.code === 0, code: r.code, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };

  if (action === "sync") {
    onProgress?.({ status: "Syncing (Pull → Push)…" });
    const res = await runGitSyncWithUpstream("sync", root, on);
    logs.push(`[git sync] ok=${res.ok} detail=${res.detail}`);
    return {
      ok: res.ok,
      status: res.ok ? "Synced ✓" : "Git Sync Failed",
      detail: res.detail,
      error: res.ok ? null : res.detail,
      logs,
    };
  }

  if (action === "ai-sync") {
    const unmerged = await git(["ls-files", "--unmerged"]);
    if (unmerged.out) {
      const errMsg = "存在未解决的合并冲突，请先解决冲突后再执行 AI Commit & Sync。";
      logs.push(`[git] ${errMsg}`);
      notify({ title: "AI Commit & Sync Blocked", body: errMsg, level: "error", timeout: 4500 });
      return { ok: false, error: errMsg, logs };
    }
  }

  let committedMsg = null;
  const allowClean = action === "ai-sync";
  onProgress?.({ status: "Staging & checking changes…" });
  const stagedCheck = await git(["diff", "--cached", "--name-only"]);
  if (!stagedCheck.out) {
    const add = await git(["add", "-A"]);
    logs.push(`[git add -A] exit=${add.code}${add.err ? ` stderr=${add.err}` : ""}`);
    if (!add.ok) {
      const errMsg = add.err || add.out || "git add -A failed";
      notify({ title: "AI Commit Failed", body: errMsg, level: "error", timeout: 4500 });
      return { ok: false, error: errMsg, logs };
    }
  }
  const diff = await git(["diff", "--cached", "--stat"]);
  if (!diff.out) {
    logs.push("[git diff --cached --stat] (empty)");
    if (!allowClean) {
      const infoMsg = "Nothing to commit (working tree clean).";
      notify({ title: "AI Commit", body: infoMsg, level: "info", timeout: 3500 });
      return { ok: false, clean: true, error: infoMsg, logs };
    }
    onProgress?.({ detail: "工作区无新改动，继续检查远端同步…" });
  } else {
    const summary = diff.out.split("\n").pop()?.trim() || "";
    onProgress?.({ status: "Generating AI commit message…", detail: summary });
    const patch = await git(["diff", "--cached", "--no-color"]);
    const gen = await generateAiCommitMessage(diff.out, patch.out.slice(0, 6000), root, on);
    logs.push(...(gen.logs ?? []));
    if (!gen.ok) {
      notify({ title: "AI Commit 失败", body: gen.error, level: "error", timeout: 5500 });
      return { ok: false, error: gen.error, draft: gen.msg, needEdit: true, logs };
    }
    const msg = gen.msg;
    onProgress?.({ status: "Committing changes…", draft: msg, logs });
    const c = await git(["commit", "-m", msg]);
    logs.push(`[git commit] exit=${c.code}${c.err ? ` stderr=${c.err}` : ""}${c.out ? ` stdout=${c.out.slice(0, 300)}` : ""}`);
    if (!c.ok) {
      const errMsg = c.err || c.out || "git commit failed";
      notify({ title: "Git Commit Failed", body: errMsg, level: "error", timeout: 5500 });
      return { ok: false, error: errMsg, draft: msg, needEdit: true, logs };
    }
    bumpGitDirty();
    committedMsg = msg;
    notify({ title: "AI Commit ✓", body: msg.split("\n")[0], level: "success", timeout: 6000 });
    onProgress?.({ status: "Committed ✓", committedMsg: msg });
    if (action === "ai-commit") {
      return { ok: true, status: "Committed ✓", detail: summary, committedMsg: msg, logs };
    }
  }

  // action === "ai-sync": Pull if behind > 0, then Push if ahead > 0 or no upstream yet.
  const remotes = await git(["remote"]);
  if (!remotes.ok || !remotes.out) {
    const infoMsg = "No git remote configured (skipped pull/push).";
    notify({ title: "AI Commit & Sync", body: infoMsg, level: "info", timeout: 3500 });
    return {
      ok: true,
      status: committedMsg ? "Committed locally ✓" : "Working tree clean ✓",
      detail: infoMsg,
      committedMsg,
      logs,
    };
  }

  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  let ahead = 0;
  if (upstream.ok && upstream.out) {
    onProgress?.({ status: "Checking remote changes…" });
    const fetched = await git(["fetch", "--quiet"]);
    logs.push(`[git fetch] exit=${fetched.code}${fetched.err ? ` stderr=${fetched.err}` : ""}`);
    if (!fetched.ok) {
      const errMsg = fetched.err || fetched.out || "git fetch failed";
      notify({ title: "Git Sync Failed", body: errMsg, level: "error", timeout: 4500 });
      return { ok: false, error: errMsg, committedMsg, logs };
    }
    const counts = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    const parts = (counts.out || "").trim().split(/\s+/);
    ahead = Number(parts[0] ?? 0);
    const behind = Number(parts[1] ?? 0);
    if (behind > 0) {
      onProgress?.({ status: `Pulling incoming changes (↓${behind})…` });
      const pullRes = await runGitSyncWithUpstream("pull", root, on);
      logs.push(`[git pull] ok=${pullRes.ok} detail=${pullRes.detail}`);
      if (!pullRes.ok) {
        return { ok: false, error: pullRes.detail, committedMsg, logs };
      }
      const afterCounts = await git(["rev-list", "--count", "@{u}..HEAD"]);
      ahead = afterCounts.ok ? Number(afterCounts.out || 0) : ahead;
    }
    if (ahead === 0) {
      notify({
        title: "AI Commit & Sync ✓",
        body: committedMsg ? `${committedMsg.split("\n")[0]}（远端已是最新）` : "工作区干净且已与远端同步",
        level: "success",
        timeout: 4000,
      });
      return {
        ok: true,
        status: committedMsg ? "Committed & synced ✓" : "Already up to date ✓",
        detail: "No outgoing commits to push.",
        committedMsg,
        logs,
      };
    }
  }

  onProgress?.({ status: ahead > 0 ? `Pushing to remote (↑${ahead})…` : "Pushing to remote…" });
  const pushRes = await runGitSyncWithUpstream("push", root, on);
  logs.push(`[git push] ok=${pushRes.ok} detail=${pushRes.detail}`);
  if (!pushRes.ok) {
    return { ok: false, error: pushRes.detail, committedMsg, logs };
  }
  return {
    ok: true,
    status: committedMsg ? "AI Commit + Sync Complete ✓" : "Pushed ✓",
    detail: pushRes.detail,
    committedMsg,
    logs,
  };
}

async function undoLastCommit(root, on) {
  const git = async (args) => {
    const r = await exec("git", args, { cwd: root, on });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  };
  const head = await git(["rev-parse", "--short", "HEAD"]);
  if (!head.ok || !head.out) {
    return { ok: false, error: head.err || "Repository has no commits yet." };
  }
  const subj = await git(["log", "-1", "--pretty=%s"]);
  const hasParent = await git(["rev-parse", "--verify", "-q", "HEAD~1"]);
  const r = hasParent.ok
    ? await git(["reset", "--soft", "HEAD~1"])
    : await git(["update-ref", "-d", "HEAD"]);
  if (!r.ok) {
    return { ok: false, error: r.err || r.out || "git reset --soft HEAD~1 failed" };
  }
  bumpGitDirty();
  const detail = hasParent.ok
    ? `Reset ${head.out} (${subj.out}). Changes kept staged.\nRecover: git reset --soft ${head.out}`
    : `Uncommitted initial commit ${head.out} (${subj.out}). Changes kept staged.`;
  return { ok: true, hash: head.out, subj: subj.out, isInitial: !hasParent.ok, detail };
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

// ── Agent Session Persistence & Auto-Reconnect ────────────────────────────────
const AGENT_KIND_RULES = [
  ["agy", /antigravity|\bagy\b/],
  ["cmdc", /command[- ]?code|\bcmdc\b/],
  ["codebuddy", /codebuddy|\bcbc\b/],
  ["claude", /claude/],
  ["codex", /codex/],
  ["opencode", /opencode/],
  ["omp", /oh-my-pi|\bomp\b/],
  ["pi", /\bpi\b|pi-coding/],
  ["gemini", /gemini/],
];

// Value-taking flags preserved when building a reconnect command; positional prompts & old session flags are stripped.
const AGENT_VALUE_FLAGS = new Set([
  "-m", "--model", "--models", "--effort", "--mode", "--agent", "-p", "--profile",
  "--permission-mode", "--approval-mode", "--thinking", "--add-dir", "-s", "--sandbox",
  "-a", "--ask-for-approval", "-c", "--config", "--theme", "--tools", "--tools-enable",
  "--project", "--service-tier",
]);

const AGENT_STRIP_FLAGS = new Set([
  "-c", "--continue", "-r", "--resume", "--conversation", "--session", "--session-id",
  "--fork", "--fork-session", "--no-session", "--no-session-persistence",
  "-p", "--print", "--prompt", "-i", "--prompt-interactive", "--last", "--all",
]);

const AGENT_SESSION_PROBE_PY = `
import glob, json, os, re, sqlite3, sys

def proc_ctime(pid):
    try: return os.stat(f"/proc/{pid}").st_ctime
    except Exception: return 0.0

def proc_ppid(pid):
    try:
        s = open(f"/proc/{pid}/stat", encoding="utf-8", errors="ignore").read()
        return s[s.rfind(")") + 2:].split()[1]
    except Exception:
        return None

def child_pids(pid):
    out, q = [str(pid)], [str(pid)]
    while q:
        cur = q.pop(0)
        for p in glob.glob(f"/proc/{cur}/task/*/children"):
            try:
                for c in open(p).read().split():
                    if c not in out:
                        out.append(c); q.append(c)
            except Exception: pass
    return out

def from_argv(kind, argv):
    a = argv or []
    for i, tok in enumerate(a):
        if kind == "agy":
            if tok == "--conversation" and i + 1 < len(a): return a[i + 1]
            if tok.startswith("--conversation="): return tok.split("=", 1)[1]
        elif kind in ("cmdc", "claude", "codebuddy"):
            if tok in ("-r", "--resume", "--session", "--session-id") and i + 1 < len(a) and not a[i + 1].startswith("-"):
                return a[i + 1]
            for pfx in ("--resume=", "--session=", "--session-id="):
                if tok.startswith(pfx): return tok.split("=", 1)[1]
        elif kind == "codex":
            if tok == "resume":
                for nxt in a[i + 1:]:
                    if not nxt.startswith("-"): return nxt
        elif kind in ("opencode", "pi", "omp", "gemini"):
            if tok in ("-s", "--session", "-r", "--resume") and i + 1 < len(a) and not a[i + 1].startswith("-"):
                v = a[i + 1]
                if v and v != "latest": return v
            for pfx in ("--session=", "--resume="):
                if tok.startswith(pfx):
                    v = tok.split("=", 1)[1]
                    if v and v != "latest": return v
    return None

def probe_one(item):
    pid = str(item.get("pid") or "")
    kind = item.get("kind") or ""
    cwd = item.get("cwd") or ""
    argv = item.get("argv") or []
    sid = from_argv(kind, argv)
    shell_pid = proc_ppid(pid) if pid else None
    if sid: return {"sessionId": sid, "shellPid": shell_pid}
    if not pid or not os.path.isdir(f"/proc/{pid}"): return {"sessionId": None, "shellPid": shell_pid}
    start_ts = proc_ctime(pid)
    pids = child_pids(pid)

    if kind == "agy":
        for p in pids:
            for fd in glob.glob(f"/proc/{p}/fd/*"):
                try:
                    t = os.readlink(fd)
                    m = re.search(r"/\\.gemini/antigravity-cli/presence/([^/]+)\\.lock$", t)
                    if m: return {"sessionId": m.group(1), "shellPid": shell_pid}
                except Exception: pass
    elif kind in ("claude", "codebuddy"):
        base = os.path.expanduser(f"~/.{kind}/sessions")
        for p in pids:
            f = os.path.join(base, f"{p}.json")
            if os.path.isfile(f):
                try:
                    d = json.load(open(f, encoding="utf-8"))
                    if d.get("sessionId"): return {"sessionId": d["sessionId"], "shellPid": shell_pid}
                except Exception: pass
    elif kind == "cmdc":
        slug = re.sub(r"[/_]", "-", cwd.lstrip("/"))
        d0 = os.path.expanduser(f"~/.commandcode/projects/{slug}")
        dirs = [d0] if os.path.isdir(d0) else glob.glob(os.path.expanduser("~/.commandcode/projects/*"))
        best = None
        for d in dirs:
            for f in glob.glob(os.path.join(d, "*.jsonl")):
                if f.endswith(".checkpoints.jsonl"): continue
                try:
                    st = os.stat(f)
                    if st.st_mtime < start_ts - 5: continue
                    meta = json.loads(open(f, encoding="utf-8").readline())
                    if cwd and meta.get("cwd") and meta.get("cwd") != cwd: continue
                    cid = meta.get("id") or os.path.basename(f)[:-6]
                    if best is None or st.st_mtime > best[0]: best = (st.st_mtime, cid)
                except Exception: pass
        if best: return {"sessionId": best[1], "shellPid": shell_pid}
    elif kind == "codex":
        for p in pids:
            for fd in glob.glob(f"/proc/{p}/fd/*"):
                try:
                    t = os.readlink(fd)
                    if "/.codex/sessions/" in t and t.endswith(".jsonl"):
                        meta = json.loads(open(t, encoding="utf-8").readline())
                        sid = (meta.get("payload") or {}).get("id") or (meta.get("payload") or {}).get("session_id")
                        if sid: return {"sessionId": sid, "shellPid": shell_pid}
                except Exception: pass
        best = None
        for f in glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/*.jsonl")):
            try:
                st = os.stat(f)
                if st.st_mtime < start_ts - 5: continue
                pl = (json.loads(open(f, encoding="utf-8").readline())).get("payload") or {}
                if cwd and pl.get("cwd") and pl.get("cwd") != cwd: continue
                sid = pl.get("id") or pl.get("session_id")
                if sid and (best is None or st.st_mtime > best[0]): best = (st.st_mtime, sid)
            except Exception: pass
        if best: return {"sessionId": best[1], "shellPid": shell_pid}
    elif kind in ("pi", "omp"):
        root = os.path.expanduser("~/.pi/agent/sessions" if kind == "pi" else "~/.omp/agent/sessions")
        slug = "--" + cwd.strip("/").replace("/", "-") + "--"
        d0 = os.path.join(root, slug)
        dirs = [d0] if os.path.isdir(d0) else glob.glob(os.path.join(root, "*"))
        best = None
        for dd in dirs:
            for f in glob.glob(os.path.join(dd, "*.jsonl")):
                try:
                    st = os.stat(f)
                    if st.st_mtime < start_ts - 5: continue
                    meta = json.loads(open(f, encoding="utf-8").readline())
                    if cwd and meta.get("cwd") and meta.get("cwd") != cwd: continue
                    sid = meta.get("id")
                    if sid and (best is None or st.st_mtime > best[0]): best = (st.st_mtime, sid)
                except Exception: pass
        if best: return {"sessionId": best[1], "shellPid": shell_pid}
    elif kind == "opencode":
        db = os.path.expanduser("~/.local/share/opencode/opencode.db")
        if os.path.isfile(db):
            try:
                conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
                row = conn.execute(
                    "SELECT id FROM session WHERE directory = ? AND time_updated >= ? ORDER BY time_updated DESC LIMIT 1",
                    (cwd, int((start_ts - 5) * 1000)),
                ).fetchone()
                conn.close()
                if row: return {"sessionId": row[0], "shellPid": shell_pid}
            except Exception: pass
    return {"sessionId": None, "shellPid": shell_pid}

items = json.loads(sys.argv[1])
print(json.dumps({it["address"]: probe_one(it) for it in items}))
`;

const agentProbeCache = new Map(); // addr -> { fgPid, sessionId, shellPid, checkedAt }
const reconnectedShells = new Set(); // `${addr}:${shellPid}`
let agentSyncBusy = false;

function detectAgentKindFromTerm(term, pane) {
  const candidates = [
    term?.foreground?.name,
    String(term?.foreground?.argv?.[0] ?? "").split("/").pop(),
    pane?.program?.key,
    pane?.program?.name,
    term?.app,
    term?.status?.app,
  ];
  for (const raw of candidates) {
    const s = String(raw || "").toLowerCase();
    if (!s || s === "zsh" || s === "bash" || s === "sh" || s === "fish" || s === "fresh") continue;
    for (const [kind, re] of AGENT_KIND_RULES) {
      if (re.test(s)) return kind;
    }
  }
  return null;
}

const AGENT_INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3"]);

function buildAgentResumeCommand(kind, sessionId, origArgv) {
  const rawArgv = Array.isArray(origArgv) && origArgv.length ? origArgv : [kind];
  const arg0 = String(rawArgv[0] || kind).split("/").pop() || kind;
  const bin = AGENT_INTERPRETERS.has(arg0.toLowerCase()) ? kind : arg0;
  const kept = [];
  for (let i = 1; i < rawArgv.length; i++) {
    const tok = String(rawArgv[i] ?? "");
    if (!tok) continue;
    if (kind === "codex" && tok === "resume") {
      if (i + 1 < rawArgv.length && !String(rawArgv[i + 1]).startsWith("-")) i++;
      continue;
    }
    const eqIdx = tok.indexOf("=");
    const flagName = eqIdx > 0 ? tok.slice(0, eqIdx) : tok;
    if (AGENT_STRIP_FLAGS.has(flagName)) {
      const needsVal = eqIdx < 0 && flagName !== "-c" && flagName !== "--continue" && flagName !== "--fork-session" && flagName !== "--no-session" && flagName !== "--no-session-persistence" && flagName !== "--last" && flagName !== "--all" && flagName !== "--print" && flagName !== "-p";
      if (needsVal && i + 1 < rawArgv.length && !String(rawArgv[i + 1]).startsWith("-")) i++;
      continue;
    }
    if (!tok.startsWith("-")) continue; // drop positional prompt
    kept.push(tok);
    if (eqIdx < 0 && AGENT_VALUE_FLAGS.has(tok) && i + 1 < rawArgv.length) {
      kept.push(String(rawArgv[++i]));
    }
  }
  let parts;
  if (kind === "agy") parts = [bin, ...kept, "--conversation", sessionId];
  else if (kind === "cmdc" || kind === "claude" || kind === "codebuddy") parts = [bin, ...kept, "--resume", sessionId];
  else if (kind === "codex") parts = [bin, "resume", ...kept, sessionId];
  else if (kind === "opencode") parts = [bin, "-s", sessionId, ...kept];
  else if (kind === "pi") parts = [bin, "--session", sessionId, ...kept];
  else if (kind === "omp" || kind === "gemini") parts = [bin, "--resume", sessionId, ...kept];
  else parts = [bin, ...kept];

  return parts.map((p) => (/^[A-Za-z0-9_./:=+-]+$/.test(p) ? p : `'${sq(p)}'`)).join(" ");
}

function saveAgentSessionBackup(entry) {
  if (!entry?.spaceId || !entry?.kind || !entry?.sessionId) return;
  const key = `${entry.spaceId}:${entry.cwd || ""}`;
  const all = { ...(shared("ide.agent.sessions") ?? {}) };
  const prev = all[key];
  if (prev && prev.sessionId === entry.sessionId && prev.cmd === entry.cmd && prev.terminal === entry.terminal) return;
  all[key] = entry;
  setShared("ide.agent.sessions", all);
  try {
    const path = `${appHome()}/agent-sessions.json`;
    readTextFile(path).then((old) => writeTextFile(path, JSON.stringify(all, null, 2), old)).catch(() => {});
  } catch {}
}

async function syncAgentSessions(cx) {
  if (agentSyncBusy) return;
  const space = spaces().find((s) => s.active);
  const activeTab = space?.tabs?.find((t) => t.active)?.id;
  if (!space || !activeTab) return;
  const tabPanes = panes().filter((p) => p.tab === activeTab);
  if (!tabPanes.length) return;
  const termsByAddr = terminalMap();
  const cfg = getIdeSettings();
  const on = space.machine ?? null;
  const now = Date.now();

  agentSyncBusy = true;
  try {
    const toProbe = [];
    const toReconnect = [];

    for (const p of tabPanes) {
      if (!p.terminal) continue;
      const t = termsByAddr.get(p.terminal);
      if (!t || t.state !== "live") continue;

      const kind = detectAgentKindFromTerm(t, p);
      if (kind && t.foreground?.pid) {
        const fgPid = String(t.foreground.pid);
        const cached = agentProbeCache.get(t.address);
        const needProbe =
          !cached ||
          cached.fgPid !== fgPid ||
          (!cached.sessionId && now - cached.checkedAt >= 6000) ||
          (cached.sessionId && t.labels?.["ide.agent_session"] !== cached.sessionId);
        if (needProbe) {
          toProbe.push({
            pane: p,
            term: t,
            kind,
            fgPid,
            argv: t.foreground?.argv ?? [kind],
            cwd: t.foreground?.cwd || t.cwd || space.folder || "",
          });
        }
        continue;
      }

      // No live agent in this terminal: check if it previously held an active session.
      const lbl = t.labels ?? {};
      const fgName = String(t.foreground?.name || "").toLowerCase();
      const fgIsShell = !fgName || /^(zsh|bash|sh|fish|dash)$/.test(fgName);
      const isIdleShell = fgIsShell && (!p.program || Boolean(p.program.shell));
      if (isIdleShell && lbl["ide.agent_active"] === "1" && lbl["ide.agent_cmd"]) {
        toReconnect.push({ pane: p, term: t, lbl });
      }
    }

    if (toProbe.length && (on !== null || win()?.platform !== "windows")) {
      const payload = toProbe.map((x) => ({ address: x.term.address, pid: x.fgPid, kind: x.kind, cwd: x.cwd, argv: x.argv }));
      const r = await exec("python3", ["-c", AGENT_SESSION_PROBE_PY, JSON.stringify(payload)], { on, timeout: 4000 }).catch(() => null);
      let resMap = null;
      if (r?.code === 0 && r.stdout) {
        try { resMap = JSON.parse(r.stdout); } catch {}
      }
      for (const item of toProbe) {
        const info = resMap?.[item.term.address];
        const sessionId = info?.sessionId || null;
        const shellPid = item.term.pid ?? info?.shellPid ?? null;
        agentProbeCache.set(item.term.address, { fgPid: item.fgPid, sessionId, shellPid, checkedAt: Date.now() });
        if (!sessionId) continue;

        const cmd = buildAgentResumeCommand(item.kind, sessionId, item.argv);
        const lbl = item.term.labels ?? {};
        const updates = [];
        if (lbl["ide.agent"] !== item.kind) updates.push(`ide.agent=${item.kind}`);
        if (lbl["ide.agent_session"] !== sessionId) updates.push(`ide.agent_session=${sessionId}`);
        if (lbl["ide.agent_cmd"] !== cmd) updates.push(`ide.agent_cmd=${cmd}`);
        if (item.cwd && lbl["ide.agent_cwd"] !== item.cwd) updates.push(`ide.agent_cwd=${item.cwd}`);
        if (shellPid && lbl["ide.agent_shell_pid"] !== String(shellPid)) updates.push(`ide.agent_shell_pid=${shellPid}`);
        if (lbl["ide.agent_active"] !== "1") updates.push("ide.agent_active=1");
        if (updates.length) {
          await hc(["label", item.term.address, ...updates]).catch(() => {});
        }
        saveAgentSessionBackup({
          spaceId: space.id,
          tabId: activeTab,
          terminal: item.term.address,
          kind: item.kind,
          sessionId,
          cmd,
          cwd: item.cwd,
          updatedAt: Date.now(),
        });
      }
    }

    for (const item of toReconnect) {
      let curPid = item.term.pid ?? null;
      if (curPid == null) {
        const gr = await hc(["get", item.term.address]).catch(() => null);
        if (gr?.code === 0 && gr.stdout) {
          try {
            const g = JSON.parse(gr.stdout);
            curPid = g?.pid ?? null;
            if (g?.foreground?.name && g.foreground.name !== "zsh" && g.foreground.name !== "bash" && g.foreground.name !== "sh") {
              continue; // something is already running in this pane
            }
          } catch {}
        }
      }
      if (curPid == null) continue;
      const oldPid = item.lbl["ide.agent_shell_pid"];
      const key = `${item.term.address}:${curPid}`;
      if (reconnectedShells.has(key)) continue;

      if (oldPid && String(curPid) === String(oldPid)) {
        // Same outer shell PID -> user manually exited the agent; clear auto-reconnect flag.
        await hc(["label", item.term.address, "ide.agent_active=0"]).catch(() => {});
        continue;
      }

      if (cfg.autoResumeAgent === false) continue;

      // Different outer shell PID -> herdr-core restarted this pane; reconnect inside it.
      reconnectedShells.add(key);
      await hc(["label", item.term.address, `ide.agent_shell_pid=${curPid}`]).catch(() => {});
      if (cx?.sleep && item.term.turn === 0) await cx.sleep(350);
      const savedCwd = item.lbl["ide.agent_cwd"];
      const cmd = item.lbl["ide.agent_cmd"];
      const fullCmd = savedCwd && item.term.cwd && item.term.cwd !== savedCwd
        ? `cd '${sq(savedCwd)}' && ${cmd}`
        : cmd;
      const sr = await hc(["send", item.term.address, fullCmd]).catch(() => null);
      if (sr?.code === 0) {
        const shortSid = (item.lbl["ide.agent_session"] || "").slice(0, 8);
        notify({
          title: "Agent 会话已重连",
          body: `${item.lbl["ide.agent"] || "agent"}${shortSid ? ` (${shortSid}…)` : ""}`,
          level: "info",
          timeout: 3000,
        });
      }
    }
  } finally {
    agentSyncBusy = false;
  }
}

async function sendSelectionToAgent(cx) {
  const space = spaces().find((s) => s.active);
  const on = space?.machine ?? null;
  let req = null;
  try {
    const r = await exec(
      "sh",
      ["-c", 'p="${XDG_STATE_HOME:-$HOME/.local/state}/fresh-ide/send-to-agent-request.json"; [ -f "$p" ] && cat "$p"'],
      { on, timeout: 5000 },
    );
    const raw = r.code === 0 ? r.stdout : null;
    const q = raw ? JSON.parse(raw) : null;
    const age = Date.now() - (q?.ts ?? 0);
    if (q?.text && age >= -10000 && age < 60000) req = q;
  } catch {}
  if (!req) {
    notify({ title: "Send to Agent", body: "No editor selection found.", level: "info", timeout: 2500 });
    return;
  }

  const trackedEdId = space ? shared("ide.editor.paneByTab")?.[space.active_tab] : null;
  const terms = terminals();
  const termsByAddr = new Map(terms.map((t) => [t.address, t]));
  const spacePanes = panes();
  const activeTab = space?.active_tab ?? spacePanes.find((p) => p.focused)?.tab ?? spacePanes[0]?.tab;
  const tabPanes = activeTab ? spacePanes.filter((p) => p.tab === activeTab) : spacePanes;
  const nonEd = tabPanes.filter(
    (p) => p.terminal && !isEditorPane(p, trackedEdId, termsByAddr) && !termsByAddr.get(p.terminal)?.labels?.["ide.bottom-for"],
  );

  let target = null;
  for (const p of nonEd) {
    const term = termsByAddr.get(p.terminal);
    if (p.program?.agent || term?.labels?.["ide.agent_active"] === "1" || detectAgentKindFromTerm(term, p)) {
      target = p;
      break;
    }
  }
  if (!target) {
    const workId = activeTab ? shared("ide.workPaneByTab")?.[activeTab] : null;
    if (workId) target = nonEd.find((p) => p.pane === workId) ?? null;
  }
  if (!target) target = findNonEditorTerminal(tabPanes, trackedEdId, termsByAddr) ?? nonEd[0] ?? null;

  cx?.write_to_clipboard?.(req.text);
  if (!target) {
    notify({ title: "Send to Agent", body: "Copied to clipboard (no Agent pane found in this tab).", level: "warning", timeout: 3000 });
    return;
  }

  run("pane.focus", { pane: target.pane });
  if (cx?.sleep) await cx.sleep(80);
  run("terminal.paste");
  notify({ title: "Sent to Agent", body: req.label || "Selection pasted", level: "info", timeout: 2000 });
}
