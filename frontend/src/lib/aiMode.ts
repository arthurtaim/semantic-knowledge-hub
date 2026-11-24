import type { AiMode } from "../api/types";

/**
 * How each AI mode presents itself (AI-first has to work in all four AI modes, docs/UI_REDESIGN.md §5). `mock` and `disabled` are the default deployments, so the app is complete without a model.
 * A mode says HOW the assistant answers; it never says what the documents are: `mock` is «без модели» (verbatim
 * excerpts), not «демо» — whether the content is synthetic is «Демо-данные» and the origin of an answer's sources.
 */
export const AI_CHIP_LABEL: Record<AiMode, string> = {
  mock: "ИИ: без модели",
  internal_api: "ИИ: внутренняя модель",
  claude_cli: "ИИ: Claude CLI (эксперимент)",
  disabled: "ИИ отключён",
};

export const AI_PROVIDER_TITLE: Record<AiMode, string> = {
  mock: "Без языковой модели (mock)",
  internal_api: "Внутренняя модель банка (OpenAI-совместимый API)",
  claude_cli: "Claude Code CLI — личный тест, экспериментальный провайдер",
  disabled: "Отключён в этой установке (AI_PROVIDER=disabled)",
};

export const AI_LIMITS: Record<AiMode, string> = {
  mock:
    "Языковой модели нет: ответ — дословные выдержки из найденных документов, без выводов; черновики собираются по шаблону из таких же выдержек. Это режим ответа, а не свойство документов: их происхождение указано у ответа.",
  internal_api:
    "Отвечает только по найденным фрагментам; сервер сверяет каждую цитату с источником. Ничего не меняет сам: правки — только черновик, diff и ревью.",
  claude_cli:
    "Только синтетические данные. Отвечает по найденным фрагментам; сервер сверяет цитаты. Ничего не меняет сам: правки — только черновик, diff и ревью.",
  disabled: "Ответы и черновики ИИ недоступны. Поиск, документы, ручное редактирование и ревью работают полностью.",
};

/** Where the assistant looks by default: team documents; corporate sources only as a separate, labelled step. */
export const AI_SCOPE_NOTE =
  "Утверждённые документы команды. Корпоративные источники — только отдельным помеченным запросом.";

/** The assistant can be asked (an answer is produced, even if only from verbatim excerpts in `mock`). */
export function canAsk(mode: AiMode | null | undefined): boolean {
  return mode === "mock" || mode === "internal_api" || mode === "claude_cli";
}
