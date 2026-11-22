/** Bounded line comparison: common prefix/suffix remain context, the changed middle is explicit. */
export function skillReviewDiff(before: string | null, after: string): { kind: "context" | "removed" | "added"; text: string }[] {
  const old = before === null ? [] : before.split(/\r?\n/);
  const next = after.split(/\r?\n/);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
  return [
    ...old.slice(Math.max(0, start - 3), start).map((text) => ({ kind: "context" as const, text })),
    ...old.slice(start, old.length - end).map((text) => ({ kind: "removed" as const, text })),
    ...next.slice(start, next.length - end).map((text) => ({ kind: "added" as const, text })),
    ...next.slice(next.length - end, next.length - end + 3).map((text) => ({ kind: "context" as const, text })),
  ];
}
