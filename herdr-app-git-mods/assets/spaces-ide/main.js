// Workspace spaces grouped by folder: folder name represents the space,
// with each running CLI/IDE agent listed underneath in a tree (icon, concise title, status).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  spaces,
  agents,
  terminals,
  machines,
  panes,
  focused,
  run,
  openOverlay,
  exec,
  hc,
  theme,
  shared,
  setShared,
  watchFolder,
  window,
  layout,
  playSound,
  notify,
  settings,
  checking,
} from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const normPath = (p) => String(p || "").replace(/[\\/]+$/, "");
const base = (p) => normPath(p).split(/[\\/]/).pop() || "";
const FALLBACK = 60000;
const AT_ONCE = 6;

async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

const AGENT_META = {
  claude: { label: "Claude Code", icon: "icons/claude.svg", tint: false },
  codex: { label: "Codex", icon: "icons/codex.svg", tint: false },
  agy: { label: "Antigravity", icon: "icons/antigravity.svg", tint: false },
  gemini: { label: "Gemini", icon: "icons/gemini.svg", tint: true, color: "#60a5fa" },
  cmdc: { label: "Command Code", icon: "icons/command-code.svg", tint: true },
  codebuddy: { label: "CodeBuddy", icon: "icons/claude.svg", tint: true, color: "#10b981" },
  opencode: { label: "OpenCode", icon: "icons/opencode.svg", tint: true },
  cursor: { label: "Cursor", icon: "icons/cursor.svg", tint: true },
  copilot: { label: "Copilot", icon: "icons/copilot.svg", tint: true },
  pi: { label: "Pi", icon: "icons/pi.svg", tint: false },
  omp: { label: "OMP", icon: "icons/omp.svg", tint: false },
  goose: { label: "Goose", icon: "icons/goose.svg", tint: false },
  dsh: { label: "DSH", icon: "icons/dsh-tui.svg", tint: false },
  aider: { label: "Aider", icon: "icons/agent.svg", tint: true },
};

function agentKind(prog, title) {
  const s = String(prog || "").toLowerCase();
  const ti = String(title || "").toLowerCase();
  if (s.includes("fresh") || s.includes("nvim") || ti.includes("— fresh") || ti.includes(" - fresh")) return null;
  if (/antigravity|\bagy\b/.test(s)) return "agy";
  if (/cmdc|command[- ]?code/.test(s) || /command code|^⌘\s/.test(ti)) return "cmdc";
  if (/codebuddy|\bcbc\b/.test(s) || ti.includes("codebuddy")) return "codebuddy";
  if (s.includes("claude") || ti.includes("claude")) return "claude";
  if (s.includes("codex") || ti.includes("codex")) return "codex";
  if (s.includes("gemini") || ti.includes("gemini")) return "gemini";
  if (s.includes("opencode") || ti.includes("opencode")) return "opencode";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("copilot")) return "copilot";
  if (s.includes("goose")) return "goose";
  if (/\bdsh\b/.test(s)) return "dsh";
  if (/\baider\b/.test(s)) return "aider";
  if (/\bpi\b|pi-coding/.test(s)) return "pi";
  if (/\bomp\b|oh-my-pi/.test(s)) return "omp";
  return null;
}

const SPIN_CHARS = "\u2800-\u28FF\u25D0-\u25D3◐◓◑◒✢✣✤✥✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❇❈❉❊❋";
const SPIN_TITLE = new RegExp(`^\\s*[${SPIN_CHARS}]`, "u");
const SHELL_RE = /^(zsh|bash|sh|fish|dash|pwsh|powershell|cmd)$/i;

function isKnownCliAgent(p, tm) {
  const fgName = String(tm?.foreground?.name || "");
  if (p.program?.shell && (!fgName || SHELL_RE.test(fgName)) && !SPIN_TITLE.test(p.title || "")) return false;
  const prog = `${p.program?.key || ""} ${p.program?.id || ""} ${p.program?.name || ""} ${fgName} ${tm?.foreground?.argv?.[0] || ""}`;
  return Boolean(agentKind(prog, p.title)) || p.program?.agent === true || SPIN_TITLE.test(p.title || "");
}

function detectKind(p, tm, agInfo) {
  const fgName = String(tm?.foreground?.name || "");
  if (p.program?.shell && (!fgName || SHELL_RE.test(fgName)) && !agInfo && !SPIN_TITLE.test(p.title || "")) return null;
  const candidates = [
    agInfo?.app,
    p.app,
    p.program?.key,
    p.program?.id,
    p.program?.name,
    fgName,
    String(tm?.foreground?.argv?.[0] || "").split(/[\\/]/).pop(),
  ];
  for (const c of candidates) {
    const k = agentKind(c, p.title);
    if (k) return k;
  }
  if (p.program?.agent || agInfo || SPIN_TITLE.test(p.title || "")) {
    return agentKind("", p.title) || p.program?.key || "agent";
  }
  return null;
}

