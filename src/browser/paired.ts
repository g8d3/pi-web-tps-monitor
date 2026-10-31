// Transport for the browser-only panel (tps-monitor.panel): plain HTTP +
// WebSocket to the server-only backend (tps-monitor) through the host's
// paired-backend proxy.
//
// Why this file exists: a plugin entry WITH a serverModule pins its browser
// asset to the session daemon's active revision, so ANY package update 404s
// the tab until the daemon restarts — the restart that orphans every working
// agent. A browser-only entry is served fresh on every page reload; it calls
// its backend here using the backend's active revision from /api/plugins, so
// new panel code keeps working against the old running backend (unknown input
// fields are ignored there; responses are sliced and defaulted here).

const PLUGIN_ID = "tps-monitor";

export interface BackendScope {
  projectId: string;
  workspaceId: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The backend revision the running daemon serves; new panel, old backend. */
export async function backendRevision(): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/plugins");
  } catch (error) {
    throw new Error("PI WEB is unreachable: " + messageOf(error));
  }
  if (!res.ok) throw new Error(`plugin list unavailable (HTTP ${res.status})`);
  const list = (await res.json()) as {
    plugins?: Array<{ id?: string; server?: { activeRevision?: string } }>;
  };
  const entry = (list.plugins ?? []).find((p) => p?.id === PLUGIN_ID);
  const rev = entry?.server?.activeRevision;
  if (!rev) {
    throw new Error(
      `backend ${PLUGIN_ID} has no active revision yet — it loads on the next session-daemon restart`,
    );
  }
  return rev;
}

function requestPath(scope: BackendScope, operation: string): string {
  return (
    `/api/paired-plugin-backends/${PLUGIN_ID}` +
    `/projects/${encodeURIComponent(scope.projectId)}` +
    `/workspaces/${encodeURIComponent(scope.workspaceId)}` +
    `/${encodeURIComponent(operation)}`
  );
}

/** One paired-backend call; mirrors the host's in-process peer.request. */
export async function pairedRequest<T>(scope: BackendScope, operation: string, input: unknown): Promise<T> {
  const revision = await backendRevision();
  let res: Response;
  try {
    res = await fetch(requestPath(scope, operation), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision,
        input: input ?? null,
        scope: "workspace",
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
      }),
    });
  } catch (error) {
    throw new Error("backend unreachable: " + messageOf(error));
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // error body below
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string; message?: string } | null)?.error ??
      (data as { error?: string; message?: string } | null)?.message ??
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export interface WatchChannel {
  close(): void;
  closed: Promise<void>;
}

interface WireEnvelope {
  version?: unknown;
  kind?: unknown;
  data?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Open the server's "watch" push channel over the paired-backend WebSocket
 * route. The first frame is the open envelope; the server answers "ready",
 * then "data" frames (snapshot-start/part/done, update) and closes the
 * socket to end the channel — resolving `closed` is how the panel learns to
 * reconnect. Any handshake or transport failure rejects, and the panel's
 * polling fallback covers it.
 */
export async function openWatchChannel(
  scope: BackendScope,
  input: unknown,
  handlers: { onData(data: unknown): void },
): Promise<WatchChannel> {
  const revision = await backendRevision();
  const proto = globalThis.location?.protocol === "https:" ? "wss" : "ws";
  const host = globalThis.location?.host ?? "";
  const url =
    `${proto}://${host}/api/paired-plugin-backends/${PLUGIN_ID}` +
    `/projects/${encodeURIComponent(scope.projectId)}` +
    `/workspaces/${encodeURIComponent(scope.workspaceId)}` +
    `/channels/watch`;
  const openFrame = JSON.stringify({
    version: 1,
    kind: "open",
    revision,
    input: input ?? null,
    scope: "workspace",
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
  });
  return new Promise<WatchChannel>((resolve, reject) => {
    let settled = false;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(new Error("channel unreachable: " + messageOf(error)));
      return;
    }
    const finish = (): void => {
      try {
        socket.close();
      } catch {
        // already gone
      }
      resolveClosed();
    };
    const fail = (error: unknown): void => {
      if (!settled) {
        settled = true;
        try {
          socket.close();
        } catch {
          // already gone
        }
        reject(error instanceof Error ? error : new Error(String(error)));
        resolveClosed();
        return;
      }
      finish();
    };
    socket.addEventListener("open", () => {
      try {
        socket.send(openFrame);
      } catch (error) {
        fail(new Error("channel open failed: " + messageOf(error)));
      }
    });
    socket.addEventListener("message", (event) => {
      let envelope: WireEnvelope;
      try {
        envelope = JSON.parse(String((event as MessageEvent).data)) as WireEnvelope;
      } catch {
        return; // malformed frame: ignore, polling covers it
      }
      if (!settled) {
        if (envelope.kind === "ready") {
          settled = true;
          resolve({ close: finish, closed });
          return;
        }
        fail(new Error("channel open refused: " + String(envelope.message ?? envelope.kind ?? "unknown")));
        return;
      }
      if (envelope.kind === "data") {
        try {
          handlers.onData(envelope.data);
        } catch {
          // malformed frame: ignore, polling covers it
        }
        return;
      }
      if (envelope.kind === "error") {
        finish();
      }
    });
    socket.addEventListener("error", () => {
      fail(new Error("channel transport failed"));
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("channel closed before ready"));
      }
      resolveClosed();
    });
  });
}
