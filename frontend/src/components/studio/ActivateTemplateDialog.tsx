import { useEffect, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { StudioActivation, StudioCheck, TemplateComparison } from "../../api/types";
import { ACTIVATION_TEXT, STUDIO_ERROR_TITLE, TEMPLATE_FIELD_LABEL } from "../../lib/labels";
import { ErrorState, Loading } from "../Feedback";
import { SidePanel, useSidePanelMode } from "../shell/SidePanel";
import { Button } from "../ui/Button";
import { TemplateComparisonView } from "./TemplateComparisonView";

export type ActivationTarget =
  | { kind: "draft"; check: StudioCheck }
  /** An existing version: a rollback, or the version a release shipped. */
  | { kind: "version"; version: number; shipped?: boolean };

interface ActivateTemplateDialogProps {
  templateId: string;
  revision: number;
  currentVersion: number | null;
  target: ActivationTarget;
  onClose: () => void;
  onActivated: (result: StudioActivation) => void;
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, "client_error", String(err), null);
}

/**
 * «Активировать» — the confirmation (a modal sheet; a bottom sheet on phones): what will be current, what changes
 * against the current version, and that documents keep their pinned version. Activation is its own right.
 */
export function ActivateTemplateDialog({ templateId, revision, currentVersion, target, onClose, onActivated }: ActivateTemplateDialogProps) {
  const mode = useSidePanelMode(true);
  const [comparison, setComparison] = useState<TemplateComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const version = target.kind === "draft" ? target.check.next_version : target.version;
  const outcome = target.kind === "draft" ? target.check.activation : "reactivate";
  const compareWith = currentVersion !== null && (target.kind === "version" || target.check.activation !== "new_template");

  useEffect(() => {
    if (!compareWith || currentVersion === null) return;
    let active = true;
    setLoading(true);
    api
      .studioCompare(templateId, currentVersion, target.kind === "draft" ? "draft" : target.version)
      .then((result) => {
        if (active) setComparison(result);
      })
      .catch(() => {
        if (active) setComparison(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [templateId, currentVersion, compareWith, target]);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const result = await api.studioActivate(templateId, revision, target.kind === "version" ? target.version : undefined);
      onActivated(result);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setPending(false);
    }
  }

  const label = outcome === "info_update" ? `Обновить v${version}` : `Активировать v${version}`;
  return (
    <SidePanel
      id="template-activate"
      title="Активировать шаблон"
      mode={mode}
      onClose={onClose}
      className="studio-activate"
      footer={
        <div className="button-row">
          <Button variant="primary" onClick={() => void confirm()} disabled={pending}>
            {pending ? "Активируем…" : label}
          </Button>
          <Button onClick={onClose}>Отмена</Button>
        </div>
      }
    >
      <p className="studio-activate__outcome">
        {target.kind === "version"
          ? `Действующей станет v${version}${currentVersion ? ` (сейчас v${currentVersion})` : ""}${
              target.shipped ? " — версия из поставки приложения" : ""
            }. Новые документы получат её.`
          : (ACTIVATION_TEXT[outcome]?.(version) ?? "")}
      </p>
      {target.kind === "draft" && target.check.changed_fields.length > 0 ? (
        <p>
          Изменённые поля: {target.check.changed_fields.map((f) => TEMPLATE_FIELD_LABEL[f] ?? f).join(", ")}.
        </p>
      ) : null}
      <p className="muted">
        Документы и черновики, созданные раньше, остаются на своей версии шаблона и проверяются по ней — ничего не
        меняется автоматически. Действие записывается в историю с вашим именем и временем.
      </p>
      {loading ? <Loading label="Сравниваем с действующей версией…" /> : null}
      {comparison ? <TemplateComparisonView result={comparison} /> : null}
      {error ? <ErrorState error={error} title={STUDIO_ERROR_TITLE[error.code]} /> : null}
    </SidePanel>
  );
}
