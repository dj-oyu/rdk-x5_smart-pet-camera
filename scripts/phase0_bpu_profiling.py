#!/usr/bin/env python3
"""
Phase 0 BPU Profiling Script

Tests:
- 0-4: BPU core count verification (core_id=0,1,2)
- 0-5: bpu_infer_lib vs hobot_dnn performance comparison
- 0-6: Detection rate baseline at various thresholds
"""

import sys
import time
import json
import numpy as np

MODEL_PATH_V13 = "/app/smart-pet-camera/models/yolov13n_detect_bayese_640x640_nv12.bin"
MODEL_PATH_V8 = "/app/smart-pet-camera/models/yolov8n_detect_bayese_640x640_nv12.bin"
MODEL_PATH_11N = "/app/smart-pet-camera/models/yolo11n_detect_bayese_640x640_nv12.bin"

# Generate a synthetic NV12 test frame (640x640)
WIDTH, HEIGHT = 640, 640
Y_SIZE = WIDTH * HEIGHT
UV_SIZE = Y_SIZE // 2
NV12_SIZE = Y_SIZE + UV_SIZE


def make_test_nv12():
    """Create a synthetic NV12 frame with some structure for testing."""
    nv12 = np.zeros(NV12_SIZE, dtype=np.uint8)
    # Y plane: gradient pattern
    y = np.arange(Y_SIZE, dtype=np.uint8).reshape(HEIGHT, WIDTH)
    nv12[:Y_SIZE] = y.flatten()
    # UV plane: neutral (128)
    nv12[Y_SIZE:] = 128
    return nv12


def test_core_ids():
    """Phase 0-4: Test BPU core availability."""
    print("\n=== Phase 0-4: BPU Core Verification ===")
    from hobot_dnn import pyeasy_dnn as dnn

    models = dnn.load(MODEL_PATH_V13)
    model = models[0]
    test_input = make_test_nv12()

    results = {}
    for core_id in [0, 1, 2]:
        try:
            start = time.perf_counter()
            outputs = model.forward(test_input, core_id=core_id)
            elapsed = (time.perf_counter() - start) * 1000
            results[f"core_{core_id}"] = {"status": "OK", "latency_ms": round(elapsed, 2)}
            print(f"  core_id={core_id}: OK ({elapsed:.2f} ms)")
        except Exception as e:
            results[f"core_{core_id}"] = {"status": "ERROR", "error": str(e)}
            print(f"  core_id={core_id}: ERROR - {e}")

    return results


def test_bpu_infer_lib():
    """Phase 0-5: Test bpu_infer_lib performance."""
    print("\n=== Phase 0-5: bpu_infer_lib Evaluation ===")

    results = {}
    test_input = make_test_nv12()

    # Test hobot_dnn first
    print("  Testing hobot_dnn.pyeasy_dnn...")
    from hobot_dnn import pyeasy_dnn as dnn

    models = dnn.load(MODEL_PATH_V13)
    model = models[0]

    # Warmup
    for _ in range(3):
        model.forward(test_input)

    # Benchmark
    times_dnn = []
    for _ in range(20):
        start = time.perf_counter()
        model.forward(test_input)
        times_dnn.append((time.perf_counter() - start) * 1000)

    avg_dnn = np.mean(times_dnn)
    std_dnn = np.std(times_dnn)
    results["hobot_dnn"] = {
        "model": "yolov13n",
        "avg_ms": round(float(avg_dnn), 2),
        "std_ms": round(float(std_dnn), 2),
        "min_ms": round(float(np.min(times_dnn)), 2),
        "max_ms": round(float(np.max(times_dnn)), 2),
    }
    print(f"    hobot_dnn (yolov13n): avg={avg_dnn:.2f}ms, std={std_dnn:.2f}ms")

    # Test bpu_infer_lib
    try:
        print("  Testing bpu_infer_lib...")
        from bpu_infer_lib import Infer

        infer = Infer(False)  # Constructor requires bool arg (debug flag)
        infer.load_model(MODEL_PATH_V13)

        # Warmup
        for _ in range(3):
            infer.read_numpy_arr_nv12(test_input)
            infer.forward()
            _ = infer.get_infer_res_np_float32()

        # Benchmark
        times_bpu = []
        for _ in range(20):
            start = time.perf_counter()
            infer.read_numpy_arr_nv12(test_input)
            infer.forward()
            _ = infer.get_infer_res_np_float32()
            times_bpu.append((time.perf_counter() - start) * 1000)

        avg_bpu = np.mean(times_bpu)
        std_bpu = np.std(times_bpu)
        results["bpu_infer_lib"] = {
            "model": "yolov13n",
            "avg_ms": round(float(avg_bpu), 2),
            "std_ms": round(float(std_bpu), 2),
            "min_ms": round(float(np.min(times_bpu)), 2),
            "max_ms": round(float(np.max(times_bpu)), 2),
        }
        print(f"    bpu_infer_lib (yolov13n): avg={avg_bpu:.2f}ms, std={std_bpu:.2f}ms")

        # Check output format
        infer.read_numpy_arr_nv12(test_input)
        infer.forward()
        out = infer.get_infer_res_np_float32()
        print(f"    Output count: {len(out)}")
        for i, o in enumerate(out):
            print(f"      output[{i}]: shape={o.shape}, dtype={o.dtype}")

        # Check quantization info
        try:
            scale = infer.get_output_scale()
            shift = infer.get_output_shift()
            results["bpu_infer_lib"]["has_scale"] = True
            print(f"    Scale: {scale[:3]}...")
            print(f"    Shift: {shift[:3]}...")
        except Exception as e:
            results["bpu_infer_lib"]["has_scale"] = False
            print(f"    Scale/Shift: not available ({e})")

    except ImportError as e:
        results["bpu_infer_lib"] = {"status": "NOT_AVAILABLE", "error": str(e)}
        print(f"    bpu_infer_lib: NOT AVAILABLE - {e}")
    except Exception as e:
        results["bpu_infer_lib"] = {"status": "ERROR", "error": str(e)}
        print(f"    bpu_infer_lib: ERROR - {e}")

    # Also benchmark hobot_dnn with yolo11n and yolov8n
    for model_name, model_path in [
        ("yolo11n", MODEL_PATH_11N),
        ("yolov8n", MODEL_PATH_V8),
    ]:
        try:
            print(f"  Testing hobot_dnn with {model_name}...")
            m = dnn.load(model_path)
            model = m[0]
            # Warmup
            for _ in range(3):
                model.forward(test_input)
            # Benchmark
            times = []
            for _ in range(20):
                start = time.perf_counter()
                model.forward(test_input)
                times.append((time.perf_counter() - start) * 1000)
            avg = np.mean(times)
            std = np.std(times)
            results[f"hobot_dnn_{model_name}"] = {
                "model": model_name,
                "avg_ms": round(float(avg), 2),
                "std_ms": round(float(std), 2),
                "min_ms": round(float(np.min(times)), 2),
                "max_ms": round(float(np.max(times)), 2),
            }
            print(f"    hobot_dnn ({model_name}): avg={avg:.2f}ms, std={std:.2f}ms")
        except Exception as e:
            results[f"hobot_dnn_{model_name}"] = {"status": "ERROR", "error": str(e)}
            print(f"    hobot_dnn ({model_name}): ERROR - {e}")

    return results


