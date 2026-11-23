import type { HighlightSegment } from "../api/types";

/** Search snippets arrive as segments, so no HTML from the server is ever injected here. */
export function Highlighted({ segments }: { segments: HighlightSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlight ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
      )}
    </>
  );
}
