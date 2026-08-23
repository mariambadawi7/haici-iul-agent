import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AdminApp from "./components/admin/AdminApp";
import ErrorBoundary from "./components/ErrorBoundary";
import { BrandingProvider } from "./lib/branding/context";
import { loadBranding } from "./lib/branding/store";
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
  applyBranding(config);

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

bootstrap();
