import { useCallback, useState } from "react";
import { readPreference, writePreference } from "./storage";

/** «Как в системе» follows `prefers-color-scheme`; the other two pin the theme. */
export type ThemeChoice = "system" | "light" | "dark";

/** Also read by public/theme-init.js, which applies the choice before the first paint. */
export const THEME_STORAGE_KEY = "skh.theme";

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "Как в системе",
  light: "Светлая",
  dark: "Тёмная",
};

export const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"];

export function readThemeChoice(): ThemeChoice {
  const stored = readPreference(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** `data-theme` on <html>: set for an explicit choice, absent for the system theme (the CSS media query decides). */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

/** The current choice and a setter that applies and remembers it. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  const update = useCallback((next: ThemeChoice) => {
    applyTheme(next);
    writePreference(THEME_STORAGE_KEY, next === "system" ? null : next);
    setChoice(next);
  }, []);
  return [choice, update];
}
