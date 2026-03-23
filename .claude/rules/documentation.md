When writing or editing Markdown documentation (*.md):

- **Diagrams**: Use mermaid fenced code blocks (```` ```mermaid ````) for all diagrams. Never use ASCII art box drawings — they break with Japanese proportional fonts.
- **Mermaid syntax validation**: After writing mermaid blocks, validate with `bunx @mermaid-js/mermaid-cli -i <file>.mmd -o <file>.svg`. Extract each mermaid block to a temp .mmd file and render to confirm no syntax errors.
- **Mermaid node IDs**: Use ASCII-only identifiers for node IDs. Put Japanese text inside labels (`["日本語テキスト"]` or `<br/>`).
- **Facts must match code**: Every function name, struct name, SHM name, parameter value, and file path referenced in docs must be verifiable in the current codebase. Do not document removed or planned-but-unimplemented features without marking them as such.
- **SHM single source of truth**: `src/capture/shm_constants.h` is the authoritative source for SHM region names and counts.
