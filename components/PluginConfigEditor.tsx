"use client";

import { useEffect, useId, useState } from "react";
import type { PluginConfigChange, PluginConfigDocument, PluginConfigField, PluginConfigListing } from "@/lib/plugin-config-types";
import { parsePluginConfigValue, pluginConfigFieldKey } from "@/lib/plugin-config-types";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigDetailActions, ConfigField, ConfigNotice, ConfigSectionTitle, ConfigSwitch } from "./SettingsUi";

type Identity = { cwd: string; source: string; scope: "global" | "project"; kind?: "package" | "extension" };
type Draft = { action: "set" | "remove"; text: string };
const inputStyle = { width: "100%", minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 5,
  color: "var(--text)", background: "var(--bg)", fontFamily: "var(--font-mono)", fontSize: 12 };

function fieldText(field: PluginConfigField): string {
  if (field.value === undefined) return "";
  return field.kind === "string" ? String(field.value) : JSON.stringify(field.value, null, 2);
}
function errorKey(code: unknown): string {
  const known = ["invalid", "large", "unsafe", "conflict", "confirm", "missing", "denied"];
  return `pluginConfig.error.${typeof code === "string" && known.includes(code) ? code : "unavailable"}`;
}

function ConfigValue({ field, draft, disabled, onChange }: {
  field: PluginConfigField; draft?: Draft; disabled: boolean; onChange: (draft?: Draft) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const label = field.path.map((part) => JSON.stringify(part)).join(" / ");
  const text = draft?.text ?? fieldText(field);
  const removed = draft?.action === "remove";
  const editing = field.present && !field.secret || draft?.action === "set";
  const multiline = !removed && editing && field.kind === "json" && !field.secret;
  return <ConfigField label={<label htmlFor={id} style={{ overflowWrap: "anywhere" }}>{label}</label>}>
    <div className={`plugin-config-field-row${multiline ? " is-multiline" : ""}`}>
      <div className="plugin-config-field-value">
        {removed ? <span style={{ color: "var(--text-muted)" }}>{t("pluginConfig.removing")}</span>
          : editing ? field.kind === "boolean" ? <ConfigSwitch checked={text === "true"} label={label} loading={disabled}
            onChange={() => onChange({ action: "set", text: text === "true" ? "false" : "true" })} />
          : multiline ? <textarea id={id} rows={5} style={{ ...inputStyle, resize: "vertical" }} spellCheck={false}
            value={text} disabled={disabled} onChange={(event) => onChange({ action: "set", text: event.target.value })} />
          : <input id={id} style={inputStyle} type={field.secret ? "password" : "text"}
            inputMode={field.kind === "number" ? "decimal" : undefined} autoComplete="off" spellCheck={false}
            value={text} disabled={disabled} onChange={(event) => onChange({ action: "set", text: event.target.value })} />
          : <span style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", fontSize: 12 }}>
            {field.secret ? t(field.present ? "pluginConfig.secretStored" : "pluginConfig.secretExample")
              : `${t("pluginConfig.example")}: ${text}`}
          </span>}
      </div>
      <ConfigDetailActions>
        {!editing && !removed && <ConfigButton size="small" disabled={disabled}
          onClick={() => onChange({ action: "set", text: field.secret ? "" : fieldText(field) })}>
          {t(field.present ? "pluginConfig.replace" : "pluginConfig.add")}
        </ConfigButton>}
        {field.present && !removed && <ConfigButton size="small" disabled={disabled}
          onClick={() => onChange({ action: "remove", text: "" })}>{t("pluginConfig.clear")}</ConfigButton>}
        {draft && <ConfigButton size="small" disabled={disabled} onClick={() => onChange()}>{t("pluginConfig.undo")}</ConfigButton>}
      </ConfigDetailActions>
    </div>
  </ConfigField>;
}

function ConfigDocument({ initial, identity, blocked }: { initial: PluginConfigDocument; identity: Identity; blocked: boolean }) {
  const { t } = useI18n();
  const [file, setFile] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = Object.keys(drafts).length > 0;
  async function save() {
    setError(null); setSaved(false);
    const changes: PluginConfigChange[] = [];
    try {
      for (const field of file.fields ?? []) {
        const draft = drafts[pluginConfigFieldKey(field.path)];
        if (!draft) continue;
        changes.push(draft.action === "remove" ? { path: field.path, action: "remove" }
          : { path: field.path, action: "set", value: parsePluginConfigValue(field.kind, draft.text) });
      }
    } catch { setError("invalid"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/plugins/config", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...identity, id: file.id, revision: file.revision, confirmCreate, changes }) });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "unavailable"); return; }
      setFile(result.file); setDrafts({}); setConfirmCreate(false); setSaved(true);
    } catch { setError("unavailable"); } finally { setBusy(false); }
  }
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <code style={{ fontSize: 12, overflowWrap: "anywhere", color: "var(--text-muted)" }}>{file.path}</code>
    {file.error ? <ConfigNotice>{t(errorKey(file.error))}</ConfigNotice> : <>
      {file.examplePath && <span style={{ fontSize: 12, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
        {t("pluginConfig.example")}: {file.examplePath}
      </span>}
      {file.packageLocal && <ConfigNotice>{t("pluginConfig.packageWarning")}</ConfigNotice>}
      {(file.fields ?? []).map((field) => <ConfigValue key={pluginConfigFieldKey(field.path)} field={field}
        draft={drafts[pluginConfigFieldKey(field.path)]} disabled={busy || blocked} onChange={(draft) => {
          setSaved(false); setError(null);
          setDrafts((previous) => {
            const next = { ...previous }; const key = pluginConfigFieldKey(field.path);
            if (draft) next[key] = draft; else delete next[key];
            return next;
          });
        }} />)}
      {!file.fields?.length && <ConfigNotice>{t("pluginConfig.noFields")}</ConfigNotice>}
      {!file.exists && <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
        <input type="checkbox" checked={confirmCreate} disabled={busy || blocked}
          onChange={(event) => setConfirmCreate(event.target.checked)} />{t("pluginConfig.confirmCreate")}
      </label>}
      <ConfigDetailActions>
        <ConfigButton variant="primary" disabled={busy || blocked || !dirty || (!file.exists && !confirmCreate)} onClick={() => void save()}>
          {t(busy ? "pluginConfig.saving" : "pluginConfig.save")}
        </ConfigButton>
        <ConfigButton disabled={busy || !dirty} onClick={() => { setDrafts({}); setError(null); setConfirmCreate(false); }}>{t("pluginConfig.cancel")}</ConfigButton>
      </ConfigDetailActions>
      {error && <div role="alert" style={{ color: "var(--text)", fontSize: 12 }}>{t(errorKey(error))}</div>}
      {saved && <div role="status" style={{ fontSize: 12 }}>{t("pluginConfig.saved")}</div>}
    </>}
  </div>;
}

/** Parent keys this by package identity, cwd and installed version: old responses/drafts cannot cross packages. */
export function PluginConfigEditor({ cwd, source, scope, kind = "package", blocked }: Identity & { blocked: boolean }) {
  const { t } = useI18n();
  const [listing, setListing] = useState<PluginConfigListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/plugins/config?${new URLSearchParams({ cwd, source, scope, kind })}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (controller.signal.aborted) return;
        if (response.ok) { setListing(result); setError(null); }
        else setError(result.error ?? "unavailable");
      }).catch(() => { if (!controller.signal.aborted) setError("unavailable"); });
    return () => controller.abort();
  }, [cwd, source, scope, kind, attempt]);
  return <section aria-label={t("pluginConfig.title")} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
    <ConfigSectionTitle>{t("pluginConfig.title")}</ConfigSectionTitle>
    {error ? <ConfigNotice action={<ConfigButton size="small" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>{t("pluginConfig.retry")}</ConfigButton>}>
      {t(errorKey(error))}
    </ConfigNotice> : !listing ? <ConfigNotice>{t("pluginConfig.loading")}</ConfigNotice>
      : !listing.files.length ? <ConfigNotice>{t("pluginConfig.empty")}</ConfigNotice>
      : <>
        <ConfigNotice>{t("pluginConfig.hint")}</ConfigNotice>
        {listing.files.map((file) => <ConfigDocument key={file.id} initial={file} identity={{ cwd, source, scope, kind }} blocked={blocked} />)}
      </>}
  </section>;
}
