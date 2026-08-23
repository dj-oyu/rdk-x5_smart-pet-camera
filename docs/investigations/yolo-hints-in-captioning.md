# Do YOLO hints improve VLM captions?

Investigation date: 2026-08-24
Device: AI Pyramid Pro (AX8850), Qwen3.5-2B via axllm-serve
Component: `src/ai-pyramid/src/vlm/client.rs`

## Why

`VlmClient::analyze_with_detections()` — added in 6ee6f24 ("Level2 local YOLO
detection + VLM context enhancement") — appends the YOLO detection list to the
captioning prompt as a hint. It has **never been called**: no call site has
existed at any commit since it was introduced. Before either wiring it up or
deleting it, the question is whether the hints would earn the change.

The case that motivated wiring it: a frame of a **dog** was captioned
`"A small white and brown dog with floppy ears is lying on a wooden floor…"`
while the model still answered `cat: true`, so the frame counted as a valid
observation and reached the daily summary.

## Measurement

`comic_20260823_145341_mike.jpg` (the dog frame), 3 runs each, temperature 0.1.

Its stored YOLO detections:

| panel | class | confidence |
|---|---|---|
| 0 | cat | 0.38 |
| 1 | cat | 0.55 |

**The hint source makes the same mistake as the model.** YOLO reports a cat,
not a dog, on exactly the frame where the caption is wrong.

| prompt | result (3/3 runs) |
|---|---|
| no hints | `cat: true`, dog described in the caption |
| `panel 0: cat 0.38, panel 1: cat 0.55` | `cat: true`, dog described in the caption |

The reverse direction, on a cat frame with no stored detections
(`comic_20260624_222553_mike.jpg`):

| prompt | result (3/3 runs) |
|---|---|
| `no objects detected` | `cat: true` — unchanged, and correct |

So the hints moved nothing in either direction: they neither corrected a wrong
`cat: true` nor talked the model out of a right one.

## Cost of wiring it up

`ingest/watcher.rs` captions first and detects afterwards. Feeding hints into
the caption means reversing that, and both stages take the same exclusive NPU
permit, so every photo would wait for detection before captioning began.

## Decision

Deleted. Zero measured benefit against a pipeline reordering, on a method that
had been dead for five months.

If this is revisited, the useful precondition is a detector that disagrees with
the VLM when the VLM is wrong. Today it agrees — see
`docs/investigations/pet-color-bias-investigation.md` for the related finding
that upstream pet classification is skewed as well.
