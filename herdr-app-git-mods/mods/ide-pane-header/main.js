// Pane header with a per-agent icon: herdr's program icon when it knows the program,
// else the pane's app id, else a foreground probe (an agent typed inside a shell).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, home, hc, theme } from "herdr";

// name/argv token -> icon; brand icons are colored files (image), agent.svg is a
// one-color glyph drawn with the theme text color.
const AGENTS = [
  [/claude/, "icons/claude.svg", false],
  [/codex/, "icons/codex.svg", false],
  [/gemini/, "icons/gemini.svg", false],
  [/opencode/, "icons/opencode.svg", false],
  [/oh-my-pi|\bomp\b/, "icons/omp.svg", false],
  [/\bpi\b|pi-coding/, "icons/pi.svg", false],
  [/command[- ]?code|cmdc/, "icons/command-code.svg", false],
  [/goose/, "icons/goose.svg", false],
  [/dsh/, "icons/dsh-tui.svg", false],
  [/aider/, "icons/agent.svg", true],
  [/codebuddy|\bcbc\b/, "icons/agent.svg", true],
];

function iconFor(...names) {
  for (const name of names) {
    const n = String(name || "").toLowerCase();
    if (!n) continue;
    for (const [re, icon, tint] of AGENTS) if (re.test(n)) return { icon, tint };
  }
  return null;
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// terminal -> { at, name }: agents started inside a shell report no app, so ask hc
// for the foreground argv every few seconds (only for shell panes).
const probed = new Map();
const PROBE_MS = 3000;

export default class IdePaneHeader extends View {
  init(_p, cx) {
    cx.timer.every(PROBE_MS, (cx2) => this.probe(cx2));
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  probe(cx) {
    const p = this.me();
    if (!p?.terminal || p.app) return;
    if (p.program && (p.program.agent || !p.program.shell)) return;
    const t = p.terminal;
    const prev = probed.get(t);
    if (prev && Date.now() - prev.at < PROBE_MS - 200) return;
    probed.set(t, { ...(prev ?? {}), at: Date.now() });
    cx.spawn(async (cx2) => {
      const r = await hc(["get", t]).catch(() => null);
      if (!r || r.code !== 0) return;
      let info = null;
      try { info = JSON.parse(r.stdout); } catch {
        return;
      }
      const name = [info?.foreground?.argv?.join(" "), info?.agent, info?.title]
        .filter(Boolean)
        .join(" ");
      const hit = iconFor(name);
      const had = probed.get(t)?.name ?? null;
      const next = hit ? (hit.icon === "icons/agent.svg" ? "codebuddy" : name) : null;
      if (next !== had) {
        probed.set(t, { at: Date.now(), name: next });
        cx2.notify();
      }
    });
  }

  button(id, icon, command, args) {
    const t = theme();
    return div()
      .id(id)
      .p(4)
      .rounded(5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(15));
  }

  render() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const pane = p.pane;
    const g = p.program;
    const where = folder(p.cwd);
    const title = p.title || "shell";
    const dir = where && !title.includes(where) && !/^[~/]/.test(title) ? where : "";
    const hit = iconFor(p.app, g?.key, g?.name, probed.get(p.terminal)?.name);
    const icon = hit?.icon ?? g?.icon ?? null;
    const tint = hit ? hit.tint : Boolean(g?.tint);
    return h_flex()
      .id(`tm-head-${pane}`)
      .size_full()
      .pl(12)
      .pr(8)
      .gap(8)
      .items_center()
      .text_size(14)
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(icon), (el) =>
        el.child(
          tint
            ? svg(icon).size(16).flex_none().text_color(p.focused ? t.foreground : t.dim)
            : image(icon).w(16).h(16).flex_none(),
        ),
      )
      .child(div().flex_none().max_w(320).truncate().font_semibold().text_color(p.focused ? t.foreground : t.muted).child(title))
      .child(div().flex_1().truncate().text_color(t.dim).child(dir))
      .child(this.button(`th-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
      .child(this.button(`th-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
      .child(this.button(`th-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
      .child(this.button(`th-x-${pane}`, "close", "pane.close", { pane }));
  }
}
