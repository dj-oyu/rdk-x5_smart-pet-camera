#!/usr/bin/env python3
"""VLM Benchmark Runner — one command to evaluate and compare model/prompt configurations.

Usage:
    # Run benchmark with default prompt (v2_no_petid) against live VLM API:
    python3 tests/vlm/benchmark.py

    # Run with specific prompt variant:
    python3 tests/vlm/benchmark.py --prompt v1_other

    # Run with custom prompt from file:
    python3 tests/vlm/benchmark.py --prompt-file my_prompt.txt

    # Compare two previous runs:
    python3 tests/vlm/benchmark.py --compare results/eval_20260321_A.json results/eval_20260321_B.json

    # Re-evaluate existing results (no API calls):
    python3 tests/vlm/benchmark.py --offline

    # Only edge cases:
    python3 tests/vlm/benchmark.py --categories edge_dark edge_fake edge_empty

    # Limit to N images (fast sanity check):
    python3 tests/vlm/benchmark.py --limit 10

Output:
    tests/vlm/results/bench_YYYYMMDD_HHMMSS/
      ├── config.json       # model, prompt, timestamp
      ├── raw_results.json  # per-image VLM responses
      ├── metrics.json      # accuracy, confusion matrix, bias
      └── report.txt        # human-readable summary
"""

import argparse
import base64
import json
import sys
import time
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
IMAGES_DIR = SCRIPT_DIR / "images"
RESULTS_DIR = SCRIPT_DIR / "results"
GT_PATH = IMAGES_DIR / "ground_truth.json"
PROMPTS_PATH = SCRIPT_DIR / "prompts.json"


def load_prompts() -> dict:
    return json.loads(PROMPTS_PATH.read_text())


def load_ground_truth() -> dict:
    if not GT_PATH.exists():
        print(f"ERROR: {GT_PATH} not found. Run collect_test_images.py first.")
        sys.exit(1)
    return json.loads(GT_PATH.read_text())


def call_vlm(api_url: str, image_path: Path, model: str, max_tokens: int, prompt: str) -> dict:
    b64 = base64.b64encode(image_path.read_bytes()).decode()
    mime = "image/jpeg" if image_path.suffix.lower() in (".jpg", ".jpeg") else "image/png"
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                {"type": "text", "text": prompt},
            ],
        }],
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{api_url}/v1/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
        content = result["choices"][0]["message"]["content"].strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(content)
    except json.JSONDecodeError as e:
        return {"_parse_error": str(e), "_raw": content}
    except Exception as e:
        return {"_error": str(e)}


def evaluate(gt: dict, results: dict) -> dict:
    m = {"total": 0, "is_valid_correct": 0, "is_valid_total": 0,
         "pet_id_correct": 0, "pet_id_total": 0, "errors": 0,
         "by_category": {}, "confusion": {}, "response_dist": {}, "gt_dist": {},
         "is_valid_errors": []}

    for rel_path, expected in gt.items():
        if rel_path not in results:
            continue
        res = results[rel_path]
        cat = expected["category"]
        m["by_category"].setdefault(cat, {"total": 0, "is_valid_correct": 0, "pet_id_correct": 0, "errors": 0})
        cm = m["by_category"][cat]
        m["total"] += 1
        cm["total"] += 1

        if "_error" in res or "_parse_error" in res:
            m["errors"] += 1
            cm["errors"] += 1
            continue

        predicted_valid = res.get("is_valid")
        expected_valid = expected["expected_is_valid"]
        m["is_valid_total"] += 1
        if predicted_valid == expected_valid:
            m["is_valid_correct"] += 1
            cm["is_valid_correct"] += 1
        else:
            m["is_valid_errors"].append({
                "file": rel_path, "category": cat,
                "expected": expected_valid, "predicted": predicted_valid,
                "caption": res.get("caption", ""),
            })

        if expected_valid:
            predicted_pid = res.get("pet_id")
            expected_pid = expected.get("expected_pet_id")
            # Normalize null → "other" for comparison if prompt uses "other"
            if expected_pid is None:
                expected_pid = "other"
            m["pet_id_total"] += 1
            if predicted_pid == expected_pid:
                m["pet_id_correct"] += 1
                cm["pet_id_correct"] += 1
            key = f"{expected_pid} -> {predicted_pid}"
            m["confusion"][key] = m["confusion"].get(key, 0) + 1
            m["response_dist"][str(predicted_pid)] = m["response_dist"].get(str(predicted_pid), 0) + 1
            m["gt_dist"][str(expected_pid)] = m["gt_dist"].get(str(expected_pid), 0) + 1

    if m["is_valid_total"]:
        m["is_valid_accuracy"] = m["is_valid_correct"] / m["is_valid_total"]
    if m["pet_id_total"]:
        m["pet_id_accuracy"] = m["pet_id_correct"] / m["pet_id_total"]
    return m


