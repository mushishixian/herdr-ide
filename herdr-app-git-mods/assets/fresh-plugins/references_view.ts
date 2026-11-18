/**
 * Find References and Go to Implementation as a docked panel, in the style of
 * VS Code's References view: one group per file, and each hit shown with the
 * code around it.
 *
 * Replaces Fresh's embedded find_references plugin: it is unloaded here, so
 * one lsp_references (or lsp_implementation) result opens exactly one panel.
 *   - Groups: the current file first, then the other files by relative path.
 *     A header row names the file, its relative path and its hit count.
 *   - Rows: each hit line with CONTEXT_BEFORE / CONTEXT_AFTER lines around it.
 *     Ranges that overlap or touch merge into one block; blocks of the same
 *     file are separated by a dim "···" row. Lines are shown whole.
 *   - Hit lines get a soft background (ui.menu_hover_bg, a theme colour that
 *     stays quiet) and the symbol is bold and underlined; context lines are
 *     dimmer. Code keeps its syntax colours (setSyntaxRegions).
 *   - Moving the caret previews the location in the source split, through the
 *     preview tab. Enter or a double-click opens the row and closes the panel;
 *     Esc closes and drops the preview.
 *   - Double-click: Fresh gives plugins no double-click event; the two left
 *     presses are recognised from mouse_click and the cursor move that
 *     word-selects (see the mouse section below).
 *
 * The panel is rendered here rather than by lib/finder.ts: Finder draws one
 * truncated line per item and maps rows to items one to one, which cannot
 * hold context rows, separators or per-row columns. The pieces shared with it
 * (virtual buffer, mode keys, preview debounce, syntax regions) follow
 * lib/finder.ts (Fresh 0.5.3, see lib/SOURCE.txt); each is marked "from
 * Finder". Hot reload: context_menu.ts reloads this file when it changes.
 *
 * Speed: the plugin runs in QuickJS, so per-row JS work and per-call host
 * work both cost. Files are read in one batch (open buffers use their own
 * text), each row's styles go in its entry as inline overlays, and ASCII rows
 * skip the byte-offset arithmetic.
 */

import { byteLength } from "./lib/text.ts";

const editor = getEditor();

const STOCK_PLUGIN = "find_references";
/** Lines of code shown above and below each hit. */
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 2;
/** Two left clicks on the same row within this many ms open that row. */
const DOUBLE_CLICK_MS = 450;
/** Pause before a preview opens, so arrow-key browsing does not open each row (from Finder). */
const PREVIEW_DEBOUNCE_MS = 90;
const DEFAULT_TAB_SIZE = 4;
const PANEL_ID = "references_view";
const PANEL_MODE = "references_view-results";
const PANEL_NAMESPACE = "references_view";
const PREVIEW_TICK = "references_view_preview_tick";
/** Only ASCII text has byte offsets equal to its char offsets. */
const ASCII_ONLY = /^[\x00-\x7f]*$/;

type LspLocation = { file: string; line: number; column: number };

/** A row that opens a location. `line` is 1-based, `column` 1-based bytes. */
type CodeRow = { kind: "code"; hit: boolean; file: string; line: number; column: number };
/** Title, header, separator, blank and help rows: no location. */
type RowInfo = CodeRow | { kind: "other" };

/** A style over absolute byte offsets of the panel buffer (applied with addOverlay). */
type Overlay = { start: number; end: number; style: Partial<OverlayOptions> };

type Group = {
  file: string;
  rel: string;
  base: string;
  /** File content, one entry per line; a CR at a line's end is stripped when it is drawn. */
  lines: string[];
  /** 1-based hit line -> byte columns of the hits on it, ascending. */
  hits: Map<number, number[]>;
  /** Context blocks: each a run of consecutive 1-based line numbers. */
  blocks: number[][];
};

type Panel = {
  bufferId: number;
  splitId: number | null;
  sourceSplitId: number | null;
  /** 1-based buffer line -> what that row is (index 0 unused). */
  rowAt: RowInfo[];
  cursorLine: number;
  previewNext: { file: string; line: number; column: number } | null;
  previewTimer: number | null;
  /** The file showing as the preview tab, or null. */
  previewFile: string | null;
  lastClick: { line: number; at: number } | null;
};

