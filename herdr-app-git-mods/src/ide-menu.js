import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";

export default class IdeMenu extends View {
  init(_p, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
  }

  pick(item) {
    if (!item || item.sep || item.disabled) return;
    const prev = shared("ide.menu.action")?.seq ?? 0;
    setShared("ide.menu.action", { seq: prev + 1, id: item.id, payload: props()?.payload ?? {} });
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const list = props()?.items ?? [];
    const pickable = list.filter((it) => !it.sep && !it.disabled);
    if (this.at >= pickable.length) this.at = Math.max(0, pickable.length - 1);

    return v_flex()
      .id("ide-context-menu")
      .track_focus(this.handle)
      .w_full()
      .p(6)
      .gap(2)
      .bg(t.popover)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return closeOverlay(props().overlay);
        if (e.key === "down" && pickable.length) {
          this.at = (this.at + 1) % pickable.length;
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "up" && pickable.length) {
          this.at = (this.at + pickable.length - 1) % pickable.length;
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "enter" && pickable[this.at]) {
          this.pick(pickable[this.at]);
          cx.stop_propagation();
        }
      })
      .children(
        list.map((it, idx) => {
          if (it.sep) {
            return div().my(3).h(1).bg(t.border);
          }
          const sel = pickable[this.at] === it;
          return h_flex()
            .id(`ide-ctx-${idx}`)
            .px(10)
            .py(5)
            .gap(10)
            .items_center()
            .rounded(6)
            .when(!it.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
            .when(sel && !it.disabled, (el) => el.bg(t.hover))
            .on_click(() => this.pick(it))
            .child(div().flex_1().text_color(it.disabled ? t.dim : it.danger ? t.ansi1 : t.foreground).child(it.label))
            .when(Boolean(it.hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(it.hint)));
        }),
      );
  }
}
