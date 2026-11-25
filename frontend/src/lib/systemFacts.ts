import type { AskResponse, DocStatus, DocType, ProjectStatus, SystemFact, SystemFactItem, SystemFactSource, TaskStatus, ToolOutcome, ToolStepInfo } from "../api/types";
import { formatDate, pluralRu, STATUS_LABEL, TEMPLATE_STATUS_LABEL, TYPE_LABEL } from "./labels";
import { PROJECT_STATUS_LABEL, TASK_STATUS_LABEL } from "./work";

/*
 * M5.7: system facts of an AI-native answer (docs/AI_NATIVE_TOOLS.md «Evidence»). A fact is an authoritative,
 * server-computed observation of SKH state (registry, graph, templates, a proposal); `[F1]` in the answer text
 * refers to it. Everything shown comes from the observation itself — never from the model's narrative.
 */

/** Marker of a system fact in the text: «С1», «С2» … (document citations are 1 / К1 / Ф1). */
export const FACT_MARK = "С";

/** «F1» → «С1» in the order of `system_facts` (the server numbers facts per answer; gaps are closed here). */
export function factLabels(facts: SystemFact[]): Map<string, string> {
  return new Map(facts.map((fact, index) => [fact.ref, `${FACT_MARK}${index + 1}`]));
}

/** What a fact card starts with: «По данным реестра SKH» — a system source, visibly not a document quote. */
export const FACT_SOURCE_TITLE: Record<SystemFactSource, string> = {
  skh_document_registry: "По данным реестра SKH",
  skh_knowledge_graph: "По данным графа связей SKH",
  skh_template_registry: "По данным реестра шаблонов SKH",
  skh_ai_proposals: "Предложение ИИ в SKH",
  skh_work: "По данным модуля «Работа» SKH",
};

/** The source in a few words (copy text, tooltips). */
export const FACT_SOURCE_SHORT: Record<SystemFactSource, string> = {
  skh_document_registry: "реестр SKH",
  skh_knowledge_graph: "граф связей SKH",
  skh_template_registry: "реестр шаблонов SKH",
  skh_ai_proposals: "предложения ИИ SKH",
  skh_work: "задачи SKH",
};

export function factSourceTitle(fact: SystemFact): string {
  return FACT_SOURCE_TITLE[fact.source] ?? "По данным SKH";
}

const UNIT_FORMS: Record<string, [string, string, string]> = {
  documents: ["документ", "документа", "документов"],
  templates: ["шаблон", "шаблона", "шаблонов"],
  relations: ["связь", "связи", "связей"],
  items: ["пункт", "пункта", "пунктов"],
  tasks: ["задача", "задачи", "задач"],
  projects: ["проект", "проекта", "проектов"],
  dependencies: ["зависимость", "зависимости", "зависимостей"],
};

/** The authoritative value with its unit: «83 документа», «0 документов», «версия 2»; null when there is none. */
export function factValueText(fact: SystemFact): string | null {
  if (fact.value === null || fact.value === undefined) return null;
  if (fact.unit === "version") return `версия ${fact.value}`;
  const forms = fact.unit ? UNIT_FORMS[fact.unit] : undefined;
  const number = fact.value.toLocaleString("ru-RU");
  return forms ? `${number} ${pluralRu(fact.value, ...forms)}` : number;
}

const DIRECTION_LABEL: Record<string, string> = {
  in: "входящие ссылки",
  out: "исходящие ссылки",
  both: "входящие и исходящие ссылки",
};

const SORT_LABEL: Record<string, string> = {
  updated: "сначала недавно обновлённые",
  title: "по названию",
  status: "по статусу",
  id: "по ID",
};

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}

function docStatusText(value: string): string {
  return (STATUS_LABEL[value as DocStatus] ?? value).toLocaleLowerCase("ru");
}

function docTypeText(value: string): string {
  return (TYPE_LABEL[value as DocType] ?? value).toLocaleLowerCase("ru");
}

/**
 * The filters really applied, in words («статус: утверждён», «тег: aris», «текст содержит «ARIS»»). A text match
 * is named as such — the fact's `definition` says it is not a system tag.
 */
