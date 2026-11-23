import type { ProposalDetail } from "../api/types";
import { Notice } from "./Feedback";

/**
 * A draft keeps the template version it was created with; when the template moved on, say so. The draft is still
 * validated against its own version — switching to the new one is a separate decision of the author.
 */
export function TemplateVersionNotice({ proposal }: { proposal: Pick<ProposalDetail, "template_version" | "template_current_version"> | null }) {
  const own = proposal?.template_version;
  const current = proposal?.template_current_version;
  if (!own || !current || own >= current) return null;
  return (
    <Notice tone="info" className="template-version-notice">
      Черновик создан по шаблону v{own}; актуальная версия — v{current}. Черновик проверяется по v{own}; переход на
      новую версию — отдельное действие автора.
    </Notice>
  );
}
