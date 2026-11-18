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
  ["selection_send_to_agent", "Selection: Send to Agent"],
]);

type Pointer = {
  column: number;
  row: number;
  content_x: number;
  content_y: number;
};

type Calibration = { gutter: number; digits: number };

let daemonKey = "";
let latestPointer: Pointer | null = null;
const snapshots = new Map<string, Pointer>();
const calibrations = new Map<number, Calibration>();
let lastHandled = "";

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

function on_mouse_move(ev: Pointer): void {
  try {
    latestPointer = {
      column: ev.column,
      row: ev.row,
      content_x: ev.content_x,
      content_y: ev.content_y,
    };
  } catch {}
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
  const command = PLUGIN_COMMANDS.get(action);
  if (!isBuiltin && !command) return;
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
    } else if (command) {
      await editor.runCommand(command);
    }
  } catch {}
}

async function on_path_changed(ev: { path: string }): Promise<void> {
  try {
    await on_request(ev.path);
  } catch {}
}

async function startWatch(): Promise<void> {
  try {
    await editor.spawnProcess("mkdir", ["-p", CTX_DIR]).result;
    await editor.watchPath(CTX_DIR);
  } catch {}
}

daemonKey = deriveKey();
registerHandler("context_menu_mouse_move", on_mouse_move);
registerHandler("context_menu_mouse_click", on_mouse_click);
registerHandler("context_menu_path_changed", on_path_changed);
editor.on("mouse_move", "context_menu_mouse_move");
editor.on("mouse_click", "context_menu_mouse_click");
editor.on("path_changed", "context_menu_path_changed");
void startWatch();
