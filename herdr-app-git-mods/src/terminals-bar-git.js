// Terminals-Git layout's draggable top bar: space picker, tabs, git branch/actions, IDE sidebar toggle, and window controls.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, theme, home, openOverlay, window as win, shared, setShared } from "herdr";

const C = {
  tray: "#1d1f22",
  tab: "#34373c",
  tabEdge: "#4a4d53",
  hover: "#ffffff07",
  edge: "#383b40",
  chip: "#252628",
  text: "#e8e9eb",
  dim: "#8b8f95",
};

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
    .w(24)
    .h(24)
    .rounded(8)
    .flex()
    .items_center()
    .justify_center()
    .bg(g?.tile ?? "#5a6370")
    .when(Boolean(g?.icon && g.tint), (el) => el.child(svg(g.icon).size(14).text_color("#ffffff")))
    .when(Boolean(g?.icon && !g.tint), (el) => el.child(image(g.icon).w(14).h(14)))
    .when(!g?.icon, (el) => el.text_size(12).font_semibold().text_color("#ffffff").child(g?.glyph ?? ">"))
    .when(Boolean(dot), (el) =>
      el.child(div().absolute().top(-1).right(-1).w(7).h(7).rounded_full().bg(dot).border_1().border_color(C.tray)),
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
      .w(24)
      .h(24)
      .rounded_full()
      .flex()
      .items_center()
      .justify_center()
      .bg(C.chip)
      .text_color(C.dim)
      .cursor_pointer()
      .hover((s) => s.bg(C.edge).text_color(C.text))
      .on_click(() => run(command))
      .child(svg(`mods/terminals-bar-git/${icon}.svg`).size(14)),
  );
}

function iconButton(id, icon, tip, onClick) {
  return own(div())
    .id(id)
    .flex_none()
    .p(7)
    .rounded(8)
    .text_color(C.dim)
    .cursor_pointer()
    .tooltip(tip)
    .hover((s) => s.bg(C.chip).text_color(C.text))
    .on_click(onClick)
    .child(svg(`mods/terminals-bar-git/${icon}.svg`).size(16));
}

function pillBtn(id, label, tip, onClick) {
  return own(div())
    .id(id)
    .flex_none()
    .h(26)
    .px(8)
    .flex()
    .items_center()
    .rounded(7)
    .bg(C.chip)
    .text_size(11.5)
    .text_color(C.dim)
    .cursor_pointer()
    .tooltip(tip)
    .hover((s) => s.bg(C.edge).text_color(C.text))
    .on_click(onClick)
    .child(label);
}

export default class TerminalsBarGit extends View {
  render() {
    const t = theme();
    const space = spaces().find((p) => p.active);
    if (!space) return div();
    const curBranch = space.branch || shared("ide.branchBySpace")?.[space.id] || null;
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
        .w(240)
        .min_w(0)
        .h_full()
        .pl(5)
        .pr(12)
        .gap(9)
        .items_center()
        .rounded(13)
        .border_1()
        .cursor_pointer()
        .text_size(13)
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
            .gap(6)
            .truncate()
            .child(div().flex_none().text_color(c.active ? C.text : "#c4c6ca").child(c.name))
            .when(Boolean(where), (el) => el.child(div().truncate().text_color(C.dim).child(where))),
        );
    };

    return h_flex()
      .size_full()
      .gap(6)
      .items_center()
      .when(w.platform === "macos" && w.titlebar === "none" && !w.fullscreen, (el) => el.pl(72))
      .child(
        own(h_flex())
          .id("tm-space")
          .flex_none()
          .h(30)
          .pl(10)
          .pr(12)
          .gap(8)
          .items_center()
          .rounded_full()
          .bg(C.chip)
          .cursor_pointer()
          .text_size(13)
          .text_color(C.dim)
          .hover((s) => s.text_color(C.text))
          .on_click(() => openOverlay({ mod: "picker", kind: "popup", at: "top", offset: 40, width: 640, height: 0.8 }))
          .child(svg("mods/terminals-bar-git/stack.svg").size(15))
          .child(div().max_w(140).truncate().text_color(C.text).child(space.name)),
      )
      .child(
        h_flex()
          .flex_shrink(1)
          .min_w(0)
          .h(36)
          .p(3)
          .gap(3)
          .rounded(16)
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
              .h(28)
              .px(9)
              .gap(5)
              .items_center()
              .rounded_full()
              .bg(C.chip)
              .cursor_pointer()
              .tooltip("Switch branch (Ctrl+Alt+C)")
              .hover((s) => s.bg(C.edge))
              .on_click(() => run("mod.open", { name: "git-branch" }))
              .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.accent))
              .child(div().max_w(130).truncate().text_size(12).text_color(C.text).child(curBranch)),
          )
          .child(pillBtn("tm-git-new", "+", "New branch (Ctrl+Alt+N)", () => run("mod.open", { name: "git-new" })))
          .child(pillBtn("tm-git-merge", "Merge", "Merge branch (Ctrl+Alt+X)", () => run("mod.open", { name: "git-merge" })))
          .child(pillBtn("tm-git-pull", sync.behind > 0 ? `↓${sync.behind}` : "↓", sync.behind > 0 ? `Pull ${sync.behind} incoming commit(s) (Ctrl+Alt+P)` : "Git Pull (Ctrl+Alt+P)", () => run("mod.open", { name: "git-pull" })))
          .child(pillBtn("tm-git-push", sync.ahead > 0 ? `↑${sync.ahead}` : "↑", sync.ahead > 0 ? `Push ${sync.ahead} outgoing commit(s) (Ctrl+Alt+K)` : "Git Push (Ctrl+Alt+K)", () => run("mod.open", { name: "git-push" }))),
      )
      .child(pillBtn("tm-quick-open", "Files", "Quick Open (Ctrl+Q)", () => run("mod.open", { name: "quick-open" })))
      .child(
        own(div())
          .id("tm-sidebar")
          .flex_none()
          .p(6)
          .rounded(8)
          .text_color(C.dim)
          .cursor_pointer()
          .tooltip("Toggle IDE Sidebar (Ctrl+Shift+B)")
          .hover((s) => s.bg(C.chip).text_color(C.text))
          .on_click(() => run("layout.toggle", { id: "sidebar" }))
          .child(svg("mods/workspace-chrome/sidebar.svg").size(15)),
      )
      .child(iconButton("tm-keys", "command", "Command Palette", () => run("app.palette")))
      .child(iconButton("tm-new", "plus", "New Tab", () => run("tab.new", { space: space.id })))
      .when(Boolean(w.buttons), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .pl(6)
            .pr(4)
            .gap(8)
            .child(windowButton("tm-min", "win-min", "window.minimize"))
            .child(windowButton("tm-max", w.maximized ? "win-restore" : "win-max", "window.maximize"))
            .child(windowButton("tm-close", "win-close", "window.close")),
        ),
      );
  }
}
