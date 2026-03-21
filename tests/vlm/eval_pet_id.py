#!/usr/bin/env python3
"""Evaluate VLM pet_id / is_valid accuracy against ground truth test images.

Usage:
    uv run tests/vlm/eval_pet_id.py [--api-url http://localhost:8000] [--max-tokens 128]

Requires:
    - Test images collected by collect_test_images.py
    - AI Pyramid Pro VLM API running (or any OpenAI-compatible endpoint)

Output:
    - Per-category accuracy metrics
    - Confusion matrix for pet_id
    - Detailed results in tests/vlm/results/eval_YYYYMMDD_HHMMSS.json
"""

import argparse
import base64
import json
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import urllib.request
except ImportError:
    pass

SCRIPT_DIR = Path(__file__).parent
IMAGES_DIR = SCRIPT_DIR / "images"
RESULTS_DIR = SCRIPT_DIR / "results"
GROUND_TRUTH_PATH = IMAGES_DIR / "ground_truth.json"

PROMPT_ORIGINAL = (
    'Analyze this photo of a pet camera feed. Respond with valid JSON only, no markdown.\n'
    '{"is_valid": true if a cat is clearly visible else false,\n'
    ' "caption": "one sentence describing the cat\'s appearance and action",\n'
    ' "pet_id": "mike" if calico/tricolor cat or "chatora" if tabby/orange cat or null,\n'
    ' "behavior": one of "eating","sleeping","playing","resting","moving","grooming","other"}'
)

PROMPT_OTHER = (
    'Analyze this photo of a pet camera feed. Respond with valid JSON only, no markdown.\n'
    '{"is_valid": true if a cat is clearly visible else false,\n'
    ' "caption": "one sentence describing the cat\'s appearance and action",\n'
    ' "pet_id": "mike" if calico/tricolor cat, "chatora" if tabby/orange cat, "other" if different cat or not a cat,\n'
    ' "behavior": one of "eating","sleeping","playing","resting","moving","grooming","other"}'
)

PROMPTS = {
    "original": PROMPT_ORIGINAL,
    "other": PROMPT_OTHER,
}
VLM_PROMPT = PROMPT_ORIGINAL


def load_ground_truth() -> dict:
    if not GROUND_TRUTH_PATH.exists():
        print(f"ERROR: Ground truth not found at {GROUND_TRUTH_PATH}")
        print("Run collect_test_images.py first.")
        sys.exit(1)
    return json.loads(GROUND_TRUTH_PATH.read_text())


def encode_image_base64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("utf-8")


def call_vlm(api_url: str, image_path: Path, model: str, max_tokens: int,
             prompt: str = "") -> dict | None:
    """Send image to VLM API and parse JSON response."""
    b64 = encode_image_base64(image_path)
    mime = "image/jpeg" if image_path.suffix.lower() in (".jpg", ".jpeg") else "image/png"

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime};base64,{b64}"},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url}/v1/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
        content = result["choices"][0]["message"]["content"]
        # Try to parse JSON from response (handle markdown wrapping)
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(content)
    except json.JSONDecodeError as e:
        return {"_parse_error": str(e), "_raw": content}
    except Exception as e:
        return {"_error": str(e)}


