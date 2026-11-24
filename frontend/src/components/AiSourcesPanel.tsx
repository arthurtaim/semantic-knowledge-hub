import { Link } from "react-router-dom";
import type { AiDraftResponse } from "../api/types";
import { shortRevision } from "../lib/labels";
import { Notice } from "./Feedback";
import { StatusStamp } from "./StatusStamp";

export const AI_MODE_LABEL: Record<string, string> = {
  mock: "Демо-режим: без языковой модели",
  internal_api: "Внутренняя языковая модель",
  claude_cli: "Claude Code CLI (личный тест)",
  disabled: "ИИ отключён",
};

const SCOPE_LABEL: Record<string, string> = {
  team: "только утверждённые документы команды, доступные вам; корпоративные источники не используются",
};

/**
 * Provenance of an AI text suggestion: what it relied on, verbatim quotes, unverified claims and limits.
 * The suggestion itself is not stored and is never authoritative.
 */
export function AiSourcesPanel({ result }: { result: AiDraftResponse }) {
  return (
    <section className="panel ai-sources" aria-labelledby="ai-sources-title">
      <div className="ai-sources__head">
        <h2 id="ai-sources-title">Источники и выдержки</h2>
        <span className={`ai-mode ai-mode--${result.mode}`}>{AI_MODE_LABEL[result.mode] ?? result.mode}</span>
      </div>
      {result.mode === "mock" ? (
        <p className="muted">
          Текст собран по шаблону из дословных выдержек утверждённых документов. Языковая модель не использовалась.
        </p>
      ) : (
        <p className="muted">Текст предложен моделью и требует проверки человеком.</p>
      )}
      {result.insufficient_data ? (
        <div className="answer__insufficient ai-sources__insufficient" role="note">
          <p className="feedback__title">Недостаточно данных</p>
          <p>
            В доступных утверждённых документах нет сведений для части разделов. Они оставлены с пометкой «Требует
            уточнения» — ничего не придумано. Заполните их сами или укажите связанные документы.
          </p>
        </div>
      ) : null}
      <p className="ai-sources__scope">
        <span className="muted">Область доступа:</span> {SCOPE_LABEL[result.access_scope] ?? result.access_scope}
      </p>

      <h3>Использованные документы</h3>
      {result.references.length === 0 ? (
        <p className="muted">Подходящих утверждённых документов не найдено.</p>
      ) : (
        <ul className="ai-sources__refs">
          {result.references.map((ref) => (
            <li key={ref.document_id}>
              <Link to={`/documents/${encodeURIComponent(ref.document_id)}`}>{ref.title}</Link>
              <span className="ai-sources__meta">
                <code className="doc-id">{ref.document_id}</code>
                <StatusStamp status={ref.status} />
                <span>
                  ревизия <code className="doc-id">{shortRevision(ref.revision)}</code>
                </span>
                {ref.is_demo ? <span className="muted">демо-документ</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Подтверждённые выдержки</h3>
      {result.citations.length === 0 ? (
        <p className="muted">Дословных выдержек нет.</p>
      ) : (
        <ul className="ai-sources__quotes">
          {result.citations.map((c, index) => (
            <li key={`${c.document_id}-${index}`}>
              <blockquote className="ai-sources__quote">{c.quote}</blockquote>
              <span className="ai-sources__meta">
                <Link to={`/documents/${encodeURIComponent(c.document_id)}`}>
                  <code className="doc-id">{c.document_id}</code>
                </Link>
                {c.section ? <span>раздел «{c.section}»</span> : null}
                <span>
                  ревизия <code className="doc-id">{shortRevision(c.revision)}</code>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {result.unverified_claims.length > 0 ? (
        <Notice tone="warning">
          <p>
            <strong>Не подтверждено источниками</strong> — проверьте или удалите:
          </p>
          <ul>
            {result.unverified_claims.map((claim) => (
              <li key={claim}>{claim}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {result.warnings.length > 0 ? (
        <Notice tone="warning">
          <p>Предупреждения:</p>
          <ul>
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </section>
  );
}
