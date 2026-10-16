// Browser entry: TPS workspace panel (live rate + history) and workspace label.
// Panel data is fetched from the paired server peer; render stays synchronous
// by caching the last fetch and re-rendering when it resolves.

import type {
  PiWebPlugin,
  WorkspaceLabelContext,
  WorkspacePanelContext,
  WorkspacePanelHost,
} from "@jmfederico/pi-web/plugin-api";
import { isTpsLive, normalizeSample, normalizeTurn, UNKNOWN_TTFT, type TpsLive, type TpsSample, type TpsTurn } from "./protocol.js";

const POLL_MS = 2000;
const FETCH_STALE_MS = 1500;
const HISTORY_LIMIT = 500; // match companion MAX_HISTORY + server MAX_LIMIT: the panel sees every row on disk
const PAGE_SIZE = 10;

interface PanelState {
  live: TpsLive | undefined;
  history: TpsSample[];
  turns: TpsTurn[];
  view: "messages" | "turns" | "tools";
  toolSort: "slow" | "recent";
  status: string;
  fetching: boolean;
  lastFetch: number;
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
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toLocaleTimeString();
}

function shortSession(id: string): string {
  return id ? id.slice(0, 8) : "–";
}

interface ToolRow {
  ts: string;
  sessionId: string;
  turnIndex: number;
  name: string;
  durationMs: number;
  isError: boolean;
}

interface ToolStat {
  name: string;
  calls: number;
  ms: number;
  fails: number;
}

