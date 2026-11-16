import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, openOverlay } from "herdr";

export default class GitStatus extends View {
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  openGit(mode) {
    openOverlay({
      mod: "git-branch",
      kind: "popup",
      at: "top",
      offset: 40,
      width: 540,
      height: mode === "rename" || mode === "new" ? 0.45 : 0.72,
      props: { mode },
    });
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const actionBtn = (id, text, tip, mode) =>
      div()
        .id(id)
        .px(6)
        .py(2)
        .rounded(4)
        .text_size(11)
        .text_color(t.dim)
        .cursor_pointer()
        .tooltip(tip)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.openGit(mode))
        .child(text);

    return h_flex()
      .size_full()
      .px(14)
      .gap(12)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) =>
        el
          .child(
            h_flex()
              .id("git-status-branch")
              .px(6)
              .py(2)
              .rounded(5)
              .gap(5)
              .items_center()
              .text_color(t.foreground)
              .cursor_pointer()
              .tooltip("Switch branch (Ctrl+Alt+C)")
              .hover((s) => s.bg(t.hover))
              .on_click(() => this.openGit("switch"))
              .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.accent))
              .child(space.branch),
          )
          .child(
            h_flex()
              .gap(2)
              .items_center()
              .child(actionBtn("git-status-new", "+", "New branch (Ctrl+Alt+N)", "new"))
              .child(actionBtn("git-status-merge", "Merge", "Merge branch (Ctrl+Alt+X)", "merge"))
              .child(actionBtn("git-status-rename", "Rename", "Rename branch (Ctrl+Alt+R)", "rename")),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))),
      )
      .child(div().flex_1())
      .child(
        div()
          .id("palette")
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(this.hint()),
      );
  }
}
