import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/hooks/useI18n";
import { ModelsConfig } from "@/components/ModelsConfig";

createRoot(document.getElementById("root")!).render(
  <I18nProvider><ModelsConfig embedded onClose={() => {}} /></I18nProvider>,
);