function toolRows(turns: TpsTurn[], sort: "slow" | "recent"): ToolRow[] {
  const out: ToolRow[] = [];
  for (const t of turns) {
    for (const c of t.tools) {
      out.push({ ts: t.ts, sessionId: t.sessionId, turnIndex: t.turnIndex, name: c.name, durationMs: c.durationMs, isError: c.isError });
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
  if (s.stalled) return "Stalled mid-stream";
  return s.approx ? "Estimated (no provider usage)" : "Measured";
}

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "TPS Monitor",
  activate({ html }) {
    const states = new Map<string, PanelState>();
    const hosts = new Set<WorkspacePanelHost>();
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
        state = { live: undefined, history: [], turns: [], view: "messages", toolSort: "recent", status: "Loading…", fetching: false, lastFetch: 0, filter: "", page: 0, expanded: [] };
        states.set(key, state);
      }
      return state;
    };

    async function fetchState(context: WorkspacePanelContext, state: PanelState): Promise<void> {
      if (state.fetching) return;
      if (!context.peer?.request) {
        state.status = "Package backend unavailable on this machine (enable plugin + restart session daemon).";
        return;
      }
      state.fetching = true;
      try {
        const [liveRaw, histRaw, turnRaw]: unknown[] = await Promise.all([
          context.peer.request("live", null),
          context.peer.request("history", { limit: HISTORY_LIMIT }),
          context.peer.request("turns", { limit: HISTORY_LIMIT }),
        ]);
        state.live = isTpsLive(liveRaw) ? liveRaw : undefined;
        state.history = Array.isArray(histRaw) ? histRaw.map((r) => normalizeSample(r)).filter((s): s is TpsSample => !!s) : [];
        state.turns = Array.isArray(turnRaw) ? turnRaw.map((r) => normalizeTurn(r)).filter((t): t is TpsTurn => !!t) : [];
        state.lastFetch = Date.now();
        const n = state.history.length;
        state.status = n === 0 ? "No samples yet in this workspace." : `${n} recent message(s), ${state.turns.length} turn(s).`;
      } catch (error) {
        state.status = error instanceof Error ? error.message : String(error);
      } finally {
        state.fetching = false;
        if (!disposed) context.host.requestRender();
      }
    }

    function maybeFetch(context: WorkspacePanelContext, state: PanelState): void {
      if (!state.fetching && Date.now() - state.lastFetch >= FETCH_STALE_MS) {
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
              const live = state.live;
              const streaming = live?.state === "streaming";
              const last: TpsSample | undefined = streaming ? undefined : (live?.last ?? state.history[0]);
              const rated = state.history.filter((s) => s.streamed && s.status === "ok");
              const chrono = [...rated].reverse();
              const max = Math.max(1, ...chrono.map((s) => s.tps));
              const stats = modelStats(state.history);
              const q = state.filter.trim().toLowerCase();
              const isTurns = state.view === "turns";
              const isTools = state.view === "tools";
              // `#12` filters to one turn index; plain text matches model/session/tool.
              const turnNum = q.startsWith("#") ? parseInt(q.slice(1), 10) : NaN;
              const gotoSession = (id: string): void => {
                state.filter = shortSession(id);
                state.page = 0;
                context.host.requestRender();
              };
              const listedMsgs = isTurns || isTools
                ? []
                : state.history.filter(
                    (s) => !q || s.model.toLowerCase().includes(q) || s.sessionId.toLowerCase().startsWith(q),
                  );
              const listedTurns = isTurns
                ? state.turns.filter(
                    (t) =>
                      (!Number.isNaN(turnNum) && t.turnIndex === turnNum) ||
                      (!q ||
                        t.model.toLowerCase().includes(q) ||
                        t.sessionId.toLowerCase().startsWith(q) ||
                        t.tools.some((c) => c.name.toLowerCase().includes(q))),
                  )
                : [];
              const allToolRows = isTools ? toolRows(state.turns, state.toolSort) : [];
              const listedTools = allToolRows.filter(
                (r) => !q || r.name.toLowerCase().includes(q) || r.sessionId.toLowerCase().startsWith(q),
              );
              const listedCount = isTurns ? listedTurns.length : isTools ? listedTools.length : listedMsgs.length;
              const pages = Math.max(1, Math.ceil(listedCount / PAGE_SIZE));
              const page = Math.min(state.page, pages - 1);
              const visible = listedMsgs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              const visibleT = listedTurns.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              const visibleTools = listedTools.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              const statsTools = toolStats(listedTools);

              return html`<section>
                <p style="font-size: 1.6em; margin: 0.4em 0;">
                  ${streaming
                    ? html`⚡ ~${fmtRate(live?.approxTps ?? 0)} <small>t/s streaming</small>${live?.stalled ? html` <small>STALLED</small>` : ""}`
                    : last
                      ? html`⚡ ${fmtRate(last.tps)} <small>t/s last (${shortModel(last.model)})</small>${last.stalled ? html` <small>stalled mid-stream</small>` : ""}`
                      : html`⚡ – <small>no data yet</small>`}
                </p>
                ${streaming
                  ? html`<p role="status">Streaming ${shortModel(live?.model ?? "?")}${live?.ttftMs !== undefined && live.ttftMs >= 0 ? html` — first token in ${fmtMs(live.ttftMs)}` : ""}. Refresh is automatic.</p>`
                  : last
                    ? last.streamed
                      ? html`<p role="status">Last: ${last.output} out tokens in ${(last.durationMs / 1000).toFixed(1)}s${last.approx ? " (estimated)" : ""}, ttft ${fmtMs(last.ttftMs)}, cache hit ${cacheHit(last)} at ${clock(last.ts)}.</p>`
                      : html`<p role="status">Last message was replayed, not generated live — excluded from rates.</p>`
                    : html`<p role="status">Ask something in any session in this workspace, then watch this tab.</p>`}
                <button
                  ?disabled=${state.fetching || !context.peer?.request}
                  @click=${() => {
                    state.lastFetch = 0;
                    void fetchState(context, state);
                  }}
                >
                  Refresh
                </button>
                <p aria-hidden="true" style="display: flex; align-items: flex-end; gap: 2px; height: 48px; margin: 0.6em 0;">
                  ${chrono.map(
                    (s) => html`<span
                      title="${clock(s.ts)} ${s.tps} t/s ${shortModel(s.model)}"
                      style="flex: 1; min-width: 3px; background: currentColor; opacity: 0.65; height: ${Math.max(4, Math.round((s.tps / max) * 100))}%;"
                    ></span>`,
                  )}
                </p>
                ${state.history.length || state.turns.length
                  ? html`<p>
                      <button ?disabled=${state.view === "messages"} @click=${() => { state.view = "messages"; state.page = 0; context.host.requestRender(); }}>Messages</button>
                      <button ?disabled=${state.view === "turns"} @click=${() => { state.view = "turns"; state.page = 0; context.host.requestRender(); }}>Turns</button>
                      <button ?disabled=${state.view === "tools"} @click=${() => { state.view = "tools"; state.page = 0; context.host.requestRender(); }}>Tools</button>
                    </p>
                    <label>Filter <input
                      type="search"
                      placeholder="model, session or tool"
                      .value=${state.filter}
                      @change=${(event: Event) => {
                        if (event.target instanceof HTMLInputElement) {
                          state.filter = event.target.value;
                          state.page = 0;
                          context.host.requestRender();
                        }
                      }}></label>
                    ${isTurns
                      ? html`<table>
                          <thead><tr><th></th><th>Time</th><th>Turn</th><th>Sess</th><th>LLM</th><th>TTFT</th><th>Tools</th><th>Tool time</th><th>Total</th></tr></thead>
                          <tbody>
                            ${visibleT.flatMap((t) => {
                              const key = `${t.sessionId}#${t.turnIndex}`;
                              const open = state.expanded.includes(key);
                              const toggle = html`<button aria-label=${open ? "collapse" : "expand"} @click=${() => {
                                state.expanded = open ? state.expanded.filter((k) => k !== key) : [...state.expanded, key];
                                context.host.requestRender();
                              }}>${open ? "–" : "+"}</button>`;
                              const row = html`<tr title=${t.tools.map((c) => `${c.name} ${(c.durationMs / 1000).toFixed(1)}s${c.isError ? " ✗" : ""}`).join(", ") || "no tool calls"}>
                                <td>${t.outcome === "completed" ? toggle : html`✗ ${toggle}`}</td>
                                <td>${clock(t.ts)}</td>
                                <td>#${t.turnIndex}</td>
                                <td><button @click=${() => { gotoSession(t.sessionId); }} title="Show only this session">${shortSession(t.sessionId)}</button></td>
                                <td>${t.streamed ? html`${(t.llmDurationMs / 1000).toFixed(1)}s ${fmtRate(t.tps)}` : html`–`}</td>
                                <td>${fmtMs(t.ttftMs)}</td>
                                <td>${t.tools.length ? t.tools.slice(0, 3).map((c) => c.name).join(",") + (t.tools.length > 3 ? `+${t.tools.length - 3}` : "") : "–"}</td>
                                <td>${(t.toolMsTotal / 1000).toFixed(1)}s</td>
                                <td>${(t.turnMsTotal / 1000).toFixed(1)}s</td>
                              </tr>`;
                              if (!open) return [row];
                              const detail = html`<tr><td></td><td colspan="8">${t.tools.length
                                ? t.tools.map((c) => html`<div>${c.name} — ${(c.durationMs / 1000).toFixed(1)}s${c.isError ? " ✗" : ""}</div>`)
                                : html`<em>no tool calls this turn</em>`}</td></tr>`;
                              return [row, detail];
                            })}
                          </tbody>
                        </table>`
                      : isTools
                      ? html`<p>
                          ${listedTools.length} call(s) from ${state.turns.length} turn(s), sorted
                          <button ?disabled=${state.toolSort === "recent"} @click=${() => { state.toolSort = "recent"; state.page = 0; context.host.requestRender(); }}>Newest-first</button>
                          <button ?disabled=${state.toolSort === "slow"} @click=${() => { state.toolSort = "slow"; state.page = 0; context.host.requestRender(); }}>Slowest-first</button>
                          <br><small>Calls from the running step appear when it finishes.</small>
                        </p>
                        ${statsTools.length
                          ? html`<h4>Most expensive tools</h4>
                            <table>
                              <thead><tr><th>Tool</th><th>Calls</th><th>Total</th><th>Fails</th></tr></thead>
                              <tbody>
                                ${statsTools.slice(0, 8).map(
                                  (s) => html`<tr>
                                    <td>${s.name}</td>
                                    <td>${s.calls}</td>
                                    <td>${(s.ms / 1000).toFixed(1)}s</td>
                                    <td>${s.fails || "–"}</td>
                                  </tr>`,
                                )}
                              </tbody>
                            </table>`
                          : ""}
                        <table>
                          <thead><tr><th></th><th>Time</th><th>Sess</th><th>Turn</th><th>Tool</th><th>Secs</th></tr></thead>
                          <tbody>
                            ${visibleTools.map(
                              (r) => html`<tr>
                                <td>${r.isError ? "✗" : ""}</td>
                                <td>${clock(r.ts)}</td>
                                <td><button @click=${() => { gotoSession(r.sessionId); }} title="Show only this session">${shortSession(r.sessionId)}</button></td>
                                <td>#${r.turnIndex}</td>
                                <td><button @click=${() => {
                                  state.view = "turns";
                                  state.filter = `#${r.turnIndex}`;
                                  state.page = 0;
                                  context.host.requestRender();
                                }} title="Open this turn">${r.name}</button></td>
                                <td>${(r.durationMs / 1000).toFixed(1)}</td>
                              </tr>`,
                            )}
                          </tbody>
                        </table>`
                      : html`<table>
                      <thead><tr><th></th><th>Time</th><th>Sess</th><th>Model</th><th>Out</th><th>Secs</th><th>t/s</th><th>TTFT</th><th>Hit</th></tr></thead>
                      <tbody>
                        ${visible.map(
                          (s) => html`<tr title=${titleOf(s)}>
                            <td>${markOf(s)}</td>
                            <td>${clock(s.ts)}</td>
                            <td><button @click=${() => { gotoSession(s.sessionId); }} title="Show only this session">${shortSession(s.sessionId)}</button></td>
                            <td>${shortModel(s.model)}</td>
                            <td>${s.output}</td>
                            <td>${(s.durationMs / 1000).toFixed(1)}</td>
                            <td>${s.streamed ? html`${s.approx ? "~" : ""}${fmtRate(s.tps)}` : html`–`}</td>
                            <td>${fmtMs(s.ttftMs)}</td>
                            <td>${cacheHit(s)}</td>
                          </tr>`,
                        )}
                      </tbody>
                    </table>`}
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
                <p><small>Tip: <code>/tps 10</code> messages, <code>/tps turns</code> steps, <code>/tps tools</code> slowest calls. Rows: ✗ failed, ↺ replayed (excluded), ⚠ stalled.</small></p>
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
              if (live?.state === "streaming") {
                return [{ type: "text", text: `⚡ ~${fmtRate(live.approxTps)} t/s`, title: "Tokens/sec, streaming estimate" }];
              }
              const last = live?.last ?? state?.history[0];
              if (last) {
                return [{ type: "text", text: `⚡ ${fmtRate(last.tps)} t/s`, title: `Last message: ${last.output} tokens in ${(last.durationMs / 1000).toFixed(1)}s` }];
              }
              return [{ type: "text", text: "⚡ –", title: "No tokens/sec samples yet in this workspace" }];
            },
          },
        ],
      },
      dispose() {
        disposed = true;
        clearInterval(timer);
        states.clear();
        hosts.clear();
      },
    };
  },
};

export default plugin;
