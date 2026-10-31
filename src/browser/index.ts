// Browser entry: TPS workspace panel (live rate + history) and workspace label.
// Panel data arrives over a push channel when the host supports it
// (server watches the workspace files); polling is the fallback.
// Render stays synchronous by caching the last fetch and re-rendering.

import type {
  PiWebPlugin,
  WorkspaceLabelContext,
  WorkspacePanelContext,
  WorkspacePanelHost,
} from "@jmfederico/pi-web/plugin-api";
import { isTpsLive, mergeSamples, mergeTurns, normalizeSample, normalizeTurn, UNKNOWN_TTFT, type TpsLive, type TpsSample, type TpsTurn } from "./protocol.js";

import { contextPressure, fleetStats, fmtCost, fmtDur, fmtPartialCost, hasUnaccountedGap, perModelCost, sessionLabel, shortSessionId, unaccountedMs } from "./models.js";
import { openWatchChannel, pairedRequest } from "./paired.js";

const POLL_MS = 2000;
const KEEPALIVE_MS = 15000;
const FETCH_STALE_MS = 1500;
// Silence this long on an open channel means it died without telling us: drop
// it and reconnect, never sit on a zombie that claims to be live.
const PUSH_DEAD_MS = 8000;
const REOPEN_MIN_MS = 5000;
const HISTORY_LIMIT = 500; // match companion MAX_HISTORY + server MAX_LIMIT: the panel sees every row on disk
const PAGE_SIZE = 10;
// Sparkline shows the most recent rows: rated messages get height, unrated
// ones a faint tick, so density survives even when most rows are unrated.
const SPARKLINE_LIMIT = 100;

interface PanelState {
  live: TpsLive | undefined;
  history: TpsSample[];
  turns: TpsTurn[];
  view: "messages" | "turns" | "tools" | "fleet";
  toolSort: "slow" | "recent";
  status: string;
  fetching: boolean;
  lastFetch: number;
  lastFrame: number;
  livePush: boolean;
  filter: string;
  page: number;
  expanded: string[];
}

function keyFor(machineId: string, projectId: string, workspaceId: string): string {
  return JSON.stringify([machineId, projectId, workspaceId]);
}

