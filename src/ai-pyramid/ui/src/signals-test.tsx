/**
 * Signals Test Page — isolated sandbox to validate @preact/signals patterns
 * before applying them to the production app.
 *
 * Tests:
 * 1. Auto-subscribe: signal.value in JSX → re-render on change?
 * 2. useSignalEffect bridge: signal → useState → re-render
 * 3. createModel + useModel lifecycle
 * 4. Modal pattern: conditional render based on signal (the broken case)
 * 5. Computed signals
 * 6. action() batching
 */
import "preact/debug"; // Must be first — enables Preact DevTools + warnings
import { render } from "preact";
import { useState } from "preact/hooks";
import "@preact/signals"; // side-effect: install options hooks
import {
  signal,
  computed,
  effect,
  action,
  batch,
  createModel,
  useModel,
  useSignal,
  useSignalEffect,
  useComputed,
} from "@preact/signals";
import { Show, For } from "@preact/signals/utils";

// ─── Test infrastructure ───
const results = signal<Array<{ name: string; pass: boolean; detail: string }>>([]);

function log(name: string, pass: boolean, detail = "") {
  results.value = [...results.value, { name, pass, detail }];
}

// ─── Test 1: Auto-subscribe ───
const autoCount = signal(0);
let t1Renders = 0;

function Test1_AutoSubscribe() {
  t1Renders++;

  return (
    <div class="test-card">
      <h3>Test 1: Auto-subscribe</h3>
      <p>
        signal.value in JSX: <strong>{autoCount.value}</strong>
      </p>
      <p class="dim">Component renders: {t1Renders}</p>
      <button
        onClick={() => {
          autoCount.value++;
        }}
      >
        Increment
      </button>
      <p class="hint">
        If the number updates when you click, auto-subscribe works with Bun's
        bundler.
      </p>
    </div>
  );
}

// ─── Test 2: useSignalEffect bridge ───
const bridgeSignal = signal(0);

function Test2_Bridge() {
  const [local, setLocal] = useState(bridgeSignal.value);
  useSignalEffect(() => {
    setLocal(bridgeSignal.value);
  });

  return (
    <div class="test-card">
      <h3>Test 2: useSignalEffect bridge</h3>
      <p>
        Signal: <strong id="t2-signal">{bridgeSignal.value}</strong> | Local
        state: <strong id="t2-local">{local}</strong>
      </p>
      <button onClick={() => { bridgeSignal.value++; }}>
        Increment signal
      </button>
      <p class="hint">
        Both numbers should update together. If only "Signal" updates, auto-subscribe works
        but bridge is redundant. If neither updates, both are broken.
      </p>
    </div>
  );
}

// ─── Test 3: createModel + useModel ───
const CounterModel = createModel(() => {
  const count = signal(0);
  const doubled = computed(() => count.value * 2);
  const increment = action(() => { count.value++; });
  const reset = action(() => { count.value = 0; });
  return { count, doubled, increment, reset };
});

function Test3_Model() {
  const m = useModel(CounterModel);
  return (
    <div class="test-card">
      <h3>Test 3: createModel + useModel</h3>
      <p>
        Count: <strong>{m.count.value}</strong> | Doubled:{" "}
        <strong>{m.doubled.value}</strong>
      </p>
      <button onClick={m.increment}>+1</button>
      <button onClick={m.reset}>Reset</button>
      <p class="hint">
        Tests model creation, computed derivation, and action batching.
      </p>
    </div>
  );
}

// ─── Test 4: Modal pattern (THE broken case) ───
const modalEvent = signal<{ id: number; name: string } | null>(null);

