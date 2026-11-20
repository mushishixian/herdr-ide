/**
 * Context menu bridge: lets herdr's right-click menu drive Fresh.
 *
 * Fresh never receives right-clicks, so herdr writes a request file
 * /tmp/fresh-ide-ctx/<daemon>.json instead:
 *   - phase "open" when its menu opens: this plugin snapshots the last known
 *     mouse pointer under that id (the pointer then moves over herdr's popup,
 *     so later motion is not used);
 *   - phase "run" with the same id and a Fresh action name when an item is
 *     picked: the caret moves to the snapshot point (kept if that point lies
 *     inside the current selection, as in VS Code) and the action runs.
 *
 * Zero timers: a non-recursive directory watch wakes the plugin.
 *
 * It also keeps references_view.ts (and its lib/*.ts) loaded and current: a
 * deploy that writes them loads or reloads them in the running daemon.
 *
 * Pointer routing: herdr sends a right-click to Fresh ("program") only where
 * Fresh has its own menus (menu bar, tab bars, explorer, status bar, popups)
 * and to herdr's menu ("menu") over a normal file's text. On every mouse move
 * the plugin decides the region and, only when it changes, relabels the
 * terminal with `hc label` (one process at a time, latest mode wins).
 *
 * Ctrl+click: go to definition, or references when the click is on the
 * definition itself (LSP). Needs the mouse_click modifier "ctrl", which
 * Fresh 0.5.3 does not report (only "shift" arrives), so it is inert there.
 */
const editor = getEditor();

const CTX_DIR = "/tmp/fresh-ide-ctx";
const MAX_AGE_MS = 15000;
const DEFAULT_TAB_SIZE = 4;
const MAX_SNAPSHOTS = 32;

/** Fresh built-in actions that herdr may request (run with executeAction). */
const BUILTIN_ACTIONS = new Set([
  "lsp_goto_definition",
  "lsp_implementation",
  "lsp_references",
  "lsp_rename",
  "lsp_code_actions",
  "lsp_hover",
  "cut",
  "copy",
  "paste",
  "select_all",
  "toggle_comment",
  "close_tab",
]);

/**
 * Actions registered by the user's other plugins. executeAction only reaches
 * built-ins, so these run through runCommand with their palette names.
 */
const PLUGIN_COMMANDS = new Map<string, string>([
  ["git_line_history", "Git: Line History"],
  ["selection_copy_reference", "Selection: Copy as Reference"],
]);

type Pointer = {
  column: number;
  row: number;
  content_x: number;
  content_y: number;
};

type Calibration = { gutter: number; digits: number };

type Mode = "menu" | "program";
type Loc = {
  uri: string;
  range: LspRange;
  jump: LspRange;
};
type LspPos = { line: number; character: number };
type LspRange = { start: LspPos; end: LspPos };

let daemonKey = "";
let latestPointer: Pointer | null = null;
const snapshots = new Map<string, Pointer>();
const calibrations = new Map<number, Calibration>();
let lastHandled = "";

// Right-click routing state (see pumpMode).
let desiredMode: Mode | null = null;
let appliedMode: Mode | null = null;
let hcBusy = false;
let clientCache: { pid: string; terminal: string } | null = null;
let navSeq = 0;

/** Daemon name: FRESH_IDE_DAEMON, else --session-name from our cmdline. */
function deriveKey(): string {
  try {
    const fromEnv = editor.getEnv("FRESH_IDE_DAEMON");
    if (fromEnv) return fromEnv;
  } catch {}
  try {
    const raw = editor.readFile("/proc/self/cmdline") ?? "";
    const parts = raw.split("\u0000");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "--session-name" && parts[i + 1]) return parts[i + 1];
      if (parts[i].startsWith("--session-name=")) {
        const name = parts[i].slice("--session-name=".length);
        if (name) return name;
      }
    }
  } catch {}
  return "default";
}