def evaluate(ground_truth: dict, results: dict) -> dict:
    """Compute accuracy metrics from results."""
    metrics = {
        "total": 0,
        "is_valid_correct": 0,
        "is_valid_total": 0,
        "pet_id_correct": 0,
        "pet_id_total": 0,
        "errors": 0,
        "by_category": {},
        "confusion": {},  # {(expected, predicted): count}
        "response_dist": {},  # {pet_id: count}
        "gt_dist": {},  # {pet_id: count}
    }

    for rel_path, gt in ground_truth.items():
        if rel_path not in results:
            continue

        res = results[rel_path]
        cat = gt["category"]
        if cat not in metrics["by_category"]:
            metrics["by_category"][cat] = {
                "total": 0, "is_valid_correct": 0, "pet_id_correct": 0, "errors": 0,
            }
        cat_m = metrics["by_category"][cat]

        metrics["total"] += 1
        cat_m["total"] += 1

        if "_error" in res or "_parse_error" in res:
            metrics["errors"] += 1
            cat_m["errors"] += 1
            continue

        # is_valid accuracy
        predicted_valid = res.get("is_valid")
        expected_valid = gt["expected_is_valid"]
        metrics["is_valid_total"] += 1
        if predicted_valid == expected_valid:
            metrics["is_valid_correct"] += 1
            cat_m["is_valid_correct"] += 1

        # pet_id accuracy (only when is_valid is expected True)
        if expected_valid:
            predicted_pid = res.get("pet_id")
            expected_pid = gt["expected_pet_id"]
            metrics["pet_id_total"] += 1
            if predicted_pid == expected_pid:
                metrics["pet_id_correct"] += 1
                cat_m["pet_id_correct"] += 1

            # Confusion matrix & distributions
            key = f"{expected_pid} -> {predicted_pid}"
            metrics["confusion"][key] = metrics["confusion"].get(key, 0) + 1
            metrics["response_dist"][str(predicted_pid)] = metrics["response_dist"].get(str(predicted_pid), 0) + 1
            metrics["gt_dist"][str(expected_pid)] = metrics["gt_dist"].get(str(expected_pid), 0) + 1

    # Compute rates
    if metrics["is_valid_total"] > 0:
        metrics["is_valid_accuracy"] = metrics["is_valid_correct"] / metrics["is_valid_total"]
    if metrics["pet_id_total"] > 0:
        metrics["pet_id_accuracy"] = metrics["pet_id_correct"] / metrics["pet_id_total"]

    # Chance-level accuracy (majority class baseline)
    if metrics["pet_id_total"] > 0:
        majority = max(metrics["response_dist"].values())
        metrics["majority_baseline"] = majority / metrics["pet_id_total"]

    return metrics


def print_report(metrics: dict):
    """Print human-readable accuracy report."""
    print("\n" + "=" * 60)
    print("VLM pet_id Evaluation Report")
    print("=" * 60)

    total = metrics["total"]
    print(f"\nTotal images evaluated: {total}")
    print(f"Parse/API errors: {metrics['errors']}")

    if metrics.get("is_valid_accuracy") is not None:
        pct = metrics["is_valid_accuracy"] * 100
        print(f"\nis_valid accuracy: {metrics['is_valid_correct']}/{metrics['is_valid_total']} ({pct:.1f}%)")

    if metrics.get("pet_id_accuracy") is not None:
        pct = metrics["pet_id_accuracy"] * 100
        print(f"pet_id accuracy:  {metrics['pet_id_correct']}/{metrics['pet_id_total']} ({pct:.1f}%)")
        if metrics.get("majority_baseline") is not None:
            bpct = metrics["majority_baseline"] * 100
            print(f"  (majority-class baseline: {bpct:.1f}%)")

    # Distribution comparison
    print("\n--- Distribution: Ground Truth vs Response ---")
    all_pids = sorted(set(list(metrics["gt_dist"].keys()) + list(metrics["response_dist"].keys())))
    n = metrics["pet_id_total"]
    print(f"  {'pet_id':>10s}  {'GT':>6s} {'GT%':>6s}  {'Resp':>6s} {'Resp%':>6s}  {'Bias':>6s}")
    for pid in all_pids:
        gt_c = metrics["gt_dist"].get(pid, 0)
        rs_c = metrics["response_dist"].get(pid, 0)
        gt_p = gt_c / n * 100 if n else 0
        rs_p = rs_c / n * 100 if n else 0
        bias = rs_p - gt_p
        print(f"  {pid:>10s}  {gt_c:>6d} {gt_p:>5.1f}%  {rs_c:>6d} {rs_p:>5.1f}%  {bias:>+5.1f}%")

    # Confusion matrix
    print("\n--- Confusion Matrix (expected -> predicted) ---")
    for key in sorted(metrics["confusion"].keys()):
        cnt = metrics["confusion"][key]
        print(f"  {key}: {cnt}")

    print("\n--- Per Category ---")
    for cat, cm in metrics["by_category"].items():
        print(f"\n  [{cat}] ({cm['total']} images, {cm['errors']} errors)")
        valid_total = cm["total"] - cm["errors"]
        if valid_total > 0:
            print(f"    is_valid correct: {cm['is_valid_correct']}/{valid_total}")
            if cat in ("calico", "tabby", "other_cat"):
                print(f"    pet_id correct:  {cm['pet_id_correct']}/{valid_total}")


