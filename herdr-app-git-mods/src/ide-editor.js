import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Scrollbar, v_virtual_list } from "gpui-base";
import { mkdir, writeFile, unlink } from "fs/promises";
import { Buffer } from "buffer";
import {
  exec, readTextFile, writeTextFile, theme, settings, props,
  shared, setShared, notify, checking, window as win, run, closeOverlay, appHome,
} from "herdr";

const IMG_LOAD_PY = `
import base64, json, os, re, shutil, struct, sys

p = sys.argv[1]
dst_win = sys.argv[2] if len(sys.argv) > 2 else ""
if not os.path.isfile(p):
    sys.exit(2)
sz = os.path.getsize(p)

dst_wsl = None
if dst_win and len(dst_win) >= 3 and dst_win[1] == ":" and dst_win[2] in ("\\\\", "/"):
    cand = "/mnt/" + dst_win[0].lower() + "/" + dst_win[3:].replace("\\\\", "/")
    if os.path.isdir("/mnt/" + dst_win[0].lower()):
        dst_wsl = cand

if not dst_wsl and sz > 5 * 1024 * 1024:
    print(json.dumps({"tooLarge": True, "size": sz, "limit": "5 MB"}))
    sys.exit(0)
if dst_wsl and sz > 50 * 1024 * 1024:
    print(json.dumps({"tooLarge": True, "size": sz, "limit": "50 MB"}))
    sys.exit(0)

with open(p, "rb") as f:
    head = f.read(65536)

w = h = 0
ext = os.path.splitext(p)[1].lower().lstrip(".")
try:
    if head[:8] == b"\\x89PNG\\r\\n\\x1a\\n" and len(head) >= 24:
        w, h = struct.unpack(">II", head[16:24])
    elif head[:6] in (b"GIF87a", b"GIF89a") and len(head) >= 10:
        w, h = struct.unpack("<HH", head[6:10])
    elif head[:2] == b"BM" and len(head) >= 26:
        w, h = struct.unpack("<ii", head[18:26])
        h = abs(h)
    elif head[:4] == b"RIFF" and head[8:12] == b"WEBP" and len(head) >= 30:
        chunk = head[12:16]
        if chunk == b"VP8 " and len(head) >= 30:
            w, h = struct.unpack("<HH", head[26:30])
            w &= 0x3FFF; h &= 0x3FFF
        elif chunk == b"VP8L" and len(head) >= 25:
            b0, b1, b2, b3 = head[21:25]
            w = 1 + (b0 | ((b1 & 0x3F) << 8))
            h = 1 + (((b1 & 0xC0) >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10))
        elif chunk == b"VP8X" and len(head) >= 30:
            w = 1 + int.from_bytes(head[24:27], "little")
            h = 1 + int.from_bytes(head[27:30], "little")
    elif head[:2] == b"\\xff\\xd8":
        with open(p, "rb") as jf:
            jdata = jf.read(min(sz, 524288))
        i = 2
        while i + 9 < len(jdata):
            if jdata[i] != 0xFF:
                i += 1; continue
            m = jdata[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", jdata[i + 5:i + 9])
                break
            if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
                i += 2; continue
            ln = struct.unpack(">H", jdata[i + 2:i + 4])[0]
            i += 2 + max(2, ln)
    elif head[:4] == b"\\x00\\x00\\x01\\x00" and len(head) >= 8:
        w = head[6] or 256
        h = head[7] or 256
    elif ext == "svg":
        txt = head[:16384].decode("utf-8", errors="ignore")
        mv = re.search(r'viewBox=["\\\']\\s*[0-9.eE+-]+\\s+[0-9.eE+-]+\\s+([0-9.eE+-]+)\\s+([0-9.eE+-]+)', txt, re.I)
        mw = re.search(r'<svg[^>]*\\bwidth=["\\\']([0-9.]+)(?:px)?["\\\']', txt, re.I)
        mh = re.search(r'<svg[^>]*\\bheight=["\\\']([0-9.]+)(?:px)?["\\\']', txt, re.I)
        if mw and mh:
            w, h = int(float(mw.group(1))), int(float(mh.group(1)))
        elif mv:
            w, h = int(float(mv.group(1))), int(float(mv.group(2)))
except Exception:
    pass

if dst_wsl:
    os.makedirs(os.path.dirname(dst_wsl), exist_ok=True)
    shutil.copy2(p, dst_wsl)
    print(json.dumps({"size": sz, "width": w, "height": h, "direct": True}))
else:
    with open(p, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    print(json.dumps({"size": sz, "width": w, "height": h, "b64": b64}))
`;

