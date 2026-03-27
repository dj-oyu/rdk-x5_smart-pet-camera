import "preact/debug";
import { render } from "preact";
import "@preact/signals";
import { App } from "./app";
import "./styles.css";

const root = document.getElementById("app");
if (!root) throw new Error("#app root not found");
render(<App />, root);