/** M6 work facts: project / task keys, task statuses, the computed flags and the plan revision. */
function workFilterParts(fact: SystemFact): string[] {
  const parts: string[] = [];
  const flags: Record<string, [string, string]> = {
    overdue: ["просроченные", "не просроченные"],
    late: ["отстают от плана", "не отстают от плана"],
    blocked: ["ждут предшественников", "не ждут предшественников"],
    milestone: ["вехи", "не вехи"],
    scheduled: ["с датами", "без дат"],
  };
  for (const [key, value] of Object.entries(fact.effective_filters ?? {})) {
    const list = asList(value);
    if (key === "project") parts.push(`проект ${list.join(", ")}`);
    else if (key === "task") parts.push(`задача ${list.join(", ")}`);
    else if (key === "status" && list.length > 0) parts.push(`статус: ${list.map((s) => (TASK_STATUS_LABEL[s as TaskStatus] ?? s).toLocaleLowerCase("ru")).join(", ")}`);
    else if (key === "text") parts.push(`название содержит «${list.join(" ")}»`);
    else if (key === "plan_revision") parts.push(`ревизия плана ${list.join("")}`);
    else if (key in flags) parts.push((flags[key] ?? ["", ""])[value === false ? 1 : 0]);
  }
  return parts;
}

export function filterParts(fact: SystemFact): string[] {
  if (fact.source === "skh_work") return workFilterParts(fact);
  const templates = fact.source === "skh_template_registry";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fact.effective_filters ?? {})) {
    const list = asList(value);
    switch (key) {
      case "status":
        if (templates) {
          if (list[0] !== "any") parts.push(`статус шаблона: ${list.map((s) => (TEMPLATE_STATUS_LABEL[s] ?? s).toLocaleLowerCase("ru")).join(", ")}`);
        } else if (list.length > 0) {
          parts.push(`статус: ${list.map(docStatusText).join(", ")}`);
        }
        break;
      case "type":
        if (list.length > 0) parts.push(`тип: ${list.map(docTypeText).join(", ")}`);
        break;
      case "doc_type":
        if (list.length > 0) parts.push(`тип документа: ${list.map(docTypeText).join(", ")}`);
        break;
      case "owner":
        parts.push(`владелец: ${list.join(", ")}`);
        break;
      case "owner_missing":
        parts.push(value === false ? "владелец назначен" : "владелец не назначен");
        break;
      case "needs_attention":
        // The same rule as «Требуют внимания» of «Документы»; the fact's definition states it in full.
        parts.push(value === false ? "не требуют внимания" : "требуют внимания");
        break;
      case "tags":
        if (list.length > 0) parts.push(`${list.length === 1 ? "тег" : "теги"}: ${list.join(", ")}`);
        break;
      case "text":
        parts.push(`текст содержит «${list.join(" ")}»`);
        break;
      case "updated_from":
        parts.push(`обновлён не раньше ${formatDate(list[0])}`);
        break;
      case "updated_to":
        parts.push(`обновлён не позже ${formatDate(list[0])}`);
        break;
      case "template_id":
        parts.push(`шаблон: ${list.join(", ")}`);
        break;
      case "eligible_for_answers":
        if (value === true) parts.push("только документы, которые ассистент может цитировать");
        break;
      case "document_ids":
      case "document_id":
        if (list.length > 0) parts.push(`${list.length === 1 ? "документ" : "документы"}: ${list.join(", ")}`);
        break;
      case "target_id":
        parts.push(`до документа ${list.join(", ")}`);
        break;
      case "direction":
        parts.push(DIRECTION_LABEL[list[0] ?? ""] ?? `направление: ${list.join(", ")}`);
        break;
      case "relations":
        if (list.length > 0) parts.push(`типы связей: ${list.join(", ")}`);
        break;
      case "depth":
        parts.push(`глубина: ${list.join("")}`);
        break;
      case "sort":
        parts.push(`порядок: ${SORT_LABEL[list[0] ?? ""] ?? list.join(", ")}`);
        break;
      case "kind":
      case "version":
        break; // already in the label / value
      default:
        if (list.length > 0) parts.push(`${key}: ${list.join(", ").slice(0, 120)}`);
    }
  }
  return parts;
}

/** Why a document needs attention (`catalog_query` with `needs_attention`; the documents tree's rule). */
export const ATTENTION_REASON_LABEL: Record<string, string> = {
  in_review: "на ревью",
  draft: "черновик",
  deprecated: "устарел",
  review_stale: "проверка устарела",
  never_reviewed: "не проверялся",
  owner_missing: "без владельца",
};