def format_report(config: dict, metrics: dict) -> str:
    lines = []
    lines.append("=" * 70)
    lines.append(f"VLM Benchmark Report — {config.get('timestamp', '?')}")
    lines.append(f"Model: {config.get('model', '?')}")
    lines.append(f"Prompt: {config.get('prompt_name', '?')}")
    lines.append(f"Max tokens: {config.get('max_tokens', '?')}")
    lines.append("=" * 70)

    m = metrics
    lines.append(f"\nTotal: {m['total']}  Errors: {m['errors']}")
    if "is_valid_accuracy" in m:
        lines.append(f"is_valid:  {m['is_valid_correct']}/{m['is_valid_total']} ({m['is_valid_accuracy']*100:.1f}%)")
    if "pet_id_accuracy" in m:
        lines.append(f"pet_id:   {m['pet_id_correct']}/{m['pet_id_total']} ({m['pet_id_accuracy']*100:.1f}%)")

    # Distribution
    if m.get("gt_dist"):
        lines.append(f"\n{'pet_id':>10s}  {'GT%':>6s}  {'Resp%':>6s}  {'Bias':>6s}")
        n = m["pet_id_total"]
        for pid in sorted(set(list(m["gt_dist"]) + list(m["response_dist"]))):
            gp = m["gt_dist"].get(pid, 0) / n * 100
            rp = m["response_dist"].get(pid, 0) / n * 100
            lines.append(f"  {pid:>10s}  {gp:>5.1f}%  {rp:>5.1f}%  {rp-gp:>+5.1f}%")

    # Confusion
    if m.get("confusion"):
        lines.append("\nConfusion (expected -> predicted):")
        for k in sorted(m["confusion"]):
            lines.append(f"  {k}: {m['confusion'][k]}")

    # Per category
    lines.append("\nPer category:")
    for cat, cm in sorted(m.get("by_category", {}).items()):
        valid_n = cm["total"] - cm["errors"]
        iv = f"{cm['is_valid_correct']}/{valid_n}" if valid_n else "n/a"
        lines.append(f"  {cat:16s}  is_valid={iv:>6s}  pet_id={cm['pet_id_correct']}/{valid_n}")

    # is_valid errors
    if m.get("is_valid_errors"):
        lines.append(f"\nis_valid errors ({len(m['is_valid_errors'])}):")
        for e in m["is_valid_errors"]:
            lines.append(f"  [{e['category']}] {e['file']}")
            lines.append(f"    expected={e['expected']} got={e['predicted']}  caption: {e['caption'][:80]}")

    return "\n".join(lines)


def compare_runs(file_a: str, file_b: str, gt: dict):
    ra = json.loads(Path(file_a).read_text())
    rb = json.loads(Path(file_b).read_text())
    ma = evaluate(gt, ra)
    mb = evaluate(gt, rb)

    print(f"\n{'Metric':>20s}  {'Run A':>10s}  {'Run B':>10s}  {'Delta':>8s}")
    print("-" * 55)

    def row(label, a, b):
        delta = b - a
        print(f"  {label:>20s}  {a:>10.1%}  {b:>10.1%}  {delta:>+7.1%}")

    if "is_valid_accuracy" in ma and "is_valid_accuracy" in mb:
        row("is_valid", ma["is_valid_accuracy"], mb["is_valid_accuracy"])
    if "pet_id_accuracy" in ma and "pet_id_accuracy" in mb:
        row("pet_id", ma["pet_id_accuracy"], mb["pet_id_accuracy"])

    # Per-image diff
    changed = []
    common = set(ra) & set(rb)
    for k in sorted(common):
        a_valid = ra[k].get("is_valid")
        b_valid = rb[k].get("is_valid")
        if a_valid != b_valid:
            changed.append((k, a_valid, b_valid))

    if changed:
        print(f"\nis_valid changed ({len(changed)} images):")
        for k, a, b in changed:
            print(f"  {k}: {a} -> {b}")


