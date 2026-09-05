import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AdminApp from "./components/admin/AdminApp";
import ErrorBoundary from "./components/ErrorBoundary";
import { BrandingProvider } from "./lib/branding/context";
import { loadBranding } from "./lib/branding/store";
import { DEFAULT_CONFIG } from "./lib/branding/defaults";
import type { TenantConfig } from "./lib/branding/types";
import { setTenantScope } from "./lib/branding/scope";
import { applyBranding } from "./lib/branding/theme";
import "./index.css";

// Last-resort handlers so unhandled rejections at least leave a trace in
// the console instead of being swallowed.
window.addEventListener("unhandledrejection", (e) => {
  console.error("[global] unhandled rejection", e.reason);
});
window.addEventListener("error", (e) => {
  console.error("[global] uncaught error", e.error);
});

// Minimal hash-based gate for the admin analytics dashboard. There is no
// router dependency — `#/admin` (optionally with a `?...` query, e.g.
// `#/admin?mock=1` for local dev fixtures) renders <AdminApp/> instead of
// the kiosk <App/>. Any other hash (including none) renders the kiosk as
// before. `hashchange` re-renders so navigating between the two works
// without a full page reload.
const root = ReactDOM.createRoot(document.getElementById("root")!);

function isAdminRoute(hash: string): boolean {
  return hash === "#/admin" || hash.startsWith("#/admin?");
}

/**
 * Branding is resolved and painted BEFORE the first render, so the app never
 * flashes default colours and components can read the config synchronously —
 * there is no loading state to thread through the tree. A failed fetch still
 * resolves (to cached or default branding), so this cannot block boot.
 */
async function bootstrap() {
  const config = await loadBranding();
  setTenantScope(config.id);
  try {
    applyBranding(config);
  } catch (err) {
    // A malformed leaf value (e.g. a non-hex `theme.brand`) can slip past
    // withDefaults' shape guard (F-07 only guards object-vs-scalar, not leaf
    // types) and blow up inside paintTheme. Falling back to the built-in
    // theme here means a bad tenant config costs colours, not the boot.
    console.error("[boot] tenant theme failed to paint; using defaults", err);
    applyBranding(DEFAULT_CONFIG);
  }

  mount(config);
}

/**
 * Mounts the tree and keeps it in sync with the hash. Hoisted out of
 * bootstrap() so the failure path below can reuse it: the whole point of
 * falling back to default branding rather than leaving the page blank is that
 * the operator can still reach #/admin and repair the config that broke boot,
 * and that is only true if the failure path routes on the hash too.
 */
function mount(config: TenantConfig) {
  function render() {
    const hash = window.location.hash;
    // A tenant that did not buy the dashboard cannot reach it by URL.
    const admin = isAdminRoute(hash) && config.features.admin;
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <BrandingProvider initial={config}>
            {/* Keyed on the full hash so a query change (e.g. switching
                `?mock=1` → `?mock=empty`) forces a clean remount instead of
                reusing a stale instance — AdminApp reads the mock scenario
                once at mount time. */}
            {admin ? <AdminApp key={hash} /> : <App />}
          </BrandingProvider>
        </ErrorBoundary>
      </React.StrictMode>,
    );
  }

  window.addEventListener("hashchange", render);
  render();
}

// bootstrap() is async, and it was previously called as a bare floating
// promise: nothing caught its rejection. root.render() sits on the last line
// of the function, so a throw anywhere before it (loadBranding,
// setTenantScope, or a theme paint the try/catch above didn't already
// contain) meant render() was never reached and <div id="root"> stayed
// empty forever — ErrorBoundary can't help because React never started
// rendering. Painting the built-in defaults and rendering the kiosk anyway
// means the operator can still reach #/admin to repair the config that
// caused this, which a blank page would make impossible.
bootstrap().catch((err) => {
  console.error("[boot] branding bootstrap failed; falling back to defaults", err);
  try {
    applyBranding(DEFAULT_CONFIG);
  } catch (themeErr) {
    console.error("[boot] default theme failed to paint", themeErr);
  }
  mount(DEFAULT_CONFIG);
});
