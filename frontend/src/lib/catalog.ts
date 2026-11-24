import { listValues, STATUS_PARAM, TYPE_PARAM } from "./docsTable";

/*
 * «Карта» from «Документы»: the knowledge-map URL with the filters of the catalog that the map has too. The table's
 * own filters, sort and grouping live in lib/docsTable.ts.
 */

/** Document types that are their own node kind on the map (backend/app/services/graph.py KIND_BY_TYPE). */
const GRAPH_KIND_BY_TYPE: Partial<Record<string, string>> = {
  source: "source_system",
  integration: "integration",
  domain: "semantic_entity",
  dataset: "dataset",
};

/**
 * `/graph` with the catalog's filters mapped to the map's filters: one status → `status`, one section that is a
 * node kind of its own → `kind`. Owner, tag, source, system, several values and a text query have no map equivalent
 * and are dropped (the map shows the whole base then).
 */
export function graphHref(params: URLSearchParams): string {
  const next = new URLSearchParams();
  const types = listValues(params, TYPE_PARAM);
  const statuses = listValues(params, STATUS_PARAM);
  const kind = types.length === 1 ? GRAPH_KIND_BY_TYPE[types[0] ?? ""] : undefined;
  if (kind) next.set("kind", kind);
  if (statuses.length === 1 && statuses[0]) next.set("status", statuses[0]);
  const query = next.toString();
  return query ? `/graph?${query}` : "/graph";
}
