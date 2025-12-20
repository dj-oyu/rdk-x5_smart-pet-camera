#!/bin/bash
#
# YOLO検出ベンチマークスクリプト
#
# 使用例:
#   ./run_yolo_benchmark.sh              # デフォルト画像で全モデルテスト
#   ./run_yolo_benchmark.sh --model v11n # YOLO11nのみテスト
#   ./run_yolo_benchmark.sh --image /path/to/image.jpg --model v8n # カスタム画像でv8nをテスト
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "YOLO Detection Benchmark"
echo "=========================================="
echo "Project Root: $PROJECT_ROOT"
echo ""

# Pythonパスの設定
export PYTHONPATH="$PROJECT_ROOT/src/common/src:$PYTHONPATH"

# デフォルト設定
DEFAULT_TEST_IMAGE="/app/github/rdk_model_zoo/demos/resource/datasets/COCO2017/assets/bus.jpg"
LOG_DIR="$PROJECT_ROOT/logs/yolo_tests"
MODELS_DIR="/tmp/yolo_models"

# 引数解析
ALL_MODELS=false
MODEL=""
IMAGE=""
IMAGE_DIR=""
MAX_IMAGES=10

while [[ $# -gt 0 ]]; do
    case $1 in
        --all-models)
            ALL_MODELS=true
            shift
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        --image)
            IMAGE="$2"
            shift 2
            ;;
        --image-dir)
            IMAGE_DIR="$2"
            shift 2
            ;;
        --max-images)
            MAX_IMAGES="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --all-models          Test all YOLO models (v8n, v11n, v13n)"
            echo "  --model MODEL         Test specific model (v8n, v11n, v13n)"
            echo "  --image PATH          Test with specific image"
            echo "  --image-dir PATH      Test with all images in directory"
            echo "  --max-images N        Maximum number of images to test (default: 10)"
            echo "  -h, --help            Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Test all models with default image"
            echo "  $0 --model v11n                       # Test YOLO11n only"
            echo "  $0 --all-models --image /path/to/img  # Test all models with custom image"
            echo "  $0 --image-dir /path/to/imgs          # Test with multiple images"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# ログディレクトリ作成
mkdir -p "$LOG_DIR"
mkdir -p "$MODELS_DIR"

# 引数構築
PYTHON_ARGS=""

if [ "$ALL_MODELS" = true ]; then
    PYTHON_ARGS="$PYTHON_ARGS --all-models"
elif [ -n "$MODEL" ]; then
    PYTHON_ARGS="$PYTHON_ARGS --model $MODEL"
else
    # デフォルトで全モデルをテスト
    PYTHON_ARGS="$PYTHON_ARGS --all-models"
fi

if [ -n "$IMAGE" ]; then
    PYTHON_ARGS="$PYTHON_ARGS --image $IMAGE"
elif [ -n "$IMAGE_DIR" ]; then
    PYTHON_ARGS="$PYTHON_ARGS --image-dir $IMAGE_DIR --max-images $MAX_IMAGES"
elif [ -f "$DEFAULT_TEST_IMAGE" ]; then
    echo "Using default test image: $DEFAULT_TEST_IMAGE"
    PYTHON_ARGS="$PYTHON_ARGS --image $DEFAULT_TEST_IMAGE"
fi

PYTHON_ARGS="$PYTHON_ARGS --log-dir $LOG_DIR --models-dir $MODELS_DIR"

echo "Arguments: $PYTHON_ARGS"
echo ""

# テスト実行
cd "$PROJECT_ROOT"
python3 "$SCRIPT_DIR/test_yolo_detection.py" $PYTHON_ARGS

echo ""
echo "=========================================="
echo "Benchmark Complete!"
echo "=========================================="
echo "Logs saved to: $LOG_DIR"
echo ""
echo "View results:"
echo "  cat $LOG_DIR/yolo_*.log"
echo "  cat $LOG_DIR/yolo_*.json | jq '.summary'"
echo ""
