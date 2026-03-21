#!/usr/bin/env python3
"""Collect cat test images from Wikimedia Commons for VLM pet_id accuracy testing.

Usage:
    uv run tests/vlm/collect_test_images.py [--max-per-category 20] [--resize 640]

Downloads images into tests/vlm/images/{calico,tabby,other_cat,non_cat}/
with ground truth labels for automated VLM evaluation.
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
IMAGES_DIR = SCRIPT_DIR / "images"

# Wikimedia Commons categories mapped to our pet_id labels
CATEGORIES = {
    "calico": [
        "Tricolour cats",
        "Tortoiseshell cats",
    ],
    "tabby": [
        "Red tabby cats",
        "Red cats",
        "Tabby cats",
    ],
    "other_cat": [
        "Black cats",
        "White cats",
        "Siamese cats",
        "Tuxedo patterned cats",
        "Solid cats",
    ],
    "non_cat": [
        "Unidentified dogs",
        "Dog types",
        "Canis lupus familiaris",
    ],
    # --- is_valid boundary conditions ---
    "edge_partial": [
        "Cat tails",
        "Cat paws and claws",
    ],
    "edge_far": [
        "Cats in gardens",
    ],
    "edge_dark": [
        "Cats at night",
    ],
    "edge_multi": [
        "Groups of cats",
    ],
    "edge_fake": [
        "Cat toys",
        "Maneki-neko",
        "Gat de Botero (El Raval)",
        "Carreras Cigarette Factory Cat Statues",
    ],
    "edge_empty": [
        "Interior design",
        "Living rooms",
    ],
}

# Expected VLM ground truth for each category
GROUND_TRUTH = {
    "calico": {"is_valid": True, "pet_id": "mike"},
    "tabby": {"is_valid": True, "pet_id": "chatora"},
    "other_cat": {"is_valid": True, "pet_id": None},
    "non_cat": {"is_valid": False, "pet_id": None},
    "edge_partial": {"is_valid": True, "pet_id": None},
    "edge_far": {"is_valid": True, "pet_id": None},
    "edge_dark": {"is_valid": True, "pet_id": None},
    "edge_multi": {"is_valid": True, "pet_id": None},
    "edge_fake": {"is_valid": False, "pet_id": None},
    "edge_empty": {"is_valid": False, "pet_id": None},
}

API_URL = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "SmartPetCamera-TestCollector/1.0 (https://github.com/dj-oyu/smart-pet-camera)"


def query_category_images(category: str, limit: int = 20) -> list[dict]:
    """Query Wikimedia Commons API for images in a category."""
    params = {
        "action": "query",
        "generator": "categorymembers",
        "gcmtitle": f"Category:{category}",
        "gcmtype": "file",
        "gcmlimit": str(limit),
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
        "iiurlwidth": "640",
        "format": "json",
    }
    url = f"{API_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"  WARNING: API query failed for '{category}': {e}")
        return []

    pages = data.get("query", {}).get("pages", {})
    results = []
    for page in pages.values():
        info_list = page.get("imageinfo", [])
        if not info_list:
            continue
        info = info_list[0]
        mime = info.get("mime", "")
        if mime not in ("image/jpeg", "image/png"):
            continue
        # Prefer thumbnail URL (resized) over full-size
        thumb_url = info.get("thumburl", info.get("url", ""))
        if not thumb_url:
            continue
        results.append({
            "title": page.get("title", ""),
            "url": thumb_url,
            "width": info.get("thumbwidth", info.get("width", 0)),
            "height": info.get("thumbheight", info.get("height", 0)),
            "mime": mime,
        })
    return results


def download_image(url: str, dest: Path) -> bool:
    """Download a single image."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            dest.write_bytes(resp.read())
        return True
    except Exception as e:
        print(f"  WARNING: Download failed {dest.name}: {e}")
        return False


def sanitize_filename(title: str, idx: int) -> str:
    """Convert Wikimedia title to safe filename."""
    # Remove "File:" prefix
    name = title.replace("File:", "").replace(" ", "_")
    # Keep only safe characters
    safe = "".join(c for c in name if c.isalnum() or c in "._-")
    # Prefix with index for uniqueness
    return f"{idx:03d}_{safe}"


def collect_category(label: str, categories: list[str], max_per_cat: int) -> int:
    """Collect images for one label category."""
    dest_dir = IMAGES_DIR / label
    dest_dir.mkdir(parents=True, exist_ok=True)

    existing = list(dest_dir.glob("*.jpg")) + list(dest_dir.glob("*.png"))
    print(f"\n[{label}] existing: {len(existing)} images")

    total_downloaded = 0
    global_idx = len(existing)

    for cat_name in categories:
        remaining = max_per_cat - total_downloaded
        if remaining <= 0:
            break

        print(f"  Querying: Category:{cat_name} (limit={remaining})")
        images = query_category_images(cat_name, limit=remaining)
        print(f"  Found: {len(images)} images")

        for img in images:
            if total_downloaded >= max_per_cat:
                break
            ext = ".jpg" if "jpeg" in img["mime"] else ".png"
            filename = sanitize_filename(img["title"], global_idx) + ext
            dest = dest_dir / filename
            if dest.exists():
                continue

            if download_image(img["url"], dest):
                total_downloaded += 1
                global_idx += 1
                print(f"  [{total_downloaded}/{max_per_cat}] {filename}")

            # Be polite to Wikimedia servers
            time.sleep(0.5)

    return total_downloaded


def write_ground_truth():
    """Write ground truth labels JSON for test evaluation."""
    gt_path = IMAGES_DIR / "ground_truth.json"
    ground_truth = {}

    for label, expected in GROUND_TRUTH.items():
        label_dir = IMAGES_DIR / label
        if not label_dir.exists():
            continue
        for img_file in sorted(label_dir.iterdir()):
            if img_file.suffix.lower() in (".jpg", ".jpeg", ".png"):
                rel_path = f"{label}/{img_file.name}"
                ground_truth[rel_path] = {
                    "expected_is_valid": expected["is_valid"],
                    "expected_pet_id": expected["pet_id"],
                    "category": label,
                }

    gt_path.write_text(json.dumps(ground_truth, indent=2, ensure_ascii=False))
    print(f"\nGround truth written: {gt_path} ({len(ground_truth)} entries)")


def main():
    parser = argparse.ArgumentParser(description="Collect VLM test images from Wikimedia Commons")
    parser.add_argument("--max-per-category", type=int, default=20,
                        help="Max images per label category (default: 20)")
    parser.add_argument("--categories", nargs="*", choices=list(CATEGORIES.keys()),
                        help="Only collect specific categories")
    parser.add_argument("--dry-run", action="store_true",
                        help="Query API but don't download")
    args = parser.parse_args()

    targets = args.categories or list(CATEGORIES.keys())
    print(f"Collecting test images: {targets}")
    print(f"Max per category: {args.max_per_category}")
    print(f"Output: {IMAGES_DIR}")

    total = 0
    for label in targets:
        cats = CATEGORIES[label]
        if args.dry_run:
            for cat_name in cats:
                images = query_category_images(cat_name, limit=5)
                print(f"  [{label}] Category:{cat_name} -> {len(images)} images available")
        else:
            count = collect_category(label, cats, args.max_per_category)
            total += count
            print(f"  [{label}] Downloaded: {count}")

    if not args.dry_run:
        write_ground_truth()
        print(f"\nTotal downloaded: {total}")
        print("Next step: uv run tests/vlm/eval_pet_id.py")


if __name__ == "__main__":
    main()
