// Terminal right-click menu (layout root "terminal_menu": "ide-term-menu").
// Props: { tab: "pane", target: { pane, terminal }, overlay }.
// Fresh panes get Fresh's editing actions plus herdr's pane items. A picked Fresh
// action is handed to assets/fresh-plugins/context_menu.ts through a small request
// file on the terminal's machine: /tmp/fresh-ide-ctx/<daemon>.json.
// Other terminals get exactly the built-in "pane" items.
// ↑/↓ move, Enter runs, Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, keys, terminals, panes, exec } from "herdr";

// Fixed popup size; keep in sync with deploy.ps1 (mod.json overlay).
const MENU_H = 520;

// Positional args: $1 = daemon key, $2 = JSON. Values are never interpolated.
const CTX_SCRIPT = 'mkdir -p /tmp/fresh-ide-ctx && printf \'%s\' "$2" > "/tmp/fresh-ide-ctx/$1.json.tmp" && mv -f "/tmp/fresh-ide-ctx/$1.json.tmp" "/tmp/fresh-ide-ctx/$1.json"';

// [label, Fresh action, hint]. Hints are Fresh's default/vscode bindings (confirmed in the
// binary's keymap); Close Tab has no hint because herdr takes Alt+W before Fresh sees it.
const FRESH_GROUPS = [
  [
    ["Go to Definition", "lsp_goto_definition", "F12"],
    ["Go to Implementation", "lsp_implementation", "Ctrl+F12"],
    ["Find References", "lsp_references", "Shift+F12"],
  ],
  [
    ["Rename Symbol", "lsp_rename", "F2"],
    ["Code Actions", "lsp_code_actions", "Alt+."],
    ["Show Hover", "lsp_hover", "Alt+K"],
  ],
  [
    ["Cut", "cut", "Ctrl+X"],
    ["Copy", "copy", "Ctrl+C"],
    ["Paste", "paste", "Ctrl+V"],
    ["Select All", "select_all", "Ctrl+A"],
    ["Toggle Comment", "toggle_comment", "Ctrl+/"],
  ],
  [
    ["Git: Line History", "git_line_history", "Ctrl+Alt+O"],
    ["Copy as Reference", "selection_copy_reference", "Ctrl+Alt+L"],
    ["Send to Agent", "selection_send_to_agent", "Ctrl+Alt+A"],
  ],
  [["Close Tab", "close_tab", ""]],
];

