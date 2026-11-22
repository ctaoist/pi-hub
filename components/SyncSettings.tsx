"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

type SyncPlatform = "windows" | "macos" | "linux" | "other";
type SyncStatus = "unknown" | "online" | "offline" | "error";

interface SyncNode {
  id: string;
  name: string;
  url?: string;
  direction: "inbound" | "outbound";
  platform: SyncPlatform;
  enabled: boolean;
  status: SyncStatus;
  lastSeenAt?: string;
  lastSyncAt?: string;
  lastError?: string;
  hasCredential: boolean;
}

interface SyncState {
  config: {
    version: 1;
    node: { id: string; name: string; platform: SyncPlatform };
    enabled: boolean;
    conflictStrategy: "mtime" | "authority";
    authorityNodeId?: string;
    waitingForAuthority?: boolean;
    lastDecision?: { sourceNodeId: string; at: string; strategy: "mtime" | "authority"; applied: number };
  };
  nodes: SyncNode[];
  available: boolean;
}

async function requestSync(body?: Record<string, unknown>): Promise<SyncState> {
  const response = await fetch("/api/sync", {
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json() as SyncState & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  if (!data.config?.node || !Array.isArray(data.nodes)) throw new Error("Invalid synchronization state");
  return data;
}

const PLATFORM_KEYS: Record<SyncPlatform, string> = {
  windows: "settings.syncPlatformWindows", macos: "settings.syncPlatformMacos", linux: "settings.syncPlatformLinux", other: "settings.syncPlatformOther",
};
const STATUS_KEYS: Record<SyncStatus, string> = {
  unknown: "settings.syncStatusUnknown", online: "settings.syncStatusOnline", offline: "settings.syncStatusOffline", error: "settings.syncStatusError",
};

export function SyncSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<SyncState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [password, setPassword] = useState("");
  const requestId = useRef(0);
  const mutating = useRef(false);

  const load = useCallback(async () => {
    if (mutating.current) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await requestSync();
      if (id === requestId.current) setState(next);
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const sequence = requestId;
    return () => { sequence.current++; };
  }, [load]);

  const update = async (body: Record<string, unknown>) => {
    if (loading || mutating.current) return;
    mutating.current = true;
    const id = ++requestId.current;
    setSaving(true);
    setError(null);
    try {
      const next = await requestSync(body);
      if (id === requestId.current) setState(next);
    } catch (cause) {
      if (id === requestId.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        // A lost reply may still have committed; refresh without discarding the error.
        try { const next = await requestSync(); if (id === requestId.current) setState(next); } catch { /* explicit Refresh remains available */ }
      }
    } finally {
      mutating.current = false;
      if (id === requestId.current) setSaving(false);
    }
  };

  const addNode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading || mutating.current || !state?.available) return;
    mutating.current = true;
    const id = ++requestId.current;
    setSaving(true);
    setError(null);
    try {
      const next = await requestSync({ action: "add-node", name, url: remoteUrl, password });
      if (id === requestId.current) {
        setState(next);
        setName("");
        setRemoteUrl("");
        setPassword("");
      }
    } catch (cause) {
      if (id === requestId.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        try { const next = await requestSync(); if (id === requestId.current) setState(next); } catch { /* explicit Refresh remains available */ }
      }
    } finally {
      mutating.current = false;
      if (id === requestId.current) setSaving(false);
    }
  };

  const removeNode = async (node: SyncNode) => {
    if (!window.confirm(t("settings.syncRemoveConfirm", { name: node.name }))) return;
    await update({ action: "remove-node", id: node.id });
  };

  if (loading && !state) return <div className="settings-general"><p className="settings-general-description">{t("settings.syncLoading")}</p></div>;

  const localNode = state?.config.node;
  return (
    <div className="settings-general">
      <ConfigButton size="small" disabled={saving || loading} onClick={() => void load()}>{t("settings.syncRefresh")}</ConfigButton>
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {state && (
        <>
          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.sync")}</h3>
            <p className="settings-general-description">{t("settings.syncDescription")}</p>
            {!state.available && <p id="sync-unavailable" className="settings-general-description">{t("settings.syncUnavailable")}</p>}
            <div className="settings-shell-option">
              <span>{t("settings.syncEnabled")}</span>
              <ConfigSwitch
                checked={state.config.enabled}
                loading={saving || loading}
                disabled={!state.available && !state.config.enabled}
                describedBy={!state.available ? "sync-unavailable" : undefined}
                label={t("settings.syncEnabled")}
                onChange={(enabled) => void update({ action: "options", enabled })}
              />
            </div>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.syncConflict")}</h3>
            <div className="settings-sync-conflict">
              <label htmlFor="settings-sync-strategy">{t("settings.syncConflictStrategy")}</label>
              <select
                id="settings-sync-strategy"
                value={state.config.conflictStrategy}
                disabled={saving || loading}
                onChange={(event) => {
                  const conflictStrategy = event.target.value as "mtime" | "authority";
                  void update({
                    action: "options",
                    conflictStrategy,
                    authorityNodeId: conflictStrategy === "authority" ? (state.config.authorityNodeId ?? localNode?.id) : null,
                  });
                }}
              >
                <option value="mtime">{t("settings.syncConflictMtime")}</option>
                <option value="authority">{t("settings.syncConflictAuthority")}</option>
              </select>
            </div>
            {state.config.conflictStrategy === "authority" && localNode && (
              <div className="settings-sync-conflict">
                <label htmlFor="settings-sync-authority">{t("settings.syncAuthorityNode")}</label>
                <select
                  id="settings-sync-authority"
                  value={state.config.authorityNodeId ?? localNode.id}
                  disabled={saving || loading}
                  onChange={(event) => void update({ action: "options", authorityNodeId: event.target.value })}
                >
                  {state.config.authorityNodeId && state.config.authorityNodeId !== localNode.id && !state.nodes.some((node) => node.id === state.config.authorityNodeId) && (
                    <option value={state.config.authorityNodeId}>{state.config.authorityNodeId}</option>
                  )}
                  <option value={localNode.id}>{t("settings.syncThisNode")} ({localNode.name})</option>
                  {state.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                </select>
              </div>
            )}
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.syncNodes")}</h3>
            {state.config.waitingForAuthority && <p role="status" className="settings-general-description">{t("settings.syncWaitingAuthority")}</p>}
            {state.config.lastDecision && <p className="settings-general-description">{t("settings.syncDecision", {
              count: state.config.lastDecision.applied,
              name: state.nodes.find((node) => node.id === state.config.lastDecision?.sourceNodeId)?.name ?? state.config.lastDecision.sourceNodeId,
              time: new Date(state.config.lastDecision.at).toLocaleString(),
            })}</p>}
            <p className="settings-general-description">{t("settings.syncNodesDescription")}</p>
            <div className="settings-sync-node-list">
              {state.nodes.length === 0 && <p className="settings-general-description">{t("settings.syncNoNodes")}</p>}
              {state.nodes.map((node) => (
                <div className="settings-sync-node" key={node.id}>
                  <div className="settings-sync-node-main">
                    <strong>{node.name}</strong>
                    <span>{t(PLATFORM_KEYS[node.platform])} · {node.url ?? t("settings.syncInbound")}</span>
                    <span className={`settings-sync-status is-${node.status}`}>{t(STATUS_KEYS[node.status])}</span>
                    {node.lastSyncAt && <span>{t("settings.syncLastSync", { time: new Date(node.lastSyncAt).toLocaleString() })}</span>}
                    {node.lastError && <span className="settings-sync-node-error">{node.lastError}</span>}
                  </div>
                  <div className="settings-sync-node-actions">
                    <ConfigSwitch
                      checked={node.enabled}
                      loading={saving || loading}
                      label={t("settings.syncNodeEnabled", { name: node.name })}
                      onChange={(enabled) => void update({ action: "node-enabled", id: node.id, enabled })}
                    />
                    <ConfigButton variant="danger" size="small" disabled={saving || loading} onClick={() => void removeNode(node)}>
                      {t("settings.syncRemove")}
                    </ConfigButton>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.syncAddNode")}</h3>
            <p className="settings-general-description">{t("settings.syncAddDescription")}</p>
            <form className="settings-sync-form" onSubmit={(event) => void addNode(event)}>
              <label>{t("settings.syncNodeName")}<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} /></label>
              <label>{t("settings.syncRemoteUrl")}<input type="url" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://node.example" required /></label>
              <label>{t("settings.syncRemotePassword")}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></label>
              <ConfigButton type="submit" variant="primary" disabled={saving || loading || !state.available}>{t("settings.syncAdd")}</ConfigButton>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
