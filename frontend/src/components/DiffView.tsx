import { useState } from "react";
import type { DiffLine, DiffResult } from "../api/types";

interface SideRow {
  left: DiffLine | null;
  right: DiffLine | null;
  hunk?: string;
}

/** Pairs removed/added runs so that a change appears on one row in the side-by-side view. */
export function toSideBySide(lines: DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    const length = Math.max(removed.length, added.length);
    for (let i = 0; i < length; i += 1) rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "remove") removed.push(line);
    else if (line.kind === "add") added.push(line);
    else {
      flush();
      if (line.kind === "hunk") rows.push({ left: null, right: null, hunk: line.text });
      else rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", remove: "−", context: " ", hunk: "" };

/**
 * `newFile`: the diff of a file that does not exist yet — every line is an addition, so the before/after
 * view (an empty left column) is not offered.
 */
export function DiffView({
  diff,
  newFile = false,
  label,
  beforeLabel = "Было",
  afterLabel = "Стало",
}: {
  diff: DiffResult;
  newFile?: boolean;
  /** Accessible name of the line-by-line table (defaults to the proposal wording). */
  label?: string;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const [selected, setMode] = useState<"unified" | "split">("unified");
  const mode = newFile ? "unified" : selected;
  if (!diff.changed) return <p className="muted">Изменений нет.</p>;
  return (
    <div className="diff">
      <div className="diff__toolbar">
        {newFile ? (
          <p className="diff__stats">
            <span className="diff__add">+{diff.additions}</span> строк · новый файл
          </p>
        ) : (
          <p className="diff__stats">
            <span className="diff__add">+{diff.additions}</span> <span className="diff__del">−{diff.deletions}</span>{" "}
            строк
          </p>
        )}
        {newFile ? null : (
          <div className="tabs tabs--small" role="tablist" aria-label="Вид сравнения">
            <button type="button" role="tab" aria-selected={mode === "unified"} onClick={() => setMode("unified")}>
              Построчно
            </button>
            <button type="button" role="tab" aria-selected={mode === "split"} onClick={() => setMode("split")}>
              До и после
            </button>
          </div>
        )}
      </div>
      <div className="diff__scroll">
        {mode === "unified" ? (
          <table
            className="diff__table"
            aria-label={label ?? (newFile ? "Содержимое нового файла" : "Изменения построчно")}
          >
            <thead className="visually-hidden">
              <tr>
                <th>Было, строка</th>
                <th>Стало, строка</th>
                <th>Текст</th>
              </tr>
            </thead>
            <tbody>
              {diff.lines.map((line, index) =>
                line.kind === "hunk" ? (
                  <tr key={index} className="diff__hunk">
                    <td colSpan={3}>{line.text}</td>
                  </tr>
                ) : (
                  <tr key={index} className={`diff__row diff__row--${line.kind}`}>
                    <td className="diff__no">{line.old_no ?? ""}</td>
                    <td className="diff__no">{line.new_no ?? ""}</td>
                    <td className="diff__code">
                      <span className="diff__sign" aria-label={line.kind === "add" ? "добавлено" : line.kind === "remove" ? "удалено" : undefined}>
                        {SIGN[line.kind]}
                      </span>
                      {line.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ) : (
          <table className="diff__table diff__table--split" aria-label="Сравнение до и после">
            <thead>
              <tr>
                <th colSpan={2}>{beforeLabel}</th>
                <th colSpan={2}>{afterLabel}</th>
              </tr>
            </thead>
            <tbody>
              {toSideBySide(diff.lines).map((row, index) =>
                row.hunk ? (
                  <tr key={index} className="diff__hunk">
                    <td colSpan={4}>{row.hunk}</td>
                  </tr>
                ) : (
                  <tr key={index}>
                    <td className="diff__no">{row.left?.old_no ?? ""}</td>
                    <td className={`diff__code diff__code--${row.left?.kind ?? "empty"}`}>{row.left?.text ?? ""}</td>
                    <td className="diff__no">{row.right?.new_no ?? ""}</td>
                    <td className={`diff__code diff__code--${row.right?.kind ?? "empty"}`}>{row.right?.text ?? ""}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
