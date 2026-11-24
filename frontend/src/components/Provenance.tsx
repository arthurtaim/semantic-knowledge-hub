import type { AnswerProvenance, ProvenanceOrigin } from "../api/types";
import { ORIGIN_LABEL, provenanceLine } from "../lib/provenance";

/*
 * Origin of an answer's sources (lib/provenance.ts): quiet metadata, never a warning notice. The amber dot is the one
 * of «Демо-данные» in the toolbar — the same meaning (synthetic content), not the AI mode.
 */

/** One line in the answer's head: what the sources it relies on are. Nothing when it relies on none. */
export function ProvenanceLine({ provenance }: { provenance: AnswerProvenance | null | undefined }) {
  const text = provenanceLine(provenance);
  if (!text || !provenance) return null;
  return <p className={`answer__provenance answer__provenance--${provenance.overall}`}>{text}</p>;
}

/** One source's origin, shown only where the sources of an answer differ (`showsSourceOrigins`). */
export function OriginMark({ origin }: { origin: ProvenanceOrigin }) {
  return (
    <span className={`source-origin source-origin--${origin}`}>
      {origin === "unknown" ? null : <span className="visually-hidden">Происхождение: </span>}
      {ORIGIN_LABEL[origin]}
    </span>
  );
}
