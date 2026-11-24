/**
 * Idempotency key for a create request (`^[A-Za-z0-9_-]{8,64}$`): generated once per form, so a double
 * submit or a retry after a lost answer returns the draft that was already created instead of a second one.
 */
export function newRequestId(): string {
  const c = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
