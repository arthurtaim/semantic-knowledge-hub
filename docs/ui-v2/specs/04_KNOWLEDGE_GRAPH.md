# 04. Карта знаний: внешний вид и перетаскивание узлов

Источник: `screens/design/design-06-knowledge-map.png`.
Формы узлов в макете условные. В приложении остаются текущие формы; из макета берутся цвета, подписи,
подсветка, легенда, сведения и управление.
До UI v2 это был «клубок»:
все узлы одного цвета, подписи наслаиваются, узел нельзя сдвинуть.

**Работать только во фронтенде** (`components/GraphCanvas.tsx`, `components/GraphDetails.tsx`,
`pages/GraphPage.tsx`, `lib/graph.ts`, стили). Бэкенд-API и семантику графа (узлы, связи, происхождение,
фильтры, режимы) не менять.

## Требования владельца (дословно)

> Improve the Knowledge Graph visualization and node interactions across the Semantic Knowledge Hub.
>
> **1. Visual clarity**
> * Make graph layouts cleaner, more readable, and less cluttered.
> * Improve automatic node spacing and reduce overlapping nodes, labels, and edges.
> * Visually distinguish document types, systems, datasets, and relationship types.
> * Improve node labels, edge styling, directional arrows, and hover states.
> * Add a clear legend and highlight connected nodes and edges when hovering over a node.
> * Maintain a minimal, modern, Apple-like visual style.
>
> **2. Direct node dragging — essential**
> Implement intuitive drag-and-drop repositioning of individual graph nodes:
> * The user presses and holds the left mouse button on a node.
> * While holding the button, they can freely move that node anywhere on the graph.
> * The node must follow the cursor smoothly in real time.
> * Releasing the mouse button leaves the node at its new position.
> * The node must not snap back to its original position or trigger a full graph relayout.
> * Other nodes should remain stable while the selected node is being moved.
> * Dragging the empty background should pan the graph as before.
> * Clicking a node without dragging should retain its existing selection/navigation behavior.
>
> **3. Layout and usability**
> * Improve the initial automatic layout.
> * Provide a Reset Layout action.
> * Preserve manually adjusted node positions while exploring the graph.
> * Maintain zoom, pan, filters, and existing graph functionality.
> * Apply these improvements consistently to Global Graph, Local Graph, and Query Graph wherever applicable.
>
> **4. Validation**
> Test mouse dragging, click-versus-drag behavior, zooming, panning, overlapping nodes, and graph stability.
> Work only on the relevant frontend components. Do not modify backend APIs or graph semantics.
> The primary goal is to make the graph visually understandable and allow users to manually create space by
> simply clicking, holding, and dragging individual nodes.

## Как устроено сейчас (проверь в коде)

- `lib/graph.ts → layoutGraph()`: раскладка d3-force считается синхронно фиксированным числом тиков
  (`LAYOUT_TICKS`), детерминированно, до отрисовки. Анимации нет.
- `components/GraphCanvas.tsx`: статический SVG, панорамирование перетаскиванием фона (`onPointerDown` на
  `<svg>`), масштаб колесом и кнопками, выбор узла с клавиатуры (Tab, Enter / Space), `fitView()` при
  смене раскладки.
- Формы узлов по типу — `nodeShapePath()`; подписи — `shortLabel()`.
- Режимы `GraphMode`:
  - global — «Вся база»;
  - local — «Вокруг узла», глубина 1–2;
  - query — «Граф ответа», `/graph?trace=…` из ответа ассистента.

## 1. Внешний вид

| Элемент | Решение |
|---|---|
| Холст | Фон `--bg-subtle`, без рамки-коробки; граф во всю ширину рабочей области; справа панель «Сведения об узле» 300–320 px (существующий `GraphDetails` в новой стилистике) |
| Узлы | **Формы оставить текущими** (`nodeShapePath`: они уже несут смысл), добавить заливку по типу (таблица ниже) и белую обводку 1.5 px. Размер по степени, как сейчас |
| Статус | Черновик — пунктирная обводка; устарел — пониженная непрозрачность и перечёркнутая подпись в сведениях; неподтверждённый — как сейчас, но в новых токенах |
| Подписи | Inter 11.5 px, тёмный текст с белым «ореолом» (`paint-order: stroke`). По умолчанию подписаны только узлы с высокой степенью, выбранный, наведённый и их соседи. Подписи, которые пересекаются, скрываются по приоритету (выбранный > наведённый > соседи > по степени). Полное название — в `title` и в доступном имени |
| Связи | Подтверждённые (`canonical_metadata`, `verified_registry`) — сплошные 1.2 px `#C9CFCA`; неподтверждённые (`external_discovery`, `ai_suggestion`, `query_trace`) — пунктир. Стрелка у цели, отступ от края фигуры. Тип связи — подпись на линии только при наведении или выборе |
| Наведение и выбор | Узел и его связи и соседи — полная яркость, связи тёмные `#59625C` 1.6 px с подписями типа; остальное — непрозрачность 0.2. Выбранный — кольцо `--accent` с прозрачностью около 25 %. Плавное затемнение 120 мс (без него при reduced motion) |
| Легенда | Плашка в левом нижнем углу: типы узлов (форма плюс цвет плюс название) и два вида связей. Сворачивается. Показывает только типы, которые есть на экране |
| Управление | Справа снизу: «Сбросить расположение», группа «− / Вписать / +». Сверху панель инструментов: сегменты «Вся база / Вокруг узла / Граф ответа», «Списком»; строка фильтров-чипов и «N узлов, M связей» |

