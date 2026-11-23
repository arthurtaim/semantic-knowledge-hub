import { formatWhen } from "../lib/labels";

/**
 * A past moment in a list or table: relative text for today and yesterday, the full date as a tooltip (and,
 * for relative text, for screen readers), never wrapped across lines.
 */
export function When({ value, fallback = "—" }: { value: string | null | undefined; fallback?: string }) {
  if (!value) return <>{fallback}</>;
  const { text, full, relative } = formatWhen(value);
  return (
    <time className="when" dateTime={value} title={full}>
      {text}
      {relative ? <span className="visually-hidden"> ({full})</span> : null}
    </time>
  );
}
