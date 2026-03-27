import { render } from "preact";
// Force Bun to include @preact/signals integration side effects.
// Without this, Bun tree-shakes the Preact options hooks that enable
// auto-subscribe (signal.value reads in components trigger re-renders).
import "@preact/signals";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("#app root not found");
render(<App />, root);