const IMG_LOAD_NODE = `
const fs = require("fs");
const path = require("path");
const src = process.argv[1], dst = process.argv[2];
const st = fs.statSync(src);
if (st.size > 25 * 1024 * 1024) { console.log(JSON.stringify({ tooLarge: true, size: st.size })); process.exit(0); }
const data = fs.readFileSync(src);
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, data);
let w = 0, h = 0;
const ext = path.extname(src).toLowerCase().slice(1);
if (data[0]===0x89 && data[1]===0x50 && data.length>=24) { w = data.readUInt32BE(16); h = data.readUInt32BE(20); }
else if (data.slice(0,3).toString()==="GIF" && data.length>=10) { w = data.readUInt16LE(6); h = data.readUInt16LE(8); }
else if (data.slice(0,2).toString()==="BM" && data.length>=26) { w = Math.abs(data.readInt32LE(18)); h = Math.abs(data.readInt32LE(22)); }
else if (data.slice(0,4).toString()==="RIFF" && data.slice(8,12).toString()==="WEBP" && data.length>=30) {
  const ch = data.slice(12,16).toString();
  if (ch==="VP8 ") { w = data.readUInt16LE(26)&0x3fff; h = data.readUInt16LE(28)&0x3fff; }
  else if (ch==="VP8L") { const b0=data[21],b1=data[22],b2=data[23],b3=data[24]; w=1+(b0|((b1&0x3f)<<8)); h=1+(((b1&0xc0)>>6)|(b2<<2)|((b3&0x0f)<<10)); }
  else if (ch==="VP8X") { w=1+(data[24]|(data[25]<<8)|(data[26]<<16)); h=1+(data[27]|(data[28]<<8)|(data[29]<<16)); }
} else if (data[0]===0xff && data[1]===0xd8) {
  let i=2; while (i+9<data.length) { if (data[i]!==0xff){i++;continue;} const m=data[i+1]; if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(m)) { h=data.readUInt16BE(i+5); w=data.readUInt16BE(i+7); break; } if (m===0xd8||m===0xd9||(m>=0xd0&&m<=0xd7)){i+=2;continue;} i+=2+Math.max(2,data.readUInt16BE(i+2)); }
} else if (data[0]===0&&data[1]===0&&data[2]===1&&data[3]===0&&data.length>=8) { w=data[6]||256; h=data[7]||256; }
else if (ext==="svg") {
  const txt = data.slice(0,16384).toString("utf8");
  const mv = /viewBox=["']\\s*[0-9.eE+-]+\\s+[0-9.eE+-]+\\s+([0-9.eE+-]+)\\s+([0-9.eE+-]+)/i.exec(txt);
  const mw = /<svg[^>]*\\bwidth=["']([0-9.]+)(?:px)?["']/i.exec(txt), mh = /<svg[^>]*\\bheight=["']([0-9.]+)(?:px)?["']/i.exec(txt);
  if (mw&&mh) { w=Math.round(+mw[1]); h=Math.round(+mh[1]); } else if (mv) { w=Math.round(+mv[1]); h=Math.round(+mv[2]); }
}
console.log(JSON.stringify({ size: st.size, width: w, height: h }));
`;