def test_detection_baseline():
    """Phase 0-6: Detection rate baseline at various thresholds."""
    print("\n=== Phase 0-6: Detection Rate Baseline ===")

    # We need a real image for meaningful detection baseline
    # Try to use bus.jpg from rdk_model_zoo if available
    import os

    test_images = [
        "/app/smart-pet-camera/recordings/iframe_20251227_175707_044_frame000599.jpg",
        "/app/github/rdk_model_zoo/demos/Vision/ultralytics_YOLO/source/reference_yamls/bus.jpg",
        "/opt/tros/humble/lib/dnn_node_sample/config/test.jpg",
    ]

    test_img_path = None
    for p in test_images:
        if os.path.exists(p):
            test_img_path = p
            break

    if test_img_path is None:
        print("  No test image found. Skipping detection baseline.")
        return {"status": "SKIPPED", "reason": "no test image"}

    import cv2

    sys.path.insert(0, "/app/smart-pet-camera/src/common/src")
    from detection.yolo_detector import YoloDetector

    img = cv2.imread(test_img_path)
    print(f"  Test image: {test_img_path} ({img.shape[1]}x{img.shape[0]})")

    with open(test_img_path, "rb") as f:
        jpeg_data = f.read()

    results = {}
    thresholds = [0.25, 0.3, 0.4, 0.5, 0.6]

    for model_name, model_path in [
        ("yolov13n", MODEL_PATH_V13),
        ("yolo11n", MODEL_PATH_11N),
        ("yolov8n", MODEL_PATH_V8),
    ]:
        print(f"\n  Model: {model_name}")
        model_results = {}

        for thresh in thresholds:
            try:
                detector = YoloDetector(
                    model_path=model_path,
                    score_threshold=thresh,
                    nms_threshold=0.7,
                    auto_download=False,
                    clahe_enabled=False,
                )

                # Run detection
                detections = detector.detect(jpeg_data)
                timing = detector.get_last_timing()

                classes = {}
                for d in detections:
                    cls = d.class_name.value
                    if cls not in classes:
                        classes[cls] = 0
                    classes[cls] += 1

                model_results[str(thresh)] = {
                    "count": len(detections),
                    "classes": classes,
                    "total_ms": round(timing["total"] * 1000, 1),
                    "inference_ms": round(timing["inference"] * 1000, 1),
                    "preprocessing_ms": round(timing["preprocessing"] * 1000, 1),
                    "postprocessing_ms": round(timing["postprocessing"] * 1000, 1),
                }

                print(
                    f"    thresh={thresh}: {len(detections)} detections, "
                    f"infer={timing['inference']*1000:.1f}ms, "
                    f"total={timing['total']*1000:.1f}ms, "
                    f"classes={classes}"
                )
            except Exception as e:
                model_results[str(thresh)] = {"error": str(e)}
                print(f"    thresh={thresh}: ERROR - {e}")

        results[model_name] = model_results

    return results


def main():
    print("=" * 60)
    print("Phase 0: BPU Profiling & Baseline Measurement")
    print("=" * 60)

    all_results = {}

    # Phase 0-4
    all_results["core_verification"] = test_core_ids()

    # Phase 0-5
    all_results["api_comparison"] = test_bpu_infer_lib()

    # Phase 0-6
    all_results["detection_baseline"] = test_detection_baseline()

    # Write results
    output_path = "/app/smart-pet-camera/scripts/phase0_results.json"
    with open(output_path, "w") as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)

    print(f"\n\nResults saved to: {output_path}")
    print("\n=== Summary ===")
    print(json.dumps(all_results, indent=2, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
