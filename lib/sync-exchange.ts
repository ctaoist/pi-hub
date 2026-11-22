import type { SyncChannel } from "./sync-channel";
import { createSyncSnapshot, createSyncDelta, parseSyncManifest, reconcileSyncDelta, syncManifest, SyncBasisChanged } from "./sync-protocol";
import { syncRecord } from "./sync-validation";
import { subscribeSyncChanges } from "./sync-watch";

interface Options {
  server: boolean;
  agentDir: string;
  peerId: string;
  connectionId: string;
  channel: SyncChannel;
  allowed: () => Promise<boolean>;
  synced: () => Promise<void>;
  fail: () => void;
}
/** One coordinator per connection: events coalesce and never interleave rounds. */
export class SyncExchange {
  private phase: "idle" | "delta" | "result" | "ack" | "done" = "idle";
  private requested = false;
  private busy = false;
  private closed = false;
  private notified = false;
  private basisRetries = 0;
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private unsubscribe: () => void;
  private queue: unknown[] = [];
  constructor(private options: Options) {
    this.unsubscribe = subscribeSyncChanges(options.agentDir, () => this.changed());
    this.changed(); // Initial/reconnected links always compare full indexes.
  }
  close(): void {
    this.closed = true; this.unsubscribe();
    clearTimeout(this.timer); clearTimeout(this.deadline); this.queue = [];
  }
  changed(): void {
    if (this.closed) return;
    this.requested = true;
    this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.timer || !this.requested || this.phase !== "idle" || this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || this.busy || this.phase !== "idle") return;
      this.busy = true;
      void this.pump().catch(() => this.options.fail()).finally(() => this.release());
    }, 300);
    this.timer.unref();
  }
  private timeout(): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.options.fail(), 60_000); this.deadline.unref();
  }
  private idle(): void {
    this.phase = "idle"; this.notified = false;
    clearTimeout(this.deadline);
  }
  private async pump(): Promise<void> {
    if (!this.requested) return;
    this.requested = false;
    if (!await this.options.allowed()) return;
    if (!this.options.server) {
      if (!this.notified) { this.notified = true; await this.options.channel.send({ type: "changed" }); }
      return;
    }
    const snapshot = await createSyncSnapshot(this.options.agentDir, { id: this.options.peerId, connectionId: this.options.connectionId });
    if (!await this.options.allowed() || this.closed) return;
    this.phase = "delta"; this.timeout();
    await this.options.channel.send({ type: "offer", manifest: syncManifest(snapshot) });
  }
  receive(message: unknown): void {
    if (this.closed) return;
    if (!syncRecord(message)) { this.options.fail(); return; }
    // A notification may cross a response. It contains no body and occupies
    // one dirty bit, never an unbounded message queue.
    if (this.options.server && message.type === "changed") { this.changed(); return; }
    if (this.queue.length >= 2) { this.options.fail(); return; }
    this.queue.push(message);
    this.drain();
  }
  private drain(): void {
    if (this.closed || this.busy || !this.queue.length) return;
    this.busy = true;
    const message = this.queue.shift();
    void this.handle(message as Record<string, unknown>).catch(() => this.options.fail()).finally(() => this.release());
  }
  private release(): void { this.busy = false; this.drain(); this.schedule(); }
  private async handle(value: Record<string, unknown>): Promise<void> {
    const { server, agentDir, peerId, connectionId, channel } = this.options;
    if (!server && this.phase === "idle" && value.type === "offer") {
      const manifest = parseSyncManifest(value.manifest, agentDir, peerId);
      this.requested = false; this.notified = false;
      if (!await this.options.allowed()) { this.phase = "done"; this.timeout(); await channel.send({ type: "paused" }); return; }
      const snapshot = await createSyncSnapshot(agentDir, { id: peerId, connectionId });
      this.phase = "result"; this.timeout();
      if (!await this.options.allowed()) throw new Error("Sync peer is not configured or disabled");
      await channel.send({ type: "delta", delta: createSyncDelta(snapshot, manifest) });
      return;
    }
    if (!server && value.type === "done" && this.phase === "done") { this.idle(); return; }
    if (!server && value.type === "retry" && this.phase === "result") { this.idle(); return; }
    if (!await this.options.allowed()) throw new Error("Sync peer is not configured or disabled");
    if (server && this.phase === "delta" && value.type === "paused") {
      await channel.send({ type: "done" }); this.requested = false; this.idle(); return;
    }
    if (server && this.phase === "delta" && value.type === "delta") {
      try {
        const merged = await reconcileSyncDelta(value.delta, agentDir, peerId, connectionId);
        // reconcile validates all versions/contents before we use this index.
        if (!syncRecord(value.delta)) throw new Error("Invalid synchronization delta");
        const index = { ...value.delta }; delete index.contents;
        const client = parseSyncManifest(index, agentDir, peerId);
        this.phase = "ack";
        if (!await this.options.allowed()) throw new Error("Sync peer is not configured or disabled");
        await channel.send({ type: "result", delta: createSyncDelta(merged, client) });
      } catch (error) {
        if (!(error instanceof SyncBasisChanged) || ++this.basisRetries > 3) throw error;
        await channel.send({ type: "retry" }); this.idle(); this.requested = true;
      }
      return;
    }
    if (!server && this.phase === "result" && value.type === "result") {
      try {
        await reconcileSyncDelta(value.delta, agentDir, peerId, connectionId);
        if (!await this.options.allowed()) throw new Error("Sync peer is not configured or disabled");
        this.phase = "done";
        await channel.send({ type: "ack" }); await this.options.synced(); this.basisRetries = 0;
      } catch (error) {
        if (!(error instanceof SyncBasisChanged) || ++this.basisRetries > 3) throw error;
        this.phase = "done"; await channel.send({ type: "retry" });
      }
      return;
    }
    if (server && this.phase === "ack" && (value.type === "ack" || value.type === "retry")) {
      if (value.type === "ack") { await this.options.synced(); this.basisRetries = 0; }
      else {
        if (++this.basisRetries > 3) throw new Error("Synchronization basis kept changing");
        this.requested = true;
      }
      await channel.send({ type: "done" }); this.idle(); return;
    }
    throw new Error("Unexpected incremental sync message");
  }
}
