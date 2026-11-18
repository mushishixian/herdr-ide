# Plan: VS Code-style right-click menu for Fresh panes

Status (2026-11-18): Tasks A and B are implemented, reviewed and deployed. The plugins are
installed in WSL, and `herdr-app check` passes for ide-term-menu and ide-sidebar. Remaining:
the user restarts herdr-app and the Fresh panes, then runs the end-to-end test (Final steps 3–6).
Known limit: LSP inlay hints (virtual text) shift screen columns, so the cursor can land a few
characters off on lines that show hints.

Workflow: director → `clinepass-worker` per task → `reviewer` until APPROVE (see `~/.claude/CLAUDE.md`).
Repo path from WSL: `/mnt/d/Project/herdr-ide`. Read `AGENTS.md` first.

## Goal

Right-clicking in the text area of a Fresh editor pane opens a VS Code-style context menu with
Go to Definition, Find References, Rename, Cut/Copy/Paste and more, and right-click moves the
cursor to the click point first, like VS Code.

## Why it needs two halves (verified facts)

- **Fresh 0.5.3 never gives right-clicks to plugins.** It emits `mouse_click` only for the left
  button; `git_line_history.ts` documents this and a tmux probe confirmed it. Upstream v0.5.9
  (2026-11-16) still has no buffer context menu; PR sinelaw/fresh#2308 is open.
- **Fresh's own remote control is locked.** `fresh --cmd command run` and `script run` need a
  `FRESH_CMD_TOKEN` that only terminals spawned inside Fresh get, so herdr can't drive Fresh
  that way.
- **What does work:**
  - herdr: a layout root key `"terminal_menu": "<mod>"` replaces herdr's terminal right-click
    menu. The mod gets props `{tab: "pane", target: {pane, terminal}, overlay}` and opens as a
    pointer popup sized by its mod.json `overlay` width/height.
  - herdr: `terminal.right_click {to: "menu" | "program", terminal}`.
    `common.js` `enforceTabEditorOrderAndMouse()` currently forces `"program"` for Fresh,
    which has to change.
  - Fresh plugin: `editor.watchPath(dir)` plus a `path_changed` event (no polling needed),
    `editor.executeAction(name)`, `setBufferCursor`, `getViewport`, `listSplits`, `readFile`,
    `getEnv`.
  - Fresh plugin: `mouse_move` fires with `{column, row, content_x, content_y}` (0-based
    screen cells). A left `mouse_click` also carries `buffer_id, buffer_row, buffer_col`
    (buffer_col is a byte column).
- **The gutter width isn't exposed.** `getViewport().width` includes it (99 on a 100-col
  terminal). Measured gutters: `▾ 1 │ ` = 6 cells on a 4-line file, `   1 │ ` = 7 cells on a
  150-line file. Calibrate from left clicks and fall back to an estimate (guess
  `1 + max(2, digits(lineCount)) + 3`, still unverified).
- **Fresh action names**, confirmed in the binary's keymaps: `lsp_goto_definition`,
  `lsp_implementation`, `lsp_references`, `lsp_rename`, `lsp_code_actions`, `lsp_hover`,
  `lsp_completion`, `cut`, `copy`, `paste`, `select_all`, `toggle_comment`, `close_tab`,
  `save`, `undo`, `redo`. No format action was found.
- **Terminal records:** herdr `terminals()` entries for Fresh panes have
  `foreground.name === "fresh"` and
  `foreground.argv = [".../fresh", "--no-upgrade-check", "-a", "ide-41f55bf0", "<file>"]`.
  The address is `"wsl/t3"` for the WSL machine and `"t4"` for a local one.
- **Daemon name inside Fresh:** the Fresh server runs as `fresh --server --session-name <name>`.
  Inside the plugin, `editor.getEnv("FRESH_IDE_DAEMON")` works for panes launched by the
  current `freshLaunchBash()`. Older panes lack that variable, so parse `/proc/self/cmdline`.
- **Known side bug:** `active_file_notify.ts` is in the repo but isn't installed in WSL
  `~/.config/fresh/plugins/`, so the explorer's auto-reveal of the active file is broken. Task B
  fixes the install path.

## Flow

```
right-click in a Fresh pane
  → herdr opens the ide-term-menu popup at the pointer (layout terminal_menu)
  → the mod writes {id, phase:"open"} to /tmp/fresh-ide-ctx/<daemon>.json   (fire-and-forget)
      → the plugin freezes the last mouse_move position under that id
  → the user picks an item → the mod writes {id, phase:"run", action} and focuses the pane
      → the plugin places the cursor from the frozen position (kept if inside the selection)
        → executeAction(action)
```