function utf8Len(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Terminal cells for a code point: 0 for combining marks, 2 for wide CJK/emoji. */
function cellWidth(cp: number): number {
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function digitsOf(n: number): number {
  return String(Math.max(1, Math.floor(n))).length;
}

/** Gutter width in cells when no calibration exists: marker + number + " │ ". */
function estimateGutter(lineCount: number): number {
  return 1 + Math.max(2, digitsOf(lineCount)) + 3;
}

function gutterFor(bufferId: number, lineCount: number): number {
  const cal = calibrations.get(bufferId);
  if (cal && cal.digits === digitsOf(lineCount)) return cal.gutter;
  return estimateGutter(lineCount);
}

function tabSize(): number {
  try {
    const n = editor.getConfig()?.editor?.tab_size;
    if (typeof n === "number" && n > 0) return n;
  } catch {}
  return DEFAULT_TAB_SIZE;
}

/** Display width of a text fragment, expanding tabs to the next stop. */
function displayWidth(text: string, tab: number): number {
  let col = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    col += cp === 9 ? tab - (col % tab) : cellWidth(cp);
  }
  return col;
}

/** Leading part of `text` spanning `bytes` UTF-8 bytes. */
function prefixByBytes(text: string, bytes: number): string {
  let n = 0;
  let out = "";
  for (const ch of text) {
    if (n >= bytes) break;
    n += utf8Len(ch.codePointAt(0) ?? 0);
    out += ch;
  }
  return out;
}

/**
 * Byte offset within `line` of the caret boundary nearest to display column
 * `target`. Ties go to the earlier boundary; past the end clamps to the end.
 */
function byteOffsetForColumn(line: string, target: number, tab: number): number {
  let col = 0;
  let bytes = 0;
  let bestBytes = 0;
  let bestDist = Math.abs(target);
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0;
    col += cp === 9 ? tab - (col % tab) : cellWidth(cp);
    bytes += utf8Len(cp);
    const dist = Math.abs(col - target);
    if (dist < bestDist) {
      bestDist = dist;
      bestBytes = bytes;
    }
  }
  return bestBytes;
}

