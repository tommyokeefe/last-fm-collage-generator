import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { syncTheme } from "@tommyokeefe/theme/theme-client";
import "@tommyokeefe/theme/styles.css";
import App from "./App";
import "./index.css";

syncTheme();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Could not find the root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
