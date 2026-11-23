import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { PluginConfigEditor } from "@/components/PluginConfigEditor";
function Fixture() {
  const { setLocale } = useI18n();
  const [source, setSource] = useState("existing");
  const [generation, setGeneration] = useState(0);
  const root = document.body.dataset.root!;
  const cwd = document.body.dataset.cwd!;
  return <main style={{ maxWidth: 700, margin: "auto", padding: 16 }}>
    <nav style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
      {["existing", "example", "empty", "standalone"].map((name) => <button key={name} onClick={() => setSource(name)}>{name}</button>)}
      <button onClick={() => setGeneration((n) => n + 1)}>Reopen</button>
      <button onClick={() => setLocale("zh-CN")}>简体中文</button>
      <button onClick={() => setLocale("zh-TW")}>繁體中文</button>
      <button onClick={() => setLocale("en")}>English</button>
    </nav>
    <PluginConfigEditor key={`${source}:${generation}`} cwd={cwd}
      source={source === "standalone" ? `${root}/agent/extensions/hindsight-distill/index.ts` : `${root}/${source}`}
      kind={source === "standalone" ? "extension" : "package"} scope="global" blocked={false} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider><Fixture /></I18nProvider>);
