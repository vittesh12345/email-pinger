// Live channel to open browser tabs (server-sent events) plus a little shared runtime state.

const clients = new Set();

/** Things worth showing in the UI that are not worth a database table. */
export const runtime = {
  syncing: false,
  lastSyncError: null,
  aiError: null,
  calendarError: null,
};

export function addClient(res, { canNotify }) {
  const client = { res, canNotify };
  clients.add(client);
  return () => clients.delete(client);
}

export function broadcast(event, data = {}) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

export const clientCount = () => clients.size;

/** True when at least one open tab can raise a browser notification itself. */
export const someTabCanNotify = () => [...clients].some((c) => c.canNotify);

/** Tell every tab that some data changed so it can refetch. */
export const changed = (...topics) => broadcast('changed', { topics });