## Contract (both halves must match it exactly)

- **File:** `/tmp/fresh-ide-ctx/<key>.json` on the terminal's machine, written atomically
  (`<key>.json.tmp`, then `mv -f`). The herdr side runs
  `exec("bash", ["-c", script, "fresh-ctx", key, json], { on })`, passing values as positional
  args, never interpolated:
  `mkdir -p /tmp/fresh-ide-ctx && printf '%s' "$2" > "/tmp/fresh-ide-ctx/$1.json.tmp" && mv -f "/tmp/fresh-ide-ctx/$1.json.tmp" "/tmp/fresh-ide-ctx/$1.json"`
- **`<key>`, herdr side:** the argument after `-a` in `foreground.argv`, else `"default"`.
- **`<key>`, plugin side:** `getEnv("FRESH_IDE_DAEMON")`, else the value after `--session-name`
  in `/proc/self/cmdline`, else `"default"`.
- **JSON:** `{"id": string, "phase": "open" | "run", "action"?: string, "ts": epochMs}`. The
  plugin ignores a repeat of the same id+phase and anything with `ts` older than 15 s.
- **Action whitelist:** `lsp_goto_definition`, `lsp_implementation`, `lsp_references`,
  `lsp_rename`, `lsp_code_actions`, `lsp_hover`, `cut`, `copy`, `paste`, `select_all`,
  `toggle_comment`, `close_tab`, `git_line_history`, `selection_copy_reference`,
  `selection_send_to_agent`. The last three are handlers from the user's own plugins.
  Check whether `executeAction` can trigger them; if not, use the run-by-palette-name API.
  Their palette names are "Git: Line History", "Selection: Copy as Reference" and
  "Selection: Send to Agent".

## Task A: Fresh plugin `herdr-app-git-mods/assets/fresh-plugins/context_menu.ts`

1. **Style:** match `active_file_notify.ts` and `herdr-sidebar/dotfiles/config/fresh/plugins/*.ts`
   (doc header, `registerHandler` plus `editor.on`, try/catch around host calls). The API is in
   `~/.config/fresh/types/fresh.d.ts`.
2. **Watching:** run `mkdir -p` on the directory (`editor.spawnProcess(...).result`), call
   `watchPath(dir)`, and in `path_changed` react only when the basename is `<key>.json`.
3. **Pointer tracking:** track the last `mouse_move`. Calibrate the gutter per buffer from each
   left click: `gutter = (column - content_x) - (displayCol(line, buffer_col) - leftColumn)`.
   Store it with the buffer's line-count digit width.
4. **On run:**
   - If the frozen point is inside the active split's text area, compute
     `line = topLine + (row - content_y)`, clamped to the last line.
   - Compute `displayCol = leftColumn + (column - content_x - gutter)` and convert it to a byte
     offset: tabs use the configured tab size, CJK characters count 2 cells, multi-byte UTF-8 is
     handled, and the result is clamped to the line end.
   - If that byte offset is inside the current selection, keep the selection. Otherwise call
     `setBufferCursor`.
   - Then run the action, making sure the cursor move lands first (`executeAction` is queued).
   - If anything is unknown, run the action at the current cursor.
5. **Test headless in WSL tmux** with an isolated config, never the user's live daemons:

   ```bash
   P=/tmp/fctx-test; mkdir -p $P/cfg/fresh/plugins $P/work
   cp ~/.config/fresh/config.json $P/cfg/fresh/; cp ~/.config/fresh/plugins/*.ts $P/cfg/fresh/plugins/
   cp /mnt/d/Project/herdr-ide/herdr-app-git-mods/assets/fresh-plugins/context_menu.ts $P/cfg/fresh/plugins/
   cd $P/work; tmux new-session -d -s fctx -x 100 -y 30 \
     "XDG_CONFIG_HOME=$P/cfg FRESH_IDE_DAEMON=fctx-test $HOME/.local/share/fresh-editor/fresh --no-upgrade-check a.txt"
   tmux send-keys -t fctx -l $'\e[<35;20;4M'                                     # motion to col 20,row 4 (1-based)
   tmux send-keys -t fctx -l $'\e[<0;12;3M'; tmux send-keys -t fctx -l $'\e[<0;12;3m'   # left click
   tmux capture-pane -t fctx -p
   ```

   **Prove each of these:**
   - the cursor lands correctly on a line containing a tab, and on a file with more than 150
     lines;
   - the selection is kept when the pointer is inside it;
   - `select_all`, `toggle_comment`, `copy` and `close_tab` work;
   - stale and duplicate requests are ignored;
   - the key is derived from `--session-name` when Fresh runs as a daemon (`-a NAME`);
   - `lsp_goto_definition` runs, if a language server is installed.

   Clean up the tmux sessions and `/tmp/fctx-test` afterwards.

