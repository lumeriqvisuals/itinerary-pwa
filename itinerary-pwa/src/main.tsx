import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { registerServiceWorker } from "./lib/notifications";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { void registerServiceWorker().catch(console.error); });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
