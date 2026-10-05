import { API_BASE } from './http';

// Real-Time Event Stream Subscription Helper
//
// Reliability (sync-audit improvement #5): reconnects back off
// exponentially (1s → 2s → 4s … capped at 30s) with ±20% jitter so a
// server restart doesn't herd every client into the same retry tick.
// The tab also reconnects IMMEDIATELY when it becomes visible again or
// the browser reports the network is back, instead of waiting out the
// current backoff delay.
//
// Connection state (#5): onStatus fires on every connect/disconnect so
// App.tsx can poll /api/sync/version only while the stream is down and
// run a catch-up refresh when it comes back.
//
// Multi-tab relay (#6): every tab keeps its own SSE connection (they
// are cheap), but each RECEIVED event is forwarded over a
// BroadcastChannel so tabs that slept through the event (or whose
// connection dropped) refresh identically instead of showing stale
// registers. The channel also carries LOGOUT so a sign-out in one tab
// signs the others out too.

const SYNC_CHANNEL_NAME = 'inventory-sync';

/** A payload relayed between tabs: a live sync event or a LOGOUT notice. */
export type SyncRelayMessage =
  | { kind: 'event'; event: any }
  | { kind: 'logout' };

export function subscribeToSyncStream(
  onEvent: (data: any) => void,
  onStatus?: (connected: boolean) => void
): () => void {
  // The stream endpoint requires auth (audit backlog #2). Native EventSource
  // cannot send an Authorization header, so the token travels as a query
  // parameter — the server's SSE auth middleware accepts either transport.
  //
  // The token is read INSIDE connect(), never captured once at subscribe
  // time: a retry that kept a null token (subscribed before login, or before
  // the token was refreshed) would otherwise 401 forever and the paged
  // registers' sseRefreshKey would never fire from a realtime event.
  const streamUrl = () => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('inventory_auth_token') : null;
    return token
      ? `${API_BASE}/api/sync/stream?token=${encodeURIComponent(token)}`
      : `${API_BASE}/api/sync/stream`;
  };

  let eventSource: EventSource | null = null;
  let retryTimeout: any = null;
  let relayChannel: BroadcastChannel | null = null;
  let disposed = false;
  let retryDelayMs = 1000;

  // Multi-tab relay (#6): forward received events to sibling tabs and
  // feed events arriving FROM sibling tabs into this tab's handler.
  // Logged-in tabs only — a logged-out tab must not relay.
  const isAuthed = () =>
    typeof localStorage !== 'undefined' && !!localStorage.getItem('inventory_auth_token');

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      relayChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      relayChannel.onmessage = (message: MessageEvent) => {
        const payload = message.data as SyncRelayMessage | undefined;
        if (!payload || !isAuthed()) return;
        if (payload.kind === 'logout') {
          window.dispatchEvent(new CustomEvent('inventory_sync_logout'));
          return;
        }
        try {
          onEvent(payload.event);
        } catch (_err) {}
      };
    }
  } catch (_e) {
    relayChannel = null; // BroadcastChannel unavailable (old browser) — tabs keep their own SSE.
  }

  const relayToOtherTabs = (event: any) => {
    try {
      relayChannel?.postMessage({ kind: 'event', event } as SyncRelayMessage);
    } catch (_e) {}
  };

  function scheduleRetry() {
    if (disposed) return;
    // Exponential backoff with ±20% jitter, capped at 30s.
    const jitter = retryDelayMs * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.min(30000, Math.round(retryDelayMs + jitter));
    retryDelayMs = Math.min(30000, retryDelayMs * 2);
    retryTimeout = setTimeout(connect, delay);
  }

  function connect() {
    if (disposed) return;
    clearTimeoutBackoff();
    try {
      eventSource = new EventSource(streamUrl());
      eventSource.onopen = () => {
        retryDelayMs = 1000; // healthy connection — reset the backoff ladder
        onStatus?.(true);
      };
      eventSource.onmessage = (event) => {
        try {
          if (event.data && event.data.startsWith('{')) {
            const parsed = JSON.parse(event.data);
            relayToOtherTabs(parsed);
            onEvent(parsed);
          }
        } catch (_err) {}
      };
      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        onStatus?.(false);
        scheduleRetry();
      };
    } catch (_e) {
      onStatus?.(false);
      scheduleRetry();
    }
  }

  function clearTimeoutBackoff() {
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
  }

  // Reconnect NOW on tab-visibility or network recovery instead of
  // waiting out the scheduled backoff (sync-audit improvement #5).
  const reconnectNow = () => {
    if (disposed) return;
    if (eventSource) return; // already connected — nothing to do
    clearTimeoutBackoff();
    retryDelayMs = 1000;
    connect();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') reconnectNow();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', reconnectNow);

  connect();

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', reconnectNow);
    clearTimeoutBackoff();
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (relayChannel) {
      relayChannel.close();
      relayChannel = null;
    }
  };
}

/**
 * Broadcasts a LOGOUT notice to every other tab sharing this app
 * (multi-tab relay #6) so they sign out in step instead of sitting on
 * a dead session until their next 401.
 */
export function broadcastLogoutToOtherTabs(): void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      channel.postMessage({ kind: 'logout' } as SyncRelayMessage);
      channel.close();
    }
  } catch (_e) {}
}

/**
 * Reads the server's current dataVersion (sync-audit improvement #1).
 * While the SSE stream is down App.tsx polls this on an interval: a
 * changed version means mutations happened while the tab couldn't hear
 * the stream, so it runs a full catch-up refresh once reconnected.
 */
export async function getSyncVersion(): Promise<number | undefined> {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('inventory_auth_token') : null;
  const res = await fetch(`${API_BASE}/api/sync/version`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`sync/version failed with status ${res.status}`);
  const body = (await res.json()) as { dataVersion?: number };
  return body.dataVersion;
}
