// Custom Space context menu (never overwritten by herdr-app updates).
// Opened from spaces-ide on right-click: Close runs space.close with confirmed: true.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec } from "herdr";

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  return [
    ["Rename", "space.rename", { id: tg.id }],
    ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
    ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
    ["Close", "space.close", { id: tg.id, confirmed: true }],
  ];
}

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command === "worktree" ? "git-branch" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

function shortcut(name, args) {
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class IdeSpaceMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = spaces().find((s) => s.id === p?.target?.id);
    const folder = space && place(space);
    if (folder) {
      cx.spawn(async (cx2) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx2.notify();
      });
    }
  }

  choose(i) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") {
      openOverlay({
        mod: "worktree",
        kind: "dialog",
        ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }),
        props: it[2],
      });
    } else {
      run(it[1], it[2]);
    }
  }

  render() {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("ide-space-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && it[1].endsWith(".close"), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(
              h_flex()
                .id(`ism-${i}`)
                .h(31)
                .px(8)
                .gap(9)
                .rounded(7)
                .items_center()
                .justify_between()
                .text_color(t.foreground)
                .when(i === this.at, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click(() => this.choose(i))
                .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
                .child(div().flex_1().child(it[0]))
                .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2]))),
            ),
        ),
      );
  }
}
