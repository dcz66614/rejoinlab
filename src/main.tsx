import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";
import "./ui/styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("RejoinLab: #root element not found in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
