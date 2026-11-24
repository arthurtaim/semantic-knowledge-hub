import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AiMode, IntegrationStatus, SessionResponse } from "../api/types";
import { AI_CHIP_LABEL, AI_LIMITS, AI_PROVIDER_TITLE, AI_SCOPE_NOTE } from "../lib/aiMode";
import { useSession } from "../lib/session";
import { useDisclosure } from "../lib/useDisclosure";
import { StateBadge } from "./StateBadge";
import { Popover } from "./ui/Popover";

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
 * The demo status: a quiet amber badge in the page toolbar (--demo-*). The facts open on demand; the wrapper
 * is the page's one `note` and always contains «Демо-данные.».
 */
export function DemoPill() {
  const session = useSession();
  const facts = demoFacts(session);
  if (facts.length === 0) return null;
  return (
    <Popover
      id="demo-facts"
      role="note"
      className="header-status__item"
      trigger={(props) => (
        <button type="button" className="demo-pill" aria-label="Демо-данные" {...props}>
          <span>
            Демо<span className="demo-pill__rest">-данные</span>
          </span>
        </button>
      )}
    >
      <p>
        <strong>Демо-данные.</strong> {facts.join(" ")}
      </p>
    </Popover>
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
      {/* Rendered only while open: its text must not stand in for the page's own wording. */}
      <div id="ai-mode-details" className="popover popover--bottom popover--end" hidden={!open}>
        {open ? <AiModeDetails mode={mode} status={status} failed={failed} /> : null}
      </div>
    </div>
  );
}

function AiModeDetails({ mode, status, failed }: { mode: AiMode; status: IntegrationStatus | null; failed: boolean }) {
  const model = status?.details.model;
  return (
    <>
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
    </>
  );
}
