console.log("[pet-album] bundle:loaded");
window.addEventListener("error", (event) => {
  console.error("[pet-album] window:error", event.message, event.error);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[pet-album] window:unhandledrejection", event.reason);
});

import { render } from "preact";
import { App } from "./app";
import "./styles.css";

console.log("[pet-album] mount:lookup-root");
const root = document.getElementById("app");

if (!root) {
  throw new Error("#app root not found");
}

console.log("[pet-album] mount:render-start");
render(<App />, root);
console.log("[pet-album] mount:render-done");