/** «Фильтр: статус: утверждён · тег: aris», or the whole visible catalog; null when the filters say nothing. */
export function filtersText(fact: SystemFact): string | null {
  const parts = filterParts(fact);
  if (parts.length > 0) return `Фильтр: ${parts.join(" · ")}`;
  return fact.source === "skh_document_registry" ? "Весь доступный вам каталог, без фильтров" : null;
}

/** Where the marker of a fact leads: the proposal card for a `drafts_propose` fact, else the fact's own card. */
export function factCardId(turnNo: number, ref: string): string {
  return `fact-${turnNo}-${ref}`;
}

export function proposalCardId(turnNo: number): string {
  return `proposal-${turnNo}`;
}

/** A proposal fact is shown by the existing proposal card (AskProposal), not by a second card. */
export function isProposalFact(fact: SystemFact, answer: Pick<AskResponse, "proposal">): boolean {
  return fact.source === "skh_ai_proposals" && Boolean(answer.proposal);
}

/** «[С1] По данным реестра SKH — Документы в доступном каталоге SKH: 83 документа (Фильтр: …)», for copying. */
export function factPlainText(fact: SystemFact, label: string): string {
  const value = factValueText(fact);
  const filters = filterParts(fact);
  const head = `[${label}] ${factSourceTitle(fact)} — ${fact.label}${value ? `: ${value}` : ""}`;
  return filters.length > 0 ? `${head} (фильтр: ${filters.join(", ")})` : head;
}

// --- tool steps: progress and honest states --------------------------------------------------------------------

/** One short progress line while the backend runs a tool the model asked for (no debug screen). */
const TOOL_ACTIVITY: Record<string, string> = {
  catalog_query: "Проверяю каталог…",
  knowledge_search: "Ищу в документах…",
  graph_inspect: "Смотрю граф связей…",
  templates_inspect: "Смотрю шаблоны…",
  drafts_propose: "Готовлю предложение…",
};

export function toolActivity(tool: string): string {
  return TOOL_ACTIVITY[tool] ?? "Проверяю данные системы…";
}

/** How a check ended, in words — unavailable, denied and not found are different things, and none of them is zero. */
export const CHECK_OUTCOME_LABEL: Record<Exclude<ToolOutcome, "ok">, string> = {
  unavailable: "Не проверено — источник недоступен",
  timeout: "Не проверено — нет ответа вовремя",
  denied: "Нет доступа",
  not_found: "Не найдено в доступной вам области",
  error: "Не проверено — ошибка",
  invalid: "Запрос к системе отклонён",
  unknown_tool: "Запрос к системе отклонён",
};

/** Outcomes that are about the data (shown next to an answer); refused model requests are not the user's concern
 *  unless nothing else could be checked. */
const DATA_OUTCOMES = new Set<ToolOutcome>(["unavailable", "timeout", "denied", "not_found", "error"]);

/** A repeated identical call was answered «already done»: nothing failed, nothing to report. */
const NOT_A_FAILURE = new Set(["duplicate_call"]);

function uniqueByMessage(steps: ToolStepInfo[]): ToolStepInfo[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = step.message ?? "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Checks that did not work out and that the answer text does not already report (the server composes «Не удалось
 * проверить: …» itself when it stops): `all` adds refused requests — for an answer that could check nothing.
 */
export function failedChecks(answer: Pick<AskResponse, "answer" | "tool_steps">, all = false): ToolStepInfo[] {
  const steps = (answer.tool_steps ?? []).filter(
    (step) =>
      step.outcome !== "ok" &&
      !NOT_A_FAILURE.has(step.error_code ?? "") &&
      (all || DATA_OUTCOMES.has(step.outcome)) &&
      Boolean(step.message),
  );
  return uniqueByMessage(steps).filter((step) => all || !answer.answer.includes(step.message ?? ""));
}

/** The assistant used system tools for this answer and at least one of them did not work out. */
export function toolChecksFailed(answer: Pick<AskResponse, "tool_steps">): boolean {
  return (answer.tool_steps ?? []).some((step) => step.outcome !== "ok" && !NOT_A_FAILURE.has(step.error_code ?? ""));
}


/** The status of a fact item in words: a task or project status of the work module, else as it is. */
export function workItemStatus(item: SystemFactItem): string | null {
  if (!item.status) return null;
  if (item.kind === "task") return TASK_STATUS_LABEL[item.status as TaskStatus] ?? item.status;
  if (item.kind === "project") return PROJECT_STATUS_LABEL[item.status as ProjectStatus] ?? item.status;
  return null;
}