function Test4_Modal() {
  return (
    <div class="test-card">
      <h3>Test 4: Modal (conditional render from signal)</h3>
      <button
        onClick={() => {
          modalEvent.value = { id: 1, name: "Cat detected!" };
        }}
      >
        Open Modal
      </button>
      <button onClick={() => { modalEvent.value = null; }}>
        Close Modal
      </button>
      <p>
        modalEvent: <code>{JSON.stringify(modalEvent.value)}</code>
      </p>
      {modalEvent.value && (
        <div class="mock-modal">
          <div class="mock-modal-content">
            <strong>Modal Open!</strong>
            <p>Event: {modalEvent.value.name} (id={modalEvent.value.id})</p>
            <button onClick={() => { modalEvent.value = null; }}>×</button>
          </div>
        </div>
      )}
      <p class="hint">
        If the modal does NOT appear when clicking "Open Modal", auto-subscribe
        is broken and the component doesn't re-render on signal change.
      </p>
    </div>
  );
}

// ─── Test 4b: Modal with useSignalEffect bridge (workaround) ───
function Test4b_ModalBridge() {
  const [ev, setEv] = useState(modalEvent.value);
  useSignalEffect(() => {
    setEv(modalEvent.value);
  });

  return (
    <div class="test-card">
      <h3>Test 4b: Modal (bridge workaround)</h3>
      <button onClick={() => { modalEvent.value = { id: 2, name: "Dog detected!" }; }}>
        Open Modal
      </button>
      <button onClick={() => { modalEvent.value = null; }}>Close</button>
      <p>
        local ev: <code>{JSON.stringify(ev)}</code>
      </p>
      {ev && (
        <div class="mock-modal">
          <div class="mock-modal-content">
            <strong>Bridge Modal Open!</strong>
            <p>Event: {ev.name} (id={ev.id})</p>
            <button onClick={() => { modalEvent.value = null; }}>×</button>
          </div>
        </div>
      )}
      <p class="hint">Same modal but using useSignalEffect→useState bridge.</p>
    </div>
  );
}

// ─── Test 5: useModel modal pattern (mimics production app.tsx) ───
const ModalStore = createModel(() => {
  const selected = signal<{ id: number; name: string } | null>(null);
  const items = signal([
    { id: 1, name: "Chatora sleeping" },
    { id: 2, name: "Mike eating" },
    { id: 3, name: "Kijitora playing" },
  ]);
  const openModal = action((item: { id: number; name: string }) => {
    selected.value = item;
  });
  const closeModal = action(() => {
    selected.value = null;
  });
  return { selected, items, openModal, closeModal };
});

function Test5_StoreModal() {
  const store = useModel(ModalStore);
  return (
    <div class="test-card">
      <h3>Test 5: useModel + modal (production pattern)</h3>
      <div class="item-list">
        {store.items.value.map((item) => (
          <button key={item.id} onClick={() => store.openModal(item)}>
            {item.name}
          </button>
        ))}
      </div>
      <p>
        selected: <code>{JSON.stringify(store.selected.value)}</code>
      </p>
      {store.selected.value && (
        <div class="mock-modal">
          <div class="mock-modal-content">
            <strong>{store.selected.value.name}</strong>
            <button onClick={store.closeModal}>×</button>
          </div>
        </div>
      )}
      <p class="hint">
        This is the exact pattern from app.tsx. If the modal doesn't appear,
        createModel + auto-subscribe is the problem.
      </p>
    </div>
  );
}

// ─── Test 5b: useModel + bridge ───
function Test5b_StoreModalBridge() {
  const store = useModel(ModalStore);
  const [sel, setSel] = useState(store.selected.value);
  useSignalEffect(() => {
    setSel(store.selected.value);
  });
  return (
    <div class="test-card">
      <h3>Test 5b: useModel + bridge modal</h3>
      <div class="item-list">
        {store.items.value.map((item) => (
          <button key={item.id} onClick={() => store.openModal(item)}>
            {item.name}
          </button>
        ))}
      </div>
      <p>
        local sel: <code>{JSON.stringify(sel)}</code>
      </p>
      {sel && (
        <div class="mock-modal">
          <div class="mock-modal-content">
            <strong>{sel.name}</strong>
            <button onClick={store.closeModal}>×</button>
          </div>
        </div>
      )}
      <p class="hint">Same but with useSignalEffect bridge.</p>
    </div>
  );
}

