import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, home, run, spaces, panes } from "herdr";

function shortCwd(cwd) {
  if (!cwd) return "";
  const h = home();
  const s = cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
  const parts = s.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : s;
}

export default class IdeBottomBar extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const cwd = shortCwd(p.cwd);
    const close = () => {
      const ov = p.overlay ?? shared("ide.bottomTerm.overlay");
      setShared("ide.bottomTerm.overlay", null);
      if (ov) closeOverlay(ov);
      const space = spaces().find((s) => s.active);
      const activeTab = space?.tabs?.find((tb) => tb.active)?.id;
      const edId = activeTab ? shared("ide.editor.paneByTab")?.[activeTab] : null;
      const target = (edId && panes().find((x) => x.pane === edId)) || panes().find((x) => x.tab === activeTab);
      if (target) run("pane.focus", { pane: target.pane });
    };

    return h_flex()
      .id("ide-bottom-bar")
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(div().flex_none().text_size(11).font_semibold().text_color(t.foreground).child(">_ Terminal"))
      .when(Boolean(cwd), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(cwd)))
      .when(!cwd, (el) => el.child(div().flex_1()))
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Alt+F12"))
      .child(
        div()
          .id("ide-bottom-close")
          .px(5)
          .py(1)
          .rounded(4)
          .text_size(12)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(close)
          .child("×"),
      );
  }
}
