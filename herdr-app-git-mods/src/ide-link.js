import { spaces, panes, exec, run, shared, setShared, window as win } from "herdr";

const LINK_RESOLVE_SH = `
target="$1"
base="$2"
space_root="$3"
editor_cwd="$4"

case "$target" in
  "~/"*) target="$HOME/\${target#~/}" ;;
esac

check_path() {
  cand="$1"
  [ -n "$cand" ] || return 1
  if [ -f "$cand" ]; then
    abs=$(realpath "$cand" 2>/dev/null || printf '%s' "$cand")
    printf 'FILE\n%s\n' "$abs"
    return 0
  fi
  if [ -d "$cand" ]; then
    abs=$(realpath "$cand" 2>/dev/null || printf '%s' "$cand")
    printf 'DIR\n%s\n' "$abs"
    return 0
  fi
  return 1
}

case "$target" in
  /*)
    check_path "$target" && exit 0
    ;;
  *)
    for d in "$base" "$editor_cwd" "$space_root"; do
      [ -n "$d" ] && check_path "$d/$target" && exit 0
    done
    for d in "$base" "$editor_cwd" "$space_root"; do
      if [ -n "$d" ] && [ -d "$d" ]; then
        top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || true)
        [ -n "$top" ] && check_path "$top/$target" && exit 0
      fi
    done
    ;;
esac
printf 'MISS\n'
`;

const LINK_RESOLVE_NODE = `
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const [target, base, spaceRoot, editorCwd] = process.argv.slice(1);
function check(p) {
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    const abs = fs.realpathSync(p);
    if (st.isFile()) return ["FILE", abs];
    if (st.isDirectory()) return ["DIR", abs];
  } catch {}
  return null;
}
if (path.isAbsolute(target)) {
  const r = check(target);
  if (r) { console.log(r[0] + "\\n" + r[1]); process.exit(0); }
} else {
  const dirs = [base, editorCwd, spaceRoot].filter(Boolean);
  for (const d of dirs) {
    const r = check(path.join(d, target));
    if (r) { console.log(r[0] + "\\n" + r[1]); process.exit(0); }
  }
  for (const d of dirs) {
    try {
      const top = execFileSync("git", ["-C", d, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
      const r = check(path.join(top, target));
      if (r) { console.log(r[0] + "\\n" + r[1]); process.exit(0); }
    } catch {}
  }
}
console.log("MISS");
`;

function parseLinkTarget(link) {
  let raw = String(link?.raw ?? "").trim();
  let line = typeof link?.line === "number" && link.line > 0 ? link.line : null;
  if (!raw) return { pathText: "", line };

  if (/^file:\/\//i.test(raw)) {
    const anchor = /#L(\d+)(?:-L?\d+)?$/i.exec(raw);
    if (anchor) {
      if (!line) line = Number(anchor[1]) || null;
      raw = raw.slice(0, anchor.index);
    } else {
      const coord = /:(\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/.exec(raw);
      if (coord) {
        if (!line) line = Number(coord[1]) || null;
        raw = raw.slice(0, coord.index);
      }
    }
    raw = raw.replace(/^file:\/\/wsl\.localhost\/[^/]+/i, "");
    raw = raw.replace(/^file:\/\/localhost/i, "");
    raw = raw.replace(/^file:\/\//i, "");
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    if (/^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1);
    return { pathText: raw, line };
  }

  // Strip coordinate/anchor suffix from plain text links (e.g. foo.ts:42, foo.ts#L10-L20).
  const anchor = /#L(\d+)(?:-L?\d+)?$/i.exec(raw);
  if (anchor) {
    if (!line) line = Number(anchor[1]) || null;
    raw = raw.slice(0, anchor.index);
  } else {
    const coord = /:(\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/.exec(raw);
    if (coord) {
      if (!line) line = Number(coord[1]) || null;
      raw = raw.slice(0, coord.index);
    }
  }
  return { pathText: raw, line };
}

export async function handleLink(click) {
  const link = click?.link;
  const source = click?.source ?? {};
  if (!link || link.kind !== "file") return "pass";

  const { pathText, line } = parseLinkTarget(link);
  const candidate = link.path || pathText;
  if (!candidate) return "pass";

  const on = source.machine ?? null;
  const allSpaces = spaces();
  const srcSpace = (source.space && allSpaces.find((s) => s.id === source.space)) || allSpaces.find((s) => s.active) || null;
  const srcTabId = source.tab || srcSpace?.tabs?.find((t) => t.active)?.id || null;
  const allPanes = panes();
  const tabPanes = srcTabId ? allPanes.filter((p) => p.tab === srcTabId) : [];
  const trackedId = srcTabId ? shared("ide.editor.paneByTab")?.[srcTabId] : null;
  const editorPane = tabPanes.find((p) => isEditorPane(p, trackedId)) ?? null;

  const baseDir = source.cwd || "";
  const editorCwd = editorPane?.cwd || "";
  const spaceRoot = srcSpace?.folder || tabPanes.find((p) => p.cwd)?.cwd || "";

  let kind = null;
  let abs = null;

  if (link.path && !on && win()?.platform === "windows") {
    kind = "FILE";
    abs = link.path;
  } else if (on !== null || win()?.platform !== "windows") {
    const r = await exec("sh", ["-c", LINK_RESOLVE_SH, "link", candidate, baseDir, spaceRoot, editorCwd], {
      cwd: baseDir || spaceRoot || undefined,
      on,
      timeout: 4000,
    }).catch(() => null);
    const lines = (r?.stdout || "").trim().split("\n");
    if (lines[0] === "FILE" || lines[0] === "DIR") {
      kind = lines[0];
      abs = lines[1] || candidate;
    }
  } else {
    const r = await exec("node", ["-e", LINK_RESOLVE_NODE, candidate, baseDir, spaceRoot, editorCwd], {
      cwd: baseDir || spaceRoot || undefined,
      on: null,
      timeout: 4000,
    }).catch(() => null);
    const lines = (r?.stdout || "").trim().split(/\r?\n/);
    if (lines[0] === "FILE" || lines[0] === "DIR") {
      kind = lines[0];
      abs = lines[1] || candidate;
    }
  }

  if (!kind || !abs) return "pass";

  if (srcSpace && !srcSpace.active) run("space.select", { id: srcSpace.id });
  if (srcTabId && !srcSpace?.tabs?.find((t) => t.id === srcTabId)?.active) run("tab.select", { id: srcTabId });

  const norm = (s) => String(s || "").replace(/[\\/]+$/, "");
  const rootCand = [editorCwd, spaceRoot, baseDir].map(norm).find((r) => r && (abs === r || abs.startsWith(r + "/") || abs.startsWith(r + "\\")));
  const sep = !on && win()?.platform === "windows" ? "\\" : "/";
  const idxLast = abs.lastIndexOf(sep);
  const parentDir = idxLast > 0 ? abs.slice(0, idxLast) : abs;
  const root = rootCand || norm(editorCwd || spaceRoot || baseDir || parentDir);
  const file = rootCand && abs.startsWith(rootCand + sep) ? abs.slice(rootCand.length + 1) : abs;

  if (kind === "DIR") {
    setShared("ide.explorer.reveal", {
      file: abs,
      root,
      on,
      seq: (shared("ide.explorer.reveal")?.seq ?? 0) + 1,
    });
    return "handled";
  }

  openInCenterEditor({ file, root, on, line: line ?? 1, direct: false });
  return "handled";
}
