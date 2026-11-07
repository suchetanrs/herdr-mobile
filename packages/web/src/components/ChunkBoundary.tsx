import { Component, type ReactNode } from 'react';
import { Icon } from './Icon';

/** A lazy view that couldn't load even after retries (lib/chunks.ts): say so, offer a reload. */
export class ChunkBoundary extends Component<{ children: ReactNode; what: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="state-card" role="alert">
        <Icon name="alert" size={22} />
        <h3>Couldn’t load the {this.props.what}</h3>
        <p>The app on this phone is older than the bridge. Reloading fetches the current one.</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          <Icon name="refresh" size={14} />
          Reload
        </button>
      </div>
    );
  }
}