type Rendered = {
  entries: TextPropertyEntry[];
  overlays: Overlay[];
  regions: TsSyntaxRegion[];
  /** 1-based buffer line -> what that row is (index 0 unused). */
  rowAt: RowInfo[];
  /** 1-based line and byte offset of the first hit row (0 / 0 when none). */
  firstHitLine: number;
  firstHitStart: number;
};

const OTHER: RowInfo = { kind: "other" };
const DIM = "editor.line_number_fg";
const DIM_STYLE: Partial<OverlayOptions> = { fg: DIM };
const BOLD_STYLE: Partial<OverlayOptions> = { bold: true };
/**
 * The hit row's background. ui.menu_hover_bg is a grey in every theme (DarkGray
 * in builtin://terminal, where selection_bg is reverse video and
 * current_line_bg is the terminal default, so neither can carry a tint).
 * Syntax comments are DarkGray too, so fgOnCollisionOnly lifts a token that
 * would vanish into the background to the editor's own foreground.
 */
const HIT_STYLE: Partial<OverlayOptions> = {
  bg: "ui.menu_hover_bg",
  fg: "editor.fg",
  fgOnCollisionOnly: true,
  extendToLineEnd: true,
};
const SYMBOL_STYLE: Partial<OverlayOptions> = { bold: true, underline: true };

let panel: Panel | null = null;
let regionStreams = 0;

editor.defineMode(
  PANEL_MODE,
  [
    ["enter", "references_view_panel_select"],
    ["escape", "references_view_panel_close"],
  ],
  true,
);

