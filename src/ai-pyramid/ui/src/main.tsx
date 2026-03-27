import "preact/debug";
import { render } from "preact";
import "@preact/signals";
import { App } from "./app";
import "./styles.css";

document.title = "JS OK";
window.onerror = (msg) => { document.title = "ERR: " + msg; };
window.addEventListener("unhandledrejection", (e) => { document.title = "REJECT: " + e.reason; });

const root = document.getElementById("app");
if (!root) throw new Error("#app root not found");
try {
  render(<App />, root);
  document.title = "MOUNTED";
} catch (e) {
  document.title = "RENDER ERR: " + (e as Error).message;
}
