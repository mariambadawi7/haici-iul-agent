/**
 * Tenant config as React context.
 *
 * The config is resolved before the tree mounts (see `main.tsx`), so consumers
 * can treat it as always-present — there is no loading state to thread through
 * every component. `update` exists for the admin branding editor: it re-applies
 * the theme immediately, which is what makes live preview work.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { applyBranding } from "./theme";
import type { TenantConfig } from "./types";

interface BrandingContextValue {
  config: TenantConfig;
  /** Replace the active config and repaint the document. Does not persist. */
  update: (next: TenantConfig) => void;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

interface Props {
  initial: TenantConfig;
  children: ReactNode;
}

export function BrandingProvider({ initial, children }: Props) {
  const [config, setConfig] = useState<TenantConfig>(initial);

  const update = useCallback((next: TenantConfig) => {
    setConfig(next);
    applyBranding(next);
  }, []);

  const value = useMemo(() => ({ config, update }), [config, update]);

  return (
    <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>
  );
}

export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) {
    throw new Error("useBranding must be used inside <BrandingProvider>");
  }
  return ctx;
}

/** Convenience for the common read-only case. */
export function useTenant(): TenantConfig {
  return useBranding().config;
}