function stripEol(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/** Learn the gutter width from a left click that landed on text. */
async function calibrateFromClick(ev: MouseClickHookArgs): Promise<void> {
  if (ev.button !== "left") return;
  if (ev.buffer_id == null || ev.buffer_row == null || ev.buffer_col == null) return;
  if (ev.buffer_id !== editor.getActiveBufferId()) return;
  const info = editor.getBufferInfo(ev.buffer_id);
  if (!info || info.is_virtual || info.is_terminal || info.line_count == null) return;
  const vp = editor.getViewport();
  if (!vp) return;

  const start = await editor.getLineStartPosition(ev.buffer_row);
  const end = await editor.getLineEndPosition(ev.buffer_row);
  if (start == null || end == null) return;
  // A click past the line end reports buffer_col at the end: unusable.
  if (ev.buffer_col >= end - start) return;

  const text = stripEol(await editor.getBufferText(ev.buffer_id, start, end));
  const tab = tabSize();
  const caretCol = displayWidth(prefixByBytes(text, ev.buffer_col), tab);
  const gutter = ev.column - ev.content_x - (caretCol - vp.leftColumn);
  if (gutter < 1 || gutter > 16) return;
  calibrations.set(ev.buffer_id, { gutter, digits: digitsOf(info.line_count) });
}

/** argv of a process from /proc, or null when it is gone or unreadable. */
function argvOf(pid: string): string[] | null {
  try {
    const raw = editor.readFile(`/proc/${pid}/cmdline`);
    if (!raw) return null;
    return raw.split("\u0000").filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

/** A Fresh client attached to our daemon (`fresh ... -a <daemonKey> file`), not a server. */
function isAttachedClient(argv: string[] | null): boolean {
  if (!argv || argv.length === 0) return false;
  if ((argv[0].split("/").pop() ?? "") !== "fresh") return false;
  if (argv.includes("--server")) return false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--attach=${daemonKey}`) return true;
    if ((argv[i] === "-a" || argv[i] === "--attach") && argv[i + 1] === daemonKey) return true;
  }
  return false;
}

function terminalOf(pid: string): string | null {
  try {
    const raw = editor.readFile(`/proc/${pid}/environ`);
    if (!raw) return null;
    for (const kv of raw.split("\u0000")) {
      if (kv.startsWith("HC_TERMINAL_ID=")) {
        const id = kv.slice("HC_TERMINAL_ID=".length);
        return id || null;
      }
    }
  } catch {}
  return null;
}

/**
 * The herdr terminal this editor is shown in. The server's own HC_TERMINAL_ID
 * can be stale (the server outlives the pane it was started from), so prefer
 * the attached client's. Newest matching client wins when several exist.
 */
function attachedClientTerminal(): string | null {
  if (clientCache) {
    if (isAttachedClient(argvOf(clientCache.pid))) return clientCache.terminal;
    clientCache = null;
  }
  let pids: string[] = [];
  try {
    pids = editor
      .readDir("/proc")
      .map((e) => e.name)
      .filter((n) => /^\d+$/.test(n))
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!isAttachedClient(argvOf(pid))) continue;
    const terminal = terminalOf(pid);
    if (terminal) {
      clientCache = { pid, terminal };
      return terminal;
    }
  }
  return null;
}

function terminalId(): string | null {
  const fromClient = attachedClientTerminal();
  if (fromClient) return fromClient;
  try {
    return editor.getEnv("HC_TERMINAL_ID") || null;
  } catch {
    return null;
  }
}

function hcPath(): string {
  try {
    const home = editor.getEnv("HOME");
    if (home) return `${home}/.local/bin/hc`;
  } catch {}
  return "hc";
}

/**
 * Apply desiredMode with `hc label` when it differs from the mode last sent.
 * One process at a time: a change during a run is applied when it finishes.
 */
function pumpMode(): void {
  if (hcBusy || desiredMode === null || desiredMode === appliedMode) return;
  const terminal = terminalId();
  if (!terminal) return;
  const mode = desiredMode;
  appliedMode = mode;
  hcBusy = true;
  const done = (): void => {
    hcBusy = false;
    pumpMode();
  };
  try {
    const handle = editor.spawnProcess(hcPath(), [
      "label",
      terminal,
      mode === "program" ? "herdr.right-click=program" : "herdr.right-click=",
      "ide.fresh-ctx=1",
    ]);
    handle.result.then(done, done);
  } catch {
    done();
  }
}

/** Screen cell → split whose text area (below its tab bar) holds it, else null. */
function splitAtText(ev: Pointer): SplitSnapshot | null {
  // The hook gives content_x/content_y = the text origin of the pane under the
  // pointer (tab bar row excluded, scrollbar excluded), or 0/0 outside any pane.
  if (ev.content_y < 1) return null;
  for (const s of editor.listSplits()) {
    if (s.x !== ev.content_x) continue;
    if (ev.content_y <= s.y || ev.content_y > s.y + s.height) continue;
    return ev.column - ev.content_x < s.viewport.width ? s : null;
  }
  return null;
}

/** "menu" over a normal file's text, "program" everywhere else. */
function wantedMode(ev: Pointer): Mode {
  try {
    const split = splitAtText(ev);
    if (!split) return "program";
    const info = editor.getBufferInfo(split.bufferId);
    if (!info || info.is_virtual || info.is_terminal) return "program";
    return "menu";
  } catch {
    return "program";
  }
}

function on_mouse_move(ev: Pointer): void {
  try {
    latestPointer = {
      column: ev.column,
      row: ev.row,
      content_x: ev.content_x,
      content_y: ev.content_y,
    };
    const mode = wantedMode(ev);
    if (mode !== desiredMode) {
      desiredMode = mode;
      pumpMode();
    }
  } catch {}
}

function hasCtrl(ev: MouseClickHookArgs): boolean {
  return typeof ev.modifiers === "string" && /ctrl|control/i.test(ev.modifiers);
}

function on_mouse_click(ev: MouseClickHookArgs): void {
  try {
    if (ev.button === "left" && ev.buffer_id != null) {
      latestPointer = {
        column: ev.column,
        row: ev.row,
        content_x: ev.content_x,
        content_y: ev.content_y,
      };
    }
    void calibrateFromClick(ev).catch(() => {});
    if (ev.button === "left" && hasCtrl(ev)) void ctrlNavigate(ev);
  } catch {}
}

/** Move the caret to the pointer's text position, unless it is inside the selection. */
async function placeCursor(p: Pointer | null): Promise<void> {
  if (!p) return;
  const bufferId = editor.getActiveBufferId();
  const info = editor.getBufferInfo(bufferId);
  if (!info || !info.path || info.is_virtual || info.is_terminal) return;
  if (info.line_count == null) return;
  const vp = editor.getViewport();
  if (!vp || vp.topLine == null) return;

  const row = p.row - p.content_y;
  if (row < 0 || row >= vp.height) return;
  const relCol = p.column - p.content_x;
  const gutter = gutterFor(bufferId, info.line_count);
  if (relCol < gutter) return;

  const line = Math.min(vp.topLine + row, info.line_count - 1);
  const start = await editor.getLineStartPosition(line);
  const end = await editor.getLineEndPosition(line);
  if (start == null || end == null) return;

  const text = stripEol(await editor.getBufferText(bufferId, start, end));
  const target = vp.leftColumn + (relCol - gutter);
  const pos = start + byteOffsetForColumn(text, target, tabSize());

  const cursor = editor.getPrimaryCursor();
  if (cursor?.selection) {
    const lo = Math.min(cursor.selection.start, cursor.selection.end);
    const hi = Math.max(cursor.selection.start, cursor.selection.end);
    if (pos >= lo && pos <= hi) return;
  }
  editor.setBufferCursor(bufferId, pos);
}

/** Byte offset within `line` of the UTF-16 index `units` (LSP character). */
function byteColForUtf16(line: string, units: number): number {
  let u = 0;
  let bytes = 0;
  for (const ch of line) {
    if (u >= units) break;
    const cp = ch.codePointAt(0) ?? 0;
    u += cp > 0xffff ? 2 : 1;
    bytes += utf8Len(cp);
  }
  return bytes;
}

/** Location | Location[] | LocationLink[] | null → plain locations. */
function normalizeLocations(res: unknown): Loc[] {
  if (!res) return [];
  const out: Loc[] = [];
  for (const r of Array.isArray(res) ? res : [res]) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.targetUri === "string") {
      const range = (o.targetRange ?? o.targetSelectionRange) as LspRange | undefined;
      const jump = (o.targetSelectionRange ?? o.targetRange) as LspRange | undefined;
      if (range && jump) out.push({ uri: o.targetUri, range, jump });
    } else if (typeof o.uri === "string" && o.range) {
      const range = o.range as LspRange;
      out.push({ uri: o.uri, range, jump: range });
    }
  }
  return out;
}

function posLeq(a: LspPos, b: LspPos): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function rangeHas(r: LspRange, p: LspPos): boolean {
  return posLeq(r.start, p) && posLeq(p, r.end);
}

/** Open a location at its start (LSP line and UTF-16 character). */
function jumpTo(loc: Loc): void {
  const path = editor.fileUriToPath(loc.uri);
  const line = loc.jump.start.line;
  const text = editor.readFile(path) ?? "";
  const lineText = stripEol(text.split("\n")[line] ?? "");
  const col = byteColForUtf16(lineText, loc.jump.start.character);
  editor.openFile(path, line + 1, col + 1);
}

/**
 * Ctrl+click: definition elsewhere → lsp_goto_definition; on the definition
 * (or none found) → references: one jumps, several open Fresh's list.
 */
async function ctrlNavigate(ev: MouseClickHookArgs): Promise<void> {
  const seq = ++navSeq;
  try {
    if (ev.buffer_id == null || ev.buffer_row == null || ev.buffer_col == null) return;
    const bufferId = ev.buffer_id;
    const info = editor.getBufferInfo(bufferId);
    if (!info || !info.path || info.is_virtual || info.is_terminal) return;
    if (info.line_count == null || !info.language) return;

    const start = await editor.getLineStartPosition(ev.buffer_row);
    const end = await editor.getLineEndPosition(ev.buffer_row);
    if (start == null || end == null) return;
    const lineText = stripEol(await editor.getBufferText(bufferId, start, end));
    if (ev.buffer_col > end - start) return;

    // Fresh already moved the caret; make sure it is there and that no extra cursor remains.
    if (editor.getAllCursors().length > 1) editor.executeAction("remove_secondary_cursors");
    const bytePos = start + ev.buffer_col;
    if (editor.getCursorPosition() !== bytePos) editor.setBufferCursor(bufferId, bytePos);

    const uri = editor.pathToFileUri(info.path);
    const position: LspPos = {
      line: ev.buffer_row,
      character: prefixByBytes(lineText, ev.buffer_col).length,
    };
    const defs = normalizeLocations(
      await editor.sendLspRequest(info.language, "textDocument/definition", {
        textDocument: { uri },
        position,
      }),
    );
    if (seq !== navSeq) return;

    const onDefinition = defs.some(
      (d) => editor.fileUriToPath(d.uri) === info.path && rangeHas(d.jump, position),
    );
    if (defs.length > 0 && !onDefinition) {
      editor.executeAction("lsp_goto_definition");
      return;
    }

    const refs = normalizeLocations(
      await editor.sendLspRequest(info.language, "textDocument/references", {
        textDocument: { uri },
        position,
        context: { includeDeclaration: false },
      }),
    );
    if (seq !== navSeq) return;
    if (refs.length === 0) editor.setStatus("No references");
    else if (refs.length === 1) jumpTo(refs[0]);
    else editor.executeAction("lsp_references");
  } catch {
    try {
      editor.executeAction("lsp_goto_definition");
    } catch {}
  }
}

async function sendSelectionToAgent(): Promise<void> {
  const bufferId = editor.getActiveBufferId();
  const filePath = editor.getBufferPath(bufferId);
  const cursor = editor.getPrimaryCursor();
  if (!cursor) {
    editor.setStatus("Send to Agent: no cursor");
    return;
  }
  const cwd = editor.getCwd();
  const text = await editor.getBufferText(bufferId);
  const starts: number[] = [0];
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (ch === "\n") starts.push(bytes);
  }
  const lineOf = (byte: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= byte) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  let startLine: number;
  let endLine: number;
  if (!cursor.selection || cursor.selection.start === cursor.selection.end) {
    const l = lineOf(cursor.position) + 1;
    startLine = l;
    endLine = l;
  } else {
    const lo = Math.min(cursor.selection.start, cursor.selection.end);
    const hi = Math.max(cursor.selection.start, cursor.selection.end);
    const first = lineOf(lo);
    let last = lineOf(hi);
    if (last > first && hi === starts[last]) last -= 1;
    startLine = first + 1;
    endLine = last + 1;
  }
  const root = cwd.replace(/\/+$/, "");
  const rawPath = filePath || "(unsaved)";
  const rel = root && rawPath.startsWith(root + "/") ? rawPath.slice(root.length + 1) : rawPath;
  const lineTag = startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
  const label = `${rel}:${lineTag}`;
  const body = text
    .split("\n")
    .slice(startLine - 1, endLine)
    .map((l) => l.replace(/\r$/, ""))
    .join("\n");
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const base = rawPath.slice(rawPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const lang = dot > 0 ? base.slice(dot + 1) : "";
  const formatted = `${label}\n${fence}${lang}\n${body}\n${fence}\n`;

  try {
    editor.setClipboard(formatted);
  } catch {}

  const xdg = editor.getEnv("XDG_STATE_HOME");
  const home = editor.getEnv("HOME") ?? "";
  const stateDir = `${xdg || (home ? `${home}/.local/state` : "/tmp")}/fresh-ide`;
  const reqPath = `${stateDir}/send-to-agent-request.json`;
  const payload = JSON.stringify({ ts: Date.now(), label, text: formatted, cwd, path: rawPath });
  const wrote = editor.replaceFile(reqPath, payload) || editor.writeFile(reqPath, payload);
  if (!wrote) {
    await editor.spawnProcess("mkdir", ["-p", stateDir]).result;
    editor.writeFile(reqPath, payload);
  }

  const res = await editor.spawnProcess("herdr-app.exe", ["do", "ide-sidebar.sendToAgent"], cwd).result;
  if (res.exit_code !== 0) {
    editor.setStatus(`Send to Agent failed (${res.exit_code})`);
    return;
  }
  editor.setStatus(`Sent ${label} to Agent`);
}

async function on_request(path: string): Promise<void> {
  const name = path.split("/").pop() ?? "";
  if (name !== `${daemonKey}.json`) return;

  let req: { id?: unknown; phase?: unknown; action?: unknown; ts?: unknown };
  try {
    const raw = editor.readFile(`${CTX_DIR}/${name}`);
    if (!raw) return;
    req = JSON.parse(raw);
  } catch {
    return;
  }
  const id = typeof req.id === "string" ? req.id : "";
  const phase = req.phase;
  if (!id || (phase !== "open" && phase !== "run")) return;
  const ts = Number(req.ts);
  if (!Number.isFinite(ts) || Date.now() - ts > MAX_AGE_MS) return;

  // Duplicate check and marking happen before any await, so a second watch
  // event for the same write cannot slip through.
  const stamp = `${id}:${phase}`;
  if (stamp === lastHandled) return;

  if (phase === "open") {
    lastHandled = stamp;
    if (latestPointer) {
      snapshots.set(id, { ...latestPointer });
      while (snapshots.size > MAX_SNAPSHOTS) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) break;
        snapshots.delete(oldest);
      }
    }
    return;
  }

  const action = typeof req.action === "string" ? req.action : "";
  const isBuiltin = BUILTIN_ACTIONS.has(action);
  const isDirect = action === "selection_send_to_agent";
  const command = PLUGIN_COMMANDS.get(action);
  if (!isBuiltin && !isDirect && !command) return;
  lastHandled = stamp;

  // No snapshot (the open request was missed) means the caret stays put;
  // the latest pointer may be over herdr's popup by now.
  const pointer = snapshots.get(id) ?? null;
  snapshots.delete(id);
  try {
    await placeCursor(pointer);
  } catch {}

  try {
    if (isBuiltin) {
      editor.executeAction(action);
    } else if (isDirect) {
      await sendSelectionToAgent();
    } else if (command) {
      await editor.runCommand(command);
    }
  } catch {}
}

async function on_path_changed(ev: { path: string; kind?: string }): Promise<void> {
  try {
    // Linux notify-rs watches emit IN_OPEN/IN_CLOSE ("other") whenever we read a
    // watched file; skip those so readFile/readDir cannot re-trigger this hook.
    if (ev.kind !== "modify" && ev.kind !== "create" && ev.kind !== "rename") return;
    if (ev.path === selfPath) {
      reloadIfChanged();
      return;
    }
    if (isRefsEvent(ev.path)) {
      await ensureLibWatch();
      await syncRefs(false);
      return;
    }
    await on_request(ev.path);
  } catch {}
}

/**
 * Hot reload: a deploy that rewrites this file reloads the plugin in the
 * running daemon, so no Fresh restart is needed. Content is compared to what
 * was loaded, so the burst of events from one write reloads at most once.
 */
const pluginsDir = (() => {
  try {
    return `${editor.getConfigDir().replace(/\/+$/, "")}/plugins`;
  } catch {
    return "";
  }
})();
const selfPath = pluginsDir ? `${pluginsDir}/context_menu.ts` : "";
let selfSource: string | null = null;
let reloading = false;

function reloadIfChanged(): void {
  if (!selfPath || reloading || selfSource === null) return;
  const now = editor.readFile(selfPath);
  if (!now || now === selfSource) return;
  reloading = true;
  editor.reloadPlugin("context_menu").catch(() => {
    reloading = false;
  });
}

/**
 * references_view.ts follows the same rule. Its fingerprint is its own text
 * plus the lib/*.ts it imports, so one change to either coalesces into one
 * reload. A reload is started only when the fingerprint differs from the last
 * one applied, and never while another is in flight (the change is queued).
 */
const refsPath = pluginsDir ? `${pluginsDir}/references_view.ts` : "";
const libDir = pluginsDir ? `${pluginsDir}/lib` : "";
let refsSource: string | null = null;
let refsBusy = false;
let refsPending = false;
let libWatched = false;

function refsFingerprint(): string | null {
  let main: string | null = null;
  try {
    main = editor.readFile(refsPath);
  } catch {}
  if (main === null || main === undefined) return null;
  let names: string[] = [];
  try {
    names = editor
      .readDir(libDir)
      .map((e) => e.name)
      .filter((n) => n.endsWith(".ts") && !n.startsWith("."))
      .sort();
  } catch {}
  let out = main;
  for (const name of names) {
    let text: string | null = null;
    try {
      text = editor.readFile(`${libDir}/${name}`);
    } catch {}
    out += `\u0000${name}\u0000${text ?? ""}`;
  }
  return out;
}

function isRefsEvent(path: string): boolean {
  if (!refsPath) return false;
  if (path === refsPath || path === libDir) return true;
  return path.endsWith(".ts") && path.slice(0, path.lastIndexOf("/")) === libDir;
}

async function ensureLibWatch(): Promise<void> {
  if (libWatched || !libDir) return;
  try {
    await editor.watchPath(libDir);
    libWatched = true;
  } catch {}
}

async function refsLoaded(): Promise<boolean> {
  const plugins = await editor.listPlugins();
  return plugins.some((p) => p.name === "references_view");
}

/**
 * Load references_view.ts if it is not loaded, else reload it, when its
 * fingerprint differs from the last one applied. At startup (`startup`), a
 * loaded copy is kept as it is and only a missing one is loaded.
 */
async function syncRefs(startup: boolean): Promise<void> {
  if (!refsPath) return;
  if (refsBusy) {
    refsPending = true;
    return;
  }
  refsBusy = true;
  try {
    do {
      refsPending = false;
      const fp = refsFingerprint();
      if (fp === null) break;
      const loaded = await refsLoaded();
      if (startup && loaded) {
        refsSource = fp;
        break;
      }
      if (fp === refsSource) break;
      refsSource = fp;
      if (loaded) {
        await editor.reloadPlugin("references_view");
        editor.debug("context_menu: references_view reloaded");
      } else {
        await editor.loadPlugin(refsPath);
        editor.debug("context_menu: references_view loaded");
      }
      startup = false;
    } while (refsPending);
  } catch (e) {
    editor.debug(`context_menu: references_view sync failed: ${e}`);
  } finally {
    refsBusy = false;
  }
}

async function startWatch(): Promise<void> {
  try {
    await editor.spawnProcess("mkdir", ["-p", CTX_DIR]).result;
    await editor.watchPath(CTX_DIR);
  } catch {}
  try {
    if (selfPath) {
      selfSource = editor.readFile(selfPath);
      await editor.watchPath(pluginsDir);
    }
  } catch {}
  await ensureLibWatch();
  await syncRefs(true);
}

daemonKey = deriveKey();
registerHandler("context_menu_mouse_move", on_mouse_move);
registerHandler("context_menu_mouse_click", on_mouse_click);
registerHandler("context_menu_path_changed", on_path_changed);
registerHandler("context_menu_plugins_loaded", () => {
  void syncRefs(true);
});
editor.on("mouse_move", "context_menu_mouse_move");
editor.on("mouse_click", "context_menu_mouse_click");
editor.on("path_changed", "context_menu_path_changed");
editor.on("plugins_loaded", "context_menu_plugins_loaded");
void startWatch();