## Task B: herdr side

1. **New `herdr-app-git-mods/src/ide-term-menu.js`** (ESM, `export default class … extends View`).
   - **Look:** match the built-in menu (`%USERPROFILE%\.config\herdr-app\mods\menu\main.js`,
     or `/mnt/c/Users/64813/.config/herdr-app/mods/menu/main.js` from WSL) and `src/ide-menu.js`:
     ↑/↓/Enter/Esc, hover rows, separators, dim key hints.
   - **Fresh items**, in groups:
     - Go to Definition (F12), Go to Implementation, Find References (Shift+F12)
     - Rename Symbol (F2), Code Actions (Ctrl+.), Show Hover
     - Cut, Copy, Paste, Select All, Toggle Comment (Ctrl+/)
     - Git: Line History (Ctrl+Alt+O), Copy as Reference (Ctrl+Alt+L), Send to Agent (Ctrl+Alt+A)
     - Close Tab
     - herdr's Split right, Split down, Zoom, Close pane
   - **Hints:** confirm the F-key hints against Fresh's VS Code keymap and drop any you can't
     confirm.
   - **Non-Fresh terminals:** exactly the built-in "pane" items: split, zoom, the right-click
     toggle, send back to parent, close.
   - **Size:** the overlay has a fixed size, so use compact rows inside
     `div().relative().h(n)` + `div().absolute().inset_0().overflow_y_scroll()`
     (see AGENTS.md).
   - **Behaviour:**
     - on open (Fresh only), write `phase:"open"` without blocking rendering;
     - on pick, close the overlay, write `phase:"run"`, then call
       `run("pane.focus", { pane: target.pane })`;
     - swallow exec errors.
2. **`deploy.ps1`:**
   - deploy `ide-term-menu` with mod.json
     `@{ place = "none"; title = "Terminal Menu"; overlay = @{ width = W; height = H } }`;
   - make sure the runtime `layouts/terminals-git.json` and `ide.json` have root
     `"terminal_menu": "ide-term-menu"`, inserted as minimal text after `"id": "root",` (no
     ConvertTo-Json, UTF-8 without BOM);
   - copy every `assets\fresh-plugins\*.ts` into WSL `~/.config/fresh/plugins/`, skipping with a
     message if WSL is unavailable.
3. **`bundle/layouts/terminals-git.json` and `bundle/layouts/ide.json`:** add the same root key.
4. **`install-on-new-pc.ps1`:** copy all `fresh-plugins/*.ts`, not only `active_file_notify.ts`.
5. **`src/common.js` `enforceTabEditorOrderAndMouse()`:** Fresh panes get `to: "menu"` (existing
   ones carry `"program"`); Nvim/Helix keep `"program"`. Update the comment.

**Verify (from WSL, call Windows tools through `powershell.exe` / `cmd.exe`):**
- `node --input-type=module --check < src/ide-term-menu.js` (and `common.js`);
- run `deploy.ps1`;
- `herdr-app.exe check` on `ide-term-menu` and `ide-sidebar` comes back clean;
- the runtime layouts differ only by the new line;
- the request-writing script produces the expected file.

Don't restart herdr-app without asking.

## Final steps (director)

1. Run the reviewer on each task until APPROVE.
2. Run `deploy.ps1`, which also installs the Fresh plugins.
3. Ask the user to restart herdr-app and their Fresh panes, since plugins load when a daemon
   starts.
4. **End-to-end test by the user:**
   - right-click a symbol → Go to Definition;
   - right-click inside a selection → Copy keeps the selection;
   - right-click in a normal shell pane → the herdr items still appear.
5. Known trade-off to tell the user: Fresh's own right-click menus on its tab bar and file
   explorer no longer open, because right-clicks now go to herdr. Close Tab is in the new menu.
   The herdr sidebar replaces Fresh's explorer.
6. Run `export-bundle.ps1` if the portable zip should include this.
