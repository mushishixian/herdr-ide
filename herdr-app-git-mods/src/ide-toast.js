import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export default class IdeToast extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    const isCommit = /commit/i.test(p.title ?? "");
    const bodyText = p.body ?? "";
    // A long single-line body (git pull/push detail is joined with " · ") wraps
    // inside the narrow toast. Estimate the wrapped line count and give the body
    // a scrollable box of that height so nothing is silently clipped.
    const bodyUnits = [...bodyText].reduce(
      (n, ch) => n + (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1), 0);
    const estLines = Math.max(
      (bodyText.match(/\n/g)?.length ?? 0) + 1,
      Math.ceil(bodyUnits / 50),
    );
    const longBody = !login && Boolean(bodyText) && estLines > 2;
    const boxH = Math.min(5, estLines) * 16;
    return h_flex()
      .id("toast")
      .w_full()
      .px(14)
      .py(4)
      .gap(10)
      .items_start()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(
        p.icon
          ? image(p.icon).w(16).h(16).flex_none()
          : div().size(7).rounded_full().flex_none().bg(t[DOT[p.level] ?? "accent"]),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .overflow_hidden()
          .child(
            div()
              .truncate()
              .font_semibold()
              .text_size(12.5)
              .text_color(t.foreground)
              .child(login ? `${login[1]} needs a login: run` : (p.title ?? "")),
          )
          .when(!login && Boolean(bodyText) && !longBody, (el) =>
            el.child(
              div()
                .text_size(11.5)
                .text_color(isCommit ? t.foreground : t.muted)
                .child(bodyText),
            ),
          )
          .when(longBody, (el) =>
            el.child(
              div()
                .relative()
                .w_full()
                .h(boxH)
                .child(
                  div()
                    .absolute()
                    .inset_0()
                    .overflow_y_scroll()
                    .child(
                      div()
                        .whitespace_normal()
                        .text_size(11.5)
                        .text_color(isCommit ? t.foreground : t.muted)
                        .child(bodyText),
                    ),
                ),
            ),
          )
          .when(Boolean(login), (el) =>
            el.child(
              h_flex()
                .gap(8)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(11.5).text_color(t.muted).child(command))
                .child(
                  div()
                    .id("toast-login-copy")
                    .flex_none()
                    .px(6)
                    .py(2)
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(11)
                    .text_color(t.foreground)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      cx.write_to_clipboard(command);
                      this.copied = true;
                      cx.notify();
                    })
                    .child(this.copied ? "Copied" : "Copy"),
                ),
            ),
          ),
      );
  }
}
