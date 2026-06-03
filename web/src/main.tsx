import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// Last-resort handlers so unhandled rejections at least leave a trace in
// the console instead of being swallowed.
window.addEventListener("unhandledrejection", (e) => {
  console.error("[global] unhandled rejection", e.reason);
});
window.addEventListener("error", (e) => {
  console.error("[global] uncaught error", e.error);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
