import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { TemplateSpec } from "../../api/types";
import { AI_ERROR_TITLE, AI_PROPOSAL_ERROR_TITLE } from "../../lib/labels";
import { useAiProposal } from "../AiProposal";
import { AI_MODE_LABEL } from "../AiSourcesPanel";
import { ErrorState, Notice } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button } from "../ui/Button";

const EXAMPLE =
  "Создай шаблон для описания интеграции между системами: источники, датасеты, метаданные, маппинг, ограничения и периодичность обмена";

/**
 * «Создать с помощью AI»: the model PROPOSES a structure (sections, required fields, hints, completeness rules) and
 * names similar existing templates. Nothing is created here: «Открыть в редакторе» opens the proposal for editing;
 * the template appears only after «Сохранить черновик», and activation is a separate step.
 */
export function TemplateAiPanel({ mode, onClose }: { mode: string; onClose: () => void }) {
  const panelMode = useSidePanelMode(true);
  const navigate = useNavigate();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("");
  const state = useAiProposal();
  const busy = state.preparing !== null;
  const valid = prompt.trim().length >= 10;
  const proposal = state.proposal;
  const spec = proposal?.items.find((i) => i.id === "template")?.proposed as TemplateSpec | undefined;

  useEffect(() => {
    const timer = window.setTimeout(() => promptRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    void state.run({ kind: "draft_template", prompt: prompt.trim() });
  }

  return (
    <SidePanel id="template-ai" title="Создать шаблон с помощью ИИ" mode={panelMode} onClose={onClose} className="studio-ai">
      <p className="ai-mode-line">
        <span className={`ai-mode ai-mode--${mode}`}>{AI_MODE_LABEL[mode] ?? mode}</span>
      </p>
      <p className="muted">
        ИИ предложит разделы, обязательные поля, подсказки и правила проверки и сравнит их с шаблонами каталога. Это
        только предложение: шаблон появится, когда вы сохраните его в редакторе, а действовать начнёт после отдельной
        активации.
      </p>
      <form onSubmit={submit} className="studio-ai__form">
        <div className="field">
          <label htmlFor="studio-ai-prompt">
            Какой шаблон нужен <span aria-hidden="true">*</span>
          </label>
          <textarea
            id="studio-ai-prompt"
            ref={promptRef}
            rows={4}
            value={prompt}
            maxLength={2000}
            required
            onChange={(e) => setPrompt(e.target.value)}
            aria-describedby="studio-ai-prompt-hint"
          />
          <p id="studio-ai-prompt-hint" className="field__hint">
            Например: «{EXAMPLE}».{" "}
            <button type="button" className="button button--quiet button--sm" onClick={() => setPrompt(EXAMPLE)}>
              Подставить пример
            </button>
          </p>
        </div>
        <div className="button-row">
          <Button type="submit" variant={proposal ? "secondary" : "primary"} disabled={!valid || busy}>
            {busy ? "Готовим предложение…" : proposal ? "Предложить заново" : "Предложить шаблон"}
          </Button>
          {busy ? <Button onClick={state.cancel}>Отменить</Button> : null}
        </div>
      </form>
      {state.error ? (
        <ErrorState
          error={state.error}
          title={AI_PROPOSAL_ERROR_TITLE[state.error.code] ?? AI_ERROR_TITLE[state.error.code] ?? "Не удалось получить предложение ИИ"}
        />
      ) : null}
      {proposal && spec ? (
        <section className="studio-ai__proposal" aria-labelledby="studio-ai-result">
          <h3 id="studio-ai-result">Предложение: «{spec.title || spec.template_id}»</h3>
          <p>{proposal.summary}</p>
          {proposal.warnings.length > 0 ? (
            <Notice tone="warning">
              <ul className="studio-ai__warnings">
                {proposal.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <ol className="studio-ai__sections" aria-label="Предложенные разделы">
            {spec.sections.map((s) => (
              <li key={s.title}>
                <strong>{s.title}</strong> <span className={s.required ? "req-badge" : "opt-badge"}>{s.required ? "обязательный" : "необязательный"}</span>
                {s.hint ? <span className="muted"> — {s.hint}</span> : null}
              </li>
            ))}
          </ol>
          {spec.validation.length > 0 ? (
            <>
              <h4>Правила проверки</h4>
              <ul className="field-list">
                {spec.validation.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </>
          ) : null}
          {proposal.status === "suggested" ? (
            <div className="button-row">
              <Button variant="primary" onClick={() => navigate(`/templates/new?proposal=${encodeURIComponent(proposal.id)}`)}>
                Открыть в редакторе
              </Button>
              <Button variant="quiet" onClick={() => void state.reject()} disabled={state.decision !== null}>
                Отклонить
              </Button>
            </div>
          ) : (
            <p className="muted">{proposal.status === "rejected" ? "Предложение отклонено — ничего не создано." : `Статус: ${proposal.status}.`}</p>
          )}
          {state.decisionError ? <ErrorState error={state.decisionError} /> : null}
        </section>
      ) : null}
    </SidePanel>
  );
}
