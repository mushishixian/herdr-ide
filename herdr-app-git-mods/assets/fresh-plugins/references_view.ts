/**
 * Find References and Go to Implementation as a docked panel grouped by file,
 * in the style of VS Code's References view.
 *
 * Replaces Fresh's embedded find_references plugin: it is unloaded here, so
 * one lsp_references (or lsp_implementation) result opens exactly one panel.
 *   - Groups: the current file first, then the other files by relative path;
 *     rows inside a group are sorted by line.
 *   - Rows: the line number and the trimmed code. The group header already
 *     names the file, so the row does not repeat it, except when two files
 *     share a basename (two mod.rs): then the row shows the relative path too.
 *   - Moving the caret previews the location; Enter jumps and closes the
 *     panel; Esc closes.
 *
 * Built on lib/finder.ts (copied from Fresh 0.5.3, see lib/SOURCE.txt).
 * Hot reload: context_menu.ts reloads this file when it changes on disk.
 */

import { Finder, getRelativePath } from "./lib/finder.ts";

const editor = getEditor();

const STOCK_PLUGIN = "find_references";
const MAX_DESCRIPTION = 60;
/**
 * Finder's panel layout is: title (line 0), blank (1), group header (2), first
 * item (3). Finder does not move the caret onto the first item, so we do.
 */
const FIRST_ITEM_LINE = 3;

type LspLocation = { file: string; line: number; column: number };

type Row = {
  file: string;
  line: number;
  column: number;
  label: string;
  description: string;
};

const finder = new Finder<Row>(editor, {
  id: "references_view",
  format: (row) => ({
    id: `${row.file}:${row.line}:${row.column}`,
    label: row.label,
    description: row.description,
    location: { file: row.file, line: row.line, column: row.column },
  }),
  groupBy: "file",
  preview: false,
  navigateOnCursorMove: true,
  closeOnSelect: true,
  useUtilityDock: true,
});

function relPath(file: string): string {
  try {
    return getRelativePath(editor, file);
  } catch {
    return file;
  }
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

async function readLines(file: string): Promise<string[]> {
  try {
    const content = await editor.readFile(editor.authorityPath(file));
    return content ? content.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * Dedupe (several hits on one line, e.g. `f(1) + f(2)`, become one row at the
 * first hit), read each referenced line, sort, and set the row labels.
 */
async function buildRows(locations: LspLocation[]): Promise<Row[]> {
  const seen = new Set<string>();
  const ordered = [...locations].sort((a, b) => a.column - b.column);
  const unique = ordered.filter((loc) => {
    const key = `${loc.file}:${loc.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const cache = new Map<string, string[]>();
  const rows: Row[] = [];
  for (const loc of unique) {
    let lines = cache.get(loc.file);
    if (lines === undefined) {
      lines = await readLines(loc.file);
      cache.set(loc.file, lines);
    }
    const text = (lines[loc.line - 1] ?? "").replace(/\r$/, "").trim();
    const description =
      text.length > MAX_DESCRIPTION ? text.slice(0, MAX_DESCRIPTION - 3) + "..." : text;
    rows.push({ ...loc, label: "", description });
  }

  const current = currentFile();
  const rankOf = (file: string): number => (file === current ? 0 : 1);
  rows.sort((a, b) => {
    const fileOrder = rankOf(a.file) - rankOf(b.file);
    if (fileOrder !== 0) return fileOrder;
    if (a.file !== b.file) {
      const ra = relPath(a.file);
      const rb = relPath(b.file);
      if (ra !== rb) return ra < rb ? -1 : 1;
    }
    return a.line - b.line || a.column - b.column;
  });

  // Basenames shared by more than one file: those rows carry the relative path.
  const filesByBase = new Map<string, Set<string>>();
  for (const row of rows) {
    const base = baseName(row.file);
    const files = filesByBase.get(base) ?? new Set<string>();
    files.add(row.file);
    filesByBase.set(base, files);
  }
  const width = Math.max(...rows.map((row) => String(row.line).length));
  for (const row of rows) {
    const clash = (filesByBase.get(baseName(row.file))?.size ?? 0) > 1;
    row.label = clash
      ? `${relPath(row.file)}:${row.line}`
      : String(row.line).padStart(width);
  }
  return rows;
}

/** Move the caret onto the first item so Down starts in the list, not on a header. */
async function placeCaretOnFirstItem(): Promise<void> {
  try {
    const bufferId = editor.getActiveBufferId();
    const start = await editor.getLineStartPosition(FIRST_ITEM_LINE);
    if (start !== null) editor.setBufferCursor(bufferId, start);
  } catch (e) {
    editor.debug(`references_view: caret placement failed: ${e}`);
  }
}

async function showLocations(
  kind: "references" | "implementations",
  symbol: string,
  locations: LspLocation[],
): Promise<void> {
  if (locations.length === 0) {
    editor.setStatus(
      kind === "references"
        ? `No references found for '${symbol}'`
        : `No implementation found for '${symbol}'`,
    );
    return;
  }
  const rows = await buildRows(locations);
  const title =
    kind === "references"
      ? `References to '${symbol}' (${rows.length})`
      : `Implementations of '${symbol}' (${rows.length})`;
  if (finder.isOpen) finder.close();
  await finder.panel({ title, items: rows, ratio: 0.35 });
  await placeCaretOnFirstItem();
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
    finder.close();
  } catch {}
});

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
void unloadStock();

editor.debug("references_view plugin loaded");
