import type { ReactNode } from "react";
import type { Citation, ExcerptPart } from "../api/types";

/*
 * The quote of a citation, readable when it comes from a Markdown table. The server verifies `excerpt` verbatim;
 * when that quote touches a table it also sends `excerpt_parts` — the quote's prose and the table rows it touches,
 * taken from the cited section of the same revision (docs/API_CONTRACTS.md, v0.4). Without parts the excerpt is
 * shown as it always was. Cells are never glued: a table is a mini table under «Источники» and rows of cells
 * separated by « — » in the marker's card.
 */

const CELL_SEPARATOR = " — ";

/** Words of the question (stems of 4+ letters) — what the card highlights in the quote. */
function questionStems(question: string): string[] {
  const words = question.toLocaleLowerCase("ru").match(/[\p{L}\p{N}_]{4,}/gu) ?? [];
  return [...new Set(words.map((word) => (/^[\p{L}]+$/u.test(word) ? word.slice(0, 5) : word)))].slice(0, 12);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The quote with the question's words marked (search-style highlighting; the quote itself is verbatim). */
export function HighlightedQuote({ text, question }: { text: string; question: string }) {
  const stems = questionStems(question);
  if (stems.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${stems.map(escapeRegExp).join("|")})[\\p{L}\\p{N}_]*`, "giu");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = index === 0 ? "" : text[index - 1] ?? "";
    if (/[\p{L}\p{N}_]/u.test(before)) continue; // only whole words that start with a stem
    parts.push(text.slice(last, index));
    parts.push(<mark key={index}>{match[0]}</mark>);
    last = index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

type TablePart = ExcerptPart & { kind: "table" };

function isTable(part: ExcerptPart): part is TablePart {
  return part.kind === "table";
}

/** The parts to show, or null when the excerpt has no table (then the plain excerpt is shown). */
export function excerptParts(citation: Citation): ExcerptPart[] | null {
  const parts = citation.excerpt_parts ?? null;
  return parts && parts.some(isTable) ? parts : null;
}

/** One row of a table as text: «Источник — ARIS — SYS-ARIS». Empty cells keep their place as «—». */
export function rowText(cells: string[]): string {
  return cells.map((cell) => cell.trim() || "—").join(CELL_SEPARATOR);
}

/** The excerpt as plain text (copying an answer with its sources): table rows are «a — b — c», separated by «; ». */
export function excerptText(citation: Citation): string {
  const parts = excerptParts(citation);
  if (!parts) return citation.excerpt;
  return parts
    .map((part) => {
      if (!isTable(part)) return part.text ?? "";
      const rows = (part.rows ?? []).map(rowText).join("; ");
      const head = rowText(part.headers ?? []);
      return rows ? `${head}: ${rows}` : head;
    })
    .filter(Boolean)
    .join(" ");
}

/** Under «Источники»: prose in quotes, a table as a mini table (stacked «заголовок: значение» when narrow). */
export function SourceExcerpt({ citation }: { citation: Citation }) {
  const parts = excerptParts(citation);
  if (!parts) return <q className="source__quote">{citation.excerpt}</q>;
  return (
    <div className="source__excerpt">
      {parts.map((part, index) =>
        isTable(part) ? (
          <div key={index} className="excerpt-table">
            {/* Explicit roles: the stacked (narrow) layout changes `display`, which some browsers take as «not a table». */}
            <table role="table" aria-label={`Строки таблицы из раздела${citation.section ? ` «${citation.section}»` : ""}`}>
              <thead role="rowgroup">
                <tr role="row">
                  {(part.headers ?? []).map((header, col) => (
                    <th key={col} scope="col" role="columnheader">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup">
                {(part.rows ?? []).map((row, rowIndex) => (
                  <tr key={rowIndex} role="row">
                    {row.map((cell, col) => (
                      <td key={col} role="cell" data-label={part.headers?.[col] ?? ""}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <q key={index} className="source__quote">
            {part.text}
          </q>
        ),
      )}
    </div>
  );
}

/** In a marker's card (phrasing content only): prose with the question's words marked, a table as rows of cells. */
export function CardExcerpt({ citation, question }: { citation: Citation; question: string }) {
  const parts = excerptParts(citation);
  if (!parts) {
    return (
      <span className="cite-card__quote">
        «<HighlightedQuote text={citation.excerpt} question={question} />»
      </span>
    );
  }
  return (
    <span className="cite-card__quote">
      {parts.map((part, index) =>
        isTable(part) ? (
          <span key={index} className="cite-card__table">
            <span className="cite-card__row cite-card__row--head">{rowText(part.headers ?? [])}</span>
            {(part.rows ?? []).map((row, rowIndex) => (
              <span key={rowIndex} className="cite-card__row">
                <HighlightedQuote text={rowText(row)} question={question} />
              </span>
            ))}
          </span>
        ) : (
          <span key={index} className="cite-card__text">
            «<HighlightedQuote text={part.text ?? ""} question={question} />»
          </span>
        ),
      )}
    </span>
  );
}