// ─── Test 6: useSignal (local signal) ───
function Test6_UseSignal() {
  const count = useSignal(0);
  return (
    <div class="test-card">
      <h3>Test 6: useSignal (component-local)</h3>
      <p>
        Count: <strong>{count.value}</strong>
      </p>
      <button onClick={() => { count.value++; }}>+1</button>
      <p class="hint">useSignal creates a component-scoped signal.</p>
    </div>
  );
}

// ─── Test 7: useComputed ───
function Test7_UseComputed() {
  const count = useSignal(0);
  const label = useComputed(() =>
    count.value === 0 ? "zero" : count.value < 5 ? "few" : "many"
  );
  return (
    <div class="test-card">
      <h3>Test 7: useComputed</h3>
      <p>
        Count: <strong>{count.value}</strong> | Label: <strong>{label.value}</strong>
      </p>
      <button onClick={() => { count.value++; }}>+1</button>
      <button onClick={() => { count.value = 0; }}>Reset</button>
    </div>
  );
}

// ─── Test 8: batch() multiple signal writes ───
const batchA = signal(0);
const batchB = signal(0);

function Test8_Batch() {
  return (
    <div class="test-card">
      <h3>Test 8: batch()</h3>
      <p>
        A: <strong>{batchA.value}</strong> | B: <strong>{batchB.value}</strong>
      </p>
      <button
        onClick={() => {
          batch(() => {
            batchA.value++;
            batchB.value += 10;
          });
        }}
      >
        Batch update (A+1, B+10)
      </button>
      <p class="hint">Should update both in a single render.</p>
    </div>
  );
}

// ─── Test 9: Diagnostic — check options hooks are installed ───
function Test9_Diagnostic() {
  let info: Record<string, string> = {};
  try {
    // @ts-ignore — accessing preact internals
    const opts = (globalThis as any).__PREACT_SIGNALS_HOOKS__;
    info.globalHook = opts ? "found" : "not found";
  } catch { /* ignore */ }

  // Check if preact options have been patched
  try {
    const preact = require("preact");
    const optKeys = Object.keys(preact.options || {});
    info.preactOptions = optKeys.join(", ") || "(empty)";
  } catch {
    info.preactOptions = "(cannot access)";
  }

  return (
    <div class="test-card">
      <h3>Test 9: Diagnostics</h3>
      <pre>{JSON.stringify(info, null, 2)}</pre>
      <p>
        Side-effect import present:{" "}
        <strong>{typeof signal === "function" ? "YES" : "NO"}</strong>
      </p>
      <p class="hint">
        If preactOptions shows __b, __r, diffed, unmount — hooks are installed.
      </p>
    </div>
  );
}

// ─── Test 10: Show component (conditional render without re-render) ───
const showSignal = signal<string | null>(null);

function Test10_Show() {
  return (
    <div class="test-card">
      <h3>Test 10: {"<Show>"} component</h3>
      <button onClick={() => { showSignal.value = "Hello from Show!"; }}>
        Show content
      </button>
      <button onClick={() => { showSignal.value = null; }}>Hide</button>
      <Show when={showSignal}>
        {(val) => (
          <div class="mock-modal">
            <div class="mock-modal-content">
              <strong>{val}</strong>
            </div>
          </div>
        )}
      </Show>
      <p class="hint">
        {"<Show when={signal}>"} renders children only when signal is truthy.
        No parent re-render needed.
      </p>
    </div>
  );
}

// ─── Test 10b: Show for modal pattern ───
const showModalEvent = signal<{ id: number; name: string } | null>(null);

function Test10b_ShowModal() {
  return (
    <div class="test-card">
      <h3>Test 10b: {"<Show>"} modal pattern</h3>
      <div class="item-list">
        <button onClick={() => { showModalEvent.value = { id: 1, name: "Chatora" }; }}>
          Chatora
        </button>
        <button onClick={() => { showModalEvent.value = { id: 2, name: "Mike" }; }}>
          Mike
        </button>
      </div>
      <Show when={showModalEvent}>
        {(ev) => (
          <div class="mock-modal">
            <div class="mock-modal-content">
              <strong>{ev.name}</strong> (id={ev.id})
              <button onClick={() => { showModalEvent.value = null; }}>×</button>
            </div>
          </div>
        )}
      </Show>
      <p class="hint">
        This is the ideal modal pattern — no useState, no bridge, no parent re-render.
      </p>
    </div>
  );
}