function formatBytes(b) {
  if (!b && b !== 0) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

export default class IdeEditor extends View {
  init(p, cx) {
    this.isOverlay = Boolean(p?.overlay || props()?.overlay);
    this.tabs = []; // [{ key, kind: "file"|"diff"|"image", ... }]
    this.activeKey = null;
    this.editing = true;
    this.code = null;
    this.error = null;
    this.loadingDiff = false;
    this.loadingImage = false;
    this.wrapLines = true;
    this.diffBoxW = 0;
    this.imgBoxW = 0;
    this.imgBoxH = 0;
    this.imgSeq = 0;
    this.lastSeq = 0;
    this.handle = cx.focus_handle();

    if (checking()) return;

    if (this.isOverlay) {
      setShared("ide.diff.overlay", p?.overlay ?? props()?.overlay);
      this.handle.focus();
      cx.timer.after(300, () => this.handle.focus());
    }

    const req = shared("ide.editor.open");
    const initReq = req?.root && (req?.file || req?.ref) ? req : p;
    if (req?.seq) this.lastSeq = req.seq;
    if (initReq?.root && (initReq?.file || initReq?.ref)) {
      this.openRequest(initReq, cx);
    }
    cx.timer.every(80, (cx2) => this.pollOpenRequest(cx2));
  }

  async close(_cx) {
    if (!this.isOverlay) return;
    for (const tb of this.tabs) {
      if (tb.imgCacheAbs) unlink(tb.imgCacheAbs).catch(() => {});
    }
    setShared("ide.diff.overlay", null);
    closeOverlay(props()?.overlay);
  }

  pollOpenRequest(cx) {
    const req = shared("ide.editor.open");
    if (req?.seq && req.seq !== this.lastSeq && req.root && (req.file || req.ref)) {
      this.lastSeq = req.seq;
      this.openRequest(req, cx);
    }
  }

  tabKey(req) {
    if (req.kind === "diff") {
      return `diff:${req.on ?? "local"}:${req.root}:${req.ref || (req.untracked ? "Q" : req.staged ? "S" : "U")}:${req.file || ""}`;
    }
    if (req.kind === "image") {
      return `image:${req.on ?? "local"}:${req.root}/${req.file}`;
    }
    return `file:${req.on ?? "local"}:${req.root}/${req.file}`;
  }

  openRequest(req, cx) {
    const kind = req.kind === "diff" ? "diff" : req.kind === "image" ? "image" : "file";
    const key = this.tabKey({ ...req, kind });
    let tab = this.tabs.find((t) => t.key === key);
    if (!tab) {
      tab = {
        key,
        kind,
        title: req.title || (kind === "diff" ? `Diff: ${(req.file || req.ref || "").split("/").pop()}` : (req.file || "").split(/[\\/]/).pop()),
        file: req.file ?? null,
        staged: Boolean(req.staged),
        untracked: Boolean(req.untracked),
        ref: req.ref ?? null,
        isStash: Boolean(req.isStash),
        root: req.root,
        on: req.on ?? null,
        raw: "",
        dirty: false,
        line: req.line ?? 1,
        diffLines: [],
        diffWidth: 400,
        diffStats: { add: 0, del: 0 },
        imgRelPath: null,
        imgCacheAbs: null,
        imgWidth: 0,
        imgHeight: 0,
        imgSize: 0,
        imgZoom: null, // null = Fit to window, else number (1 = 100%)
      };
      this.tabs.push(tab);
    } else if (req.line) {
      tab.line = req.line;
    }
    this.activeKey = key;
    this.error = null;
    this.loadTab(tab, cx);
  }

  loadTab(tab, cx) {
    if (tab.kind === "diff") return this.loadDiffTab(tab, cx);
    if (tab.kind === "image") return this.loadImageTab(tab, cx);
    const sep = !tab.on && win()?.platform === "windows" ? "\\" : "/";
    const abs = `${tab.root}${sep}${tab.file}`;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(abs, { on: tab.on });
        if (this.activeKey !== tab.key) return;
        this.code?.release();
        if (text === null) {
          this.code = null;
          this.error = `File not found: ${tab.file}`;
          cx.notify();
          return;
        }
        if (text.includes("\0")) {
          this.code = null;
          this.error = `Binary file · no text editor (${tab.file})`;
          cx.notify();
          return;
        }
        tab.raw = text;
        tab.dirty = false;
        const t = theme();
        const ext = tab.file.includes(".") ? tab.file.split(".").pop() : "txt";
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: !this.editing,
          value: text.length > 400000 ? text.slice(0, 400000) : text,
          font_family: settings().font_family,
          font_size: 12.5,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
        });
        this.code.on?.("change", () => {
          if (this.code && tab.key === this.activeKey) {
            tab.dirty = this.code.value() !== tab.raw;
          }
        });
        if (tab.line > 1 && this.code.set_cursor) {
          this.code.set_cursor({ line: tab.line - 1, column: 0 });
        }
        this.error = null;
        cx.notify();
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  loadImageTab(tab, cx) {
    this.code?.release();
    this.code = null;
    this.error = null;
    if (tab.imgRelPath) {
      this.loadingImage = false;
      cx.notify();
      return;
    }
    this.reloadImageTab(tab, cx);
  }

  reloadImageTab(tab, cx) {
    this.code?.release();
    this.code = null;
    this.error = null;
    this.loadingImage = true;
    cx.notify();
    const prevCache = tab.imgCacheAbs;
    const seq = ++this.imgSeq;
    const ext = (String(tab.file || "").split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const relDir = "cache/img-preview";
    const relPath = `${relDir}/${shortHash(tab.key)}-${seq}.${ext}`;
    const homeRoot = String(appHome() || "").replace(/[\\/]+$/, "");
    const winSep = win()?.platform === "windows" ? "\\" : "/";
    const cacheDirAbs = `${homeRoot}${winSep}cache${winSep}img-preview`;
    const cacheAbs = `${cacheDirAbs}${winSep}${shortHash(tab.key)}-${seq}.${ext}`;
    const srcSep = !tab.on && win()?.platform === "windows" ? "\\" : "/";
    const isAbs = tab.file?.startsWith("/") || /^[A-Za-z]:[\\/]/.test(tab.file || "");
    const absPath = isAbs ? tab.file : `${String(tab.root || "").replace(/[\\/]+$/, "")}${srcSep}${tab.file}`;

    cx.spawn(async (cx2) => {
      try {
        let meta = null;
        if (tab.on !== null || win()?.platform !== "windows") {
          const r = await exec("python3", ["-c", IMG_LOAD_PY, absPath, cacheAbs], { on: tab.on, timeout: 10000 });
          if (r.code !== 0 || !r.stdout) throw new Error(r.stderr?.trim() || `Cannot read image: ${tab.file}`);
          meta = JSON.parse(r.stdout);
          if (meta.tooLarge) throw new Error(`Image too large (${formatBytes(meta.size)}, limit ${meta.limit || "25 MB"})`);
          if (!meta.direct) {
            await mkdir(cacheDirAbs, { recursive: true });
            await writeFile(cacheAbs, Buffer.from(meta.b64, "base64"));
          }
        } else {
          const r = await exec("node", ["-e", IMG_LOAD_NODE, absPath, cacheAbs], { on: null, timeout: 10000 });
          if (r.code !== 0 || !r.stdout) throw new Error(r.stderr?.trim() || `Cannot read image: ${tab.file}`);
          meta = JSON.parse(r.stdout);
          if (meta.tooLarge) throw new Error(`Image too large (${formatBytes(meta.size)}, limit 25 MB)`);
        }
        if (prevCache && prevCache !== cacheAbs) unlink(prevCache).catch(() => {});
        tab.imgRelPath = relPath;
        tab.imgCacheAbs = cacheAbs;
        tab.imgWidth = Number(meta.width) || 0;
        tab.imgHeight = Number(meta.height) || 0;
        tab.imgSize = Number(meta.size) || 0;
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loadingImage = false;
        cx2.notify();
      }
    });
  }

  loadDiffTab(tab, cx) {
    this.code?.release();
    this.code = null;
    this.error = null;
    if (!tab.diffLines?.length) this.loadingDiff = true;
    cx.notify();
    const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
    cx.spawn(async (cx) => {
      try {
        let rawLines = [];
        if (tab.ref) {
          const args = tab.isStash
            ? ["stash", "show", "-p", "--no-color", tab.ref]
            : ["show", "--no-color", tab.ref];
          const r = await exec("git", [...READ, ...args], { cwd: tab.root, on: tab.on });
          if (r.code !== 0 && r.stderr) throw new Error(r.stderr.trim());
          rawLines = (r.stdout ?? "").split("\n").slice(0, 4000);
        } else if (tab.untracked && tab.file) {
          const sep = !tab.on && win()?.platform === "windows" ? "\\" : "/";
          const text = await readTextFile(`${tab.root}${sep}${tab.file}`, { on: tab.on });
          if (text === null) throw new Error(`File not found: ${tab.file}`);
          if (text.includes("\0")) {
            rawLines = ["Binary file (untracked)"];
          } else {
            const fileLines = text.split("\n");
            rawLines = [`@@ -0,0 +1,${fileLines.length} @@ ${tab.file} (untracked)`];
            for (const l of fileLines.slice(0, 4000)) rawLines.push(`+${l}`);
          }
        } else if (tab.file) {
          const args = tab.staged
            ? ["diff", "--cached", "--no-color", "--", tab.file]
            : ["diff", "--no-color", "--", tab.file];
          const r = await exec("git", [...READ, ...args], { cwd: tab.root, on: tab.on });
          if (r.code !== 0 && r.stderr) throw new Error(r.stderr.trim());
          rawLines = (r.stdout ?? "").split("\n").slice(0, 4000);
          if (!rawLines.some(Boolean)) {
            const altArgs = tab.staged
              ? ["diff", "--no-color", "--", tab.file]
              : ["diff", "--cached", "--no-color", "--", tab.file];
            const r2 = await exec("git", [...READ, ...altArgs], { cwd: tab.root, on: tab.on });
            if ((r2.stdout ?? "").trim()) rawLines = r2.stdout.split("\n").slice(0, 4000);
          }
        }
        if (this.activeKey !== tab.key) return;
        const cleanLines = rawLines.map((l) => l.replace(/\r$/, ""));
        const rows = diffRows(cleanLines);
        let add = 0, del = 0;
        for (const r of rows) {
          if (r.kind === "+") add++;
          else if (r.kind === "-") del++;
        }
        tab.diffLines = rows;
        tab.diffStats = { add, del };
        tab.diffWidth = Math.max(400, ...rows.map((row) => (row.text.length + 1) * 7.5 + 84));
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loadingDiff = false;
        cx.notify();
      }
    });
  }

  closeTab(key, cx) {
    const idx = this.tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    const [removed] = this.tabs.splice(idx, 1);
    if (removed?.imgCacheAbs) unlink(removed.imgCacheAbs).catch(() => {});
    if (this.tabs.length === 0) {
      this.code?.release();
      this.code = null;
      this.activeKey = null;
      if (this.isOverlay) this.close(cx);
      else run("pane.close");
      return;
    }
    if (this.activeKey === key) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeKey = next.key;
      this.loadTab(next, cx);
    } else {
      cx.notify();
    }
  }

  saveActive(cx) {
    const tab = this.tabs.find((t) => t.key === this.activeKey);
    if (!tab || !this.code || !this.editing) return;
    const next = this.code.value();
    const sep = !tab.on && win()?.platform === "windows" ? "\\" : "/";
    const abs = `${tab.root}${sep}${tab.file}`;
    cx.spawn(async (cx) => {
      try {
        await saveText(abs, next, tab.raw, tab.on);
        tab.raw = next;
        tab.dirty = false;
        notify({ title: "Saved", body: tab.file, level: "success" });
        cx.notify();
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  toggleMode(cx) {
    this.editing = !this.editing;
    const tab = this.tabs.find((t) => t.key === this.activeKey);
    if (tab) this.loadTab(tab, cx);
    else cx.notify();
  }

  openLineHistory(cx) {
    const now = Date.now();
    if (this._lastHistoryAt && now - this._lastHistoryAt < 800) return; // guard a double key-down
    this._lastHistoryAt = now;
    const tab = this.tabs.find((tb) => tb.key === this.activeKey);
    if (!tab || !tab.file || tab.kind !== "file" || !this.code) return;
    const range = this.code.selected_range?.();
    const text = this.code.value();
    if (!range) return;
    const lineAt = (off) => text.slice(0, Math.max(0, Math.min(off, text.length))).split("\n").length;
    let start = lineAt(range.start);
    let end = lineAt(range.end);
    // A selection ending at column 0 of the next line excludes that line.
    if (range.end > range.start && range.end <= text.length && text[range.end - 1] === "\n") end -= 1;
    if (end < start) [start, end] = [end, start];
    if (start < 1) start = 1;
    if (end < start) end = start;
    // The popup reads this shared request (mod.json places it top-centre);
    // while it is already open a new seq refreshes it in place.
    setShared("ide.glh.request", {
      root: tab.root,
      file: tab.file,
      on: tab.on ?? null,
      start,
      end,
      title: tab.title || tab.file.split("/").pop(),
      seq: (shared("ide.glh.request")?.seq ?? 0) + 1,
    });
    if (!shared("ide.glh.open")) run("mod.open", { name: "git-line-history" });
  }

  render(cx) {
    const t = theme();
    const active = this.tabs.find((tb) => tb.key === this.activeKey);
    const isDiff = active?.kind === "diff";
    const isImage = active?.kind === "image";
    const vpH = cx?.viewport_size?.()?.height ?? 900;
    const overlayH = Math.max(460, Math.round(vpH * 0.88) - 12);

    const stepImgZoom = (factor, cx2) => {
      if (!active || !isImage) return;
      const vpW = cx2?.viewport_size?.()?.width ?? 1600;
      const estW = Math.round(vpW * 0.90) - 48;
      const estH = overlayH - 96;
      const bw = this.imgBoxW > 80 ? this.imgBoxW - 32 : estW;
      const bh = this.imgBoxH > 80 ? this.imgBoxH - 32 : estH;
      const fit = active.imgWidth > 0 && active.imgHeight > 0 ? Math.min(1, bw / active.imgWidth, bh / active.imgHeight) : 1;
      const cur = active.imgZoom ?? fit;
      active.imgZoom = Math.max(0.1, Math.min(8, Math.round(cur * factor * 100) / 100));
      cx2.notify();
    };

    const btn = (id, label, accent, onClick) =>
      div()
        .id(id)
        .px(8)
        .py(3)
        .rounded(5)
        .text_size(11.5)
        .cursor_pointer()
        .when(accent, (el) => el.bg(t.accent).text_color("#ffffff").font_semibold())
        .when(!accent, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click(onClick)
        .child(label);

    return v_flex()
      .id("ide-editor-pane")
      .track_focus(this.handle)
      .w_full()
      .when(this.isOverlay, (el) => el.h(overlayH))
      .when(!this.isOverlay, (el) => el.size_full().min_h(0))
      .bg(t.background)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (this.isOverlay && e.key === "escape") {
          this.close(cx);
          cx.stop_propagation();
        } else if (isImage && (e.key === "=" || e.key === "+")) {
          stepImgZoom(1.25, cx);
          cx.stop_propagation();
        } else if (isImage && (e.key === "-" || e.key === "_")) {
          stepImgZoom(0.8, cx);
          cx.stop_propagation();
        } else if (isImage && e.key === "0") {
          active.imgZoom = null;
          cx.notify();
          cx.stop_propagation();
        } else if (isImage && e.key === "1") {
          active.imgZoom = 1;
          cx.notify();
          cx.stop_propagation();
        } else if (e.key === "s" && e.modifiers.control && !isDiff && !isImage) {
          this.saveActive(cx);
          cx.stop_propagation();
        } else if (e.key === "o" && e.modifiers.control && e.modifiers.alt && !isDiff && !isImage) {
          this.openLineHistory(cx);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(8)
          .gap(4)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(4)
              .overflow_hidden()
              .children(
                this.tabs.map((tb, idx) => {
                  const isAct = tb.key === this.activeKey;
                  const label = tb.title || (tb.file ? tb.file.split("/").pop() : tb.ref || "Untitled");
                  return h_flex()
                    .id(`ed-tab-${idx}`)
                    .h(26)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .when(isAct, (el) => el.bg(t.background).text_color(t.foreground).font_semibold())
                    .when(!isAct, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
                    .on_click((_e, cx) => {
                      this.activeKey = tb.key;
                      if (tb.kind === "file" && tb.file && tb.root) {
                        publishActiveFile(tb.file, tb.root, tb.on ?? null);
                      }
                      this.loadTab(tb, cx);
                    })
                    .when(tb.kind === "diff", (el) => el.child(div().text_size(10.5).text_color(t.accent).child("±")))
                    .when(tb.kind === "image", (el) => el.child(div().text_size(10.5).text_color(t.ansi1).child("▣")))
                    .child(div().max_w(180).truncate().text_size(12).child((tb.dirty ? "● " : "") + label))
                    .child(
                      div()
                        .id(`ed-close-${idx}`)
                        .px(3)
                        .rounded(4)
                        .text_size(11)
                        .text_color(t.dim)
                        .hover((s) => s.bg(t.raised).text_color(t.foreground))
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .on_click((_e, cx) => this.closeTab(tb.key, cx))
                        .child("×"),
                    );
                }),
              ),
          )
          .when(Boolean(active?.on), (el) =>
            el.child(div().px(6).py(2).rounded(4).bg(t.hover).text_size(10.5).text_color(t.muted).child(active.on)),
          )
          .when(Boolean(active && isDiff), (el) =>
            el
              .child(btn("ed-wrap", this.wrapLines ? "换行: 开" : "换行: 关", false, (_e, cx) => {
                this.wrapLines = !this.wrapLines;
                cx.notify();
              }))
              .when(Boolean(active.file && isImageFile(active.file)), (el2) =>
                el2.child(btn("ed-view-img", "View Image", true, (_e, cx) => {
                  openInCenterEditor({ file: active.file, root: active.root, on: active.on, line: 1, direct: true }, cx);
                })),
              )
              .when(Boolean(active.file && !isImageFile(active.file)), (el2) =>
                el2.child(btn("ed-open-src", "Edit File", true, (_e, cx) => {
                  const wasOverlay = this.isOverlay;
                  if (wasOverlay) this.close(cx);
                  openInCenterEditor({ file: active.file, root: active.root, on: active.on, line: 1, direct: !wasOverlay }, cx);
                })),
              )
              .child(btn("ed-diff-ref", "↻ Refresh", false, (_e, cx) => this.loadDiffTab(active, cx))),
          )
          .when(Boolean(active && isImage), (el) => {
            const vpW = cx?.viewport_size?.()?.width ?? 1600;
            const bw = this.imgBoxW > 80 ? this.imgBoxW - 32 : Math.round(vpW * 0.90) - 48;
            const bh = this.imgBoxH > 80 ? this.imgBoxH - 32 : overlayH - 96;
            const fit = active.imgWidth > 0 && active.imgHeight > 0 ? Math.min(1, bw / active.imgWidth, bh / active.imgHeight) : 1;
            const pct = Math.round((active.imgZoom ?? fit) * 100);
            return el
              .child(btn("ed-img-out", "−", false, (_e, cx2) => stepImgZoom(0.8, cx2)))
              .child(div().px(6).text_size(11.5).text_color(t.muted).child(`${pct}%`))
              .child(btn("ed-img-in", "+", false, (_e, cx2) => stepImgZoom(1.25, cx2)))
              .child(btn("ed-img-fit", "Fit", active.imgZoom === null, (_e, cx2) => {
                active.imgZoom = null;
                cx2.notify();
              }))
              .child(btn("ed-img-100", "1:1", active.imgZoom === 1, (_e, cx2) => {
                active.imgZoom = 1;
                cx2.notify();
              }))
              .child(btn("ed-img-ref", "↻", false, (_e, cx2) => this.reloadImageTab(active, cx2)));
          })
          .when(this.isOverlay, (el) => el.child(btn("ed-esc", "Esc", false, (_e, cx) => this.close(cx))))
          .when(Boolean(active && !isDiff && !isImage), (el) =>
            el
              .child(btn("ed-mode", this.editing ? "Editing" : "Read-Only", false, (_e, cx) => this.toggleMode(cx)))
              .when(this.editing, (el2) => el2.child(btn("ed-save", "Save (Ctrl+S)", true, (_e, cx) => this.saveActive(cx)))),
          ),
      )
      .when(Boolean(active), (el) =>
        el.child(
          h_flex()
            .h(24)
            .flex_none()
            .px(10)
            .gap(8)
            .items_center()
            .bg(t.surface)
            .border_b(1)
            .border_color(t.border)
            .text_size(11)
            .text_color(t.dim)
            .child(
              div()
                .flex_1()
                .truncate()
                .child(
                  isDiff
                    ? (active.ref
                        ? `${active.isStash ? "Stash" : "Commit"} ${active.ref}`
                        : `${active.file} (${active.untracked ? "Untracked" : active.staged ? "Staged" : "Working Tree"})`)
                    : isImage
                      ? active.file
                      : active.file + (active.line > 1 ? `:${active.line}` : ""),
                ),
            )
            .when(isImage && (active.imgWidth > 0 || active.imgSize > 0), (el2) => {
              const ext = (String(active.file || "").split(".").pop() || "").toUpperCase();
              const info = [
                active.imgWidth > 0 && active.imgHeight > 0 ? `${active.imgWidth} × ${active.imgHeight}` : "",
                ext,
                active.imgSize > 0 ? formatBytes(active.imgSize) : "",
              ].filter(Boolean).join(" · ");
              return el2.child(div().flex_none().text_color(t.muted).child(info));
            })
            .when(isDiff && Boolean(active.diffStats), (el2) =>
              el2
                .child(div().px(6).py(1).rounded(4).bg(t.ansi2 + "28").font_semibold().text_color(t.ansi2).child(`+${active.diffStats.add}`))
                .child(div().px(6).py(1).rounded(4).bg(t.ansi1 + "28").font_semibold().text_color(t.ansi1).child(`−${active.diffStats.del}`)),
            ),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().p(16).text_color(t.blocked).child(this.error)))
      .when(!this.error && isDiff, (el) => {
        if (this.loadingDiff) return el.child(div().p(20).text_color(t.dim).child("Loading git diff…"));
        if (!active.diffLines?.length) return el.child(div().p(20).text_color(t.dim).child("No diff hunks for this item."));
        const vpW = cx?.viewport_size?.()?.width ?? 1600;
        const estW = this.isOverlay ? Math.round(vpW * 0.90) - 24 : Math.max(460, Math.round((vpW - 560) * 0.5));
        const effW = this.diffBoxW > 120 ? this.diffBoxW : estW;
        const maxCols = Math.max(42, Math.floor((effW - 96) / 7.6));
        const rows = this.wrapLines ? wrapDiffRows(active.diffLines, maxCols) : active.diffLines;
        return el.child(
          div()
            .id("ed-diff-wrap")
            .flex_1()
            .min_h(0)
            .relative()
            .font_family(settings().font_family ?? "JetBrains Mono")
            .text_size(12)
            .on_size_change((sz, cx2) => {
              if (sz?.width > 120 && Math.abs(sz.width - this.diffBoxW) > 10) {
                this.diffBoxW = sz.width;
                cx2.notify();
              }
            })
            .child(
              this.wrapLines
                ? v_virtual_list("ed-diff-list", rows.length, 20, (i) => String(i), (range) =>
                    rows.slice(range.start, range.end).map((row) =>
                      renderDiffLine(div, h_flex, row, t, { h: 20, numW: 36, prefixW: 16, gap: 8 }),
                    ),
                  ).size_full()
                : div()
                    .id("ed-diff-x")
                    .size_full()
                    .overflow_x_scrollbar()
                    .child(
                      div()
                        .w_full()
                        .min_w(active.diffWidth)
                        .h_full()
                        .child(
                          v_virtual_list("ed-diff-list", rows.length, 20, (i) => String(i), (range) =>
                            rows.slice(range.start, range.end).map((row) =>
                              renderDiffLine(div, h_flex, row, t, { h: 20, numW: 36, prefixW: 16, gap: 8 }),
                            ),
                          ).size_full(),
                        ),
                    ),
            )
            .child(Scrollbar.vertical("ed-diff-list").viewport_from_layout().absolute().inset_0()),
        );
      })
      .when(!this.error && isImage, (el) => {
        if (this.loadingImage) return el.child(div().p(20).text_color(t.dim).child("Loading image…"));
        if (!active.imgRelPath) return el.child(div().p(20).text_color(t.dim).child("No image preview available."));
        const vpW = cx?.viewport_size?.()?.width ?? 1600;
        const bw = this.imgBoxW > 80 ? this.imgBoxW - 32 : Math.round(vpW * 0.90) - 48;
        const bh = this.imgBoxH > 80 ? this.imgBoxH - 32 : overlayH - 96;
        const iw = active.imgWidth || 400;
        const ih = active.imgHeight || 300;
        const maxFit = String(active.file || "").toLowerCase().endsWith(".svg") && iw < 128 && ih < 128 ? 6 : 1;
        const fit = Math.min(maxFit, bw / iw, bh / ih);
        const scale = active.imgZoom ?? fit;
        const drawW = Math.max(1, Math.round(iw * scale));
        const drawH = Math.max(1, Math.round(ih * scale));
        const fits = drawW <= bw && drawH <= bh;
        return el.child(
          div()
            .id("ed-img-wrap")
            .flex_1()
            .min_h(0)
            .w_full()
            .bg(t.background)
            .overflow_scrollbar()
            .on_size_change((sz, cx2) => {
              if (sz?.width > 80 && sz?.height > 80 && (Math.abs(sz.width - this.imgBoxW) > 6 || Math.abs(sz.height - this.imgBoxH) > 6)) {
                this.imgBoxW = sz.width;
                this.imgBoxH = sz.height;
                cx2.notify();
              }
            })
            .child(
              h_flex()
                .when(fits, (c) => c.size_full().items_center().justify_center())
                .when(!fits, (c) => c.min_w(Math.max(bw + 32, drawW + 32)).min_h(Math.max(bh + 32, drawH + 32)).p(16).items_center().justify_center())
                .child(
                  div()
                    .p(2)
                    .rounded(6)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.surface)
                    .child(image(active.imgRelPath).w(drawW).h(drawH).flex_none()),
                ),
            ),
        );
      })
      .when(!this.error && !isDiff && !isImage && Boolean(this.code), (el) => el.child(Editor.new(this.code).flex_1().min_h(0)))
      .when(!this.error && !isDiff && !isImage && !this.code, (el) =>
        el.child(div().p(20).text_color(t.dim).child(active ? "Loading file…" : "Select a file from Files / Ctrl+Q to open here.")),
      );
  }
}
