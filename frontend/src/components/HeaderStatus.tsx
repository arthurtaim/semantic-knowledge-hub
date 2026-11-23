import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { IntegrationStatus, SessionResponse } from "../api/types";
import { AI_CHIP_LABEL, AI_LIMITS, AI_PROVIDER_TITLE, AI_SCOPE_NOTE } from "../lib/aiMode";
import { useSession } from "../lib/session";
import { useDisclosure } from "../lib/useDisclosure";
import { StateBadge } from "./StateBadge";

function demoFacts(session: SessionResponse | null): string[] {
  if (!session) return ["Документы синтетические и не описывают банк."];
  const facts: string[] = [];
  if (session.demo_content) facts.push("Документы синтетические и не описывают банк.");
  if (session.knowledge_backend === "local") facts.push("GitLab не подключён.");
  if (session.features.corporate_search === "disabled") facts.push("Confluence не подключён.");
  if (session.features.corporate_search === "mock") facts.push("Confluence заменён mock-коннектором.");
  if (session.features.ai_mode === "mock") facts.push("Ассистент отвечает дословными выдержками, без языковой модели.");
  return facts;
}

/**
 * The demo status: a short striped tag in the header instead of a full-width band. The facts open on demand;
 * the wrapper is the page's one `note` and always contains «Демо-данные.».
 */
export function DemoPill() {
  const session = useSession();
  const facts = demoFacts(session);
  const { open, toggle, root, button } = useDisclosure();
  if (facts.length === 0) return null;
  return (
    <div className="header-status__item" role="note" ref={root}>
      <button
        ref={button}
        type="button"
        className="demo-pill"
        aria-label="Демо-данные"
        aria-expanded={open}
        aria-controls="demo-facts"
        onClick={toggle}
      >
        <span>
          Демо<span className="demo-pill__rest">-данные</span>
        </span>
      </button>
      <div id="demo-facts" className="popover" hidden={!open}>
        <p>
          <strong>Демо-данные.</strong> {facts.join(" ")}
        </p>
      </div>
    </div>
  );
}

/** Which AI answers here: provider, model (when the server reports one), scope and limits. */
export function AiModeChip() {
  const session = useSession();
  const { open, toggle, root, button } = useDisclosure();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const mode = session?.features.ai_mode;

  useEffect(() => {
    if (!open || status || failed) return;
    let live = true;
    api
      .integrations()
      .then((res) => {
        if (live) setStatus(res.items.find((item) => item.name === "ai_provider") ?? null);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [open, status, failed]);

  if (!mode) return null;
  const model = status?.details.model;
  return (
    <div className="header-status__item" ref={root}>
      <button
        ref={button}
        type="button"
        className={`ai-chip ai-chip--${mode}`}
        aria-expanded={open}
        aria-controls="ai-mode-details"
        onClick={toggle}
      >
        {AI_CHIP_LABEL[mode]}
      </button>
      <div id="ai-mode-details" className="popover" hidden={!open}>
        <p className="popover__title">Режим ИИ</p>
        <dl className="popover__facts">
          <div>
            <dt>Провайдер</dt>
            <dd>{AI_PROVIDER_TITLE[mode]}</dd>
          </div>
          {model ? (
            <div>
              <dt>Модель</dt>
              <dd>
                <code>{model}</code>
              </dd>
            </div>
          ) : null}
          {status ? (
            <div>
              <dt>Состояние</dt>
              <dd>
                <StateBadge state={status.state} /> <span className="muted">{status.human_readable_message}</span>
              </dd>
            </div>
          ) : null}
          {mode !== "disabled" ? (
            <div>
              <dt>Где ищет</dt>
              <dd>{AI_SCOPE_NOTE}</dd>
            </div>
          ) : null}
          <div>
            <dt>Ограничения</dt>
            <dd>{AI_LIMITS[mode]}</dd>
          </div>
        </dl>
        {failed ? <p className="muted">Состояние провайдера сейчас недоступно.</p> : null}
        <Link to="/integrations" className="text-link">
          Подробнее о подключениях
        </Link>
      </div>
    </div>
  );
}
