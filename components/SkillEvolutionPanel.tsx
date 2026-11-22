"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SkillInfo } from "@/lib/api-types";
import { DEFAULT_REVIEW_CONFIG, reviewPolicy, type ReviewConfig, type ReviewRun, type ReviewEvidence } from "@/lib/skill-evolution-types";
import { ConfigButton, ConfigDetailStack, ConfigField, ConfigSwitch } from "./SettingsUi";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";
import { SkillProtectionControl } from "./SkillProtectionControl";
import { skillReviewDiff } from "@/lib/skill-review-diff";

interface Status { config: ReviewConfig; pendingTurns: number; runs: (ReviewRun & { canArchive?: boolean })[]; waitReason: string; notice?: string;
  evidence?: (ReviewEvidence & { blocked?: boolean })[]; budget?: { runs: number; tokens: number; maxRuns: number; maxTokens: number } }
const fieldStyle = { width: "100%", minWidth: 0, padding: 8, background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5 };
const codeStyle = { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const, maxHeight: 320, overflow: "auto", fontSize: 12, padding: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5 };

export function SkillEvolutionPanel({ cwd, skills, onSkillsChanged }: {
  cwd: string; skills: SkillInfo[]; onSkillsChanged: (skills: SkillInfo[]) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState<ReviewConfig>({ ...DEFAULT_REVIEW_CONFIG });
  const [models, setModels] = useState<ModelSelectorOption[]>([]);
  const [levels, setLevels] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [fromTurn, setFromTurn] = useState(1);
  const [toTurn, setToTurn] = useState(1);
  const [sessions, setSessions] = useState<{ id: string; name?: string; firstMessage?: string }[]>([]);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const requestSeq = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = JSON.stringify(draft) !== JSON.stringify(status?.config);
  const onSkillsRef = useRef(onSkillsChanged);
  onSkillsRef.current = onSkillsChanged;
  const load = useCallback(async (signal?: AbortSignal, resetDraft = false) => {
    const sequence = ++requestSeq.current;
    const res = await fetch(`/api/skills/evolution?cwd=${encodeURIComponent(cwd)}`, { signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.code ? t(`review.error.${data.code}`) : data.error ?? `HTTP ${res.status}`);
    if (signal?.aborted || sequence !== requestSeq.current) return;
    setStatus(data);
    if (resetDraft || !dirtyRef.current) setDraft(data.config);
    const skillsResponse = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal });
    if (!skillsResponse.ok) return;
    const listing = await skillsResponse.json();
    if (!signal?.aborted && sequence === requestSeq.current) onSkillsRef.current(listing.skills);
  }, [cwd, t]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, true).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    void fetch(`/api/models?cwd=${encodeURIComponent(cwd)}&scope=all`, { signal: controller.signal }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (!controller.signal.aborted) { setModels((data.modelList ?? []).map((m: { provider: string; providerName?: string; id: string; name: string }) => ({ ...m, modelId: m.id }))); setLevels(data.thinkingLevels ?? {}); }
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [cwd, load]);
  const running = status?.runs.some((r) => r.status === "running");
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = () => {
      if (document.hidden || inFlight || !root.current?.getClientRects().length) return;
      inFlight = true;
      void load(controller.signal).catch((e) => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { inFlight = false; });
    };
    const timer = setInterval(refresh, running ? 3000 : 10000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); controller.abort(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [running, busy, load]);
  async function mutate(action: string, extra: object = {}) {
    if (busy) return;
    setBusy(true); setError(null);
    const sequence = ++requestSeq.current;
    try {
      const res = await fetch("/api/skills/evolution", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, action, ...extra }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.code ? t(`review.error.${data.code}`) : data.error ?? `HTTP ${res.status}`);
      if (sequence !== requestSeq.current) return;
      setStatus(data);
      if (action === "configure") setDraft(data.config);
      if (action === "approve" || action === "rollback") {
        const response = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
        const listing = await response.json();
        if (response.ok) onSkillsChanged(listing.skills);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!sessionPickerOpen) return;
    const controller = new AbortController();
    void fetch(`/api/sessions?summary=1`, { signal: controller.signal }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = Array.isArray(data) ? data : data.sessions ?? [];
      setSessions(list.filter((s: { cwd: string; relation?: { kind: string } }) => s.cwd === cwd && !["side", "subagent"].includes(s.relation?.kind ?? "")));
    }).catch((e) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [sessionPickerOpen, cwd]);
  const policy = reviewPolicy(draft);
  const availableLevels = levels[`${draft.provider}:${draft.modelId}`] ?? [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(status?.config);
  return <div ref={root}><ConfigDetailStack>
    <h3>{t("review.title")}</h3>
    <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("review.consent")}</p>
    <ConfigField label={t("review.automatic")}>
      <ConfigSwitch label={t("review.automatic")} checked={draft.enabled} disabled={busy} onChange={(enabled) => setDraft({ ...draft, enabled })} />
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("review.schedule")}</p>
    </ConfigField>
    <ConfigField label={t("review.model")}>
      <ModelSelector variant="field" options={models} value={draft.provider ? { provider: draft.provider, modelId: draft.modelId } : null}
        ariaLabel={t("review.model")} emptyLabel={t("review.selectModel")} disabled={busy} showProvider
        selectedLabel={draft.modelId || undefined}
        onChange={(provider, modelId) => {
          const supported = levels[`${provider}:${modelId}`] ?? ["off"];
          const thinkingLevel = supported.includes(draft.thinkingLevel) ? draft.thinkingLevel : supported.includes("medium") ? "medium" : supported[0];
          setDraft({ ...draft, provider, modelId, thinkingLevel: thinkingLevel as ReviewConfig["thinkingLevel"] });
        }} />
    </ConfigField>
    <ConfigField label={t("review.reasoning")}>
      <select aria-label={t("review.reasoning")} disabled={busy || !availableLevels.length} value={draft.thinkingLevel}
        onChange={(e) => setDraft({ ...draft, thinkingLevel: e.target.value as ReviewConfig["thinkingLevel"] })}
        style={{ width: "100%", padding: 8, background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5 }}>
        {!availableLevels.includes(draft.thinkingLevel) && <option value={draft.thinkingLevel}>{t(`review.thinking.${draft.thinkingLevel}`)}</option>}
        {availableLevels.map((level) => <option key={level} value={level}>{t(`review.thinking.${level}`)}</option>)}
      </select>
    </ConfigField>
    <details><summary>{t("review.policy")}</summary>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
        {(["intervalHours", "minTurns", "maxWaitHours", "dailyRuns", "dailyTokens", "timeoutMinutes", "retentionDays"] as const).map((key) => <ConfigField key={key} label={t(`review.policy.${key}`)}>
          <input type="number" min={1} step={1} aria-label={t(`review.policy.${key}`)} style={fieldStyle} disabled={busy} value={policy[key]}
            onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />
        </ConfigField>)}
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("review.budgetHint")}</p>
    </details>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <ConfigButton disabled={busy || !status || !dirty || (draft.enabled && (!draft.provider || !availableLevels.includes(draft.thinkingLevel)))} onClick={() => void mutate("configure", { config: draft })}>{t("review.save")}</ConfigButton>
      <ConfigButton disabled={busy || !!running || !status?.evidence?.some((e) => !e.blocked) || !status.config.provider || dirty} onClick={() => void mutate("run")}>{t("review.run")}</ConfigButton>
      <ConfigButton disabled={busy} onClick={() => { setError(null); void load().catch((e) => setError(String(e))); }}>{t("review.refresh")}</ConfigButton>
    </div>
    <p role="status">{t(running ? "review.running" : "review.waiting", { count: status?.pendingTurns ?? 0 })}</p>
    {status && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t(`review.wait.${status.waitReason}`)}</p>}
    {status?.budget && <p style={{ fontSize: 12 }}>{t("review.dailyUsage", status.budget)}</p>}
    {status?.notice && <p role="status">{t(`review.error.${status.notice}`)}</p>}
    {error && <p role="alert" style={{ overflowWrap: "anywhere" }}>{error}</p>}
    <details onToggle={(e) => setSessionPickerOpen(e.currentTarget.open)}><summary>{t("review.source")}</summary>
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("review.sourceHint")}</p>
      <ConfigField label={t("review.sourceSession")}><select aria-label={t("review.sourceSession")} style={fieldStyle} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
        <option value="">{t("review.sourceSession")}</option>
        {sessions.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.firstMessage ?? s.id}</option>)}
      </select></ConfigField>
      <div style={{ display: "flex", gap: 8, marginBlock: 12 }}>
        <label style={{ minWidth: 0 }}>{t("review.fromTurn")}<input type="number" min={1} style={fieldStyle} value={fromTurn} onChange={(e) => setFromTurn(Number(e.target.value))} /></label>
        <label style={{ minWidth: 0 }}>{t("review.toTurn")}<input type="number" min={fromTurn} style={fieldStyle} value={toTurn} onChange={(e) => setToTurn(Number(e.target.value))} /></label>
      </div>
      <ConfigButton disabled={busy || !sourceId || fromTurn < 1 || toTurn < fromTurn || toTurn - fromTurn >= 100} onClick={() => void mutate("source", { sessionId: sourceId, fromTurn, toTurn })}>{t("review.queueSource")}</ConfigButton>
    </details>
    {!!status?.evidence?.length && <details><summary>{t("review.queue")}</summary>
      {status.evidence.map((e) => <div key={e.id} style={{ borderTop: "1px solid var(--border)", paddingBlock: 8 }}>
        <a href={`/?session=${encodeURIComponent(e.sessionId)}`} target="_blank" rel="noreferrer">{e.sessionId.slice(0, 8)}</a>
        <p style={{ fontSize: 12 }}>{e.text.slice(0, 200)}</p>
        {e.blocked && <ConfigButton disabled={busy || !!running || dirty} onClick={() => void mutate("retry", { evidenceIds: [e.id] })}>{t("review.retryEvidence")}</ConfigButton>}
        <ConfigButton disabled={busy || !!running} onClick={() => void mutate("skip", { evidenceIds: [e.id] })}>{t("review.skip")}</ConfigButton>
      </div>)}
    </details>}
    <SkillProtectionControl cwd={cwd} skills={skills} bulk onChanged={onSkillsChanged} />
    <h4>{t("review.history")}</h4>
    <ConfigButton disabled={busy} onClick={() => void mutate("archive")}>{t("review.cleanup")}</ConfigButton>
    <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("review.archiveHint")}</p>
    {!status?.runs.length && <p style={{ color: "var(--text-muted)" }}>{t("review.empty")}</p>}
    {status?.runs.map((run) => <section key={run.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <button type="button" aria-expanded={expanded === run.id} onClick={() => setExpanded(expanded === run.id ? null : run.id)}
        style={{ width: "100%", textAlign: "left", color: "var(--text)", cursor: "pointer" }}>
        {new Date(run.startedAt).toLocaleString()} — {t(`review.status.${run.status}`)}
      </button>
      <p style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
        {run.config.provider}/{run.config.modelId} · {run.config.thinkingLevel}
        {run.usage ? ` · ${run.usage.tokens} tokens · $${run.usage.cost.toFixed(4)}` : ""}
      </p>
      {run.errorCode ? <p role="status">{t(`review.error.${run.errorCode}`)}</p> : run.error && <p role="status">{run.error}</p>}
      {run.status === "running" && run.phase && <p>{t(`review.phase.${run.phase}`)}</p>}
      {run.inputBytes !== undefined && <p style={{ fontSize: 12 }}>{t("review.inputSize", { count: run.evidence.length, bytes: run.inputBytes })}</p>}
      {!!run.duplicateCount && <p>{t("review.duplicates", { count: run.duplicateCount })}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {run.status === "running" && <ConfigButton disabled={busy || run.cancelRequested} onClick={() => void mutate("cancel", { runId: run.id })}>{t(run.cancelRequested ? "review.cancelling" : "review.cancel")}</ConfigButton>}
        {["failed", "interrupted"].includes(run.status) && <ConfigButton disabled={busy || !!running || dirty || !status.evidence?.some((e) => run.evidence.some((source) => source.id === e.id))} onClick={() => void mutate("retry", { runId: run.id })}>{t("review.retry")}</ConfigButton>}
        {run.canArchive && <ConfigButton disabled={busy} onClick={() => void mutate("archive", { runId: run.id })}>{t("review.archive")}</ConfigButton>}
      </div>
      {expanded === run.id && <>
        <p>{run.summary}</p>
        <details><summary>{t("review.evidence")}</summary>
          {run.evidence.map((e) => <div key={e.id}>
            <a href={`/?session=${encodeURIComponent(e.sessionId)}`} target="_blank" rel="noreferrer">{e.sessionId} · {e.leafId}</a>
            {e.truncated && <p>{t("review.truncated", { included: e.includedEntries ?? 0, total: e.totalEntries ?? 0 })}</p>}
            {!!e.signals?.length && <p style={{ fontSize: 12 }}>{e.signals.map((s) => t(`review.signal.${s}`)).join(" · ")}</p>}
            <pre style={codeStyle}>{e.text}</pre>
            {!!e.windows?.length && <details><summary>{t("review.windows")}</summary>{e.windows.map((w) => <pre key={w.entryId} style={codeStyle}>{w.entryId}{"\n"}{w.text}</pre>)}</details>}
          </div>)}
        </details>
        {run.candidates.map((c) => {
          const locked = c.before !== null && (skills.find((s) => s.filePath === c.filePath)?.protection?.locked ?? true);
          return <div key={c.id} style={{ marginTop: 16 }}>
            <strong>{c.name}</strong> — {t(`review.candidate.${c.status}`)}
            <p>{c.reason}</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{c.filePath}</p>
            <details><summary>{t("review.changes")}</summary>
              <pre style={codeStyle}>{skillReviewDiff(c.before, c.after).map((line, i) => <span key={i} style={{ display: "block", color: line.kind === "added" ? "var(--accent)" : line.kind === "removed" ? "var(--text-muted)" : "var(--text-dim)" }}>
                {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}{line.text}
              </span>)}</pre>
              <h5>{t("review.before")}</h5><pre style={codeStyle}>{c.before ?? t("review.newSkill")}</pre>
              <h5>{t("review.after")}</h5><pre style={codeStyle}>{c.after}</pre>
            </details>
            {locked && <p>{t("review.lockedTarget")}</p>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {["pending", "applying"].includes(c.status) && <>
                <ConfigButton disabled={busy || locked} onClick={() => void mutate("approve", { runId: run.id, candidateId: c.id })}>{t("review.approve")}</ConfigButton>
                <ConfigButton disabled={busy} onClick={() => void mutate("reject", { runId: run.id, candidateId: c.id })}>{t("review.reject")}</ConfigButton>
              </>}
              {["applied", "reverting"].includes(c.status) && <ConfigButton disabled={busy || locked} onClick={() => void mutate("rollback", { runId: run.id, candidateId: c.id })}>{t("review.rollback")}</ConfigButton>}
            </div>
          </div>;
        })}
      </>}
    </section>)}
  </ConfigDetailStack></div>;
}
