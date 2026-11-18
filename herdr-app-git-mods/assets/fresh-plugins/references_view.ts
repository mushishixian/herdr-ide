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
 *   - Hit lines are highlighted and the symbol is emphasised; context lines
 *     are dimmer. Code keeps its syntax colours (setSyntaxRegions).
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

type LspLocation = { file: string; line: number; column: number };

/** A row that opens a location. `line` is 1-based, `column` 1-based bytes. */
type CodeRow = { kind: "code"; hit: boolean; file: string; line: number; column: number };
/** Title, header, separator, blank and help rows: no location. */
type RowInfo = CodeRow | { kind: "other" };

type Overlay = { start: number; end: number; style: Record<string, unknown> };

type Group = {
  file: string;
  rel: string;
  base: string;
  /** File content, one entry per line, without the trailing CR. */
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
  /** 1-based buffer line -> what that row is. */
  rowAt: Map<number, RowInfo>;
  cursorLine: number;
  previewNext: { file: string; line: number; column: number } | null;
  previewTimer: number | null;
  /** The file showing as the preview tab, or null. */
  previewFile: string | null;
  lastClick: { line: number; at: number } | null;
};

type Rendered = {
  entries: TextPropertyEntry[];
  /** Byte offsets, ready for addOverlay. */
  overlays: Overlay[];
  regions: TsSyntaxRegion[];
  rowAt: Map<number, RowInfo>;
  /** 1-based line and byte offset of the first hit row (0 / 0 when none). */
  firstHitLine: number;
  firstHitStart: number;
};

const OTHER: RowInfo = { kind: "other" };
const DIM = "editor.line_number_fg";

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

async function readLines(file: string): Promise<string[]> {
  try {
    const content = await editor.readFile(editor.authorityPath(file));
    return content ? content.split("\n").map((line) => line.replace(/\r$/, "")) : [];
  } catch {
    return [];
  }
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

  const groups: Group[] = [];
  for (const [file, hits] of byFile) {
    for (const columns of hits.values()) columns.sort((a, b) => a - b);
    const lines = await readLines(file);
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
    rowAt: new Map(),
    firstHitLine: 0,
    firstHitStart: 0,
  };
  let bytes = 0;
  let lineNo = 1;

  const emit = (text: string, info: RowInfo, properties: Record<string, unknown>): number => {
    const start = bytes;
    out.entries.push({ text, properties });
    out.rowAt.set(lineNo, info);
    bytes += byteLength(text);
    lineNo++;
    return start;
  };
  /** Style `text[from, to)` of the row that starts at byte `start`. */
  const span = (
    start: number,
    text: string,
    from: number,
    to: number,
    style: Record<string, unknown>,
  ): void => {
    if (to <= from) return;
    out.overlays.push({
      start: start + byteLength(text.slice(0, from)),
      end: start + byteLength(text.slice(0, to)),
      style,
    });
  };

  // Title, from Finder's title row, with the hit count.
  const title =
    kind === "references"
      ? `References to '${symbol}' (${hitCount})`
      : `Implementations of '${symbol}' (${hitCount})`;
  const titleText = `${title}\n`;
  span(emit(titleText, OTHER, { type: "title" }), titleText, 0, titleText.length - 1, {
    bold: true,
  });
  emit("\n", OTHER, { type: "blank" });

  for (const group of groups) {
    const headerText = `▾ ${group.base}  ${group.rel}  (${group.hits.size})\n`;
    const header = emit(headerText, OTHER, { type: "header", file: group.file });
    const baseEnd = 2 + group.base.length;
    span(header, headerText, 2, baseEnd, { bold: true });
    span(header, headerText, baseEnd, headerText.length - 1, { fg: DIM });

    group.blocks.forEach((block, index) => {
      if (index > 0) {
        const sepText = `${" ".repeat(width + 1)}···\n`;
        span(emit(sepText, OTHER, { type: "sep" }), sepText, 0, sepText.length - 1, { fg: DIM });
      }

      const blockStart = bytes;
      const stream = (regionStreams = (regionStreams + 1) % 0xffffffff);
      for (const line of block) {
        const hitColumns = group.hits.get(line);
        const hit = hitColumns !== undefined;
        const raw = group.lines[line - 1] ?? "";
        const code = expandTabs(raw, size);
        const gutter = gutterOf(line);
        const text = `${gutter}${code.text}\n`;
        const column = hitColumns?.[0] ?? 1;
        const info: CodeRow = { kind: "code", hit, file: group.file, line, column };
        const start = emit(text, info, {
          type: "code",
          hit,
          file: group.file,
          line,
          column,
        });
        if (hit && out.firstHitLine === 0) {
          out.firstHitLine = lineNo - 1;
          out.firstHitStart = start;
        }

        const body = text.length - 1;
        if (hit) {
          span(start, text, 0, body, { bg: "editor.selection_bg", extendToLineEnd: true });
          span(start, text, 0, gutter.length, { bold: true });
          for (const col of hitColumns ?? []) {
            const at = charIndexOfByte(raw, col - 1);
            if (symbol && raw.startsWith(symbol, at)) {
              span(
                start,
                text,
                gutter.length + code.map[at],
                gutter.length + code.map[at + symbol.length],
                { bold: true, underline: true },
              );
            }
          }
        } else {
          span(start, text, 0, gutter.length, { fg: DIM });
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

  emit("\n", OTHER, { type: "blank" });
  const helpText = "Enter / double-click: open  ·  Esc: close\n";
  span(emit(helpText, OTHER, { type: "help" }), helpText, 0, helpText.length - 1, { fg: DIM });

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
  const row = p.rowAt.get(line);
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
  const groups = locations.length === 0 ? [] : await buildGroups(locations);
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
  for (const o of rendered.overlays) {
    editor.addOverlay(p.bufferId, PANEL_NAMESPACE, o.start, o.end, o.style);
  }

  const first = rendered.rowAt.get(rendered.firstHitLine);
  if (first && first.kind === "code") schedulePreview(p, first);
  const hits = groups.reduce((n, group) => n + group.hits.size, 0);
  editor.setStatus(`${hits} hit${hits !== 1 ? "s" : ""} in ${groups.length} file${groups.length !== 1 ? "s" : ""}`);
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
    const row = p.rowAt.get(data.line);
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
