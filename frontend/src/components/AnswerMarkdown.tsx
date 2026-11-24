import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import { Link } from "react-router-dom";
import { answerRemarkPlugins, safeHref, type KnownRefs, type MarkerKind } from "../lib/answerMarkdown";

/*
 * An assistant answer as Markdown (lib/answerMarkdown.ts has the pipeline and its safety rules). The FINAL answer
 * gets live markers and links; PRELIMINARY (streamed, unvalidated) text gets the same formatting with nothing
 * interactive: `[C1]` stays literal text and a link is only its text. The element components are module-level
 * (stable identities), so a re-render never remounts a marker: its open card and keyboard focus survive.
 */

export interface AnswerMarkers {
  /** References the server verified for this answer: only these become markers. */
  known: KnownRefs;
  /** The marker of one verified reference (CitationMarker / FactMarker); null leaves the text as written. */
  render: (kind: MarkerKind, ref: string) => ReactNode;
}

interface AnswerContext {
  /** null — preliminary text: no markers, no live links. */
  markers: AnswerMarkers | null;
  /** The level of the heading that owns the text: Markdown headings go below it (`#` → h3 in the dialog). */
  headingLevel: number;
}

const Context = createContext<AnswerContext>({ markers: null, headingLevel: 2 });

type Props<Tag extends keyof React.JSX.IntrinsicElements> = ComponentProps<Tag> & ExtraProps;

/** A marker node of the pipeline (`<span data-skh-marker>`); raw HTML is text, so no other span can reach here. */
function MarkerSpan({ node, children }: Props<"span">) {
  const { markers } = useContext(Context);
  const kind = node?.properties.dataSkhMarker;
  const ref = node?.properties.dataSkhRef;
  if (markers && (kind === "citation" || kind === "fact") && typeof ref === "string") {
    const marker = markers.render(kind, ref);
    if (marker) return marker;
  }
  return <>{children}</>;
}

/** Links of model text: app paths in the app, http(s) in a new tab without referrer, mailto; nothing else. */
function AnswerLink({ href, title, children }: Props<"a">) {
  const { markers } = useContext(Context);
  const target = markers ? safeHref(href) : null;
  if (!target) return <span className="answer-md__link-text">{children}</span>;
  if (target.startsWith("/")) {
    return (
      <Link to={target} title={title}>
        {children}
      </Link>
    );
  }
  if (/^mailto:/i.test(target)) {
    return (
      <a href={target} title={title}>
        {children}
      </a>
    );
  }
  return (
    <a href={target} title={title} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="visually-hidden"> (откроется в новой вкладке)</span>
    </a>
  );
}

/** Images from model text are never loaded (no request leaves for a URL the model chose): their alt text stays. */
function AnswerImage({ alt }: Props<"img">) {
  return <span className="answer-md__image">{alt ? `[изображение: ${alt}]` : "[изображение]"}</span>;
}

function heading(level: number) {
  return function AnswerHeading({ children }: Props<"h1">) {
    const { headingLevel } = useContext(Context);
    const Tag = `h${Math.min(6, headingLevel + level)}` as "h3";
    return <Tag className={`answer-md__h answer-md__h--${Math.min(level, 3)}`}>{children}</Tag>;
  };
}

/**
 * A table or a code block scrolls sideways in its own frame (never the page). A frame that overflows is a named
 * region and a tab stop, so it can be scrolled with the keyboard (WCAG 2.1.1), like SafeHtml's tables.
 */
function ScrollFrame({ kind, children }: { kind: "table" | "code"; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    const check = () => setScrolls(frame.scrollWidth > frame.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(frame);
    if (frame.firstElementChild) observer.observe(frame.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const label = kind === "table" ? "Таблица из ответа" : "Код из ответа";
  return (
    <div
      ref={ref}
      className={`answer-md__frame answer-md__frame--${kind}`}
      {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": label } : {})}
    >
      {children}
    </div>
  );
}

/** The element's own props without react-markdown's `node` (not a DOM attribute). */
function domProps<P extends ExtraProps>(props: P): Omit<P, "node"> {
  const { node, ...rest } = props;
  void node;
  return rest;
}

const COMPONENTS: Components = {
  span: MarkerSpan,
  a: AnswerLink,
  img: AnswerImage,
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  table: (props) => (
    <ScrollFrame kind="table">
      <table {...domProps(props)} />
    </ScrollFrame>
  ),
  pre: (props) => (
    <ScrollFrame kind="code">
      <pre {...domProps(props)} />
    </ScrollFrame>
  ),
};

/** A URL of model text survives only if safe (react-markdown applies this to every href, src and cite). */
const urlTransform = (url: string) => safeHref(url) ?? "";

interface AnswerMarkdownProps {
  text: string;
  /** Verified references of a FINAL answer; null for preliminary text. */
  markers: AnswerMarkers | null;
  headingLevel?: number;
}

/** The blocks of an answer (paragraphs, lists, headings, tables, code); the caller provides the container. */
export const AnswerMarkdown = memo(function AnswerMarkdown({ text, markers, headingLevel = 2 }: AnswerMarkdownProps) {
  const known = markers?.known ?? null;
  const plugins = useMemo(() => answerRemarkPlugins(known), [known]);
  const context = useMemo(() => ({ markers, headingLevel }), [markers, headingLevel]);
  return (
    <Context.Provider value={context}>
      <Markdown remarkPlugins={plugins} urlTransform={urlTransform} components={COMPONENTS}>
        {text}
      </Markdown>
    </Context.Provider>
  );
});