function fmtRate(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

function fmtMs(ms: number): string {
  if (ms < 0) return "–";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Decode rate cell: generation speed after the first token, else "–". */
function decodeRate(n: number | undefined): string {
  return typeof n === "number" && n >= 0 ? fmtRate(n) : "–";
}

/** Pre-response window (turn_start -> first message_start). 0 means the row predates
 * the field or the turn never produced an assistant message; both render as "–". */
function preResp(ms: number | undefined): string {
  return ms && ms > 0 ? fmtMs(ms) : "–";
}

function cacheHit(s: TpsSample): string {
  const total = s.input + s.cacheRead;
  if (s.cacheRead <= 0 || total <= 0) return "–";
  return `${Math.round((s.cacheRead / total) * 100)}%`;
}

interface ModelStat {
  model: string;
  count: number;
  sessions: number;
  avgTps: number;
  avgTtft: number;
  fails: number;
}

function modelStats(history: TpsSample[]): ModelStat[] {
  const byModel = new Map<string, TpsSample[]>();
  for (const s of history) {
    const list = byModel.get(s.model) ?? [];
    list.push(s);
    byModel.set(s.model, list);
  }
  return [...byModel.entries()].map(([model, list]) => {
    const good = list.filter((s) => s.streamed && s.status === "ok");
    const out = good.reduce((a, s) => a + s.output, 0);
    const ms = good.reduce((a, s) => a + s.durationMs, 0);
    const ttfts = good.map((s) => s.ttftMs).filter((t) => t >= 0);
    return {
      model,
      count: list.length,
      sessions: new Set(list.map((s) => s.sessionId).filter(Boolean)).size,
      avgTps: ms > 0 ? Math.round((out / (ms / 1000)) * 10) / 10 : 0,
      avgTtft: ttfts.length ? ttfts.reduce((a, t) => a + t, 0) / ttfts.length : UNKNOWN_TTFT,
      fails: list.filter((s) => s.status === "failed").length,
    };
  });
}

function shortModel(id: string): string {
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return base.length > 22 ? base.slice(0, 21) + "…" : base;
}

function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function clockShort(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "--:--" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function ctxCell(s: TpsSample): string {
  const p = contextPressure(s.model, s.input, s.cacheRead);
  if (p === undefined) return "–";
  return `${Math.round(p * 100)}%${p >= 0.8 ? " ⚠" : ""}`;
}

interface ToolRow {
  ts: string;
  sessionId: string;
  sessionName?: string;
  turnIndex: number;
  name: string;
  durationMs: number;
  isError: boolean;
  detail?: string;
}

interface ToolStat {
  name: string;
  calls: number;
  ms: number;
  fails: number;
  detail?: string;
}

function toolRows(turns: TpsTurn[], sort: "slow" | "recent"): ToolRow[] {
  const out: ToolRow[] = [];
  for (const t of turns) {
    for (const c of t.tools) {
      out.push({ ts: t.ts, sessionId: t.sessionId, ...(t.sessionName !== undefined ? { sessionName: t.sessionName } : {}), turnIndex: t.turnIndex, name: c.name, durationMs: c.durationMs, isError: c.isError, ...(c.detail !== undefined ? { detail: c.detail } : {}) });
    }
  }
  return sort === "slow"
    ? out.sort((a, b) => b.durationMs - a.durationMs)
    : out.sort((a, b) => b.ts.localeCompare(a.ts) || b.turnIndex - a.turnIndex || a.name.localeCompare(b.name));
}

function toolStats(rows: ToolRow[]): ToolStat[] {
  const totals = new Map<string, ToolStat>();
  for (const r of rows) {
    const s = totals.get(r.name) ?? { name: r.name, calls: 0, ms: 0, fails: 0 };
    s.calls += 1;
    s.ms += r.durationMs;
    if (r.isError) s.fails += 1;
    if (s.detail === undefined && r.detail !== undefined) s.detail = r.detail;
    totals.set(r.name, s);
  }
  return [...totals.values()].sort((a, b) => b.ms - a.ms);
}

function markOf(s: TpsSample): string {
  if (s.status === "failed") return "✗";
  if (!s.streamed) return "↺";
  if (s.stalled) return "⚠";
  return "";
}

function titleOf(s: TpsSample): string {
  if (s.status === "failed") return `Failed: ${s.stopReason || "unknown"}`;
  if (!s.streamed) return "Replayed/buffered, not generated live: excluded from averages";
  if (s.stalled) return "Stalled: a mid-stream pause over 3 s";
  return s.approx ? "Estimated (no provider usage)" : "Measured";
}

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "TPS Monitor",
  activate({ html }) {
    const states = new Map<string, PanelState>();
    const hosts = new Set<WorkspacePanelHost>();
    const channels = new Map<string, { close: () => void }>();
    const opening = new Set<string>();
    const lastAttempt = new Map<string, number>();
    let disposed = false;
    const timer = setInterval(() => {
      for (const host of hosts) {
        try {
          host.requestRender();
        } catch {
          // host gone; dropped on next render cycle
        }
      }
    }, POLL_MS);
    if (typeof timer.unref === "function") timer.unref();

    const stateFor = (context: WorkspacePanelContext): PanelState => {
      const key = keyFor(context.machine.id, context.workspace.projectId, context.workspace.id);
      let state = states.get(key);
      if (!state) {
        state = { live: undefined, history: [], turns: [], view: "messages", toolSort: "recent", status: "Loading…", fetching: false, lastFetch: 0, lastFrame: 0, livePush: false, filter: "", page: 0, expanded: [] };
        states.set(key, state);
      }
      return state;
    };

    function applySnapshot(state: PanelState, liveRaw: unknown, histRaw: unknown, turnRaw: unknown): void {
      state.live = isTpsLive(liveRaw) ? liveRaw : undefined;
      // Merge, never replace: a torn read or partial snapshot must not shrink
      // good state (mergeSamples/mergeTurns keep the newest HISTORY_LIMIT).
      const hist = Array.isArray(histRaw) ? histRaw.map((r) => normalizeSample(r)).filter((s): s is TpsSample => !!s) : [];
      const turns = Array.isArray(turnRaw) ? turnRaw.map((r) => normalizeTurn(r)).filter((t): t is TpsTurn => !!t) : [];
      if (hist.length > 0) state.history = mergeSamples(state.history, hist, HISTORY_LIMIT);
      else if (state.history.length === 0) state.history = [];
      if (turns.length > 0) state.turns = mergeTurns(state.turns, turns, HISTORY_LIMIT);
      else if (state.turns.length === 0) state.turns = [];
      state.lastFetch = Date.now();
      state.lastFrame = Date.now();
      const n = state.history.length;
      state.status = n === 0 ? "No samples yet in this workspace — ask something in any session, then watch this tab." : `${n} recent message(s), ${state.turns.length} turn(s).`;
    }

    interface Accumulating {
      live: unknown;
      history: unknown[];
      turns: unknown[];
      historyTotal: number;
      turnsTotal: number;
    }
    const accumulators = new Map<string, Accumulating>();

    function onFrame(key: string, state: PanelState, context: WorkspacePanelContext, data: unknown): void {
      const f = data as { type?: unknown; live?: unknown; history?: unknown; turns?: unknown; kind?: unknown; rows?: unknown; historyTotal?: unknown; turnsTotal?: unknown };
      if (f.type === "snapshot-start") {
        accumulators.set(key, {
          live: f.live,
          history: [],
          turns: [],
          historyTotal: typeof f.historyTotal === "number" ? f.historyTotal : 0,
          turnsTotal: typeof f.turnsTotal === "number" ? f.turnsTotal : 0,
        });
        return;
      }
      if (f.type === "snapshot-part") {
        const acc = accumulators.get(key);
        if (!acc) return;
        if (f.kind === "history" && Array.isArray(f.rows)) acc.history.push(...f.rows);
        if (f.kind === "turns" && Array.isArray(f.rows)) acc.turns.push(...f.rows);
        return;
      }
      if (f.type === "snapshot-done") {
        const acc = accumulators.get(key);
        accumulators.delete(key);
        if (!acc) return;
        // Frames can arrive out of order or get dropped: never let a partial
        // snapshot clobber good state. Incomplete → force a full fetch instead.
        if (acc.history.length >= acc.historyTotal && acc.turns.length >= acc.turnsTotal) {
          applySnapshot(state, acc.live, acc.history, acc.turns);
        } else {
          state.lastFetch = 0;
          void fetchState(context, state);
        }
        state.livePush = true;
        state.lastFrame = Date.now();
        if (!disposed) context.host.requestRender();
        return;
      }
      // Incremental update (small by construction).
      applyUpdate(state, f.live ?? state.live, f.history ?? [], f.turns ?? []);
      state.livePush = true;
      state.lastFrame = Date.now();
      if (!disposed) context.host.requestRender();
    }

    function applyUpdate(state: PanelState, liveRaw: unknown, histRaw: unknown, turnRaw: unknown): void {
      if (isTpsLive(liveRaw)) state.live = liveRaw;
      // Updates arrive newest-first; merge ahead of the cached rows and cap.
      const freshH = Array.isArray(histRaw) ? histRaw.map((r) => normalizeSample(r)).filter((s): s is TpsSample => !!s) : [];
      const freshT = Array.isArray(turnRaw) ? turnRaw.map((r) => normalizeTurn(r)).filter((t): t is TpsTurn => !!t) : [];
      if (freshH.length) state.history = mergeSamples(state.history, freshH, HISTORY_LIMIT);
      if (freshT.length) state.turns = mergeTurns(state.turns, freshT, HISTORY_LIMIT);
      state.lastFetch = Date.now();
      const n = state.history.length;
      state.status = n === 0 ? "No samples yet in this workspace — ask something in any session, then watch this tab." : `${n} recent message(s), ${state.turns.length} turn(s).`;
    }

    async function fetchState(context: WorkspacePanelContext, state: PanelState): Promise<void> {
      if (state.fetching) return;
      const scope = { projectId: context.workspace.projectId, workspaceId: context.workspace.id };
      state.fetching = true;
      try {
        const [liveRaw, histRaw, turnRaw]: unknown[] = await Promise.all([
          pairedRequest(scope, "live", null),
          pairedRequest(scope, "history", { limit: HISTORY_LIMIT }),
          pairedRequest(scope, "turns", { limit: HISTORY_LIMIT }),
        ]);
        applySnapshot(state, liveRaw, histRaw, turnRaw);
      } catch (error) {
        state.status = error instanceof Error ? error.message : String(error);
      } finally {
        state.fetching = false;
        if (!disposed) context.host.requestRender();
      }
    }

    /** Push channel (TPS-26): the server watches the workspace files and sends
     * fresh rows over the paired-backend WebSocket; polling below stays the
     * fallback for a refused or failed channel. */
    async function openWatch(context: WorkspacePanelContext, state: PanelState, key: string): Promise<void> {
      // Throttle attempts: a failing transport must never become a storm.
      if (channels.has(key) || opening.has(key)) return;
      if (Date.now() - (lastAttempt.get(key) ?? 0) < REOPEN_MIN_MS) return;
      lastAttempt.set(key, Date.now());
      opening.add(key);
      try {
        const scope = { projectId: context.workspace.projectId, workspaceId: context.workspace.id };
        const ch = await openWatchChannel(scope, { limit: HISTORY_LIMIT }, {
          onData: (data) => {
            try {
              onFrame(key, state, context, data);
            } catch {
              // malformed frame: ignore, polling covers it
            }
          },
        });
        if (disposed) {
          try { ch.close(); } catch { /* already closed */ }
          return;
        }
        const entry = { close: () => { try { ch.close(); } catch { /* already closed */ } } };
        channels.set(key, entry);
        const done = () => {
          // Only remove the registration this channel owns: a superseded
          // channel must not delete its replacement (watchdog reconnect race).
          if (channels.get(key) === entry) channels.delete(key);
          accumulators.delete(key);
          if (!disposed) {
            state.livePush = false;
            context.host.requestRender();
          }
        };
        void ch.closed.then(done, done);
      } catch {
        // backend unreachable or watch unsupported: polling covers it.
      } finally {
        opening.delete(key);
      }
    }

    /** Drop a channel that has gone silent, and reconnect. Without this a
     * channel whose server side stopped pushing looks perfect (`● live`, no
     * errors) while every number on screen freezes. */
    function rewatch(context: WorkspacePanelContext, state: PanelState, key: string): void {
      const channel = channels.get(key);
      channels.delete(key);
      accumulators.delete(key);
      state.livePush = false;
      if (channel !== undefined) {
        try { channel.close(); } catch { /* already gone */ }
      }
      // Fetch now so the panel is fresh regardless of what the new channel does.
      state.lastFetch = 0;
      void fetchState(context, state);
      void openWatch(context, state, key);
    }

    function maybeFetch(context: WorkspacePanelContext, state: PanelState): void {
      const key = keyFor(context.machine.id, context.workspace.projectId, context.workspace.id);
      if (state.livePush && Date.now() - state.lastFrame > PUSH_DEAD_MS) rewatch(context, state, key);
      else void openWatch(context, state, key);
      // With push live, poll only as a keepalive; otherwise the classic 2 s loop.
      const staleMs = state.livePush ? KEEPALIVE_MS : FETCH_STALE_MS;
      if (!state.fetching && Date.now() - state.lastFetch >= staleMs) {
        void fetchState(context, state);
      }
    }

    return {
      contributions: {
        workspacePanels: [
          {
            id: "tps",
            title: "TPS",
            render(context) {
              const state = stateFor(context);
              hosts.add(context.host);
              maybeFetch(context, state);
              // The tables are the surface: no headline, no status line, no live
              // strip above them (the newest row already is the newest message, and
              // the workspace label carries the in-flight rate).
              const ratedCount = state.history.filter((s) => s.streamed && s.status === "ok").length;
              const unratedCount = state.history.length - ratedCount - state.history.filter((s) => s.status === "failed").length;
              const sparkRows = state.history.slice(0, SPARKLINE_LIMIT).reverse();
              const max = Math.max(1, ...sparkRows.filter((s) => s.streamed).map((s) => s.tps));
              const stats = modelStats(state.history);
              const q = state.filter.trim().toLowerCase();
              const isTurns = state.view === "turns";
              const isTools = state.view === "tools";
              // `#12` filters to one turn index; plain text matches model/session/tool.
              const turnNum = q.startsWith("#") ? parseInt(q.slice(1), 10) : NaN;
              const openSession = (id: string, name?: string): void => {
                if (!id) {
                  state.filter = name ?? "";
                  state.page = 0;
                  context.host.requestRender();
                  return;
                }
                // Jump to the session when the host supports it (TPS-27);
                // fall back to filtering this panel when it does not.
                try {
                  const nav = (context as WorkspacePanelContext).navigate;
                  if (typeof nav === "function") {
                    void Promise.resolve(nav({ sessionId: id })).catch(() => {
                      state.filter = name ?? shortSessionId(id);
                      state.page = 0;
                      context.host.requestRender();
                    });
                    return;
                  }
                } catch {
                  // fall through to filter
                }
                state.filter = name ?? shortSessionId(id);
                state.page = 0;
                context.host.requestRender();
              };
              // Plain text matches model, session name/id or tool.
              const matchSession = (id: string, name: string | undefined): boolean =>
                id.toLowerCase().startsWith(q) || (name !== undefined && name.toLowerCase().includes(q));
              const isFleet = state.view === "fleet";
              const listedMsgs = isTurns || isTools || isFleet
                ? []
                : state.history.filter(
                    (s) => !q || s.model.toLowerCase().includes(q) || matchSession(s.sessionId, s.sessionName) || (!Number.isNaN(turnNum) && s.turnIndex === turnNum),
                  );
              const listedTurns = isTurns
                ? state.turns.filter(
                    (t) =>
                      (!Number.isNaN(turnNum) && t.turnIndex === turnNum) ||
                      (!q ||
                        t.model.toLowerCase().includes(q) ||
                        matchSession(t.sessionId, t.sessionName) ||
                        t.tools.some((c) => c.name.toLowerCase().includes(q))),
                  )
                : [];
              const allToolRows = isTools ? toolRows(state.turns, state.toolSort) : [];
              const fleet = isFleet ? fleetStats(state.history, state.turns).filter((f) => !q || matchSession(f.sessionId, f.name)) : [];
              const listedTools = allToolRows.filter(
                (r) => !q || r.name.toLowerCase().includes(q) || matchSession(r.sessionId, r.sessionName) || (r.detail !== undefined && r.detail.toLowerCase().includes(q)),
              );
              const listedCount = isTurns ? listedTurns.length : isTools ? listedTools.length : isFleet ? fleet.length : listedMsgs.length;
              const pages = Math.max(1, Math.ceil(listedCount / PAGE_SIZE));
              const page = Math.min(state.page, pages - 1);
              const visible = listedMsgs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              const visibleT = listedTurns.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              const visibleTools = listedTools.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              const visibleF = fleet.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              const statsTools = toolStats(listedTools);
              const placeholders: Record<string, string> = {
                messages: "model or session…  •  #N = turn",
                turns: "model, session, tool or #N",
                tools: "tool, detail or session",
                fleet: "session",
              };

              return html`<section class="tps"><style>
  .tps table { border-collapse: collapse; }
  .tps th, .tps td { padding: 4px 6px; text-align: left; vertical-align: middle; border-bottom: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
  .tps thead th { border-bottom: 2px solid color-mix(in srgb, currentColor 40%, transparent); }
  .tps button { line-height: 1.3; }
  .tps .sessbtn { max-width: 20ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .tps .legend { border-collapse: collapse; margin: 0.4em 0; }
  .tps .legend td { border-bottom: none; padding: 2px 8px 2px 0; vertical-align: top; }
  @media (pointer: coarse) {
    .tps button { min-height: 44px; }
    /* Table cells stay dense: 44px per row would triple the table height
       on a phone (the user's screenshot showed ~60px rows). 32px remains
       tappable inside a table; full 44px stays on panel-level controls. */
    .tps td button { min-height: 32px; padding: 2px 6px; font-size: 0.92em; }
  }
  @media (max-width: 640px) {
    .tps-narrow-hide { display: none; }
    td.tps-model { display: inline-block; max-width: 15ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
    .tps .sessbtn { max-width: 12ch; }
    .tps .sortrow { display: flex; gap: 6px; }
    .tps .sortrow button { flex: 1 1 0; white-space: nowrap; }
    .tps .spark { height: 32px !important; }
  }
</style>
                <p class="spark" aria-hidden="true" role="img" aria-label="Recent tokens per second, tallest bar fastest" style="display: flex; align-items: flex-end; gap: 2px; height: 48px; margin: 0.6em 0;">
                  ${sparkRows.map(
                    (s) => s.streamed
                      ? html`<span
                          title="${clock(s.ts)} ${s.tps} t/s ${shortModel(s.model)}"
                          style="flex: 1 1 0; min-width: 0; background: currentColor; opacity: 0.65; height: ${Math.max(4, Math.round((s.tps / max) * 100))}%;"
                        ></span>`
                      : html`<span
                          title="${clock(s.ts)} unrated ${shortModel(s.model)}"
                          style="flex: 1 1 0; min-width: 0; background: currentColor; opacity: 0.22; height: 4%;"
                        ></span>`,
                  )}
                </p>
                ${state.history.length || state.turns.length
                  ? html`<p>
                      <button ?disabled=${state.view === "messages"} @click=${() => { state.view = "messages"; state.page = 0; context.host.requestRender(); }}>Messages</button>
                      <button ?disabled=${state.view === "turns"} @click=${() => { state.view = "turns"; state.page = 0; context.host.requestRender(); }}>Turns</button>
                      <button ?disabled=${state.view === "tools"} @click=${() => { state.view = "tools"; state.page = 0; context.host.requestRender(); }}>Tools</button>
                      <button ?disabled=${state.view === "fleet"} @click=${() => { state.view = "fleet"; state.page = 0; context.host.requestRender(); }}>Fleet</button>
                    </p>
                    <label>Filter <input
                      type="search"
                      placeholder=${placeholders[state.view] ?? "filter"}
                      .value=${state.filter}
                      @input=${(event: Event) => {
                        if (event.target instanceof HTMLInputElement) {
                          state.filter = event.target.value;
                          state.page = 0;
                          context.host.requestRender();
                        }
                      }}></label>
                    ${!isTurns && !isTools && !isFleet && unratedCount > 0
                      ? html`<p><small>${unratedCount} of the last ${state.history.length} message(s) unrated: tool-only turns stream no text (see legend).</small></p>`
                      : ""}
                    ${isTurns
                      ? html`<div style="overflow-x: auto;"><table style="white-space: nowrap;">
                          <thead><tr><th></th><th>Time</th><th>Turn</th><th class="tps-narrow-hide">Msgs</th><th class="tps-narrow-hide">Sess</th><th>LLM</th><th class="tps-narrow-hide">Pre</th><th>t/s</th><th class="tps-narrow-hide">Dec</th><th class="tps-narrow-hide">TTFT</th><th>Tools</th><th class="tps-narrow-hide">Tool time</th><th>Total</th></tr></thead>
                          <tbody>
                            ${visibleT.flatMap((t) => {
                              const key = `${t.sessionId}#${t.turnIndex}`;
                              const open = state.expanded.includes(key);
                              const toggle = html`<button aria-label=${open ? "collapse" : "expand"} @click=${() => {
                                state.expanded = open ? state.expanded.filter((k) => k !== key) : [...state.expanded, key];
                                context.host.requestRender();
                              }}>${open ? "–" : "+"}</button>`;
                              const row = html`<tr title=${`${t.model}${t.provider ? ` via ${t.provider}` : ""}${t.tools.length ? " · " : ""}` + (t.tools.map((c) => `${c.name} ${fmtDur(c.durationMs)}${c.isError ? " ✗" : ""}${c.detail ? ` — ${c.detail}` : ""}`).join(", ") || "no tool calls")}>
                                <td>${t.outcome === "completed" ? toggle : html`✗ ${toggle}`}</td>
                                <td>${clock(t.ts)}</td>
                                <td>#${t.turnIndex}</td>
                                <td class="tps-narrow-hide">${t.llmMessages}</td>
                                <td class="tps-narrow-hide"><button class="sessbtn" @click=${() => { openSession(t.sessionId, t.sessionName); }} title=${`${t.sessionName ?? t.sessionId}\nClick: open session`} >${sessionLabel(t.sessionId, t.sessionName)}</button></td>
                                <td>${fmtDur(t.llmDurationMs)}</td>
                                <td class="tps-narrow-hide" title="turn_start → first assistant message_start: the provider roundtrip window (the tax the stream clock cannot see)">${preResp(t.preResponseMs)}</td>
                                <td>${t.streamed ? html`${fmtRate(t.tps)}` : html`–`}</td>
                                <td class="tps-narrow-hide">${t.streamed ? decodeRate(t.decodeTps) : "–"}</td>
                                <td class="tps-narrow-hide">${fmtMs(t.ttftMs)}</td>
                                <td>${t.tools.length ? t.tools.slice(0, 3).map((c) => c.name).join(", ") : "–"}</td>
                                <td class="tps-narrow-hide">${fmtDur(t.toolMsTotal)}</td>
                                <td title=${`LLM ${fmtDur(t.llmDurationMs)} + tools ${fmtDur(t.toolMsTotal)} + pre ${preResp(t.preResponseMs)} + gap ${fmtDur(unaccountedMs(t))} = ${fmtDur(t.turnMsTotal)}`}>${fmtDur(t.turnMsTotal)}${hasUnaccountedGap(t) ? " ⚠" : ""}</td>
                              </tr>`;
                              if (!open) return [row];
                              const detail = html`<tr><td></td><td colspan="12">${t.llmMessages > 1 ? html`<div>${t.llmMessages} messages, ${fmtDur(t.llmDurationMs)} total</div>` : ""}${t.requestedTools > t.tools.length ? html`<div>⚠ ${t.requestedTools} requested, ${t.tools.length} completed</div>` : ""}<div>Wall-clock: LLM ${fmtDur(t.llmDurationMs)} + tools ${fmtDur(t.toolMsTotal)} + pre ${preResp(t.preResponseMs)} + gap ${fmtDur(unaccountedMs(t))} = ${fmtDur(t.turnMsTotal)}</div>${t.tools.length
                                ? t.tools.map((c) => html`<div>${c.name} — ${fmtDur(c.durationMs)}${c.isError ? " ✗" : ""}${c.detail ? html` — ${c.detail}` : ""}</div>`)
                                : html`<em>no tool calls this turn</em>`}</td></tr>`;
                              return [row, detail];
                            })}
                          </tbody>
                        </table></div>`
                      : isTools
                      ? html`${statsTools.length
                          ? html`<h4>Most expensive tools</h4>
                            <table>
                              <thead><tr><th>Tool</th><th>Calls</th><th>Total</th><th>Fails</th></tr></thead>
                              <tbody>
                                ${statsTools.slice(0, 8).map(
                                  (s) => html`<tr title=${s.detail ?? s.name}>
                                    <td>${s.name}</td>
                                    <td>${s.calls}</td>
                                    <td>${fmtDur(s.ms)}</td>
                                    <td>${s.fails || "–"}</td>
                                  </tr>`,
                                )}
                              </tbody>
                            </table>`
                          : ""}
                        <p class="sortrow">
                          <span>${listedTools.length} call(s) from ${state.turns.length} turn(s). Sort call list:</span>
                          <button ?disabled=${state.toolSort === "recent"} @click=${() => { state.toolSort = "recent"; state.page = 0; context.host.requestRender(); }}>Newest-first</button>
                          <button ?disabled=${state.toolSort === "slow"} @click=${() => { state.toolSort = "slow"; state.page = 0; context.host.requestRender(); }}>Slowest-first</button>
                        </p>
                        <p><small>Calls from the running step appear when it finishes.</small></p>
                        <div style="overflow-x: auto;"><table style="white-space: nowrap;">
                          <thead><tr><th></th><th>Time</th><th class="tps-narrow-hide">Sess</th><th>Turn</th><th>Tool</th><th>Detail</th><th>Secs</th></tr></thead>
                          <tbody>
                            ${visibleTools.map(
                              (r) => html`<tr title=${r.detail ?? r.name}>
                                <td>${r.isError ? "✗" : ""}</td>
                                <td>${clock(r.ts)}</td>
                                <td class="tps-narrow-hide"><button class="sessbtn" @click=${() => { openSession(r.sessionId, r.sessionName); }} title=${`${r.sessionName ?? r.sessionId}\nClick: open session`}>${sessionLabel(r.sessionId, r.sessionName)}</button></td>
                                <td>#${r.turnIndex}</td>
                                <td><button @click=${() => {
                                  state.view = "turns";
                                  state.filter = `#${r.turnIndex}`;
                                  state.page = 0;
                                  context.host.requestRender();
                                }} title="Open this turn">${r.name}</button></td>
                                <td class="tps-narrow-hide" style="max-width: 24ch; overflow: hidden; text-overflow: ellipsis;">${r.detail ?? "–"}</td>
                                <td>${fmtDur(r.durationMs)}</td>
                              </tr>`,
                            )}
                          </tbody>
                        </table></div>`
                      : isFleet
                      ? html`<div style="overflow-x: auto;"><table style="white-space: nowrap;">
                      <thead><tr><th>Sess</th><th class="tps-narrow-hide">Msgs</th><th class="tps-narrow-hide">Turns</th><th class="tps-narrow-hide">Done</th><th class="tps-narrow-hide">avg t/s</th><th>Cost</th><th>Waste</th><th class="tps-narrow-hide">Tools</th><th class="tps-narrow-hide">LLM</th><th class="tps-narrow-hide">Span</th><th>Ctx</th></tr></thead>
                      <tbody>
                        ${visibleF.flatMap((f) => {
                          const key = `fleet:${f.sessionId}`;
                          const open = state.expanded.includes(key);
                          const spanMs = f.latestTs >= f.earliestTs && f.latestTs !== "" ? Date.parse(f.latestTs) - Date.parse(f.earliestTs) : 0;
                          const row = html`<tr>
                            <td><button class="sessbtn" @click=${() => { openSession(f.sessionId, f.name); }} title=${`${f.name ?? f.sessionId}\nClick: open session`}>${sessionLabel(f.sessionId, f.name)}</button>
                              <button aria-label=${open ? "collapse" : "expand cost detail"} @click=${() => {
                                state.expanded = open ? state.expanded.filter((k) => k !== key) : [...state.expanded, key];
                                context.host.requestRender();
                              }}>${open ? "–" : "+"}</button></td>
                            <td class="tps-narrow-hide">${f.msgs}</td>
                            <td class="tps-narrow-hide">${f.turns}</td>
                            <td class="tps-narrow-hide" title="Turns with outcome completed">${f.done}</td>
                            <td class="tps-narrow-hide">${fmtRate(f.avgTps)}</td>
                            <td title=${f.unpricedShare > 0 ? `${Math.round(f.unpricedShare * 100)}% of this session's messages have no list price, so this is a floor` : "Estimated spend from priced messages"}>${fmtPartialCost(f.cost, f.msgs - f.unknownCost, f.unknownCost)}</td>
                            <td title="Turns that failed, aborted or produced no output">${f.wastedTurns === 0 ? "–" : `${f.wastedTurns}${f.wastedCost > 0 ? ` ${fmtCost(f.wastedCost)}` : " unpriced"}`}</td>
                            <td class="tps-narrow-hide">${fmtDur(f.toolMs)}</td>
                            <td class="tps-narrow-hide">${fmtDur(f.llmMs)}</td>
                            <td class="tps-narrow-hide" title="First to last activity">${fmtDur(spanMs)}</td>
                            <td>${f.pressure === undefined ? "–" : `${Math.round(f.pressure * 100)}%${f.pressure >= 0.8 ? " ⚠" : ""}`}</td>
                          </tr>`;
                          if (!open) return [row];
                          const models = perModelCost(state.history, f.sessionId);
                          const detail = html`<tr><td></td><td colspan="10"><div>Working: LLM ${fmtDur(f.llmMs)} + tools ${fmtDur(f.toolMs)}; wall span ${fmtDur(spanMs)}.</div>${models.length
                            ? models.map((m) => html`<div>${shortModel(m.model)} — ${m.msgs} msgs, ${m.priced > 0 ? fmtCost(m.cost) : "– unpriced"}${m.unpriced > 0 ? ` (+${m.unpriced} unpriced)` : ""}</div>`)
                            : html`<div>No priced messages.</div>`}</td></tr>`;
                          return [row, detail];
                        })}
                      </tbody>
                    </table></div>`
                      : html`<div style="overflow-x: auto;"><table style="white-space: nowrap;">
                      <thead><tr><th></th><th>Time</th><th>Turn</th><th>Sess</th><th>Model</th><th>Out</th><th>Secs</th><th>t/s</th><th class="tps-narrow-hide">Dec</th><th>TTFT</th><th class="tps-narrow-hide">Hit</th><th class="tps-narrow-hide">Ctx</th></tr></thead>
                      <tbody>
                        ${visible.map(
                          (s) => html`<tr title=${titleOf(s)}>
                            <td>${markOf(s)}</td>
                            <td>${clock(s.ts)}</td>
                            <td>${s.turnIndex !== undefined ? `#${s.turnIndex}` : "–"}</td>
                            <td><button class="sessbtn" @click=${() => { openSession(s.sessionId, s.sessionName); }} title=${`${s.sessionName ?? s.sessionId}\nClick: open session`}>${sessionLabel(s.sessionId, s.sessionName)}</button></td>
                            <td class="tps-model">${shortModel(s.model)}</td>
                            <td>${s.output}</td>
                            <td>${fmtDur(s.durationMs)}</td>
                            <td>${s.streamed ? html`${s.approx ? "~" : ""}${fmtRate(s.tps)}` : html`–`}</td>
                            <td class="tps-narrow-hide">${s.streamed ? decodeRate(s.decodeTps) : "–"}</td>
                            <td>${fmtMs(s.ttftMs)}</td>
                            <td class="tps-narrow-hide">${cacheHit(s)}</td>
                            <td class="tps-narrow-hide">${ctxCell(s)}</td>
                          </tr>`,
                        )}
                      </tbody>
                    </table></div>`}
                    <p>
                      <button ?disabled=${page <= 0} @click=${() => { state.page = page - 1; context.host.requestRender(); }}>‹ Prev</button>
                      <span>Page ${page + 1} of ${pages} (${listedCount} rows)</span>
                      <button ?disabled=${page >= pages - 1} @click=${() => { state.page = page + 1; context.host.requestRender(); }}>Next ›</button>
                    </p>`
                  : html`<p>${state.status}</p>`}
                ${stats.length > 1
                  ? html`<h4>By model</h4>
                    <table>
                      <thead><tr><th>Model</th><th>n</th><th>Sess</th><th>avg t/s</th><th>avg TTFT</th><th>Fails</th></tr></thead>
                      <tbody>
                        ${stats.map(
                          (m) => html`<tr>
                            <td>${shortModel(m.model)}</td>
                            <td>${m.count}</td>
                            <td>${m.sessions || "–"}</td>
                            <td>${fmtRate(m.avgTps)}</td>
                            <td>${fmtMs(m.avgTtft)}</td>
                            <td>${m.fails || "–"}</td>
                          </tr>`,
                        )}
                      </tbody>
                    </table>`
                  : ""}
                <table class="legend">
                  <tbody>
                    <tr><td>✗</td><td>failed request or tool error</td></tr>
                    <tr><td>↺</td><td>replayed/buffered, not generated live — excluded from every average</td></tr>
                    <tr><td>⚠</td><td>stalled mid-stream (a pause over 3 s) or unexplained wall-clock remainder</td></tr>
                    <tr><td>+</td><td>after a cost: a floor, some messages have no price — hover for the share</td></tr>
                    <tr><td>#N</td><td>turn index, 0-based (#0 = the session's first step); #N in Filter jumps to it</td></tr>
                    <tr><td>Dec</td><td>decode tok/s: generation speed after the first token, TTFT excluded</td></tr>
                  </tbody>
                </table>
                ${isFleet
                  ? html`<p><small>Free self-serve preview of the file this view reads
                      (<code>.pi-web/tps-turns.jsonl</code>, parsed in your browser, nothing uploaded):
                      <a href="https://focalis.cc/audit/preview/" target="_blank" rel="noopener">focalis.cc/audit/preview</a>.
                      The audit adds what a turn row cannot contain — the process boot before the first event.</small></p>
                    <p><button
                      @click=${async () => {
                        try {
                          const turns = await pairedRequest({ projectId: context.workspace.projectId, workspaceId: context.workspace.id }, "turns", { limit: HISTORY_LIMIT });
                          const blob = new Blob([JSON.stringify(turns)], { type: "application/json" });
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(blob);
                          a.download = `tps-turns-${context.workspace.id}.json`;
                          a.click();
                          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                        } catch {
                          state.status = "Export failed: backend request rejected.";
                          context.host.requestRender();
                        }
                      }}
                      title="Download the turn file this Fleet view reads (input for the free self-serve preview)"
                    >Export turns</button></p>`
                  : ""}
              </section>`;
            },
          },
        ],
        workspaceLabels: [
          {
            id: "tps-label",
            items(context: WorkspaceLabelContext) {
              const key = keyFor(context.machine.id, context.workspace.projectId, context.workspace.id);
              const state = states.get(key);
              const live = state?.live;
              const stamp = (iso?: string): string => {
                if (!iso) return "no data yet";
                const d = new Date(iso);
                return Number.isNaN(d.getTime()) ? "no data yet" : `as of ${clockShort(iso)}`;
              };
              if (live?.state === "streaming") {
                return [{ type: "text", text: `⚡ ~${fmtRate(live.approxTps)} t/s`, title: `Tokens/sec, streaming estimate (${stamp(live.updatedAt)})` }];
              }
              const last = live?.last ?? state?.history[0];
              if (last) {
                if (!last.streamed) {
                  return [{ type: "text", text: "⚡ –", title: `Last message was replayed, not generated live (${stamp(last.ts)})` }];
                }
                return [{ type: "text", text: `⚡ ${fmtRate(last.tps)} t/s`, title: `Last: ${last.output} tokens in ${fmtDur(last.durationMs)} (${stamp(last.ts)})` }];
              }
              return [{ type: "text", text: "⚡ –", title: "No tokens/sec samples yet in this workspace" }];
            },
          },
        ],
      },
      dispose() {
        disposed = true;
        clearInterval(timer);
        for (const ch of channels.values()) {
          try { ch.close(); } catch { /* already closed */ }
        }
        channels.clear();
        states.clear();
        hosts.clear();
      },
    };
  },
};

export default plugin;
