import type { BridgeIdentity } from '../../shared/widgetBridge.js';
import type { BridgeAdapter, RemoteMessage } from './adapters.js';

/** Reuse one prepared visitor session for both directions; no navigation here. */
export class SessionRelay implements BridgeAdapter {
  private prepared: Promise<void> | undefined;
  private identityKey: string | undefined;
  private ready = false;
  readonly acknowledge?: (count: number) => void;

  constructor(private readonly adapter: BridgeAdapter, private readonly guard: () => void) {
    if (adapter.acknowledge) this.acknowledge = count => adapter.acknowledge!(count);
  }

  async prepare(identity: BridgeIdentity): Promise<void> {
    this.guard();
    const key = JSON.stringify([identity.name, identity.email, identity.phone]);
    if (this.identityKey !== undefined && this.identityKey !== key) throw new Error('connection_stopped');
    this.identityKey = key;
    if (!this.prepared) {
      this.prepared = this.adapter.prepare(identity).then(() => { this.ready = true; }).catch(error => {
        this.prepared = undefined;
        throw error;
      });
    }
    await this.prepared;
    this.guard();
  }

  async send(body: string): Promise<boolean> {
    this.guard();
    if (!this.ready) throw new Error('connection_stopped');
    return this.adapter.send(body);
  }

  async receive(): Promise<RemoteMessage[]> {
    this.guard();
    if (!this.ready) throw new Error('connection_stopped');
    return this.adapter.receive();
  }
}