Цвета типов (светлая тема; для тёмной поднять светлоту примерно на 15 % и проверить контраст к фону ≥ 3:1):

| Тип | Цвет |
|---|---|
| `document` | `#55677A` |
| `integration` | `#2E7FB0` |
| `source_system` | `#B5651D` |
| `dataset` | `#B84A7A` |
| `semantic_entity` | `#2E8B57` |
| `template` | белая заливка, обводка `#6B746E` |
| `external_page` | белая заливка, пунктир `#7C8580` |
| `query_context` | `#8A6F1E` |

Тип всегда различим формой, а не только цветом.

## 2. Перетаскивание узла (обязательно)

Поведение:
1. `pointerdown` левой кнопкой (или касание) на узле — захват указателя (`setPointerCapture`), панорамирование
   не начинается (`stopPropagation`).
2. Порог 4 px: пока смещение меньше — это клик. Отпускание без превышения порога — **текущее поведение
   клика** (выбор или переход) без изменений.
3. После порога — режим перетаскивания: курсор `grabbing`, узел следует за указателем в каждом кадре
   (`requestAnimationFrame`). Координаты переводятся из экранных с учётом текущего масштаба и сдвига.
   Связи узла перерисовываются вместе с ним.
4. Другие узлы не двигаются: никакого перезапуска симуляции и никакого `layoutGraph()` во время и после
   перетаскивания.
5. `pointerup` — узел остаётся на новом месте. Клик после перетаскивания не срабатывает.
6. Перетаскивание фона — панорамирование, как сейчас; колесо — масштаб, как сейчас.

Реализация:
- Ручные позиции хранить отдельно от рассчитанной раскладки: `overrides: Map<nodeId, {x, y}>`. Итоговая
  позиция = override ?? layout.
- `fitView()` и смена размера окна не стирают ручные позиции.
- При расширении графа (подгрузка соседей, «Показать окружение») раскладка пересчитывается **с
  закреплёнными** узлами (`fx/fy` в d3-force для узлов с override) — сдвинутые вручную остаются на месте.
- Ручные позиции живут, пока пользователь исследует граф. Ключ — режим, фокус или trace и набор фильтров;
  хранить в `sessionStorage` (обёрнуто в try/catch). Смена фильтра не стирает позиции видимых узлов.
- «Сбросить расположение»: очищает ручные позиции для текущего вида и пересчитывает раскладку. Кнопка
  выключена, если ручных позиций нет. После сброса — «Вписать».
- Альтернатива перетаскиванию (WCAG 2.5.7): у выбранного узла Alt + стрелки сдвигают его на 10 px
  (Shift — на 40 px). Объявление для скринридера: «Узел перемещён».

## 3. Начальная раскладка

- Подобрать параметры `layoutGraph()`:
  - `forceCollide` с радиусом фигуры плюс запас под подпись;
  - сильнее `forceManyBody` для больших графов;
  - длина связи по типу;
  - центрирование;
  - больше тиков, если нужно (раскладка остаётся детерминированной и синхронной).
- Цель на демо-данных (97 узлов, 326 связей): узлы не перекрываются, подписи выбранного и соседей не
  наслаиваются.
- Изолированные узлы — аккуратным кольцом по краю, а не россыпью.
- «Вокруг узла»: фокус в центре, глубина 1 — первое кольцо, 2 — второе.
- «Граф ответа»: вопрос в центре, цитированные документы вокруг.
- Производительность: раскладка 200 узлов — не дольше 300 мс на обычном ноутбуке; перетаскивание
  60 кадров/с (без перерисовки всего SVG через React на каждый кадр: обновлять атрибуты узла и его связей
  напрямую через ref или мемоизировать остальное).

## 4. Проверка

Vitest (`frontend/src/__tests__`), с моками размеров:
- клик без смещения выбирает узел (как раньше);
- смещение больше 4 px двигает узел, `onSelect` не вызывается;
- после отпускания позиция сохранена, остальные узлы не изменили координаты;
- перетаскивание фона меняет сдвиг (панорама), позиции узлов не меняются;
- колесо меняет масштаб, перетаскивание при масштабе ≠ 1 двигает узел ровно за курсором;
- «Сбросить расположение» возвращает рассчитанные позиции и выключается;
- ручные позиции переживают «Вписать», подгрузку соседей и смену фильтра;
- Alt + стрелки двигают выбранный узел;
- `layoutGraph` на демо-графе: нет пересечений фигур (расстояние между центрами ≥ сумма радиусов).

Playwright e2e (`frontend/e2e`, desktop):
- `mouse.down` на узле → `mouse.move` шагами → `mouse.up`. Проверить новую позицию узла (`transform`
  или `cx/cy`), что соседний узел не сдвинулся, и что URL и панель сведений не сменились как при клике;
- клик по узлу открывает сведения как раньше;
- панорама фона и масштаб работают;
- «Сбросить расположение»;
- все три режима: «Вся база», «Вокруг узла», «Граф ответа» (из ответа ассистента).

Скриншоты «до» и «после»: все три режима, светлая и тёмная темы, 1440×900 и 390×844. Проверить, что на
демо-данных подписи не наслаиваются.
