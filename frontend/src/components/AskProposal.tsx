import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { AiMode, AiProposal, AskProposalRef } from "../api/types";
import { AI_PROPOSAL_ERROR_TITLE, AI_PROPOSAL_KIND_LABEL, AI_PROPOSAL_STATUS_LABEL } from "../lib/labels";
import { AiProposalCard } from "./AiProposal";
import { ErrorState, Loading, Notice } from "./Feedback";
import { buttonClass } from "./ui/Button";

/*
 * The proposal a workflow skill created (AskResponse.proposal; docs/AI_WORKFLOWS.md «Навыки ассистента и
 * вложения»). Nothing has been applied: the card opens the M5.6.3 proposal in place — items with evidence,
 * Accept of the chosen ones (into a DRAFT that goes to review) or Reject.
 */

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

const NOTE: Record<string, string> = {
  suggested: "Ничего не применено. Откройте предложение и отметьте нужные пункты: они попадут в черновик, который проходит ревью.",
  answered: "Это ответ или план: применять нечего, документы не меняются.",
  applied: "Принятые пункты применены к черновику — он проходит обычное ревью.",
  partially_applied: "Часть пунктов применена к черновику — он проходит обычное ревью.",
  rejected: "Предложение отклонено — ничего не изменено.",
  invalidated: "Предложение устарело: документ или шаблон изменились. Ничего не изменено.",
};

/** Where an accepted proposal's draft is edited: a new document in the editor, a change on its proposal page. */
function draftHref(proposal: AiProposal): string | null {
  if (!proposal.result_draft_id) return null;
  const id = encodeURIComponent(proposal.result_draft_id);
  return proposal.kind === "draft_from_prompt" ? `/documents/new?draft=${id}` : `/proposals/${id}`;
}

interface AskProposalProps {
  reference: AskProposalRef;
  mode: AiMode;
  /** The card's button is the answer's main action (an open proposal waiting for a decision). */
  primary: boolean;
  /** Inside the document panel: one heading level deeper (the answer there is an h3). */
  compact?: boolean;
}

export function AskProposal({ reference, mode, primary, compact = false }: AskProposalProps) {
  const titleId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [decision, setDecision] = useState<"accept" | "reject" | null>(null);
  const [decisionError, setDecisionError] = useState<ApiError | null>(null);
  const status = proposal?.status ?? reference.status;
  const kind = proposal?.kind ?? reference.kind;
  const generated = mode === "internal_api" || mode === "claude_cli";

  useEffect(() => {
    if (!open || proposal || loadError) return undefined;
    let live = true;
    api
      .aiProposal(reference.id)
      .then((result) => {
        if (live) setProposal(result);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(toApiError(err));
      });
    return () => {
      live = false;
    };
  }, [open, proposal, loadError, reference.id]);

  async function accept(itemIds: string[]) {
    if (!proposal || decision) return;
    setDecision("accept");
    setDecisionError(null);
    try {
      setProposal(await api.aiAccept(proposal.id, itemIds));
    } catch (err) {
      const error = toApiError(err);
      if (error.code === "ai_proposal_stale") {
        setProposal({ ...proposal, status: "invalidated", warnings: [...proposal.warnings, error.message] });
      } else {
        setDecisionError(error);
        if (error.code === "ai_proposal_closed") api.aiProposal(proposal.id).then(setProposal).catch(() => undefined);
      }
    } finally {
      setDecision(null);
    }
  }

  async function reject() {
    if (!proposal || decision) return;
    setDecision("reject");
    setDecisionError(null);
    try {
      setProposal(await api.aiReject(proposal.id));
    } catch (err) {
      setDecisionError(toApiError(err));
    } finally {
      setDecision(null);
    }
  }

  const href = proposal ? draftHref(proposal) : null;
  const Heading = compact ? "h4" : "h3";
  return (
    <section className="ask-proposal" aria-labelledby={titleId} data-status={status}>
      <div className="ask-proposal__head">
        <span className={generated ? "ai-label" : "demo-tag"}>{generated ? "ИИ" : "Демо"}</span>
        <Heading id={titleId}>Предложение ИИ: {AI_PROPOSAL_KIND_LABEL[kind] ?? kind}</Heading>
        <span className={`ai-status ai-status--${status}`}>{AI_PROPOSAL_STATUS_LABEL[status] ?? status}</span>
      </div>
      <p className="ask-proposal__note">{NOTE[status] ?? ""}</p>
      <div className="ask-proposal__actions">
        <button
          type="button"
          className={buttonClass(primary && !open ? "primary" : "secondary")}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Скрыть предложение" : "Открыть предложение"}
        </button>
        {reference.graph_link ? (
          <Link to={reference.graph_link} className={buttonClass("quiet")}>
            Показать на карте знаний
          </Link>
        ) : null}
      </div>
      <div id={panelId} className="ask-proposal__panel" hidden={!open}>
        {open && !proposal && !loadError ? <Loading label="Загружаю предложение…" /> : null}
        {loadError ? (
          <ErrorState
            error={loadError}
            title={AI_PROPOSAL_ERROR_TITLE[loadError.code] ?? "Не удалось открыть предложение"}
            onRetry={() => setLoadError(null)}
          />
        ) : null}
        {proposal ? (
          <AiProposalCard
            key={proposal.id}
            proposal={proposal}
            pending={decision}
            error={decisionError}
            onAccept={(ids) => void accept(ids)}
            onReject={() => void reject()}
            acceptLabel={proposal.kind === "draft_from_prompt" ? "Создать черновик" : "Применить выбранное"}
            appliedNote={
              href ? (
                <Notice tone="success">
                  <p>
                    <strong>Создан черновик.</strong> Принятые пункты применены к черновику, а не к базе знаний: она
                    изменится только после ревью и merge.
                  </p>
                  <Link to={href} className="text-link">
                    Открыть черновик
                  </Link>
                </Notice>
              ) : null
            }
          />
        ) : null}
      </div>
    </section>
  );
}
