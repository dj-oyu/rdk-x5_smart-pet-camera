import { render } from "preact";
import "@preact/signals";  // install Preact signals integration (side effect)
import { App } from "./app";
import { initStore } from "./lib/store";
import "./styles.css";

initStore();

const root = document.getElementById("app");
if (!root) throw new Error("#app root not found");
render(<App />, root);
