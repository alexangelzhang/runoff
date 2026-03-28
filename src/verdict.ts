/** Parse structured verdict from review output.
 *  Looks for sentinel line: VERDICT: APPROVED or VERDICT: NEEDS_REVISION: <reason> */
export function parseVerdict(raw: string): { approved: boolean; feedback: string; format: "structured" | "unstructured" } {
  const verdictMatch = raw.match(/VERDICT:\s*[*`'"\s]*(APPROVED|NEEDS_REVISION)[*`'"\s]*(?::\s*(.*))?/i);
  if (verdictMatch) {
    const isApproved = verdictMatch[1].toUpperCase() === "APPROVED";
    return { approved: isApproved, feedback: isApproved ? "" : (verdictMatch[2] ?? raw), format: "structured" };
  }
  const approvedLine = raw.match(/^\s*[*`'"\s]*APPROVED[*`'"\s]*$/m);
  if (approvedLine && !raw.toUpperCase().includes("NEEDS_REVISION")) {
    return { approved: true, feedback: "", format: "structured" };
  }
  return { approved: false, feedback: raw, format: "unstructured" };
}
