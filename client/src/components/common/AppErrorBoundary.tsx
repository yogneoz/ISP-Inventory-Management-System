import React from 'react';

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * The application's last line of defence.
 *
 * React unmounts the whole root when a render throws, so before this existed a
 * single malformed row on any of the 82 screens left an empty page with no
 * explanation and no way back except a manual reload. This boundary catches the
 * throw, keeps the reason on screen for the person to report, and offers the
 * two recoveries that actually work: reload the page, or clear the saved
 * workspace state and start again.
 *
 * It deliberately renders no app chrome — the shell may be the thing that
 * failed — and it does not depend on any context, provider or theme, because a
 * provider throw is one of the cases it has to survive.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The console is the only sink the client has; the details a maintainer
    // needs are the component stack, which React only passes here.
    console.error('Unhandled render error:', error, info?.componentStack || '');
  }

  private reload = (): void => {
    window.location.reload();
  };

  /** Clear the saved workspace/session keys a broken screen may be stuck on. */
  private resetWorkspace = (): void => {
    try {
      for (const key of [
        'inventory_active_tab',
        'inventory_workspace_state',
        'inventory_bootstrap_cache',
      ]) {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Storage unavailable (private/embedded context): the reload still works.
    }
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: '#0f172a',
          color: '#e2e8f0',
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        }}
      >
        <div style={{ maxWidth: '640px', width: '100%' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 8px' }}>
            This screen could not be displayed
          </h1>
          <p style={{ fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px', color: '#94a3b8' }}>
            The rest of your data is safe — nothing was saved by the failed screen. Reload to
            continue, or start from the Dashboard if the same screen fails again.
          </p>
          <pre
            style={{
              fontSize: '12px',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
              padding: '12px',
              margin: '0 0 20px',
              maxHeight: '220px',
              overflow: 'auto',
            }}
          >
            {error.message || String(error)}
          </pre>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={this.reload}
              style={{
                padding: '10px 18px',
                borderRadius: '8px',
                border: 'none',
                background: '#4f46e5',
                color: '#fff',
                fontWeight: 700,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Reload the page
            </button>
            <button
              type="button"
              onClick={this.resetWorkspace}
              style={{
                padding: '10px 18px',
                borderRadius: '8px',
                border: '1px solid #475569',
                background: 'transparent',
                color: '#e2e8f0',
                fontWeight: 700,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Reset the saved screen and reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
