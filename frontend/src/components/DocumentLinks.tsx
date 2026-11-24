import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ApiError } from "../api/client";
import type { Backlink, DocumentLinks, LinkVia, OutgoingLink, UnresolvedLink } from "../api/types";
import { LINK_VIA_LABEL, RELATION_LABEL, UNRESOLVED_REASON_LABEL } from "../lib/labels";
import { StatusStamp } from "./StatusStamp";

function ViaBadges({ via }: { via: LinkVia[] }) {
  return (
    <span className="via-badges">
      {via.map((v) => (
        <span key={v} className={`via-badge via-badge--${v}`}>
          {LINK_VIA_LABEL[v] ?? v}
        </span>
      ))}
    </span>
  );
}

function relationText(relation: string): string {
  return RELATION_LABEL[relation] ?? relation;
}

function lineText(lines: number[]): string | null {
  if (lines.length === 0) return null;
  return lines.length === 1 ? `строка ${lines[0]}` : `строки ${lines.join(", ")}`;
}

function OutgoingRow({ link }: { link: OutgoingLink }) {
  const lines = lineText(link.lines);
  return (
    <li className="link-row">
      <p className="link-row__head">
        <span className="link-row__relation">{relationText(link.relation)}</span>{" "}
        <Link to={`/documents/${encodeURIComponent(link.target.document_id)}`}>{link.target.title}</Link>
      </p>
      <p className="link-row__meta">
        <code className="doc-id">{link.target.document_id}</code>
        <StatusStamp status={link.target.status} />
        <ViaBadges via={link.via} />
        {lines ? <span>{lines}</span> : null}
        {link.labels.length > 0 ? <span className="muted">подпись: {link.labels.map((l) => `«${l}»`).join(", ")}</span> : null}
      </p>
    </li>
  );
}

function BacklinkRow({ link }: { link: Backlink }) {
  const lines = lineText(link.lines);
  return (
    <li className="link-row">
      <p className="link-row__head">
        <Link to={`/documents/${encodeURIComponent(link.source.document_id)}`}>{link.source.title}</Link>{" "}
        <span className="link-row__relation">{relationText(link.relation)} этот документ</span>
      </p>
      <p className="link-row__meta">
        <code className="doc-id">{link.source.document_id}</code>
        <StatusStamp status={link.source.status} />
        <ViaBadges via={link.via} />
        {lines ? <span>{lines}</span> : null}
      </p>
      {link.excerpts.map((excerpt) => (
        <blockquote key={excerpt} className="link-row__excerpt">
          {excerpt}
        </blockquote>
      ))}
    </li>
  );
}

function UnresolvedRow({ link }: { link: UnresolvedLink }) {
  return (
    <li className="link-row link-row--unresolved">
      <p className="link-row__head">
        <code className="wikilink-raw">
          [[{link.raw_target}
          {link.label && link.label !== link.raw_target ? `|${link.label}` : ""}]]
        </code>{" "}
        <span className="muted">строка {link.line}</span>
      </p>
      <p className="link-row__reason">{UNRESOLVED_REASON_LABEL[link.reason] ?? link.reason}</p>
      {link.excerpt ? <blockquote className="link-row__excerpt">{link.excerpt}</blockquote> : null}
      {link.candidates.length > 0 ? (
        <div className="link-row__candidates">
          <p>Возможно, имелся в виду:</p>
          <ul>
            {link.candidates.map((c) => (
              <li key={c.document_id}>
                <Link to={`/documents/${encodeURIComponent(c.document_id)}`}>{c.title}</Link>{" "}
                <code className="doc-id">
                  [[{c.document_id}|{c.title}]]
                </code>
              </li>
            ))}
          </ul>
          <p className="muted">
            Ссылка не исправляется сама: замените её на нужный вариант через «Предложить изменение».
          </p>
        </div>
      ) : null}
    </li>
  );
}

function Group({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="links-group" aria-labelledby={id}>
      <h3 id={id}>
        {title} <span className="muted">({count})</span>
      </h3>
      {count === 0 ? <p className="muted">{empty}</p> : <ul className="link-list">{children}</ul>}
    </section>
  );
}

/**
 * Obsidian-like links of a document: outgoing links, backlinks (with the linking line) and unresolved WikiLinks
 * with repair candidates. Only documents the reader can see are listed — the server never reveals others.
 */
export function DocumentLinksPanel({
  links,
  error,
  loading,
  onRetry,
  actions,
  extra,
}: {
  links: DocumentLinks | null;
  error: ApiError | null;
  loading: boolean;
  onRetry: () => void;
  /** Controls next to the heading («Связи на графе»). */
  actions?: ReactNode;
  /** A section after the document's own links (M6: the tasks linked to the document). */
  extra?: ReactNode;
}) {
  return (
    <section className="links-panel" id="doc-links" aria-labelledby="doc-links-title">
      <div className="links-panel__head">
        <h2 id="doc-links-title">Связи документа</h2>
        {actions}
      </div>
      <p className="muted links-panel__intro">
        Ссылка <code>[[ID|Название]]</code> в тексте — это упоминание (references), а не зависимость данных. Показаны
        только документы, доступные вам{links ? `; поколение индекса ${links.generation}` : ""}.
      </p>
      {loading && !links ? <p className="muted">Загружаем связи…</p> : null}
      {error ? (
        <p className="flag">
          Связи не загрузились: {error.message}{" "}
          <button type="button" className="button button--ghost" onClick={onRetry}>
            Повторить
          </button>
        </p>
      ) : null}
      {links ? (
        <div className="links-panel__groups">
          <Group title="Исходящие ссылки" count={links.outgoing.length} empty="Документ ни на что не ссылается.">
            {links.outgoing.map((link) => (
              <OutgoingRow key={`${link.relation}-${link.target.document_id}`} link={link} />
            ))}
          </Group>
          <Group title="Обратные ссылки" count={links.backlinks.length} empty="На этот документ пока никто не ссылается.">
            {links.backlinks.map((link) => (
              <BacklinkRow key={`${link.relation}-${link.source.document_id}`} link={link} />
            ))}
          </Group>
          <Group title="Нерешённые ссылки" count={links.unresolved.length} empty="Все ссылки в тексте указывают на найденные документы.">
            {links.unresolved.map((link) => (
              <UnresolvedRow key={`${link.line}-${link.raw_target}`} link={link} />
            ))}
          </Group>
          {extra}
        </div>
      ) : (
        extra
      )}
    </section>
  );
}
