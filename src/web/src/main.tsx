import "@preact/signals"; // side-effect: Preact VDOM にシグナル統合をインストール
import { render } from "preact";
import { App } from "./app";

render(<App />, document.getElementById("app")!);
