"use client";

import { useState } from "react";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigField, ConfigSwitch } from "./SettingsUi";

export function SkillProtectionControl({ cwd, skills, bulk = false, onChanged }: {
  cwd: string; skills: SkillInfo[]; bulk?: boolean; onChanged: (skills: SkillInfo[]) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const protection = skills[0]?.protection;
  const locked = protection?.locked ?? true;
  async function save(locked: boolean | null) {
    if (busy || !skills.length) return;
    if (bulk && !window.confirm(t(locked ? "review.confirmLockAll" : "review.confirmUnlockAll", { count: skills.length }))) return;
    setBusy(true); setError(null);
    try {
      // A large library uses bounded sequential batches. Each server reply reports partial failures.
      let latest: SkillInfo[] | undefined;
      const failures: string[] = [];
      for (let i = 0; i < skills.length; i += 500) {
        const response = await fetch("/api/skills/protection", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, filePaths: skills.slice(i, i + 500).map((s) => s.filePath), locked }) });
        const data = await response.json() as SkillsResponse & { error?: string; results?: { error?: string }[] };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        latest = data.skills;
        failures.push(...(data.results ?? []).flatMap((r) => r.error ? [r.error] : []));
        onChanged(latest);
      }
      if (failures.length) setError(failures.join("\n"));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  if (bulk) return <div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <ConfigButton disabled={busy || !skills.length} onClick={() => void save(true)}>{t("review.lockAll")}</ConfigButton>
      <ConfigButton disabled={busy || !skills.length} onClick={() => void save(false)}>{t("review.unlockAll")}</ConfigButton>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
  return <ConfigField label={t(locked ? "review.locked" : "review.unlocked")}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <ConfigSwitch label={t("review.lockSkill")} checked={locked} loading={busy} onChange={(locked) => void save(locked)} />
      {protection?.overridden && <ConfigButton disabled={busy} onClick={() => void save(null)}>{t("review.resetLock")}</ConfigButton>}
    </div>
    <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("review.lockHint")}</p>
    {skills[0]?.install && !protection?.locked && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("review.upstreamWarning")}</p>}
    {protection?.unavailable && <p role="alert">{t("review.error.review-storage")}</p>}
    {error && <p role="alert">{error}</p>}
  </ConfigField>;
}
