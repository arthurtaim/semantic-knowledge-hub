import { createContext, useContext } from "react";
import type { SessionResponse } from "../api/types";

export const SessionContext = createContext<SessionResponse | null>(null);

export function useSession(): SessionResponse | null {
  return useContext(SessionContext);
}
