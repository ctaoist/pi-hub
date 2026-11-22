// Shared by bundled routes, instrumentation and the custom HTTP upgrade host.
const key = Symbol.for("pi-web:sync-transport-state");
interface State { stopping: boolean; changed?: () => void }
function state(): State {
  const globals = globalThis as Record<symbol, unknown>;
  return (globals[key] ??= { stopping: false }) as State;
}
export function syncTransportStopped(): boolean { return state().stopping; }
export function setSyncTransportStopped(stopping: boolean): void { state().stopping = stopping; }
export function onSyncConfigurationChanged(callback: () => void): void { state().changed = callback; }
export function notifySyncConfigurationChanged(): void { state().changed?.(); }
