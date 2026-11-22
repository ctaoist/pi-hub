import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { contentHash, emptyReviewProject, readEvolutionState, withEvolutionState } from "./skill-evolution-store";
import type { ReviewEvidence } from "./skill-evolution-types";

/** Best-effort redaction, not a promise to discover every secret. Consent is still required. */
export function redactReviewText(text: string): string {
  return text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/((?:https?|postgres(?:ql)?|mysql):\/\/)[^\s/:]+:[^\s/@]+@/g, "$1[REDACTED]@")
    .replace(/(["'](?:api[_-]?key|password|secret|access[_-]?token|authorization)["']\s*:\s*["'])[^"']+["']/gi, "$1[REDACTED]\"")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[\w.+/=-]+/gi, "Bearer [REDACTED]");
}
export function turnEvidence(sessionId: string, branch: SessionEntry[], now = Date.now()): ReviewEvidence | null {
  let start = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message.role === "user") { start = i; break; }
  }
  if (start < 0) return null;
  const tail = branch.slice(start);
  const assistants = tail.filter((e) => e.type === "message" && e.message.role === "assistant");
  const last = assistants.at(-1);
  if (!last || last.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "stop") return null;
  const lines: string[] = [];
  const windows: { entryId: string; text: string }[] = [];
  const signals = new Set<string>();
  let totalEntries = 0;
  let truncated = false;
  let length = 0;
  let windowBytes = 0;
  // Keep the end (validation and final outcome) if a turn is larger than the budget.
  for (const entry of tail.toReversed()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!["user", "assistant", "toolResult"].includes(message.role)) continue;
    const content = "content" in message ? message.content : "";
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "toolCall") return [`tool ${block.name}: ${JSON.stringify(block.arguments)}`];
      return []; // No thinking, signatures, images or arbitrary tool details.
    }).join("\n") : "";
    totalEntries++;
    const safe = redactReviewText(text);
    if (message.role === "user" && /不对|不是|纠正|应该|不要|instead|incorrect|correction|don't|do not/i.test(safe)) signals.add("correction");
    if (message.role === "toolResult" && "isError" in message && message.isError) signals.add("failure");
    if (/(?:tests? passed|\bPASS\b|验证通过|测试通过|success)/i.test(safe)) signals.add("validation");
    const excerpt = safe.length > 2400 ? `${safe.slice(0, 1200)}\n[Middle of entry omitted]\n${safe.slice(-1200)}` : safe;
    const line = `${entry.id} ${message.role}: ${excerpt}`;
    if (safe.length > 2400) truncated = true;
    if (length + line.length > 12000) {
      truncated = true;
      if (windowBytes < 8000 && (message.role === "user" || message.role === "toolResult")) {
        const extra = line.slice(0, Math.min(2400, 8000 - windowBytes));
        windows.unshift({ entryId: entry.id, text: extra }); windowBytes += extra.length;
      }
      continue;
    }
    lines.unshift(line); length += line.length;
    if (safe.length > 2400 && windowBytes < 8000) {
      const extra = safe.slice(1200, Math.min(safe.length - 1200, 1200 + Math.min(4000, 8000 - windowBytes)));
      windows.unshift({ entryId: entry.id, text: extra }); windowBytes += extra.length;
    }
  }
  const user = branch[start];
  const request = user.type === "message" && user.message.role === "user" ? user.message.content : "";
  const requestText = typeof request === "string" ? request : request.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const workflow = redactReviewText(requestText).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!lines.some((line) => line.startsWith(`${user.id} user:`))) {
    const message = user.type === "message" ? user.message : null;
    if (message?.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      lines.unshift(`${user.id} user: ${redactReviewText(text).slice(0, 2400)}\n[Middle of long turn omitted]`);
    }
  }
  // Forks preserve entry IDs and timestamps: inherited turns must not be learned twice.
  return { id: contentHash(`${user.id}:${user.timestamp ?? ""}`).slice(0, 24), sessionId,
    leafId: branch.at(-1)!.id, at: now, sourceAt: Date.parse(user.timestamp) || now,
    text: lines.join("\n"), truncated, totalEntries, includedEntries: lines.length, signals: [...signals], windows,
    ...(workflow.length >= 12 ? { workflowKey: contentHash(workflow) } : {}) };
}

/** Runs on settlement, never dispatches a model. No writes or snapshots before opt-in. */
export function recordReviewTurn(cwd: string, sessionId: string, getBranch: () => SessionEntry[]): void {
  try {
    const key = realpathSync(cwd);
    const config = readEvolutionState().projects[key];
    if (!config?.config.enabled) return;
    const branch = getBranch();
    const evidence: ReviewEvidence[] = [];
    const knownIds = new Set([...config.seen, ...config.turns.map((e) => e.id)]);
    let start = -1;
    const add = (end: number) => {
      if (start < 0 || evidence.length >= 200) return;
      const user = branch[start];
      const timestamp = Date.parse(user.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < config.collectSince
        || knownIds.has(contentHash(`${user.id}:${user.timestamp}`).slice(0, 24))) return;
      const item = turnEvidence(sessionId, branch.slice(start, end));
      if (item) evidence.push(item);
    };
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === "user") { add(i); start = i; }
    }
    add(branch.length);
    if (!evidence.length) return;
    void withEvolutionState((state) => {
      const project = state.projects[key] ?? emptyReviewProject();
      if (!project.config.enabled || project.collectSince !== config.collectSince) return;
      const known = new Set([...project.seen, ...project.turns.map((e) => e.id)]);
      const fresh = evidence.filter((e) => !known.has(e.id));
      if (project.turns.length + fresh.length > 200) throw new Error("Pending review queue is full");
      project.turns.push(...fresh);
    }).catch(() => console.warn("[skill-review] Could not persist pending evidence; no model was started."));
  } catch { console.warn("[skill-review] Could not read review state; no model was started."); }
}
