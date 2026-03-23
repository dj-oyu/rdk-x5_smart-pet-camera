---
paths: src/**/*.rs
---

Rust files have heavy compilation costs. Before asking the user to build or before committing:

1. **`cargo check`** — type check (mandatory before every build request)
2. **`cargo fmt -- --check`** — format check
3. **`cargo clippy`** — lint check (if available)

Fix all errors and warnings before proceeding. Do not ask the user to build until these pass clean.
