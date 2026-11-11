/**
 * Error boundary for one panel: a render error shows a compact message with the error text and a
 * "Try again" (re-render in place) and "Reload" in place of that panel, and leaves the map and the
 * other panels running. A change of `resetKey` (the run's build) clears the error automatically;
 * `onError` lets the owner undo state the failed panel leaves behind.
 */
import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
  /** When this changes (e.g. a new run is loaded) a tripped boundary renders its children again. */
  resetKey?: unknown;
  onError?: (error: Error) => void;
}

export class PanelBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    console.error(`panel "${this.props.name}" failed:`, error);
    this.props.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-error" role="alert">
        <b>Panel error — reload</b>
        <span>{this.props.name}: {this.state.error.message}</span>
        <span className="panel-error-actions">
          <button type="button" className="link-btn" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="link-btn" onClick={() => window.location.reload()}>Reload</button>
        </span>
      </div>
    );
  }
}
