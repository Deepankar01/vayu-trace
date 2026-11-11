/**
 * Error boundary for one panel: a render error shows a compact message with the error text and a
 * reload button in place of that panel, and leaves the map and the other panels running.
 */
import { Component, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
}

export class PanelBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    console.error(`panel "${this.props.name}" failed:`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-error" role="alert">
        <b>Panel error — reload</b>
        <span>{this.props.name}: {this.state.error.message}</span>
        <button type="button" className="link-btn" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
