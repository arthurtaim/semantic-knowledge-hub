import type {
  AiDraftResponse,
  DocType,
  DocumentTemplateInfo,
  NewDocumentMetadata,
  NewDocumentStatus,
  ProposalDetail,
  ProposalOrigin,
} from "../api/types";
import { NEW_DOCUMENT_STATUSES, TYPE_ORDER } from "./labels";

/** Heading text used in the body until the author enters a title. */
export const TITLE_PLACEHOLDER = "Название документа";
/** How the server stores an unknown owner (never invented). */
export const UNASSIGNED_OWNER = "unassigned";

/** Form state of the new-document editor. Lists are kept as typed (comma-separated) until they are sent. */
export interface EditorFields {
  /** Empty until the server allocates the ID at the first save (unless `manualId`). */
  id: string;
  /** The author chose to set the ID by hand (e.g. migrating a document with a known ID); default: the server. */
  manualId: boolean;
  title: string;
  status: NewDocumentStatus;
  owner: string;
  tags: string;
  relatedIds: string;
  sourceRefs: string;
  summary: string;
  path: string;
  /** false: the path follows the ID (`<dir>/<ID>.md`); true: the author edited it. */
  pathEdited: boolean;
  reason: string;
  body: string;
  origin: ProposalOrigin;
  /** Section of a BLANK document (no template), chosen by the author; null when a template decides it. */
  type: DocType | null;
}

/** Splits a comma/newline separated list, trims items and drops empty and duplicate ones. */
export function splitList(text: string): string[] {
  const items = text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

export function joinList(items: readonly string[]): string {
  return items.join(", ");
}

export function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

/** Repository path that follows the document ID: `<dir>/<ID>.md`. */
export function autoPath(dir: string, id: string): string {
  return `${dir ? `${dir}/` : ""}${id.trim()}.md`;
}

export function headingFor(title: string): string {
  return `# ${title.trim() || TITLE_PLACEHOLDER}`;
}

/** Keeps the `# Title` heading in sync with the title field while the author has not changed the heading. */
export function retitleBody(body: string, previousTitle: string, nextTitle: string): string {
  const newline = body.indexOf("\n");
  const first = newline === -1 ? body : body.slice(0, newline);
  if (first.trimEnd() !== headingFor(previousTitle)) return body;
  return headingFor(nextTitle) + (newline === -1 ? "" : body.slice(newline));
}

function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The path that follows the ID; empty while the server has not allocated the ID yet. */
export function followingPath(dir: string, id: string): string {
  return id.trim() ? autoPath(dir, id) : "";
}

/**
 * Initial form of a manually written document: template tags and the section skeleton. The ID (and the path that
 * follows it) is allocated by the server at the first save; `owner` defaults to the current user and is optional
 * (empty → stored as `unassigned`).
 */
export function fieldsFromTemplate(template: DocumentTemplateInfo, owner = ""): EditorFields {
  return {
    id: "",
    manualId: false,
    title: "",
    status: "draft",
    owner,
    tags: joinList(template.default_tags),
    relatedIds: "",
    sourceRefs: "",
    summary: "",
    path: "",
    pathEdited: false,
    reason: "",
    body: `${headingFor("")}\n\n${withTrailingNewline(template.skeleton.trim())}`,
    origin: "manual",
    type: null,
  };
}

/**
 * «Пустой документ»: no template, no required sections — only the `# Title` heading to start writing under. The
 * server allocates the `SEM-DOC-NNN` ID at the first save; the author chose the section (`type`).
 */
export function fieldsFromBlank(title: string, type: DocType, owner = ""): EditorFields {
  return {
    id: "",
    manualId: false,
    title: title.trim(),
    status: "draft",
    owner,
    tags: "",
    relatedIds: "",
    sourceRefs: "",
    summary: "",
    path: "",
    pathEdited: false,
    reason: "",
    body: `${headingFor(title)}\n\n`,
    origin: "manual",
    type,
  };
}

export interface AiInput {
  title: string;
  request: string;
  relatedIds: string[];
}

/** Initial form after an AI suggestion: the suggested body, related documents it relied on, origin `ai_suggestion`. */
export function fieldsFromAi(
  template: DocumentTemplateInfo,
  result: AiDraftResponse,
  input: AiInput,
  owner = "",
): EditorFields {
  return {
    ...fieldsFromTemplate(template, owner),
    title: input.title.trim(),
    body: withTrailingNewline(result.body),
    relatedIds: joinList([...new Set([...input.relatedIds, ...result.suggested_related_ids])]),
    reason: input.request.trim().slice(0, 2000),
    origin: "ai_suggestion",
  };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" || typeof item === "number").map(String)
    : [];
}

/** Form state of a stored `create` proposal (`new_document` view); null when the server could not parse it. */
export function fieldsFromProposal(p: ProposalDetail): EditorFields | null {
  if (!p.new_document) return null;
  const meta = p.new_document.metadata;
  const status = (NEW_DOCUMENT_STATUSES as string[]).includes(text(meta.status))
    ? (text(meta.status) as NewDocumentStatus)
    : "draft";
  const id = text(meta.id) || p.document_id;
  const path = p.document_path;
  const owner = text(meta.owner);
  const type = text(meta.type);
  return {
    id,
    manualId: false,
    title: text(meta.title) || p.document_title,
    status,
    owner: owner === UNASSIGNED_OWNER ? "" : owner,
    tags: joinList(list(meta.tags)),
    relatedIds: joinList(list(meta.related_ids)),
    sourceRefs: joinList(list(meta.source_refs)),
    summary: text(meta.summary),
    path,
    pathEdited: path !== autoPath(directoryOf(path), id),
    reason: p.reason,
    body: p.new_document.body,
    origin: p.origin,
    // A template draft takes the template's type; a draft without one keeps (and may change) its own section.
    type: !p.template_id && (TYPE_ORDER as string[]).includes(type) ? (type as DocType) : null,
  };
}

export function toMetadata(fields: EditorFields): NewDocumentMetadata {
  return {
    id: fields.id.trim(),
    title: fields.title.trim(),
    status: fields.status,
    owner: fields.owner.trim(),
    tags: splitList(fields.tags),
    related_ids: splitList(fields.relatedIds),
    source_refs: splitList(fields.sourceRefs),
    summary: fields.summary.trim() || null,
    ...(fields.type ? { type: fields.type } : {}),
  };
}