def main():
    parser = argparse.ArgumentParser(description="VLM Benchmark Runner")
    parser.add_argument("--api-url", default="http://localhost:8000")
    parser.add_argument("--model", default="qwen3-vl-2B-Int4-ax650")
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--prompt", default="v2_no_petid",
                        help="Prompt name from prompts.json")
    parser.add_argument("--prompt-file",
                        help="Override: read prompt text from file")
    parser.add_argument("--categories", nargs="*",
                        help="Only run specific categories")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--offline", action="store_true",
                        help="Re-evaluate most recent results without API calls")
    parser.add_argument("--compare", nargs=2, metavar="FILE",
                        help="Compare two result files")
    args = parser.parse_args()

    gt = load_ground_truth()

    # Compare mode
    if args.compare:
        compare_runs(args.compare[0], args.compare[1], gt)
        return

    # Resolve prompt
    if args.prompt_file:
        prompt_text = Path(args.prompt_file).read_text().strip()
        prompt_name = Path(args.prompt_file).stem
    else:
        prompts = load_prompts()
        if args.prompt not in prompts:
            print(f"Unknown prompt '{args.prompt}'. Available: {list(prompts.keys())}")
            sys.exit(1)
        prompt_text = prompts[args.prompt]["text"]
        prompt_name = args.prompt

    # Filter
    if args.categories:
        gt = {k: v for k, v in gt.items() if v["category"] in args.categories}

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = RESULTS_DIR / f"bench_{timestamp}"
    run_dir.mkdir(parents=True, exist_ok=True)

    config = {
        "timestamp": timestamp,
        "model": args.model,
        "prompt_name": prompt_name,
        "prompt_text": prompt_text,
        "max_tokens": args.max_tokens,
        "api_url": args.api_url,
        "image_count": len(gt),
        "categories": sorted(set(v["category"] for v in gt.values())),
    }

    # Run or load
    if args.offline:
        existing = sorted(RESULTS_DIR.glob("bench_*/raw_results.json"), reverse=True)
        if not existing:
            existing = sorted(RESULTS_DIR.glob("eval_*.json"), reverse=True)
        if not existing:
            print("No results found.")
            sys.exit(1)
        results = json.loads(existing[0].read_text())
        print(f"Loaded: {existing[0]} ({len(results)} images)")
    else:
        results = {}
        total = len(gt)
        count = 0
        for rel_path in sorted(gt):
            if args.limit and count >= args.limit:
                break
            img_path = IMAGES_DIR / rel_path
            if not img_path.exists():
                continue
            count += 1
            cat = gt[rel_path]["category"]
            print(f"  [{count}/{total}] [{cat}] {rel_path} ... ", end="", flush=True)
            start = time.time()
            res = call_vlm(args.api_url, img_path, args.model, args.max_tokens, prompt_text)
            elapsed = time.time() - start
            res["_elapsed_sec"] = round(elapsed, 2)
            results[rel_path] = res
            iv = res.get("is_valid", "ERR")
            print(f"is_valid={iv} ({elapsed:.1f}s)")
            time.sleep(0.5)

    # Save results
    (run_dir / "config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False))
    (run_dir / "raw_results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))

    # Evaluate
    metrics = evaluate(gt, results)
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False))

    # Report
    report = format_report(config, metrics)
    (run_dir / "report.txt").write_text(report)
    print(f"\n{report}")
    print(f"\nResults saved: {run_dir}/")


if __name__ == "__main__":
    main()
