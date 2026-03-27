console.log("[main.tsx] script loaded");
import { render } from "preact";
import "@preact/signals";
import { App } from "./app";
import "./styles.css";

console.log("[main.tsx] imports done, mounting App");
const root = document.getElementById("app");
if (!root) throw new Error("#app root not found");
try {
  render(<App />, root);
  console.log("[main.tsx] render complete");
} catch (e) {
  console.error("[main.tsx] render error:", e);
}
