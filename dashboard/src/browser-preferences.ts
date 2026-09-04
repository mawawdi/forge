import { useSyncExternalStore } from "react";

export function browserStorage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window[kind];
  } catch {
    return undefined;
  }
}

interface BrowserPreferences {
  readonly sidebarHidden: boolean;
  readonly enterToSend: boolean;
  readonly pinnedConversations: readonly string[];
}

const KEY = "forge.workspace-preferences.v1";
const DEFAULTS: BrowserPreferences = {
  sidebarHidden: false,
  enterToSend: true,
  pinnedConversations: [],
};

function readPreferences(): BrowserPreferences {
  try {
    const value: unknown = JSON.parse(browserStorage("localStorage")?.getItem(KEY) ?? "null");
    if (
      typeof value !== "object" ||
      value === null ||
      !("sidebarHidden" in value) ||
      typeof value.sidebarHidden !== "boolean" ||
      !("enterToSend" in value) ||
      typeof value.enterToSend !== "boolean" ||
      !("pinnedConversations" in value) ||
      !Array.isArray(value.pinnedConversations) ||
      !value.pinnedConversations.every((id: unknown) => typeof id === "string")
    )
      return DEFAULTS;
    return {
      sidebarHidden: value.sidebarHidden,
      enterToSend: value.enterToSend,
      pinnedConversations: value.pinnedConversations,
    };
  } catch {
    return DEFAULTS;
  }
}

let preferences = readPreferences();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function updateBrowserPreferences(change: Partial<BrowserPreferences>): void {
  preferences = { ...preferences, ...change };
  try {
    browserStorage("localStorage")?.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // Preferences still work in memory when browser storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function toggleConversationPin(id: string): void {
  const pins = preferences.pinnedConversations;
  updateBrowserPreferences({
    pinnedConversations: pins.includes(id) ? pins.filter((pin) => pin !== id) : [...pins, id],
  });
}

export function useBrowserPreferences(): BrowserPreferences {
  return useSyncExternalStore(
    subscribe,
    () => preferences,
    () => DEFAULTS,
  );
}
