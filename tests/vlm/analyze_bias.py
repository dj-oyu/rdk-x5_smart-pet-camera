#!/usr/bin/env python3
"""Analyze VLM pet_id bias by resampling test results at varying category ratios.

Uses existing eval results (no new API calls). Tests whether the model truly
discriminates or just defaults to the majority response.

Usage:
    python3 tests/vlm/analyze_bias.py [--results-file FILE]
"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
IMAGES_DIR = SCRIPT_DIR / "images"
RESULTS_DIR = SCRIPT_DIR / "results"
GT_PATH = IMAGES_DIR / "ground_truth.json"

# Ratio configs: (calico_weight, tabby_weight, other_cat_weight)
# We sample N images per category where N = weight * base
RATIO_CONFIGS = [
    ("tabby-heavy",    {"mike": 2, "chatora": 8, "other": 2}),
    ("equal",          {"mike": 4, "chatora": 4, "other": 4}),
    ("calico-heavy",   {"mike": 8, "chatora": 2, "other": 2}),
    ("other-heavy",    {"mike": 2, "chatora": 2, "other": 8}),
    ("mike-vs-chatora",{"mike": 5, "chatora": 5, "other": 0}),
]

PID_MAP = {"calico": "mike", "tabby": "chatora", "other_cat": "other"}


def load_data(results_file: str | None):
    gt = json.loads(GT_PATH.read_text())
    # Map null -> other
    for v in gt.values():
        if v["expected_pet_id"] is None:
            v["expected_pet_id"] = "other"

    if results_file:
        results = json.loads(Path(results_file).read_text())
    else:
        files = sorted(RESULTS_DIR.glob("eval_*.json"), reverse=True)
        if not files:
            print("No results found. Run eval_pet_id.py first.")
            raise SystemExit(1)
        results = json.loads(files[0].read_text())
        print(f"Using: {files[0].name}")

    # Only cat images with valid results
    cat_data = {}
    for k, v in gt.items():
        if v["category"] == "non_cat":
            continue
        if k not in results:
            continue
        if "_error" in results[k] or "_parse_error" in results[k]:
            continue
        cat_data[k] = {
            "expected_pet_id": v["expected_pet_id"],
            "category": v["category"],
            "predicted_pet_id": results[k].get("pet_id"),
        }

    return cat_data


def sample_by_ratio(cat_data: dict, ratio: dict, n_trials: int = 200) -> list[dict]:
    """Run multiple resampling trials at given ratio, return per-trial metrics."""
    by_expected = {}
    for k, v in cat_data.items():
        by_expected.setdefault(v["expected_pet_id"], []).append(v)

    trial_results = []
    for _ in range(n_trials):
        sample = []
        for pid, count in ratio.items():
            if count == 0 or pid not in by_expected:
                continue
            pool = by_expected[pid]
            n = min(count, len(pool))
            sample.extend(random.choices(pool, k=n))

        if not sample:
            continue

        # Count
        gt_dist = Counter(v["expected_pet_id"] for v in sample)
        resp_dist = Counter(v["predicted_pet_id"] for v in sample)
        correct = sum(1 for v in sample if v["predicted_pet_id"] == v["expected_pet_id"])
        total = len(sample)

        trial_results.append({
            "accuracy": correct / total if total else 0,
            "gt_dist": dict(gt_dist),
            "resp_dist": dict(resp_dist),
            "total": total,
        })

    return trial_results


def print_analysis(cat_data: dict):
    print("\n" + "=" * 72)
    print("VLM pet_id Bias Analysis — Varying Input Ratios")
    print("=" * 72)

    # Available data
    by_exp = Counter(v["expected_pet_id"] for v in cat_data.values())
    print(f"\nAvailable data: {dict(by_exp)}")

    # Overall response distribution regardless of input
    resp_all = Counter(v["predicted_pet_id"] for v in cat_data.values())
    n_all = len(cat_data)
    print(f"Overall response dist: ", end="")
    for pid in sorted(resp_all):
        print(f"{pid}={resp_all[pid]}/{n_all}({resp_all[pid]/n_all*100:.0f}%) ", end="")
    print()

    for config_name, ratio in RATIO_CONFIGS:
        trials = sample_by_ratio(cat_data, ratio, n_trials=500)
        if not trials:
            continue

        avg_acc = sum(t["accuracy"] for t in trials) / len(trials)

        # Average response distribution
        avg_resp = Counter()
        for t in trials:
            for pid, cnt in t["resp_dist"].items():
                avg_resp[pid] += cnt
        total_resp = sum(avg_resp.values())

        # Average GT distribution
        avg_gt = Counter()
        for t in trials:
            for pid, cnt in t["gt_dist"].items():
                avg_gt[pid] += cnt
        total_gt = sum(avg_gt.values())

        print(f"\n--- {config_name} (ratio: {ratio}) ---")
        print(f"  Accuracy: {avg_acc*100:.1f}% (over {len(trials)} trials)")

        all_pids = sorted(set(list(avg_gt.keys()) + list(avg_resp.keys())))
        print(f"  {'pet_id':>10s}  {'GT%':>6s}  {'Resp%':>6s}  {'Bias':>6s}")
        for pid in all_pids:
            gt_p = avg_gt.get(pid, 0) / total_gt * 100 if total_gt else 0
            rs_p = avg_resp.get(pid, 0) / total_resp * 100 if total_resp else 0
            bias = rs_p - gt_p
            print(f"  {pid:>10s}  {gt_p:>5.1f}%  {rs_p:>5.1f}%  {bias:>+5.1f}%")

    # Per-image consistency: does the same image always get the same answer?
    print(f"\n--- Per-Image Response (full dataset, no sampling) ---")
    print(f"  {'Expected':>10s} {'Predicted':>10s} {'Count':>6s}")
    confusion = Counter()
    for v in cat_data.values():
        confusion[(v["expected_pet_id"], v["predicted_pet_id"])] += 1
    for (exp, pred), cnt in sorted(confusion.items()):
        marker = " OK" if exp == pred else " XX"
        print(f"  {exp:>10s} {pred:>10s} {cnt:>6d}{marker}")

    # Key question: does chatora% stay ~constant regardless of input?
    print(f"\n--- Key Question: Is chatora response ratio stable across configs? ---")
    print(f"  (If stable regardless of GT ratio => pure bias, not discrimination)")
    print(f"  {'Config':>20s}  {'GT chatora%':>12s}  {'Resp chatora%':>14s}")
    for config_name, ratio in RATIO_CONFIGS:
        trials = sample_by_ratio(cat_data, ratio, n_trials=500)
        if not trials:
            continue
        avg_gt_chatora = sum(t["gt_dist"].get("chatora", 0) / t["total"] for t in trials) / len(trials)
        avg_resp_chatora = sum(t["resp_dist"].get("chatora", 0) / t["total"] for t in trials) / len(trials)
        print(f"  {config_name:>20s}  {avg_gt_chatora*100:>11.1f}%  {avg_resp_chatora*100:>13.1f}%")


def main():
    parser = argparse.ArgumentParser(description="Analyze VLM pet_id bias")
    parser.add_argument("--results-file", help="Specific results JSON to use")
    args = parser.parse_args()

    random.seed(42)
    cat_data = load_data(args.results_file)
    print_analysis(cat_data)


if __name__ == "__main__":
    main()