def main():
    parser = argparse.ArgumentParser(description="Evaluate VLM pet_id accuracy")
    parser.add_argument("--api-url", default="http://localhost:8000",
                        help="VLM API base URL (default: http://localhost:8000)")
    parser.add_argument("--model", default="qwen3-vl-2B-Int4-ax650",
                        help="Model name for API request")
    parser.add_argument("--max-tokens", type=int, default=128,
                        help="Max tokens for VLM response (default: 128)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Limit total images to evaluate (0=all)")
    parser.add_argument("--categories", nargs="*",
                        help="Only evaluate specific categories")
    parser.add_argument("--prompt", choices=list(PROMPTS.keys()), default="original",
                        help="Prompt variant to use (default: original)")
    parser.add_argument("--balance", action="store_true",
                        help="Balance test set: sample min(category sizes) per category")
    parser.add_argument("--offline", action="store_true",
                        help="Skip API calls, only re-evaluate existing results")
    args = parser.parse_args()

    # Select prompt
    VLM_PROMPT = PROMPTS[args.prompt]
    print(f"Prompt variant: {args.prompt}")

    ground_truth = load_ground_truth()
    # Map ground truth pet_id for "other" prompt variant
    if args.prompt == "other":
        for gt in ground_truth.values():
            if gt["expected_pet_id"] is None:
                gt["expected_pet_id"] = "other"
    print(f"Ground truth: {len(ground_truth)} images")

    # Filter categories if specified
    if args.categories:
        ground_truth = {k: v for k, v in ground_truth.items() if v["category"] in args.categories}
        print(f"Filtered to: {len(ground_truth)} images")

    # Balance test set
    if args.balance:
        import random
        random.seed(42)
        by_cat: dict[str, list[str]] = {}
        for k, v in ground_truth.items():
            by_cat.setdefault(v["category"], []).append(k)
        min_size = min(len(v) for v in by_cat.values())
        balanced = {}
        for cat, keys in by_cat.items():
            sampled = sorted(random.sample(keys, min_size))
            for k in sampled:
                balanced[k] = ground_truth[k]
        print(f"Balanced: {min_size} per category, {len(balanced)} total "
              f"(categories: {list(by_cat.keys())})")
        ground_truth = balanced

    # Load or create results
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_path = RESULTS_DIR / f"eval_{timestamp}.json"

    results = {}
    if args.offline:
        # Find most recent results file
        existing = sorted(RESULTS_DIR.glob("eval_*.json"), reverse=True)
        if existing:
            results = json.loads(existing[0].read_text())
            print(f"Loaded existing results: {existing[0].name} ({len(results)} entries)")
        else:
            print("No existing results found. Run without --offline first.")
            sys.exit(1)
    else:
        count = 0
        total = len(ground_truth)
        for rel_path in sorted(ground_truth.keys()):
            if args.limit and count >= args.limit:
                break

            img_path = IMAGES_DIR / rel_path
            if not img_path.exists():
                print(f"  SKIP (missing): {rel_path}")
                continue

            count += 1
            print(f"  [{count}/{total}] {rel_path} ... ", end="", flush=True)

            start = time.time()
            vlm_result = call_vlm(args.api_url, img_path, args.model, args.max_tokens, VLM_PROMPT)
            elapsed = time.time() - start

            if vlm_result:
                vlm_result["_elapsed_sec"] = round(elapsed, 2)
                results[rel_path] = vlm_result
                pid = vlm_result.get("pet_id", "ERR")
                valid = vlm_result.get("is_valid", "ERR")
                print(f"is_valid={valid}, pet_id={pid} ({elapsed:.1f}s)")
            else:
                results[rel_path] = {"_error": "no response"}
                print("ERROR")

            # Rate limit
            time.sleep(1.0)

        results_path.write_text(json.dumps(results, indent=2, ensure_ascii=False))
        print(f"\nResults saved: {results_path}")

    # Evaluate
    metrics = evaluate(ground_truth, results)
    metrics["timestamp"] = timestamp
    metrics["model"] = args.model
    metrics["max_tokens"] = args.max_tokens
    print_report(metrics)

    # Save metrics
    metrics_path = RESULTS_DIR / f"metrics_{timestamp}.json"
    metrics_path.write_text(json.dumps(metrics, indent=2))
    print(f"\nMetrics saved: {metrics_path}")


if __name__ == "__main__":
    main()