// Strip status prefixes ("✦ Working", "[ ! ] ", "⌘ ") so agent titles read cleanly.
const cleanPrefix = (s) =>
  String(s ?? "")
    .replace(/^(?:\[ [!.] \] |⌘\s*|[✋⏳]\uFE0F?(?=\s)|(?!(?:\p{Emoji}\uFE0F|[#*]\u20E3))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "")
    .trim();

function cleanAgentTitle(rawTitle, kind, folderName) {
  const raw = String(rawTitle || "").trim();
  if (!raw) return "";
  if (/^[~/]|^[A-Za-z]:\\/.test(raw) || /^[^\s@]+@[^\s:]+:/.test(raw)) return "";
  if (kind === "agy" && /^agy(?:\s|$)/i.test(raw)) return "";

  let t = cleanPrefix(raw);
  if (!t) return "";

  if (kind === "cmdc" || raw.startsWith("⌘")) {
    const parts = t.split(/\s+·\s+/).map((x) => x.trim()).filter(Boolean);
    // Drop trailing model badge (e.g. "glm-5.3-flash", "claude-sonnet-...", "gpt-...")
    if (parts.length >= 2 && /^(?:glm|claude|gpt|deepseek|qwen|kimi|gemini|minimax|doubao|step|o[134]|sonnet|opus|haiku|flash|pro|auto|default)/i.test(parts[parts.length - 1])) {
      parts.pop();
    }
    if (parts.length >= 2 && parts[0].toLowerCase() === "command code" && folderName && parts[1].toLowerCase() === folderName.toLowerCase()) {
      parts.splice(1, 1);
    }
    t = parts.join(" · ");
  }

  if (/^(?:zsh|bash|sh|fish)$/i.test(t)) return "";
  return t;
}

function formatAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "now";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const SPIN_LINE = new RegExp(`^\\s*[${SPIN_CHARS}]\\s*\\S.{0,31}?(?:…|\\.\\.\\.)`, "u");
const WORKING_TEXT = /\(\s*\d+s\s*·|\b\d+s\s*·\s*(?:running|working|thinking|waiting)\b|Task running for a while|\brunning (?:REPL|command|tool|tools|task|tasks)\b|\bProcessing\b/i;

function classifyAgentOutput(raw, prevInfo, now, opts = {}) {
  const lines = (raw || "").split("\n").map((l) => l.replace(/\r$/, "").trim()).filter(Boolean);
  const tail = lines.slice(-14).join("\n");
  const bottom = lines.slice(-6).join("\n");
  const spinTitle = Boolean(opts.spinTitle);

  const hasInterruptHint = /esc to interrupt|ctrl\+c to interrupt|ctrl-c to interrupt|press esc to cancel|esc\s*(?:取消|中断)/i.test(lines.slice(-14).join("\n"));
  const hasWorkingLine = lines.slice(-14).some((l) => SPIN_LINE.test(l) || WORKING_TEXT.test(l));
  const promptLine = /^[❯›>$%]\s*(?:Ask your question|Ask anything|Type (?:a|your) message|Try\s+"[^"]*"|输入.*|.*)?$/i;
  const hasPromptGlyph = lines.slice(-5).some((l) => /^[❯›>](?:\s|$)/.test(l));
  const questionUI = /\bType something\b|^\s*❯\s*\d+\s*[.、)]|^\s*QUESTION\b|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/im.test(lines.slice(-10).join("\n"));
  const atPrompt = !questionUI && ((lines.slice(-6).some((l) => promptLine.test(l)) || hasPromptGlyph) && !hasWorkingLine && !hasInterruptHint && !spinTitle);
  const isBlocked =
    questionUI ||
    (!atPrompt &&
      /\b(allow once|allow for this session|do you want to|approve|reject|select an option|press enter to confirm)\b|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/i.test(lines.slice(-10).join("\n")));
  const hasWorkingVerb =
    !atPrompt &&
    /^(?:Thinking|Generating|Searching|Running|Executing|Reading|Writing|Editing|Working|Repairing|Tidying|Planning|Calling)\b/im.test(bottom);
  const hasWorkingSignal = spinTitle || hasInterruptHint || hasWorkingLine || hasWorkingVerb;
  const rawStatus = hasWorkingSignal ? "working" : isBlocked ? "blocked" : "idle";
  const workingSince = rawStatus === "working" ? (prevInfo?.rawStatus === "working" ? prevInfo.workingSince : now) : 0;
  const wasWorking = prevInfo?.rawStatus === "working" && (prevInfo.hasStrongWorking || now - (prevInfo.workingSince ?? now) >= 1200);

  let status = "idle";
  if (isBlocked) status = "blocked";
  else if (hasWorkingSignal) status = "working";
  else if (wasWorking && (atPrompt || rawStatus === "idle")) status = "done";
  else if (prevInfo && prevInfo.status === "done") status = "done";

  return {
    status,
    rawStatus,
    hasStrongWorking: spinTitle || hasInterruptHint || hasWorkingLine || Boolean(prevInfo?.rawStatus === "working" && prevInfo?.hasStrongWorking && rawStatus === "working"),
    workingSince,
    tail,
    doneAt: status === "done" ? (prevInfo?.doneAt || now) : 0,
  };
}

// Resolve concise titles for agents that don't expose them via terminal OSC title (agy, codex).
const TITLE_PROBE_PY = `
import glob, json, os, re, sqlite3, sys

def child_pids(root_pid):
    out, q = [str(root_pid)], [str(root_pid)]
    while q:
        p = q.pop(0)
        try:
            with open(f"/proc/{p}/task/{p}/children", "r") as f:
                for c in f.read().split():
                    if c not in out:
                        out.append(c)
                        q.append(c)
        except Exception:
            pass
    return out

def agy_sid_from_proc(pid):
    for p in child_pids(pid):
        for fd in glob.glob(f"/proc/{p}/fd/*"):
            try:
                t = os.readlink(fd)
                m = re.search(r"/\\.gemini/antigravity-cli/presence/([^/]+)\\.lock$", t)
                if m:
                    return m.group(1)
            except Exception:
                pass
    return None

def codex_sid_from_proc(pid):
    for p in child_pids(pid):
        for fd in glob.glob(f"/proc/{p}/fd/*"):
            try:
                t = os.readlink(fd)
                if "/.codex/sessions/" in t and t.endswith(".jsonl"):
                    meta = json.loads(open(t, encoding="utf-8").readline())
                    pl = meta.get("payload") or {}
                    sid = pl.get("id") or pl.get("session_id")
                    if sid:
                        return sid
            except Exception:
                pass
    return None

items = json.loads(sys.argv[1])
agy_conn = None
agy_db = os.path.expanduser("~/.gemini/antigravity-cli/conversation_summaries.db")
if any(it.get("kind") == "agy" for it in items) and os.path.isfile(agy_db):
    try:
        agy_conn = sqlite3.connect(f"file:{agy_db}?mode=ro", uri=True)
    except Exception:
        agy_conn = None

codex_titles = None
def get_codex_titles():
    global codex_titles
    if codex_titles is not None:
        return codex_titles
    codex_titles = {}
    idx = os.path.expanduser("~/.codex/session_index.jsonl")
    if os.path.isfile(idx):
        try:
            with open(idx, encoding="utf-8") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                        if d.get("id") and d.get("thread_name"):
                            codex_titles[d["id"]] = d["thread_name"]
                    except Exception:
                        pass
        except Exception:
            pass
    return codex_titles

res = {}
for it in items:
    addr = it["address"]
    kind = it.get("kind")
    sid = it.get("sessionId") or ""
    pid = it.get("pid")
    if not sid and pid:
        if kind == "agy":
            sid = agy_sid_from_proc(pid) or ""
        elif kind == "codex":
            sid = codex_sid_from_proc(pid) or ""
    title = ""
    if kind == "agy" and sid and agy_conn:
        try:
            row = agy_conn.execute(
                "SELECT title, preview FROM conversation_summaries WHERE conversation_id = ?",
                (sid,),
            ).fetchone()
            title = (row[0] if row else "") or ""
            if not title:
                r2 = agy_conn.execute(
                    "SELECT title FROM conversations_fts WHERE conversation_id = ? AND title != '' LIMIT 1",
                    (sid,),
                ).fetchone()
                title = (r2[0] if r2 else "") or ""
            if not title and row and row[1]:
                txt = re.sub(r"<[^>]+>", " ", row[1]).strip()
                title = txt.splitlines()[0].strip() if txt else ""
        except Exception:
            pass
    elif kind == "codex" and sid:
        title = get_codex_titles().get(sid, "")
    res[addr] = {"sessionId": sid or None, "title": title or None}

if agy_conn:
    agy_conn.close()
print(json.dumps(res))
`;

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {};
    this.checked = {};
    this.unsure = new Set();
    this.pending = new Set();
    this.busy = {};
    this.ready = {};
    this.at = {};
    this.watching = new Map();
    this.termAgent = {}; // terminal -> { status, rawStatus, tail, doneAt }
    this.spaceAgent = {}; // spaceId -> status
    this.agentChanged = {}; // terminal -> { s, at }
    this.titleCache = {}; // terminal -> { sessionId, title, checkedAt }
    this.lastProbeKey = {}; // terminal -> turn|title|focus
    this.lastProbedAt = {}; // terminal -> ms
    this.probingAgents = false;
    this.probingTitles = false;
    this.probeCursor = 0;
    this.lastDirtySeq = shared("ide.git.dirtySeq") ?? 0;
    this.lastRenderSig = "";
    this.lastAgeTick = 0;
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new();
    this.activeAt = -1;
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch {
      this.reconnecting = {};
    }
    try {
      this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    } catch {
      this.folded = new Set();
    }
    try {
      const savedCh = JSON.parse(localStorage.getItem("spaces.agentChanged") ?? "{}");
      if (savedCh && typeof savedCh === "object" && !Array.isArray(savedCh)) this.agentChanged = savedCh;
    } catch {}
    try {
      const savedTitles = JSON.parse(localStorage.getItem("spaces.agentTitles") ?? "{}");
      if (savedTitles && typeof savedTitles === "object" && !Array.isArray(savedTitles)) {
        for (const [k, v] of Object.entries(savedTitles)) {
          if (v && typeof v === "object" && v.title) {
            this.titleCache[k] = { sessionId: v.sessionId ?? null, title: v.title, checkedAt: 0 };
          }
        }
      }
    } catch {}
    if (checking()) return;
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx2) => this.refreshMachines(cx2));
    cx.timer.every(1000, (cx2) => this.checkNew(cx2));
    cx.timer.every(1200, (cx2) => this.probeCustomAgents(cx2));
    cx.timer.every(5000, (cx2) => this.probeAgentTitles(cx2));
    this.probeAgentTitles(cx);
  }

  probeCustomAgents(cx) {
    if (this.probingAgents) return;
    const sp = spaces();
    const ps = panes();
    const terms = terminals();
    const termByAddr = new Map(terms.map((tm) => [tm.address, tm]));
    const targets = [];
    const tabToSpace = new Map();
    for (const s of sp) {
      for (const t of s.tabs ?? []) tabToSpace.set(t.id, s);
    }
    const now = Date.now();
    const liveTerminals = new Set();
    for (const p of ps) {
      if (!p.terminal || p.status) continue;
      const s = tabToSpace.get(p.tab);
      if (!s) continue;
      const tm = termByAddr.get(p.terminal);
      if (isKnownCliAgent(p, tm)) {
        liveTerminals.add(p.terminal);
        const kind = detectKind(p, tm, null) || "agent";
        const label = AGENT_META[kind]?.label || kind;
        const probeKey = `${tm?.turn ?? ""}|${p.title ?? ""}|${p.focused ? 1 : 0}|${s.active ? 1 : 0}`;
        const prevStatus = this.termAgent[p.terminal]?.status;
        const activeState = prevStatus === "working" || prevStatus === "blocked";
        const keyChanged = this.lastProbeKey[p.terminal] !== probeKey;
        const fallbackDue = tm?.turn == null && now - (this.lastProbedAt[p.terminal] ?? 0) >= 5000;
        const idleRefreshDue = now - (this.lastProbedAt[p.terminal] ?? 0) >= 20000;
        const shouldProbe = !this.termAgent[p.terminal] || activeState || keyChanged || fallbackDue || idleRefreshDue;
        targets.push({
          spaceId: s.id,
          spaceName: base(place(s, ps) || s.folder) || s.name || "Space",
          active: s.active,
          focused: p.focused,
          terminal: p.terminal,
          label,
          spinTitle: SPIN_TITLE.test(p.title || ""),
          probeKey,
          shouldProbe,
        });
      } else {
        delete this.termAgent[p.terminal];
        delete this.lastProbeKey[p.terminal];
        delete this.lastProbedAt[p.terminal];
      }
    }
    for (const k of Object.keys(this.termAgent)) {
      if (!liveTerminals.has(k)) {
        delete this.termAgent[k];
        delete this.lastProbeKey[k];
        delete this.lastProbedAt[k];
      }
    }
    if (!targets.length) {
      if (Object.keys(this.spaceAgent).length) {
        this.spaceAgent = {};
        cx.notify();
      }
      return;
    }

    const dueTargets = targets.filter((t) => t.shouldProbe);
    if (!dueTargets.length) return;

    // Round-robin slices of 12 so even >12 active agents stay fresh without flooding hc.
    const batchSize = 12;
    const start = dueTargets.length <= batchSize ? 0 : this.probeCursor % dueTargets.length;
    const batch = [];
    for (let i = 0; i < Math.min(batchSize, dueTargets.length); i++) {
      batch.push(dueTargets[(start + i) % dueTargets.length]);
    }
    this.probeCursor = (start + batch.length) % Math.max(1, dueTargets.length);

    this.probingAgents = true;
    cx.spawn(async (cx2) => {
      let uiChanged = false;
      try {
        const ts = Date.now();
        const winActive = Boolean(window()?.active);
        const soundsOn = settings()?.sounds?.enabled !== false;
        await Promise.all(
          batch.map(async (tg) => {
            try {
              const r = await hc(["read", tg.terminal, "--lines", "18"]);
              if (r.code !== 0) return;
              this.lastProbeKey[tg.terminal] = tg.probeKey;
              this.lastProbedAt[tg.terminal] = ts;
              const prev = this.termAgent[tg.terminal];
              const info = classifyAgentOutput(r.stdout, prev, ts, { spinTitle: tg.spinTitle });
              const becameDone = prev?.rawStatus === "working" && info.rawStatus === "idle" && info.status === "done";
              const becameBlocked = prev?.rawStatus !== "blocked" && info.rawStatus === "blocked";
              if (tg.active && tg.focused && winActive && info.status === "done") info.status = "idle";
              if (!prev || prev.status !== info.status) uiChanged = true;
              this.termAgent[tg.terminal] = info;
              if (becameDone) {
                if (soundsOn) playSound("done");
                if (!tg.active || !winActive) {
                  notify({ title: `${tg.label} 完成`, body: tg.spaceName, level: "success", timeout: 4000 });
                }
              } else if (becameBlocked) {
                if (soundsOn) playSound("blocked");
                if (!tg.active || !winActive) {
                  notify({ title: `${tg.label} 等待确认`, body: tg.spaceName, level: "warning", timeout: 5000 });
                }
              }
            } catch {}
          }),
        );
        const nextSpace = {};
        const rank = { blocked: 4, working: 3, done: 2, idle: 1 };
        for (const tg of targets) {
          const st = this.termAgent[tg.terminal]?.status;
          if (!st) continue;
          const cur = nextSpace[tg.spaceId];
          if (!cur || (rank[st] ?? 0) > (rank[cur] ?? 0)) nextSpace[tg.spaceId] = st;
        }
        const prevKeys = Object.keys(this.spaceAgent);
        const nextKeys = Object.keys(nextSpace);
        if (prevKeys.length !== nextKeys.length || nextKeys.some((k) => this.spaceAgent[k] !== nextSpace[k])) {
          uiChanged = true;
        }
        this.spaceAgent = nextSpace;
        if (uiChanged) cx2.notify();
      } finally {
        this.probingAgents = false;
      }
    });
  }

  probeAgentTitles(cx) {
    if (this.probingTitles) return;
    const sp = spaces();
    const ps = panes();
    const ag = agents();
    const terms = terminals();
    const agentByPane = new Map(ag.map((a) => [a.pane, a]));
    const termByAddr = new Map(terms.map((tm) => [tm.address, tm]));
    const tabToSpace = new Map();
    for (const s of sp) {
      for (const t of s.tabs ?? []) tabToSpace.set(t.id, s);
    }

    const now = Date.now();
    const byMachine = new Map();
    for (const p of ps) {
      if (!p.terminal) continue;
      const s = tabToSpace.get(p.tab);
      if (!s) continue;
      const tm = termByAddr.get(p.terminal);
      const agInfo = agentByPane.get(p.pane);
      const kind = detectKind(p, tm, agInfo);
      if (kind !== "agy" && kind !== "codex") continue;
      // Codex usually sets its own OSC title; only look up session_index when it has none.
      if (kind === "codex" && cleanAgentTitle(p.title, kind, base(s.folder || place(s, ps)))) continue;

      const sid = tm?.labels?.["ide.agent_session"] || this.titleCache[p.terminal]?.sessionId || null;
      const turn = tm?.turn ?? null;
      const cached = this.titleCache[p.terminal];
      // Once a title is cached and the terminal hasn't produced new output, avoid re-spawning python3.
      const interval = cached?.title ? (cached.turn !== turn ? 15000 : 120000) : 5000;
      const stale = !cached || (sid && cached.sessionId !== sid) || now - cached.checkedAt >= interval;
      if (!stale) continue;

      const on = s.machine ?? null;
      if (on === null && window()?.platform === "windows") continue;
      const list = byMachine.get(on) ?? [];
      list.push({
        address: p.terminal,
        kind,
        sessionId: sid,
        pid: tm?.foreground?.pid || tm?.pid || null,
        turn,
      });
      byMachine.set(on, list);
    }

    if (!byMachine.size) return;
    this.probingTitles = true;
    cx.spawn(async (cx2) => {
      let updated = false;
      try {
        for (const [on, items] of byMachine.entries()) {
          const r = await exec("python3", ["-c", TITLE_PROBE_PY, JSON.stringify(items)], { on, timeout: 3000 }).catch(() => null);
          let parsed = null;
          if (r?.code === 0 && r.stdout) {
            try {
              parsed = JSON.parse(r.stdout);
            } catch {}
          }
          const ts = Date.now();
          for (const it of items) {
            const hit = parsed?.[it.address];
            const prev = this.titleCache[it.address];
            const nextTitle = hit?.title || prev?.title || null;
            const nextSid = hit?.sessionId || it.sessionId || prev?.sessionId || null;
            if (nextTitle !== prev?.title || nextSid !== prev?.sessionId) updated = true;
            this.titleCache[it.address] = { sessionId: nextSid, title: nextTitle, turn: it.turn, checkedAt: ts };
          }
        }
        if (updated) {
          try {
            const compact = {};
            for (const [k, v] of Object.entries(this.titleCache)) {
              if (v?.title) compact[k] = { sessionId: v.sessionId ?? null, title: v.title };
            }
            localStorage.setItem("spaces.agentTitles", JSON.stringify(compact));
          } catch {}
          cx2.notify();
        }
      } finally {
        this.probingTitles = false;
      }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    const ps = panes();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, ps);
    const dirtySeq = shared("ide.git.dirtySeq") ?? 0;
    if (dirtySeq !== this.lastDirtySeq) {
      this.lastDirtySeq = dirtySeq;
      for (const s of sp) {
        const k = where(s, ps);
        if (JSON.parse(k)[1]) due.add(k);
      }
    }
    if (due.size) this.refreshGit(due, cx);
    const foc = focused();
    const sig =
      sp.map((s) => `${s.id}:${s.active}:${s.status}:${this.spaceAgent[s.id] ?? ""}`).join(";") +
      "|" +
      ps.map((p) => `${p.pane}:${p.focused}:${p.status}:${p.program?.id ?? ""}:${p.title ?? ""}`).join(";") +
      `|${foc?.terminal ?? ""}:${foc?.pane ?? ""}`;
    const ageBucket = Math.floor(now / 30000);
    const ageTicked = ageBucket !== this.lastAgeTick;
    this.lastAgeTick = ageBucket;
    const changed = sig !== this.lastRenderSig;
    this.lastRenderSig = sig;
    if (changed || ageTicked || sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  due(now, sp, ps) {
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) {
      if (!keys.has(k)) {
        delete this.git[k];
        delete this.checked[k];
        this.unsure.delete(k);
      }
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) {
      if (!repos.has(JSON.stringify([null, repo]))) {
        this.watching.delete(repo);
        pending.cancel();
      }
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async (cx2) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      cx2.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = (this.reconnecting[name] ??= { machine, removed: false });
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async (cx2) => {
      try {
        const ask = async (args) => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try {
              error = JSON.parse(r.stdout || r.stderr).error?.message;
            } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx2);
      cx2.notify();
    });
  }

  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx2) => {
      while (this.pending.size) {
        const batch = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(AT_ONCE, batch.length) }, async () => {
            while (next < batch.length) await this.check(batch[next++], cx2);
          }),
        );
      }
      this.refreshing = false;
      cx2.notify();
    });
  }

  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    const seqAtStart = shared("ide.git.dirtySeq") ?? 0;
    try {
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else {
          this.git[key] = null;
        }
        return;
      }
      const top = r.stdout.replace(/\n$/, "");
      const repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = {
        name,
        branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)",
        ahead,
        behind,
        repo: JSON.stringify([on, repo]),
        linked: repo !== `${top}/.git`,
      };
      this.git[key] = info;
      if (info.branch !== "(detached)" && (shared("ide.git.dirtySeq") ?? 0) === seqAtStart) {
        const sp = spaces();
        const ps = panes();
        const bySpace = { ...(shared("ide.branchBySpace") ?? {}) };
        let branchChanged = false;
        for (const s of sp) {
          if (where(s, ps) === key && bySpace[s.id] !== info.branch) {
            bySpace[s.id] = info.branch;
            branchChanged = true;
          }
        }
        if (branchChanged) setShared("ide.branchBySpace", bySpace);
      }
      if (!on) this.watch(repo, cx);
    } catch {
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx2) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx2);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    openOverlay({ mod: "ide-space-menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  buildFolderGroups(sp, ps, ag, terms, foc) {
    for (const w of sp) {
      if (!this.shown.has(w.id)) {
        const ready = where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
        if (ready) this.shown.add(w.id);
      }
    }
    const visibleSpaces = sp.filter((w) => this.shown.has(w.id));
    const agentByPane = new Map(ag.map((a) => [a.pane, a]));
    const termByAddr = new Map(terms.map((tm) => [tm.address, tm]));
    const winActive = Boolean(window()?.active);
    const now = Date.now();
    const rank = { blocked: 4, working: 3, done: 2, idle: 1 };

    const groups = [];
    const byKey = new Map();

    for (const w of visibleSpaces) {
      const folderRaw = normPath(place(w, ps) || "");
      const folderName = base(folderRaw) || w.name || "~";
      const key = `${w.machine ?? ""}\0${folderRaw || w.id}`;
      let grp = byKey.get(key);
      if (!grp) {
        grp = {
          key,
          machine: w.machine ?? null,
          name: folderName,
          folderPath: folderRaw,
          branch: null,
          spaces: [],
          primary: w,
          active: false,
          items: [],
        };
        byKey.set(key, grp);
        groups.push(grp);
      }
      grp.spaces.push(w);
      const wGit = this.git[where(w, ps)];
      const wBranch = (wGit?.branch && wGit.branch !== "(detached)" ? wGit.branch : null) || w.branch || null;
      if (w.active) {
        grp.active = true;
        grp.primary = w;
        if (wBranch) grp.branch = wBranch;
      } else if (!grp.branch && wBranch) {
        grp.branch = wBranch;
      }

      const tabIds = new Set((w.tabs ?? []).map((c) => c.id));
      const tabPanes = ps.filter((p) => p.terminal && tabIds.has(p.tab));
      for (const p of tabPanes) {
        const tm = termByAddr.get(p.terminal);
        const agInfo = agentByPane.get(p.pane);
        const kind = detectKind(p, tm, agInfo);
        if (!kind) continue;

        const isFocused = Boolean(
          w.active &&
            (p.focused ||
              (foc?.terminal && foc.terminal === p.terminal) ||
              (foc?.agent && foc.agent === p.terminal)),
        );
        const probed = this.termAgent[p.terminal]?.status;
        const reported = agInfo?.status ?? p.status;
        const spinWorking = !reported && SPIN_TITLE.test(p.title || "");
        let status =
          probed && reported
            ? (rank[probed] ?? 0) >= (rank[reported] ?? 0)
              ? probed
              : reported
            : probed || reported || (spinWorking ? "working" : "idle");
        if (w.active && isFocused && winActive && status === "done") status = "idle";

        // Track state transitions for the right-side relative timestamp ("now", "2m", ...).
        const normState = status === "done" ? "idle" : status;
        const prevCh = this.agentChanged[p.terminal];
        if (!prevCh) {
          this.agentChanged[p.terminal] = { s: normState, at: normState === "working" ? now : null };
          this.changedDirty = true;
        } else if (prevCh.s !== normState) {
          this.agentChanged[p.terminal] = { s: normState, at: now };
          this.changedDirty = true;
        }
        const changedAt = this.agentChanged[p.terminal]?.at ?? null;
        const age = status === "idle" ? (isFocused ? "now" : changedAt ? formatAge(now - changedAt) : "") : "";

        const meta = AGENT_META[kind];
        const iconSpec = meta
          ? { icon: meta.icon, tint: meta.tint, color: meta.color ?? null }
          : p.program?.icon
            ? { icon: p.program.icon, tint: Boolean(p.program.tint), color: null }
            : { icon: "icons/agent.svg", tint: true, color: null };

        const cachedTitle = this.titleCache[p.terminal]?.title;
        const cleanedOsc = cleanAgentTitle(p.title, kind, folderName);
        const title =
          (kind === "agy" ? cachedTitle : cleanedOsc || cachedTitle) ||
          meta?.label ||
          p.program?.name ||
          "Agent";

        grp.items.push({
          space: w,
          pane: p.pane,
          terminal: p.terminal,
          kind,
          title,
          status,
          age,
          isFocused,
          iconSpec,
        });
      }
    }

    // Prune vanished terminals from change-tracking map and persist if updated.
    const liveTerms = new Set(terms.map((tm) => tm.address));
    for (const k of Object.keys(this.agentChanged)) {
      if (!liveTerms.has(k)) {
        delete this.agentChanged[k];
        this.changedDirty = true;
      }
    }
    if (this.changedDirty) {
      this.changedDirty = false;
      try {
        localStorage.setItem("spaces.agentChanged", JSON.stringify(this.agentChanged));
      } catch {}
    }

    return groups;
  }

  renderFolderGroup(grp, t, sp) {
    const colors = shared("space.colors") ?? {};
    const firstSpace = grp.spaces[0];
    const color = colors[firstSpace.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
    const hasFocusedItem = grp.items.some((it) => it.isFocused);
    const headerActive = grp.active && !hasFocusedItem;
    const fromIndex = this.pressed === null ? -1 : sp.findIndex((s) => s.id === this.pressed);
    const targetSpace = grp.primary;
    const targetIndex = sp.findIndex((s) => s.id === targetSpace.id);

    const tip = grp.folderPath ? (grp.branch ? `${grp.folderPath} (${grp.branch})` : grp.folderPath) : grp.branch;
    const header = h_flex()
      .relative()
      .id(`space-grp-${targetSpace.id}`)
      .h(28)
      .px(6)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(headerActive, (el) => el.bg(t.selected))
      .when(!headerActive, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === targetSpace.id && this.over !== targetSpace.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === targetSpace.id && this.pressed !== targetSpace.id, (el) =>
        el.child(
          div()
            .absolute()
            .left(0)
            .right(0)
            .h(2)
            .bg(t.accent)
            .when(fromIndex < targetIndex, (line) => line.bottom(0))
            .when(fromIndex > targetIndex, (line) => line.top(0)),
        ),
      )
      .on_mouse_down("left", () => {
        this.pressed = targetSpace.id;
        this.over = targetSpace.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = sp.find((s) => s.id === this.pressed);
        const over = source && (source.machine ?? null) === grp.machine ? targetSpace.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === targetSpace.id && from !== targetSpace.id) {
          if (targetIndex !== -1) run("space.move", { id: from, index: targetIndex + 1 });
        } else if (from === targetSpace.id) {
          run("space.select", { id: targetSpace.id });
        }
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu(targetSpace);
      })
      .child(
        h_flex()
          .size(16)
          .flex_none()
          .rounded(4)
          .bg(fill)
          .items_center()
          .justify_center()
          .text_size(9.5)
          .font_bold()
          .text_color("#ffffff")
          .child([...grp.name][0]?.toUpperCase() ?? "?"),
      )
      .child(div().flex_shrink(1).min_w(44).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(grp.name))
      .child(div().flex_1().min_w(2))
      .when(Boolean(grp.branch), (el) =>
        el.child(
          h_flex()
            .flex_shrink(2)
            .min_w(26)
            .gap(3)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(svg("mods/workspace-chrome/branch.svg").size(10).flex_none())
            .child(div().min_w(0).truncate().child(grp.branch)),
        ),
      );

    const rows = grp.items.map((it, idx) => this.renderAgentRow(it, grp, idx === grp.items.length - 1, t));
    return [header, ...rows];
  }

  renderAgentRow(it, grp, isLast, t) {
    const lineColor = t.input;
    const bright = it.isFocused || grp.active || it.status === "blocked";
    const spec = it.iconSpec;
    const iconColor = spec.color ?? (bright ? t.foreground : t.muted);
    const pic = spec.tint
      ? svg(spec.icon).size(14).flex_none().text_color(iconColor)
      : image(spec.icon).w(14).h(14).flex_none();

    let tailEl = null;
    if (it.status === "working") {
      tailEl = svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900);
    } else if (it.status === "blocked") {
      tailEl = div()
        .size(14)
        .flex_none()
        .rounded(4)
        .bg(t.blocked + "26")
        .text_size(10)
        .font_bold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .justify_center()
        .child("!");
    } else if (it.status === "done") {
      tailEl = svg("mods/workspace-chrome/circle-check.svg").size(13).flex_none().text_color(t.ansi2);
    } else if (it.age) {
      tailEl = div().flex_none().text_size(11).text_color(t.dim).child(it.age);
    }

    return h_flex()
      .id(`sp-ag-${it.pane}`)
      .h(28)
      .px(6)
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(it.isFocused, (el) => el.bg(t.selected))
      .when(!it.isFocused, (el) => el.hover((s) => s.bg(t.hover)))
      .tooltip(it.title)
      .on_click(() => run("pane.focus", { pane: it.pane }))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.menu(it.space);
      })
      .child(
        div()
          .relative()
          .w(16)
          .h(28)
          .flex_none()
          .child(div().absolute().left(7).top(0).w(9).h(15).border_l(1).border_b(1).rounded_bl(5).border_color(lineColor))
          .when(!isLast, (el) => el.child(div().absolute().left(7).top(11).bottom(0).w(1).border_l(1).border_color(lineColor))),
      )
      .child(pic)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12)
          .when(bright, (el) => el.font_medium().text_color(t.foreground))
          .when(!bright, (el) => el.text_color(t.muted))
          .child(it.title),
      )
      .when(Boolean(tailEl), (el) => el.child(tailEl));
  }

  grouped(t, collapsed) {
    const sp = spaces();
    const ps = panes();
    const ag = agents();
    const terms = terminals();
    const foc = focused();

    if (collapsed) {
      const visible = sp.filter((w) => this.shown.has(w.id));
      const rows = visible.map((w, i) => ({ w, i }));
      const draw = (r) => this.compact(r, t);
      this.activeAt = -1;
      let before = 0;
      const remote = [
        ...new Set([...rows.map((r) => r.w.machine).filter(Boolean), ...this.machines.map((m) => m.name), ...Object.keys(this.reconnecting)]),
      ].sort();
      if (!remote.length) {
        this.activeAt = rows.findIndex((r) => r.w.active);
        return rows.map(draw);
      }
      return [null, ...remote].flatMap((m) => {
        const mine = rows.filter((r) => (r.w.machine ?? null) === m);
        const folded = this.folded.has(m);
        const machine = this.machines.find((k) => k.name === m) ?? this.reconnecting[m]?.machine;
        const connected = !m || machine?.state === "connected";
        const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
        const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
        const head = railCell(
          h_flex()
            .id(`machine-${m ?? "local"}`)
            .mt(4)
            .w(RAIL_CELL)
            .h(22)
            .justify_center()
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              folded ? this.folded.delete(m) : this.folded.add(m);
              localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
              cx.notify();
            })
            .child(div().relative().flex_none().child(icon).when(Boolean(m), (el) => el.child(badge))),
        );
        const items = [head, ...(folded ? [] : mine.map(draw))];
        const first = folded ? -1 : mine.findIndex((r) => r.w.active);
        if (first >= 0) this.activeAt = before + 1 + first;
        before += items.length;
        return items;
      });
    }

    const groups = this.buildFolderGroups(sp, ps, ag, terms, foc);
    this.activeAt = -1;
    let before = 0;
    const remote = [
      ...new Set([...groups.map((g) => g.machine).filter(Boolean), ...this.machines.map((m) => m.name), ...Object.keys(this.reconnecting)]),
    ].sort();

    const loading = (m) => {
      const layoutState = machines().find((k) => k.name === m)?.layout;
      return (
        layoutState === "loading" ||
        (!layoutState && this.machines.some((k) => k.name === m && k.state === "connected")) ||
        sp.some((s) => (s.machine ?? null) === m && !this.shown.has(s.id))
      );
    };
    const loadingRow = (m) =>
      h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).items_center().text_size(12).text_color(t.dim).child("Loading…");

    const emitGroups = (list, offset) => {
      const out = [];
      for (const grp of list) {
        const elements = this.renderFolderGroup(grp, t, sp);
        if (this.activeAt < 0 && grp.active) {
          const focusedOffset = grp.items.findIndex((it) => it.isFocused);
          this.activeAt = offset + out.length + (focusedOffset >= 0 ? 1 + focusedOffset : 0);
        }
        out.push(...elements);
      }
      return out;
    };

    if (!remote.length) {
      if (loading(null) && !groups.length) return [loadingRow(null)];
      return emitGroups(groups, 0);
    }

    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = groups.filter((g) => g.machine === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find((k) => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();

      const head = h_flex()
        .id(`machine-${m ?? "local"}`)
        .h(22)
        .flex_none()
        .px(6)
        .gap(5)
        .items_center()
        .text_size(11)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, (el) =>
          el.child(
            div()
              .id(`machine-logout-${m}`)
              .flex_none()
              .text_color(t.blocked)
              .tooltip("Agents stop when you disconnect. Click for the fix.")
              .on_click((_e, cx) => {
                cx.stop_propagation();
                openOverlay({ mod: "machine-add", kind: "dialog", width: 560 });
              })
              .child("⚠"),
          ),
        )
        .child(icon)
        .child(div().flex_1().truncate().child(m ?? "This computer"))
        .when(!connected && !rebuilt && !login, (el) => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
        .when(rebuilt, (el) =>
          el.child(
            h_flex()
              .flex_none()
              .gap(3)
              .items_center()
              .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
              .child(
                div()
                  .id(`machine-connect-${m}`)
                  .text_color(repair?.error ? t.blocked : t.muted)
                  .hover((s) => s.text_color(t.foreground))
                  .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.reconnect(machine, cx);
                  })
                  .child(repair?.busy ? "Connecting…" : "Connect"),
              ),
          ),
        )
        .when(connected, (el) =>
          el.child(
            div()
              .id(`machine-add-${m ?? "local"}`)
              .flex_none()
              .px(4)
              .rounded(4)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("space.new", { machine: m ?? "" });
              })
              .child("+"),
          ),
        )
        .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none());

      const empty = h_flex()
        .id(`machine-new-${m ?? "local"}`)
        .h(28)
        .flex_none()
        .px(8)
        .gap(7)
        .items_center()
        .rounded(7)
        .text_size(12)
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          run("space.new", { machine: m ?? "" });
        })
        .child(svg("mods/workspace-chrome/plus.svg").size(12))
        .child("New space there");

      if (rebuilt) {
        before += 1;
        return [head];
      }
      const guidance = login
        ? [
            v_flex()
              .px(8)
              .pb(6)
              .gap(3)
              .flex_none()
              .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
                  .child(
                    div()
                      .id(`machine-login-copy-${m}`)
                      .flex_none()
                      .px(5)
                      .py(2)
                      .rounded(4)
                      .text_size(11)
                      .text_color(t.foreground)
                      .bg(t.raised)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        cx.write_to_clipboard(login);
                        this.copiedLogin = login;
                        cx.notify();
                      })
                      .child(this.copiedLogin === login ? "Copied" : "Copy"),
                  ),
              ),
          ]
        : [];
      const bodyOffset = before + 1 + guidance.length;
      const body = folded ? [] : mine.length ? emitGroups(mine, bodyOffset) : [loading(m) ? loadingRow(m) : empty];
      const items = [head, ...guidance, ...body];
      before += items.length;
      return items;
    });
  }

  compact({ w, i }, t) {
    return railCell(
      h_flex()
        .id(`space-${w.id}`)
        .relative()
        .w(RAIL_CELL)
        .h(26)
        .rounded(6)
        .justify_center()
        .items_center()
        .when(w.active, (el) => el.bg(t.selected))
        .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => run("space.select", { id: w.id }))
        .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
        .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))),
    );
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map((p) => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    const active = sp.find((p) => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(12.5)
      .child(
        h_flex()
          .h(26)
          .pl(10)
          .pr(6)
          .items_center()
          .justify_between()
          .text_size(11)
          .text_color(t.dim)
          .when(collapsed, (el) => el.pl(0).pr(0).justify_center())
          .when(!collapsed, (el) => el.child("Spaces"))
          .child(
            div()
              .id("space-new")
              .size(22)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(5)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => run("space.new", { machine: spaces().find((s) => s.active)?.machine ?? "" }))
              .child(svg("mods/workspace-chrome/plus.svg").size(13)),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(0)
          .px(collapsed ? 0 : 6)
          .pb(8)
          .overflow_y_scrollbar()
          .mode("always")
          .track_scroll(this.scroll)
          .on_size_change((_size, cx) => {
            if (this.activeAt >= 0) {
              this.scroll.scroll_to_item(this.activeAt);
              cx.notify();
            }
          })
          .on_mouse_up("left", (_e, cx) => {
            this.pressed = null;
            cx.notify();
          })
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            const m = spaces().find((s) => s.active)?.machine ?? null;
            openOverlay({ mod: "ide-space-menu", kind: "popup", width: 260, height: 72, props: { tab: "blank", machine: m ?? "" } });
          })
          .children(list),
      );
  }
}
