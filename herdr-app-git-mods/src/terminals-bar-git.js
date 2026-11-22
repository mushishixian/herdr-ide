// Terminals-Git layout's draggable top bar: space picker, tabs, git branch/actions, IDE sidebar toggle, and window controls.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, theme, home, openOverlay, window as win, shared, setShared } from "herdr";

// Chrome lengths go through S(): uiScale (ide-settings.json) multiplies every
// px value, so a 2K machine sets uiScale ~1.33 while 1080p keeps the default 1.
const uiScale = () => {
  const s = shared("ide.settings")?.uiScale;
  return typeof s === "number" && s >= 0.5 && s <= 3 ? s : 1;
};
const S = (px) => Math.round(px * uiScale() * 100) / 100;

// Top-bar palette derived from the theme so it follows light/dark appearance.
let C = null;
function refreshColors(t) {
  C = {
    tray: t.chrome,
    tab: t.selected,
    tabEdge: t.border,
    hover: t.hover,
    edge: t.raised,
    chip: t.raised,
    text: t.foreground,
    dim: t.muted,
  };
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function lead(all, id) {
  const mine = all.filter((p) => p.tab === id);
  return mine.find((p) => p.focused) ?? mine.find((p) => p.program?.agent) ?? mine[0];
}

function tile(t, p) {
  const g = p?.program;
  const dot = p?.status && p.status !== "idle" ? t[p.status] : null;
  return div()
    .relative()
    .flex_none()
    .w(S(24))
    .h(S(24))
    .rounded(S(8))
    .flex()
    .items_center()
    .justify_center()
    .bg(g?.tile ?? "#5a6370")
    .when(Boolean(g?.icon && g.tint), (el) => el.child(svg(g.icon).size(S(14)).text_color("#ffffff")))
    .when(Boolean(g?.icon && !g.tint), (el) => el.child(image(g.icon).w(S(14)).h(S(14))))
    .when(!g?.icon, (el) => el.text_size(S(12)).font_semibold().text_color("#ffffff").child(g?.glyph ?? ">"))
    .when(Boolean(dot), (el) =>
      el.child(div().absolute().top(-1).right(-1).w(S(7)).h(S(7)).rounded_full().bg(dot).border_1().border_color(C.tray)),
    );
}

function own(el) {
  return el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_down("right", (_e, cx) => cx.stop_propagation());
}

function windowButton(id, icon, command) {
  return own(
    div()
      .id(id)
      .flex_none()
      .w(S(24))
      .h(S(24))
      .rounded_full()
      .flex()
      .items_center()
      .justify_center()
      .bg(C.chip)
      .text_color(C.dim)
      .cursor_pointer()
      .hover((s) => s.bg(C.edge).text_color(C.text))
      .on_click(() => run(command))
      .child(svg(`mods/terminals-bar-git/${icon}.svg`).size(S(14))),
  );
}

function iconButton(id, icon, tip, onClick) {
  return own(div())
    .id(id)
    .flex_none()
    .p(S(7))
    .rounded(S(8))
    .text_color(C.dim)
    .cursor_pointer()
    .tooltip(tip)
    .hover((s) => s.bg(C.chip).text_color(C.text))
    .on_click(onClick)
    .child(svg(`mods/terminals-bar-git/${icon}.svg`).size(S(16)));
}

function pillBtn(id, label, tip, onClick) {
  return own(div())
    .id(id)
    .flex_none()
    .h(S(26))
    .px(S(8))
    .flex()
    .items_center()
    .rounded(S(7))
    .bg(C.chip)
    .text_size(S(11.5))
    .text_color(C.dim)
    .cursor_pointer()
    .tooltip(tip)
    .hover((s) => s.bg(C.edge).text_color(C.text))
    .on_click(onClick)
    .child(label);
}

export default class TerminalsBarGit extends View {
  init(_p, cx) {
    this.lastSyncSig = "";
    cx.timer.every(250, (cx2) => {
      const space = spaces().find((p) => p.active);
      if (!space) return;
      const curBranch = shared("ide.branchBySpace")?.[space.id] || space.branch || "";
      const sync = shared("ide.gitSyncBySpace")?.[space.id] ?? { ahead: 0, behind: 0 };
      const dirtySeq = shared("ide.git.dirtySeq") ?? 0;
      const sig = `${space.id}|${curBranch}|${sync.ahead}|${sync.behind}|${dirtySeq}`;
      if (sig !== this.lastSyncSig) {
        this.lastSyncSig = sig;
        cx2.notify();
      }
    });
  }

  render() {
    const t = theme();
    refreshColors(t);
    const space = spaces().find((p) => p.active);
    if (!space) return div();
    const curBranch = shared("ide.branchBySpace")?.[space.id] || space.branch || null;
    const sync = shared("ide.gitSyncBySpace")?.[space.id] ?? { ahead: 0, behind: 0 };
    const firstTab = space.tabs?.[0];
    if (firstTab && curBranch) {
      const autoMap = { ...(shared("ide.tabAutoBranch") ?? {}) };
      const prevAuto = autoMap[firstTab.id];
      if ((firstTab.name === "1" || (prevAuto && firstTab.name === prevAuto)) && firstTab.name !== curBranch) {
        autoMap[firstTab.id] = curBranch;
        setShared("ide.tabAutoBranch", autoMap);
        run("tab.rename", { id: firstTab.id, name: curBranch });
      }
    }
    const all = panes();
    const w = win() ?? {};

    const tab = (c) => {
      const p = lead(all, c.id);
      const where = folder(p?.cwd);
      return own(h_flex())
        .id(`tm-${c.id}`)
        .flex_shrink(1)
        .w(S(240))
        .min_w(0)
        .h_full()
        .pl(S(5))
        .pr(S(12))
        .gap(S(9))
        .items_center()
        .rounded(S(13))
        .border_1()
        .cursor_pointer()
        .text_size(S(13))
        .when(c.active, (el) => el.bg(C.tab).border_color(C.tabEdge))
        .when(!c.active, (el) => el.border_color("#00000000").hover((s) => s.bg(C.hover)))
        .on_click(() => run("tab.select", { id: c.id }))
        .on_mouse_down("right", () =>
          openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }),
        )
        .child(tile(t, p))
        .child(
          h_flex()
            .min_w(0)
            .gap(S(6))
            .truncate()
            .child(div().flex_none().text_color(c.active ? C.text : C.dim).child(c.name))
            .when(Boolean(where), (el) => el.child(div().truncate().text_color(C.dim).child(where))),
        );
    };

    return h_flex()
      .id("terminals-bar-git")
      .on_size_change((sz) => {
        const prev = shared("ide.winSize");
        if (!prev || prev.width !== sz.width) {
          setShared("ide.winSize", { width: sz.width, height: prev?.height ?? 0 });
        }
      })
      .size_full()
      .gap(S(6))
      .items_center()
      .when(w.platform === "macos" && w.titlebar === "none" && !w.fullscreen, (el) => el.pl(S(72)))
      .child(
        own(h_flex())
          .id("tm-space")
          .flex_none()
          .h(S(30))
          .pl(S(10))
          .pr(S(12))
          .gap(S(8))
          .items_center()
          .rounded_full()
          .bg(C.chip)
          .cursor_pointer()
          .text_size(S(13))
          .text_color(C.dim)
          .hover((s) => s.text_color(C.text))
          .on_click(() => openOverlay({ mod: "picker", kind: "popup", at: "top", offset: 40, width: 640, height: 0.8 }))
          .child(svg("mods/terminals-bar-git/stack.svg").size(S(15)))
          .child(div().max_w(S(140)).truncate().text_color(C.text).child(space.name)),
      )
      .child(
        h_flex()
          .flex_shrink(1)
          .min_w(0)
          .h(S(36))
          .p(S(3))
          .gap(S(3))
          .rounded(S(16))
          .bg(C.tray)
          .children(space.tabs.map(tab)),
      )
      .child(div().flex_1())
      .when(Boolean(curBranch), (el) =>
        el
          .child(
            own(h_flex())
              .id("tm-git-branch")
              .flex_none()
              .h(S(28))
              .px(S(9))
              .gap(S(5))
              .items_center()
              .rounded_full()
              .bg(C.chip)
              .cursor_pointer()
              .tooltip("Switch branch (Ctrl+Alt+C)")
              .hover((s) => s.bg(C.edge))
              .on_click(() => run("mod.open", { name: "git-branch" }))
              .child(svg("mods/workspace-chrome/branch.svg").size(S(13)).text_color(t.accent))
              .child(div().max_w(S(130)).truncate().text_size(S(12)).text_color(C.text).child(curBranch)),
          )
          .child(pillBtn("tm-git-new", "+", "New branch (Ctrl+Alt+N)", () => run("mod.open", { name: "git-new" })))
          .child(pillBtn("tm-git-merge", "Merge", "Merge branch (Ctrl+Alt+X)", () => run("mod.open", { name: "git-merge" })))
          .when(sync.behind > 0 && sync.ahead > 0, (el2) =>
            el2.child(pillBtn("tm-git-sync", `↓${sync.behind} ↑${sync.ahead}`, `Sync: Pull ${sync.behind} & Push ${sync.ahead}`, () => run("ide-sidebar.sync"))),
          )
          .when(!(sync.behind > 0 && sync.ahead > 0), (el2) =>
            el2
              .child(pillBtn("tm-git-pull", sync.behind > 0 ? `↓${sync.behind}` : "↓", sync.behind > 0 ? `Pull ${sync.behind} incoming commit(s) (Ctrl+Alt+P)` : "Git Pull (Ctrl+Alt+P)", () => run("mod.open", { name: "git-pull" })))
              .child(pillBtn("tm-git-push", sync.ahead > 0 ? `↑${sync.ahead}` : "↑", sync.ahead > 0 ? `Push ${sync.ahead} outgoing commit(s) (Ctrl+Alt+K)` : "Git Push (Ctrl+Alt+K)", () => run("mod.open", { name: "git-push" }))),
          ),
      )
      .child(pillBtn("tm-quick-open", "Files", "Quick Open (Ctrl+Q)", () => run("mod.open", { name: "quick-open" })))
      .child(
        own(div())
          .id("tm-sidebar")
          .flex_none()
          .p(S(6))
          .rounded(S(8))
          .text_color(C.dim)
          .cursor_pointer()
          .tooltip("Toggle IDE Sidebar (Ctrl+Shift+B)")
          .hover((s) => s.bg(C.chip).text_color(C.text))
          .on_click(() => run("layout.toggle", { id: "sidebar" }))
          .child(svg("mods/workspace-chrome/sidebar.svg").size(S(15))),
      )
      .child(iconButton("tm-keys", "command", "Command Palette", () => run("app.palette")))
      .child(iconButton("tm-new", "plus", "New Tab", () => run("tab.new", { space: space.id })))
      .when(Boolean(w.buttons), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .pl(S(6))
            .pr(S(4))
            .gap(S(8))
            .child(windowButton("tm-min", "win-min", "window.minimize"))
            .child(windowButton("tm-max", w.maximized ? "win-restore" : "win-max", "window.maximize"))
            .child(windowButton("tm-close", "win-close", "window.close")),
        ),
      );
  }
}