// The key bound to a herdr command, for the hint on the right (as the built-in menu).
function shortcut(name, args) {
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

function terminalOf(p) {
  return terminals().find((t) => t.address === p?.target?.terminal);
}

// A Fresh pane: its foreground program is fresh (argv[0] basename as a fallback).
function isFresh(term) {
  if (!term) return false;
  if (term.foreground?.name) return term.foreground.name === "fresh";
  return String(term.foreground?.argv?.[0] ?? "").split("/").pop() === "fresh";
}

// The daemon name: the argument after -a in the Fresh argv, else "default".
function daemonKey(term) {
  const argv = term?.foreground?.argv ?? [];
  const i = argv.indexOf("-a");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "default";
}

// "wsl/t3" -> "wsl" (exec on that machine); a bare address like "t4" is local (null).
function machineOf(address) {
  const s = String(address ?? "");
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i) : null;
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Fire-and-forget: a failed write only means the Fresh action is not run.
function writeRequest(term, phase, id, action) {
  const req = { id, phase, ...(action ? { action } : {}), ts: Date.now() };
  try {
    return exec("bash", ["-c", CTX_SCRIPT, "fresh-ctx", daemonKey(term), JSON.stringify(req)], { on: machineOf(term.address) }).catch(() => null);
  } catch {
    return null;
  }
}

// Rows: { label, hint, fresh? (Fresh action), cmd? ([herdr command, args]), sep? }.
function buildRows(p) {
  const tg = p?.target ?? {};
  const all = terminals();
  const term = all.find((t) => t.address === tg.terminal);
  // A terminal shown outside a tab (a layout terminal block, a window) has no pane
  // to split, zoom or close: its pane is the block's id.
  const inTab = panes().some((pane) => pane.pane === tg.pane);
  const row = (label, cmd) => ({ label, cmd, hint: shortcut(cmd[0], cmd[1]) });
  const splitRows = inTab
    ? [
        row("Split right", ["pane.split", { direction: "right", pane: tg.pane }]),
        row("Split down", ["pane.split", { direction: "down", pane: tg.pane }]),
        row("Zoom", ["pane.zoom", { pane: tg.pane }]),
      ]
    : [];

  if (isFresh(term)) {
    const rows = [];
    FRESH_GROUPS.forEach((group, gi) => {
      if (gi > 0) rows.push({ sep: true });
      for (const [label, action, hint] of group) rows.push({ label, hint, fresh: action });
    });
    const herdr = [...splitRows, ...(inTab ? [row("Close pane", ["pane.close", { pane: tg.pane }])] : [])];
    if (herdr.length) rows.push({ sep: true }, ...herdr);
    return rows;
  }

  // Any other terminal: the built-in "pane" items, same labels, commands and order.
  const parent = term?.parent && all.find((t) => t.address === term.parent);
  // Once they go to the program, Shift+right-click still opens this menu.
  const toProgram = term?.labels?.["herdr.right-click"] === "program";
  return [
    ...splitRows,
    ...(term
      ? [
          toProgram
            ? row("Use Herdr right-click menu", ["terminal.right_click", { terminal: term.address, to: "menu" }])
            : row("Send right-clicks to pane", ["terminal.right_click", { terminal: term.address, to: "program" }]),
        ]
      : []),
    ...(parent ? [row(`Send back to ${parent.name || parent.address}`, ["terminal.park", { terminal: term.address }])] : []),
    ...(inTab ? [row("Close pane", ["pane.close", { pane: tg.pane }])] : []),
  ];
}

export default class IdeTermMenu extends View {
  init(_p, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.id = newId();
    const p = props();
    this.term = terminalOf(p);
    this.fresh = isFresh(this.term);
    // Tell the Fresh plugin where the pointer was, before the list is drawn.
    if (this.fresh) writeRequest(this.term, "open", this.id);
  }

  pick(it) {
    if (!it || it.sep) return;
    const tg = props()?.target ?? {};
    closeOverlay(props()?.overlay);
    if (it.fresh) {
      writeRequest(this.term, "run", this.id, it.fresh);
      run("pane.focus", tg.pane ? { pane: tg.pane } : { terminal: tg.terminal });
    } else {
      run(it.cmd[0], it.cmd[1]);
    }
  }

  render(cx) {
    const t = theme();
    const rows = buildRows(props());
    const pickable = rows.filter((r) => !r.sep);
    if (this.at >= pickable.length) this.at = Math.max(0, pickable.length - 1);

    let idx = -1;
    const children = rows.map((r) => {
      if (r.sep) return div().mx(7).my(4).h(1).bg(t.border);
      idx += 1;
      const i = idx;
      const sel = i === this.at;
      return h_flex()
        .id(`itm-${i}`)
        .h(24)
        .px(8)
        .gap(8)
        .rounded(5)
        .items_center()
        .justify_between()
        .cursor_pointer()
        .text_color(t.foreground)
        .when(sel, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.pick(r))
        .child(div().flex_1().text_size(12.5).child(r.label))
        .when(Boolean(r.hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(r.hint)));
    });

    return v_flex()
      .id("ide-term-menu")
      .track_focus(this.handle)
      .w_full()
      .bg(t.popover)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props()?.overlay);
        if (e.key === "down" && pickable.length) {
          this.at = (this.at + 1) % pickable.length;
        } else if (e.key === "up" && pickable.length) {
          this.at = (this.at + pickable.length - 1) % pickable.length;
        } else if (e.key === "enter" && pickable[this.at]) {
          this.pick(pickable[this.at]);
        } else {
          return;
        }
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        div()
          .relative()
          .h(MENU_H)
          .w_full()
          .child(div().absolute().inset_0().overflow_y_scroll().p(5).child(v_flex().w_full().children(children))),
      );
  }
}
