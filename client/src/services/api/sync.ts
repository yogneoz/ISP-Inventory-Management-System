import { API_BASE } from './http';

// Real-Time Event Stream Subscription Helper
export function subscribeToSyncStream(onEvent: (data: any) => void): () => void {
  const streamUrl = `${API_BASE}/api/sync/stream`;
  let eventSource: EventSource | null = null;
  let retryTimeout: any = null;

  function connect() {
    try {
      eventSource = new EventSource(streamUrl);
      eventSource.onmessage = (event) => {
        try {
          if (event.data && event.data.startsWith('{')) {
            const parsed = JSON.parse(event.data);
            onEvent(parsed);
          }
        } catch (_err) {}
      };
      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        retryTimeout = setTimeout(connect, 5000);
      };
    } catch (_e) {
      retryTimeout = setTimeout(connect, 5000);
    }
  }

  connect();

  return () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
