import { api } from "../api/client";
import type { DocType } from "../api/types";
import { TYPE_LABEL, TYPE_ORDER } from "../lib/labels";
import { useAsync } from "../lib/useAsync";

/** Why a blank document needs a section, in one place (the create page and the editor say the same). */
export const SECTION_HINT =
  "Раздел определяет, где документ появится в каталоге и в дереве документов. Пока это черновик, раздел можно " +
  "сменить; шаблон, применённый позже, задаст раздел шаблона.";

interface SectionSelectProps {
  id: string;
  value: DocType;
  onChange: (value: DocType) => void;
  describedBy?: string;
  invalid?: boolean;
}

/**
 * «Раздел каталога» of a document without a template: only the EXISTING document types the server lists
 * (`GET /api/document-types`), in the catalogue's order — never a type typed by hand. While the list loads (or if it
 * cannot be loaded) the known types of this build are offered; the server validates the value anyway.
 */
export function SectionSelect({ id, value, onChange, describedBy, invalid }: SectionSelectProps) {
  const types = useAsync(() => api.documentTypes(), "document-types");
  const known = types.data ? new Set(types.data.map((t) => t.type)) : null;
  const offered = TYPE_ORDER.filter((t) => !known || known.has(t) || t === value);
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as DocType)}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
    >
      {offered.map((type) => (
        <option key={type} value={type}>
          {TYPE_LABEL[type] ?? type}
        </option>
      ))}
    </select>
  );
}
