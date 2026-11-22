import DOMPurify from "dompurify";
import { useMemo, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "img", "svg", "math", "form", "input", "button", "iframe", "object", "embed"],
  FORBID_ATTR: ["style", "srcset"],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/)|#)/i,
};

/**
 * Renders backend-sanitized document HTML. Sanitized a second time with DOMPurify (defence in depth);
 * in-app links navigate client-side, external links open in a new tab without referrer.
 */
export function SafeHtml({ html, className }: { html: string; className?: string }) {
  const navigate = useNavigate();
  const clean = useMemo(() => DOMPurify.sanitize(html, PURIFY_CONFIG), [html]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("/") && !href.startsWith("//")) {
      event.preventDefault();
      navigate(href);
    } else if (/^https?:/i.test(href)) {
      anchor.setAttribute("rel", "noopener noreferrer nofollow");
      anchor.setAttribute("target", "_blank");
    }
  }

  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: clean }} />;
}
