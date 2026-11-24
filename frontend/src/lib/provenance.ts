import type { AnswerProvenance, AskResponse, Citation, ProvenanceOrigin, SystemFactItem } from "../api/types";
import { pluralRu } from "./labels";

/*
 * Origin of the evidence an answer relies on (docs/API_CONTRACTS.md «Answer provenance», docs/UI_REDESIGN.md
 * «Происхождение источников»). It is metadata of the validated sources, not a warning: one quiet line per answer and
 * a mark per source only where the sources of that answer differ. Never «реальный»: `not_synthetic` only means «no
 * synthetic mark», and `unknown` means no metadata at all (an attachment's `is_demo: false` says nothing).
 */

/** The origin of ONE source, as its quiet mark in «Источники», in a citation card or on a listed document. */
export const ORIGIN_LABEL: Record<ProvenanceOrigin, string> = {
  synthetic: "синтетический",
  not_synthetic: "не помечен как синтетический",
  unknown: "происхождение не указано",
};

/** Group names of a count by origin (catalog facets, «По происхождению»). */
export const ORIGIN_GROUP_LABEL: Record<ProvenanceOrigin, string> = {
  synthetic: "синтетические",
  not_synthetic: "без пометки",
  unknown: "не указано",
};

/** «синтетические (учебные)», «смешанные — 2 синтетических, 1 без пометки», …; null when there is nothing to say. */
function originWords(provenance: AnswerProvenance): string | null {
  switch (provenance.overall) {
    case "synthetic":
      return "синтетические (учебные)";
    case "not_synthetic":
      return "не помечены как синтетические";
    case "unknown":
      return "не указано";
    case "mixed": {
      const parts: string[] = [];
      const { synthetic, not_synthetic: unmarked, unknown } = provenance;
      if (synthetic > 0) parts.push(`${synthetic} ${pluralRu(synthetic, "синтетический", "синтетических", "синтетических")}`);
      if (unmarked > 0) parts.push(`${unmarked} без пометки`);
      if (unknown > 0) parts.push(`${unknown} без указания происхождения`);
      return parts.length > 0 ? `смешанные — ${parts.join(", ")}` : "смешанные";
    }
    default:
      return null;
  }
}

/**
 * The answer's one line: «Источники: синтетические (учебные)», «Источники: смешанные — 2 синтетических, 1 без
 * пометки», «Происхождение источников не указано». Null when the answer relies on no source (`none`) or the server
 * sent no summary — nothing is claimed then.
 */
export function provenanceLine(provenance: AnswerProvenance | null | undefined): string | null {
  if (!provenance) return null;
  if (provenance.overall === "unknown") return "Происхождение источников не указано";
  const words = originWords(provenance);
  return words ? `Источники: ${words}` : null;
}

/** The same in copied text, where it ends the list of sources: «Происхождение источников: синтетические (учебные)». */
export function provenanceCopyLine(provenance: AnswerProvenance | null | undefined): string | null {
  const words = provenance ? originWords(provenance) : null;
  return words ? `Происхождение источников: ${words}` : null;
}

/**
 * A mark per source only when the sources of this answer differ (`mixed`); when they share one origin the answer's
 * line already says it for all of them, and repeating it on every row is the noise this replaces.
 */
export function showsSourceOrigins(answer: Pick<AskResponse, "provenance">): boolean {
  return answer.provenance?.overall === "mixed";
}

/** A citation's origin; an older server without `provenance` is read the same way the server derives it. */
export function citationOrigin(citation: Citation): ProvenanceOrigin {
  if (citation.provenance) return citation.provenance;
  if (citation.source_type === "attachment") return "unknown";
  return citation.is_demo ? "synthetic" : "not_synthetic";
}

/** A document listed by a system fact: its origin, or null when it is not a document or the server did not say. */
export function factItemOrigin(item: SystemFactItem): ProvenanceOrigin | null {
  if (item.kind !== "document" || item.is_demo === null || item.is_demo === undefined) return null;
  return item.is_demo ? "synthetic" : "not_synthetic";
}
