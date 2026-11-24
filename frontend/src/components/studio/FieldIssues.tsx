import type { StudioIssue } from "../../api/types";

/** `aria-describedby` of a control: its hint and its issues (only the ids that are rendered). */
export function describedBy(id: string, issues: StudioIssue[], hint = false): string | undefined {
  const ids = [hint ? `${id}-hint` : "", issues.length > 0 ? `${id}-issues` : ""].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function hasError(issues: StudioIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** Validation findings of one field, right under it (errors first; a warning never blocks a save). */
export function FieldIssues({ id, issues }: { id: string; issues: StudioIssue[] }) {
  if (issues.length === 0) return null;
  const ordered = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return (
    <ul id={`${id}-issues`} className="field__issues">
      {ordered.map((issue) => (
        <li key={`${issue.code}-${issue.message}`} className={`field__issue field__issue--${issue.severity}`}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}