// ─── Test 11: For component (list render) ───
const listItems = signal([
  { id: 1, name: "Chatora" },
  { id: 2, name: "Mike" },
  { id: 3, name: "Kijitora" },
]);

function Test11_For() {
  return (
    <div class="test-card">
      <h3>Test 11: {"<For>"} component</h3>
      <For each={listItems}>
        {(item) => (
          <div style="padding: 4px 0;">
            #{item.id} — <strong>{item.name}</strong>
          </div>
        )}
      </For>
      <button
        onClick={() => {
          listItems.value = [
            ...listItems.value,
            { id: listItems.value.length + 1, name: `Pet #${listItems.value.length + 1}` },
          ];
        }}
      >
        Add item
      </button>
      <button
        onClick={() => {
          listItems.value = listItems.value.slice(0, -1);
        }}
      >
        Remove last
      </button>
      <p class="hint">
        {"<For each={signal}>"} efficiently renders lists. Items should add/remove without full re-render.
      </p>
    </div>
  );
}

// ─── Test 12: Show + useModel (production-ready pattern) ───
const FullStore = createModel(() => {
  const selected = signal<{ id: number; name: string } | null>(null);
  const items = signal([
    { id: 1, name: "Chatora sleeping" },
    { id: 2, name: "Mike eating" },
    { id: 3, name: "Kijitora playing" },
  ]);
  const openModal = action((item: { id: number; name: string }) => {
    selected.value = item;
  });
  const closeModal = action(() => {
    selected.value = null;
  });
  return { selected, items, openModal, closeModal };
});

function Test12_FullPattern() {
  const store = useModel(FullStore);
  return (
    <div class="test-card">
      <h3>Test 12: useModel + Show + For (target pattern)</h3>
      <For each={store.items}>
        {(item) => (
          <button onClick={() => store.openModal(item)}>
            {item.name}
          </button>
        )}
      </For>
      <Show when={store.selected}>
        {(ev) => (
          <div class="mock-modal">
            <div class="mock-modal-content">
              <strong>{ev.name}</strong>
              <button onClick={store.closeModal}>×</button>
            </div>
          </div>
        )}
      </Show>
      <p class="hint">
        The ideal production pattern: createModel + useModel + Show + For.
        No useState, no useSignalEffect bridge, no parent re-renders.
      </p>
    </div>
  );
}

// ─── App ───
function SignalsTestApp() {
  return (
    <div class="test-app">
      <h1>@preact/signals Test Bench</h1>
      <p class="subtitle">
        Verify signal reactivity patterns before production use.
        <br />
        Build: Bun {typeof Bun !== "undefined" ? "runtime" : "bundled"} |
        @preact/signals 2.8.2
      </p>
      <div class="test-grid">
        <Test1_AutoSubscribe />
        <Test2_Bridge />
        <Test3_Model />
        <Test6_UseSignal />
        <Test7_UseComputed />
        <Test8_Batch />
      </div>
      <h2>Modal Tests (the broken case)</h2>
      <div class="test-grid">
        <Test4_Modal />
        <Test4b_ModalBridge />
        <Test5_StoreModal />
        <Test5b_StoreModalBridge />
      </div>
      <h2>Show / For (declarative pattern)</h2>
      <div class="test-grid">
        <Test10_Show />
        <Test10b_ShowModal />
        <Test11_For />
        <Test12_FullPattern />
      </div>
      <h2>Diagnostics</h2>
      <Test9_Diagnostic />
    </div>
  );
}

const root = document.getElementById("app");
if (!root) throw new Error("#app root not found");
render(<SignalsTestApp />, root);
