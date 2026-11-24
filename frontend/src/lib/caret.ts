/**
 * Pixel position of a character offset inside a textarea (relative to the textarea's border box), using an
 * off-screen mirror element with the same text metrics. Used to place the `[[` suggestions next to the caret.
 */
const COPIED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
] as const;

export interface CaretPoint {
  top: number;
  left: number;
  height: number;
}

export function caretCoordinates(textarea: HTMLTextAreaElement, position: number): CaretPoint {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const target = mirror.style as unknown as Record<string, string>;
  const source = style as unknown as Record<string, string>;
  for (const prop of COPIED) target[prop] = source[prop] ?? "";
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.overflow = "hidden";
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 20;
  const point = {
    top: marker.offsetTop + (Number.parseFloat(style.borderTopWidth) || 0) - textarea.scrollTop,
    left: marker.offsetLeft + (Number.parseFloat(style.borderLeftWidth) || 0) - textarea.scrollLeft,
    height: lineHeight,
  };
  document.body.removeChild(mirror);
  return point;
}
