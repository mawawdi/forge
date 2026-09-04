import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/spline-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import "./workspace.css";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Forge dashboard root is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
