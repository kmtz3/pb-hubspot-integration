import { Component, type ReactNode, type ErrorInfo } from 'react';

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    fetch('/api/debug/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'render-error',
        url: window.location.href,
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
      }),
    }).catch(() => {});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: 'monospace', fontSize: 13, color: '#b91c1c' }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Render error</h2>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>{this.state.error.message}</div>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#fee2e2', padding: 12, borderRadius: 6 }}>
          {this.state.error.stack}
        </pre>
        {this.state.info?.componentStack && (
          <>
            <div style={{ marginTop: 16, fontWeight: 600 }}>Component stack</div>
            <pre style={{ whiteSpace: 'pre-wrap', background: '#fee2e2', padding: 12, borderRadius: 6 }}>
              {this.state.info.componentStack}
            </pre>
          </>
        )}
      </div>
    );
  }
}