function relPath(file: string): string {
  try {
    const cwd = editor.getCwd();
    if (file.startsWith(cwd + "/")) return file.slice(cwd.length + 1);
  } catch {}
  return file;
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

function currentFile(): string {
  try {
    return editor.getBufferInfo(editor.getActiveBufferId())?.path ?? "";
  } catch {
    return "";
  }
}

function tabSize(): number {
  try {
    const size = editor.getConfig().editor?.tab_size;
    if (typeof size === "number" && size > 0) return size;
  } catch {}
  return DEFAULT_TAB_SIZE;
}

/** Split file text into lines; a CR at a line's end is left for the renderer. */
function linesOf(content: string): string[] {
  return content ? content.split("\n") : [];
}

/** A file's lines, read whole from disk. */
function readLines(file: string): string[] {
  try {
    return linesOf(editor.readFile(editor.authorityPath(file)) ?? "");
  } catch {
    return [];
  }
}

/** Open file buffers by path. */
function openBufferIds(): Map<string, number> {
  const ids = new Map<string, number>();
  try {
    for (const info of editor.listBuffers()) {
      if (info.path && !ids.has(info.path)) ids.set(info.path, info.id);
    }
  } catch {}
  return ids;
}

/** Context ranges of the hits, merged where they overlap or touch. */
function blocksOf(hits: Map<number, number[]>, lineCount: number): number[][] {
  const ranges: Array<[number, number]> = [];
  for (const hit of [...hits.keys()].sort((a, b) => a - b)) {
    const start = Math.max(1, hit - CONTEXT_BEFORE);
    const end = Math.max(hit, Math.min(hit + CONTEXT_AFTER, lineCount));
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges.map(([start, end]) => {
    const lines: number[] = [];
    for (let line = start; line <= end; line++) lines.push(line);
    return lines;
  });
}

/** Group the locations by file, read each file once, and build its blocks. */
async function buildGroups(locations: LspLocation[]): Promise<Group[]> {
  const byFile = new Map<string, Map<number, number[]>>();
  for (const loc of locations) {
    if (!loc.file || !(loc.line >= 1)) continue;
    let hits = byFile.get(loc.file);
    if (!hits) {
      hits = new Map();
      byFile.set(loc.file, hits);
    }
    const column = Math.max(1, loc.column || 1);
    const columns = hits.get(loc.line) ?? [];
    if (!columns.includes(column)) columns.push(column);
    hits.set(loc.line, columns);
  }

  for (const hits of byFile.values()) {
    for (const columns of hits.values()) columns.sort((a, b) => a - b);
  }

  // An open buffer's text is asked for first, so its reply arrives while the
  // other files are read. It includes unsaved edits.
  const openIds = openBufferIds();
  const buffered = new Map<string, Promise<string | null>>();
  for (const file of byFile.keys()) {
    const id = openIds.get(file);
    if (id !== undefined) buffered.set(file, editor.getBufferText(id).catch(() => null));
  }
  // Other files: one readFile each. (Measured on drvfs, 62 files: readFile
  // 111 ms, a single batched readFilePrefixes call 222 ms, so not that.)
  const sources = new Map<string, string[]>();
  for (const file of byFile.keys()) {
    if (!buffered.has(file)) sources.set(file, readLines(file));
  }
  for (const [file, text] of buffered) {
    const content = await text;
    sources.set(file, content === null ? readLines(file) : linesOf(content));
  }

  const groups: Group[] = [];
  for (const [file, hits] of byFile) {
    const lines = sources.get(file) ?? [];
    groups.push({
      file,
      rel: relPath(file),
      base: baseName(file),
      lines,
      hits,
      blocks: blocksOf(hits, lines.length),
    });
  }

  const current = currentFile();
  const rank = (group: Group): number => (group.file === current ? 0 : 1);
  groups.sort((a, b) => {
    const order = rank(a) - rank(b);
    if (order !== 0) return order;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
  return groups;
}

/** Tabs become spaces up to the next tab stop. `map[i]` is the display index of raw char i. */
function expandTabs(raw: string, size: number): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let column = 0;
  for (const ch of raw) {
    map.push(column);
    if (ch === "\t") {
      const pad = size - (column % size);
      text += " ".repeat(pad);
      column += pad;
    } else {
      text += ch;
      column += 1;
    }
  }
  map.push(column);
  return { text, map };
}

/** The char index in `raw` at 0-based UTF-8 byte offset `byteOffset`. */
function charIndexOfByte(raw: string, byteOffset: number): number {
  let bytes = 0;
  let index = 0;
  while (index < raw.length && bytes < byteOffset) {
    const ch = String.fromCodePoint(raw.codePointAt(index) ?? 0);
    bytes += byteLength(ch);
    index += ch.length;
  }
  return index;
}

/**
 * Lay out the panel as entries, with overlays and syntax regions. Each entry
 * is one buffer line, so the buffer line of a row is its entry's position.
 * Overlays are absolute byte offsets in the panel buffer.
 */
function renderPanel(
  kind: "references" | "implementations",
  symbol: string,
  groups: Group[],
  size: number,
): Rendered {
  let hitCount = 0;
  let maxLine = 1;
  for (const group of groups) {
    hitCount += group.hits.size;
    for (const block of group.blocks) {
      maxLine = Math.max(maxLine, block[block.length - 1]);
    }
  }
  const width = String(maxLine).length;
  const gutterOf = (line: number): string => `${String(line).padStart(width)} │ `;

  const out: Rendered = {
    entries: [],
    overlays: [],
    regions: [],
    rowAt: [OTHER],
    firstHitLine: 0,
    firstHitStart: 0,
  };
  let bytes = 0;
  let lineNo = 1;

  /** Add a row (`text` with its newline). Returns the row's byte offset. */
  const emit = (text: string, info: RowInfo, textBytes: number): number => {
    const start = bytes;
    out.entries.push({ text });
    out.rowAt.push(info);
    bytes += textBytes;
    lineNo++;
    return start;
  };
  /** Style chars [from, to) of `text`, a row that starts at byte `base`. */
  const styleChars = (
    base: number,
    text: string,
    ascii: boolean,
    from: number,
    to: number,
    style: Partial<OverlayOptions>,
  ): void => {
    if (to <= from) return;
    out.overlays.push({
      start: base + (ascii ? from : byteLength(text.slice(0, from))),
      end: base + (ascii ? to : byteLength(text.slice(0, to))),
      style,
    });
  };

  // Title, from Finder's title row, with the hit count.
  const title =
    kind === "references"
      ? `References to '${symbol}' (${hitCount})`
      : `Implementations of '${symbol}' (${hitCount})`;
  const titleText = `${title}\n`;
  const titleAscii = ASCII_ONLY.test(titleText);
  styleChars(
    emit(titleText, OTHER, byteLength(titleText)),
    titleText,
    titleAscii,
    0,
    titleText.length - 1,
    BOLD_STYLE,
  );
  emit("\n", OTHER, 1);

  for (const group of groups) {
    const headerText = `▾ ${group.base}  ${group.rel}  (${group.hits.size})\n`;
    const headerAscii = ASCII_ONLY.test(headerText);
    const headerBase = emit(headerText, OTHER, byteLength(headerText));
    const baseEnd = 2 + group.base.length;
    styleChars(headerBase, headerText, headerAscii, 2, baseEnd, BOLD_STYLE);
    styleChars(headerBase, headerText, headerAscii, baseEnd, headerText.length - 1, DIM_STYLE);

    group.blocks.forEach((block, index) => {
      if (index > 0) {
        const sepText = `${" ".repeat(width + 1)}···\n`;
        styleChars(
          emit(sepText, OTHER, byteLength(sepText)),
          sepText,
          true,
          0,
          sepText.length - 1,
          DIM_STYLE,
        );
      }

      const blockStart = bytes;
      const stream = (regionStreams = (regionStreams + 1) % 0xffffffff);
      for (const line of block) {
        const hitColumns = group.hits.get(line);
        const hit = hitColumns !== undefined;
        let raw = group.lines[line - 1] ?? "";
        if (raw.endsWith("\r")) raw = raw.slice(0, -1);
        const rawAscii = ASCII_ONLY.test(raw);
        const display = raw.indexOf("\t") >= 0 ? expandTabs(raw, size) : null;
        const code = display ? display.text : raw;
        const gutter = gutterOf(line);
        const text = `${gutter}${code}\n`;
        // The gutter's "│" is 3 bytes, so a row is not ASCII even when its code is.
        // Char offsets in the code map to bytes by the gutter's byte length.
        const gutterLen = gutter.length;
        const gutterBytes = byteLength(gutter);
        const byteAt = (index: number): number =>
          index <= gutterLen
            ? byteLength(gutter.slice(0, index))
            : gutterBytes + (rawAscii ? index - gutterLen : byteLength(code.slice(0, index - gutterLen)));
        const column = hitColumns?.[0] ?? 1;
        const info: CodeRow = { kind: "code", hit, file: group.file, line, column };
        const textBytes = gutterBytes + (rawAscii ? code.length : byteLength(code)) + 1;
        const base = emit(text, info, textBytes);
        const styleRow = (from: number, to: number, style: Partial<OverlayOptions>): void => {
          if (to > from) {
            out.overlays.push({ start: base + byteAt(from), end: base + byteAt(to), style });
          }
        };
        if (hit) {
          styleRow(0, text.length - 1, HIT_STYLE);
          styleRow(0, gutterLen, BOLD_STYLE);
          for (const col of hitColumns) {
            const at = rawAscii ? col - 1 : charIndexOfByte(raw, col - 1);
            if (symbol && raw.startsWith(symbol, at)) {
              const from = display ? display.map[at] : at;
              const to = display ? display.map[at + symbol.length] : at + symbol.length;
              styleRow(gutterLen + from, gutterLen + to, SYMBOL_STYLE);
            }
          }
          if (out.firstHitLine === 0) {
            out.firstHitLine = lineNo - 1;
            out.firstHitStart = base;
          }
        } else {
          styleRow(0, gutterLen, DIM_STYLE);
        }
      }
      // One syntax region per block: its rows are consecutive source lines,
      // so they share one parser stream and the gutter is the same width.
      out.regions.push({
        start: blockStart,
        end: bytes,
        language: group.file,
        prefix: byteLength(gutterOf(block[0])),
        streams: [stream],
      });
    });
  }

  emit("\n", OTHER, 1);
  const helpText = "Enter / double-click: open  ·  Esc: close\n";
  styleChars(
    emit(helpText, OTHER, byteLength(helpText)),
    helpText,
    ASCII_ONLY.test(helpText),
    0,
    helpText.length - 1,
    DIM_STYLE,
  );

  return out;
}

/** Drop a pending preview (from Finder). */
function dropPendingPreview(p: Panel): void {
  if (p.previewTimer !== null) {
    editor.clearInterval(p.previewTimer);
    p.previewTimer = null;
  }
  p.previewNext = null;
}

/** Show the row's location in the source split as the preview tab (from Finder). */
function schedulePreview(p: Panel, row: CodeRow): void {
  p.previewNext = { file: row.file, line: row.line, column: row.column };
  if (p.previewTimer !== null) return;
  p.previewTimer = editor.setTimeout(PREVIEW_DEBOUNCE_MS, PREVIEW_TICK);
}

function previewTick(): void {
  const p = panel;
  if (!p) return;
  p.previewTimer = null;
  const next = p.previewNext;
  p.previewNext = null;
  if (!next || p.sourceSplitId === null) return;
  // The host replaces a preview with another file, but when that file is
  // already open it switches to it and keeps the old preview tab. Drop the
  // old one first so previews always replace each other.
  if (p.previewFile !== null && p.previewFile !== next.file) editor.dismissPreview();
  p.previewFile = next.file;
  editor.previewFileInSplit(p.sourceSplitId, next.file, next.line, next.column);
}

/** The browse ended without a choice: drop the preview tab (from Finder). */
function closePreview(p: Panel): void {
  dropPendingPreview(p);
  if (p.previewFile !== null) {
    p.previewFile = null;
    editor.dismissPreview();
  }
}

/** The browse ended with a choice: the open promotes the preview, so forget the claim (from Finder). */
function commitPreview(p: Panel): void {
  dropPendingPreview(p);
  p.previewFile = null;
}

function closePanel(): void {
  const p = panel;
  if (!p) return;
  panel = null;
  closePreview(p);
  if (p.splitId !== null) editor.closeSplit(p.splitId);
  editor.closeBuffer(p.bufferId);
  // Never focus the split just closed (a stale id can name it after a reload).
  if (p.sourceSplitId !== null && p.sourceSplitId !== p.splitId) {
    editor.focusSplit(p.sourceSplitId);
  }
  editor.setStatus("Closed");
}

/** Enter or double-click on a row: open its location and close the panel. */
function openRow(p: Panel, line: number): void {
  const row = p.rowAt[line];
  if (!row || row.kind !== "code") return;
  commitPreview(p);
  closePanel();
  editor.openFile(row.file, row.line, row.column);
  editor.setStatus(`Jumped to ${row.file}:${row.line}`);
}

async function showLocations(
  kind: "references" | "implementations",
  symbol: string,
  locations: LspLocation[],
): Promise<void> {
  const t0 = Date.now();
  const groups = locations.length === 0 ? [] : await buildGroups(locations);
  const t1 = Date.now();
  if (groups.length === 0) {
    editor.setStatus(
      kind === "references"
        ? `No references found for '${symbol}'`
        : `No implementation found for '${symbol}'`,
    );
    return;
  }

  // One panel per request. An open panel was driven from its own source split,
  // which is read before it closes (closing it moves focus).
  const sourceSplitId = panel?.sourceSplitId ?? editor.getActiveSplitId();
  closePanel();
  const rendered = renderPanel(kind, symbol, groups, tabSize());
  const t2 = Date.now();

  const result = await editor.createVirtualBufferInSplit({
    name: kind === "references" ? "*References*" : "*Implementations*",
    mode: PANEL_MODE,
    readOnly: true,
    entries: rendered.entries,
    ratio: 0.35,
    direction: "horizontal",
    panelId: PANEL_ID,
    role: "utility_dock",
    showLineNumbers: false,
    showCursors: true,
    editingDisabled: true,
  });
  const t3 = Date.now();
  if (result.bufferId === null) {
    editor.setStatus("Failed to open panel");
    return;
  }
  editor.setBufferCursor(result.bufferId, rendered.firstHitStart);

  const p: Panel = {
    bufferId: result.bufferId,
    splitId: result.splitId ?? null,
    sourceSplitId,
    rowAt: rendered.rowAt,
    cursorLine: rendered.firstHitLine,
    previewNext: null,
    previewTimer: null,
    previewFile: null,
    lastClick: null,
  };
  panel = p;
  editor.setSyntaxRegions(p.bufferId, rendered.regions);
  // After the regions: the highlighter paints a row's gutter (the region's
  // prefix) and would overwrite a style set on it through the entry.
  for (const o of rendered.overlays) {
    editor.addOverlay(p.bufferId, PANEL_NAMESPACE, o.start, o.end, o.style);
  }

  const first = rendered.rowAt[rendered.firstHitLine];
  if (first && first.kind === "code") schedulePreview(p, first);
  const hits = groups.reduce((n, group) => n + group.hits.size, 0);
  editor.setStatus(`${hits} hit${hits !== 1 ? "s" : ""} in ${groups.length} file${groups.length !== 1 ? "s" : ""}`);
  editor.debug(
    `references_view: ${locations.length} locations in ${groups.length} files: read ${t1 - t0} ms, render ${t2 - t1} ms, panel ${t3 - t2} ms`,
  );
}

registerHandler(
  "references_view_references",
  async (data: { symbol: string; locations: LspLocation[] }) => {
    try {
      await showLocations("references", data.symbol, data.locations);
    } catch (e) {
      editor.debug(`references_view: references failed: ${e}`);
    }
  },
);

registerHandler(
  "references_view_implementation",
  async (data: { symbol: string; locations: LspLocation[] }) => {
    try {
      await showLocations("implementations", data.symbol, data.locations);
    } catch (e) {
      editor.debug(`references_view: implementation failed: ${e}`);
    }
  },
);

registerHandler("close_references", () => {
  try {
    closePanel();
  } catch {}
});

registerHandler("references_view_panel_select", () => {
  const p = panel;
  if (!p) return;
  try {
    openRow(p, p.cursorLine);
  } catch (e) {
    editor.debug(`references_view: open failed: ${e}`);
  }
});

registerHandler("references_view_panel_close", () => {
  try {
    closePanel();
  } catch {}
});

registerHandler("references_view_preview_tick", () => {
  try {
    previewTick();
  } catch (e) {
    editor.debug(`references_view: preview failed: ${e}`);
  }
});

/** Caret moved in the panel: preview the row it is on (from Finder's cursor handler). */
registerHandler(
  "references_view_panel_cursor",
  (data: { buffer_id: number; line: number }) => {
    const p = panel;
    if (!p || data.buffer_id !== p.bufferId) return;
    p.cursorLine = data.line;
    if (isSelectingSecondClick(p, data.line)) {
      try {
        openRow(p, data.line);
      } catch (e) {
        editor.debug(`references_view: double-click open failed: ${e}`);
      }
      return;
    }
    const row = p.rowAt[data.line];
    if (row && row.kind === "code") schedulePreview(p, row);
  },
);

/**
 * Double-click. Fresh has no double-click event, and its own double-click
 * window (double_click_time_ms, 500 ms) swallows the second press of a
 * double-click on the same cell: that press reaches no mouse_click hook. What
 * reaches the plugin instead is the cursor move that word-selects the symbol,
 * a cursor_moved that leaves a selection. So a double-click is seen two ways:
 *   - a second mouse_click on the same row within DOUBLE_CLICK_MS (when Fresh
 *     lets it through);
 *   - the selecting cursor move on that row within DOUBLE_CLICK_MS (see
 *     isSelectingSecondClick).
 * A single click only places the caret, and keyboard moves leave no selection.
 */
registerHandler("references_view_mouse_click", (args: MouseClickHookArgs) => {
  const p = panel;
  if (!p || args.button !== "left") return;
  if (args.buffer_id !== p.bufferId || args.buffer_row === null) return;
  const line = args.buffer_row + 1;
  const now = Date.now();
  const previous = p.lastClick;
  p.lastClick = { line, at: now };
  if (previous && previous.line === line && now - previous.at <= DOUBLE_CLICK_MS) {
    p.lastClick = null;
    try {
      openRow(p, line);
    } catch (e) {
      editor.debug(`references_view: double-click open failed: ${e}`);
    }
  }
});

/** The second press of a double-click on `line`, seen as its word selection (see above). */
function isSelectingSecondClick(p: Panel, line: number): boolean {
  const click = p.lastClick;
  if (!click || click.line !== line || Date.now() - click.at > DOUBLE_CLICK_MS) return false;
  let selected = false;
  try {
    selected = editor.getPrimaryCursor()?.selection != null;
  } catch {}
  if (selected) p.lastClick = null;
  return selected;
}

/**
 * Keep the stock finder out. Unloading at load covers the usual order; the
 * plugins_loaded hook covers the case where the embedded plugins load after us.
 * Only a stock plugin that is listed gets an unload: Fresh logs an error for
 * an unload of a name it does not have.
 */
let unloadingStock = false;
async function unloadStock(): Promise<void> {
  if (unloadingStock) return;
  unloadingStock = true;
  try {
    const plugins = await editor.listPlugins();
    if (plugins.some((p) => p.name === STOCK_PLUGIN)) {
      await editor.unloadPlugin(STOCK_PLUGIN);
    }
  } catch {
  } finally {
    unloadingStock = false;
  }
}

registerHandler("references_view_plugins_loaded", () => {
  void unloadStock();
});

editor.on("lsp_references", "references_view_references");
editor.on("lsp_implementation", "references_view_implementation");
editor.on("plugins_loaded", "references_view_plugins_loaded");
editor.on("cursor_moved", "references_view_panel_cursor");
editor.on("mouse_click", "references_view_mouse_click");
void unloadStock();

editor.debug("references_view plugin loaded");
