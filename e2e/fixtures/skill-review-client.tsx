import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/hooks/useI18n";
import { SkillEvolutionPanel } from "@/components/SkillEvolutionPanel";
import { SkillProtectionControl } from "@/components/SkillProtectionControl";
import type { SkillInfo } from "@/lib/api-types";
function Fixture() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const cwd = document.body.dataset.cwd!;
  return <I18nProvider><main style={{ maxWidth: 900, margin: "auto", padding: 16 }}>
    <SkillEvolutionPanel cwd={cwd} skills={skills} onSkillsChanged={setSkills} />
    {skills.map((s) => <section key={s.filePath}><h3>{s.name}</h3><SkillProtectionControl cwd={cwd} skills={[s]} onChanged={setSkills} /></section>)}
  </main></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
