/** Codes are public; upstream exception text (possibly credentials) is not. */
export class SkillReviewError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function reviewErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.startsWith("review-")) return error.code;
  if (error instanceof SyntaxError) return "review-output";
  const text = error instanceof Error ? error.message : "";
  if (/Invalid review policy|Select a review model|ID required|Invalid review ID/.test(text)) return "review-input";
  if (/lock.*compromised/i.test(text)) return "review-interrupted";
  if (/locked|discovered/.test(text)) return "review-locked";
  if (/changed|conflict|already exists/.test(text)) return "review-conflict";
  if (/trust/i.test(text)) return "review-trust";
  if (/access denied|not found/i.test(text)) return "review-access";
  if (/damaged|storage|full/.test(text)) return "review-storage";
  if (/another|active|already.*lock|lock.*already/i.test(text)) return "review-busy";
  if (/candidate|frontmatter|evidence|output|target|skill name/i.test(text)) return "review-output";
  return "review-provider";
}
