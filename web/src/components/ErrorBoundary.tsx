import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort catcher for uncaught render exceptions. Without this, a single
 * render crash blanks the page; with it, the user sees a calm recovery screen
 * and the error is logged for debugging.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[boundary] uncaught render error", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen grid place-items-center p-8">
          <div className="max-w-md text-center">
            <div className="badge-serif">Unexpected error</div>
            <h1 className="font-serif text-3xl text-ink-100 mt-2">
              The interface tripped over itself
            </h1>
            <p className="font-serif italic text-ink-300 mt-3">
              No conversations were lost — this is a presentation bug, not a
              data one.
            </p>
            <pre className="mt-4 text-left text-xs text-red-300/80 bg-red-500/5 border border-red-500/20 rounded p-3 overflow-auto max-h-40">
              {this.state.error.message}
            </pre>
            <div className="mt-6 flex gap-2 justify-center">
              <button onClick={this.reset} className="btn-ghost">
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="btn-primary"
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
