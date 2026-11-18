// Recent files of the active tab's project (ide.ws.history, recorded by the
// sidebar's openInCenterEditor on every open, any engine). Opened with
// mod.open on ctrl-tab — top-centre, like every editor's switcher. Ctrl-tab
// again cycles the selection via <mod>.<command>; releasing all modifiers
// immediately jumps to the selected file (Enter or click also works).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, props, theme, closeOverlay, checking, shared, setShared, nextCommand } from "herdr";

export default class IdeRecent extends View {
  init(_p, cx) {
    const { files, hasOpenEditor } = this.data();
    this.at = hasOpenEditor && files.length > 1 ? 1 : 0;
    this.scroll = 0;
    this.closed = false;
    this.handle = cx.focus_handle();
    if (checking()) return;
    this.handle.focus();
    cx.timer.after(40, () => { if (!this.closed) this.handle.focus(); });
    cx.timer.after(400, () => { if (!this.closed) this.handle.focus(); });
    setShared("ide.recent.overlay", props()?.overlay ?? null);
    cx.spawn(async (cx2) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "cycle") {
          const curFiles = this.data()?.files ?? [];
          if (curFiles.length) this.at = (this.at + 1) % curFiles.length;
        }
        cx2.notify();
      }
    });
  }

  // Same lookup the sidebar does: the active tab's project root decides which
  // ide.ws.history entry is recent here.
  data() {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active);
    const tabPanes = panes().filter((p) => !tab || p.tab === tab.id);
    const editorPane = tabPanes.find((p) => isEditorPane(p, shared("ide.editor.paneByTab")?.[tab?.id]));
    const root = editorPane?.cwd || space?.folder || "";
    const files = shared("ide.ws.history")?.[wsHistoryKey(space, root)]?.lastFiles ?? [];
    return {
      files,
      root,
      on: space?.machine ?? null,
      title: root.split(/[\\/]/).filter(Boolean).pop() ?? "",
      hasOpenEditor: Boolean(editorPane),
    };
  }

  async close(_cx) {
    if (this.closed) return;
    this.closed = true;
    setShared("ide.recent.overlay", null);
    closeOverlay(props()?.overlay);
  }

  open(i, cx) {
    if (this.closed) return;
    const { files, root, on } = this.data();
    const f = files[i];
    if (!f) return this.close(cx);
    this.closed = true;
    setShared("ide.recent.overlay", null);
    closeOverlay(props()?.overlay);
    openInCenterEditor({ file: f.file, root, on, line: f.line ?? 1, direct: true }, cx);
  }

  render(cx) {
    const t = theme();
    const iconTheme = getIdeSettings().iconTheme;
    const { files, on, title } = this.data();
    this.at = Math.min(this.at, Math.max(0, files.length - 1));

    const H = 32;
    const height = 310;
    const total = files.length * H;
    const fixed = total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    if (files.length > 0) {
      const top = this.at * H;
      if (top < this.scroll) this.scroll = top;
      if (top + H > this.scroll + height) this.scroll = top + H - height;
    }

    const rowEl = (f, i) => {
      if (fixed && (i * H + H <= this.scroll || i * H >= this.scroll + height)) return null;
      const rawPath = String(f.file || "");
      const slash = Math.max(rawPath.lastIndexOf("/"), rawPath.lastIndexOf("\\"));
      const name = slash >= 0 ? rawPath.slice(slash + 1) : rawPath;
      const dir = slash > 0 ? rawPath.slice(0, slash) : "";
      const isSel = i === this.at;
      const base = h_flex()
        .id(`rc-${i}`)
        .px(8)
        .h(H)
        .items_center()
        .gap(8)
        .rounded(6)
        .cursor_pointer()
        .when(isSel, (el) => el.bg(t.selected))
        .when(!isSel, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.open(i, cx))
        .child(renderFileIcon(div, svg, name, false, false, iconTheme, t))
        .child(div().flex_none().max_w(220).truncate().text_size(12.5).text_color(t.foreground).when(isSel, (d) => d.font_semibold()).child(name))
        .when(Boolean(dir), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)))
        .when(!dir, (el) => el.child(div().flex_1()))
        .when((f.line ?? 1) > 1, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(`:${f.line}`)));
      return fixed
        ? base.absolute().left(0).right(0).top(i * H - this.scroll).bottom(height - (i * H + H - this.scroll))
        : base;
    };

    return v_flex()
      .id("ide-recent")
      .track_focus(this.handle)
      .w_full()
      .h(420)
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close(cx);
        if (k === "down") this.at = (this.at + 1) % Math.max(1, files.length);
        else if (k === "up") this.at = (this.at + files.length - 1) % Math.max(1, files.length);
        else if (k === "enter") return this.open(this.at, cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .on_modifiers_changed((e, cx) => {
        const m = e?.modifiers;
        if (!m) return;
        if (!m.control && !m.shift && !m.alt && !m.platform && !m.function) {
          this.open(this.at, cx);
        }
      })
      .on_key_up((e, cx) => {
        const k = (e?.key || "").toLowerCase();
        const m = e?.modifiers;
        if (!m) return;
        const isModKey = k === "control" || k === "shift" || k === "alt" || k === "super" || k === "meta" || k === "platform";
        if (isModKey && !m.control && !m.shift && !m.alt && !m.platform && !m.function) {
          this.open(this.at, cx);
        }
      })
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/files/file.svg").size(14).text_color(t.accent))
          .child(div().font_semibold().text_size(13.5).text_color(t.foreground).child("Recent files"))
          .when(Boolean(title), (el) =>
            el.child(div().max_w(200).truncate().px(6).py(2).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(title)),
          )
          .when(Boolean(on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(on)),
          )
          .child(div().flex_1())
          .child(
            div()
              .id("rc-esc")
              .px(7).py(2).rounded(5).bg(t.raised).text_size(11).text_color(t.muted)
              .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.close(cx))
              .child("Esc"),
          ),
      )
      .child(
        v_flex()
          .w_full()
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .p(4)
          .child(
            v_flex()
              .id("rc-list")
              .relative()
              .w_full()
              .h(height)
              .when(fixed, (el) =>
                el.overflow_hidden().on_scroll_wheel((e, cx) => {
                  this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
                  cx.notify();
                }),
              )
              .children(files.length ? files.map(rowEl).filter(Boolean) : [div().px(10).py(10).text_size(12).text_color(t.dim).child("No recent files yet.")]),
          ),
      )
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .text_size(11)
          .text_color(t.dim)
          .child(div().flex_1().truncate().child("Ctrl+Tab cycle · Release Ctrl to open · ↑↓ select · Esc close"))
          .when(files.length > 0, (el) => el.child(div().flex_none().child(`${files.length} file${files.length === 1 ? "" : "s"}`))),
      );
  }
}
