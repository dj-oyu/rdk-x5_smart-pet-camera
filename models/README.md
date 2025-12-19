# 物体検出モデル

このディレクトリには、スマートペットカメラで使用する物体検出モデルを配置します。

## 必要なモデル

システムには以下の3つのクラスを検出できる物体検出モデルが必要です：

- **cat**: 猫
- **food_bowl**: 餌皿
- **water_bowl**: 水飲み場

## 推奨モデル

### 1. TensorFlow Lite（推奨）

組み込みデバイスでの実行に最適化された軽量モデル。

**ファイル名例**: `pet_detector_v1.tflite`

**推奨モデルアーキテクチャ**:
- YOLOv5-nano (TFLite変換)
- MobileNet-SSD
- EfficientDet-Lite0

### 2. ONNX Runtime

クロスプラットフォーム対応。

**ファイル名例**: `pet_detector_v1.onnx`

### 3. PyTorch Mobile

PyTorchで学習したモデルを使用する場合。

**ファイル名例**: `pet_detector_v1.pt`

## モデルの準備

### オプション1: 既存モデルのファインチューニング

COCO datasetで事前学習されたモデルをベースに、ペット検出用にファインチューニング：

1. **データセット準備**
   - 猫、餌皿、水飲み場の画像を収集
   - アノテーション（バウンディングボックス）作成
   - 推奨ツール: LabelImg, CVAT, Roboflow

2. **モデル学習**
   ```bash
   # YOLOv5の例
   git clone https://github.com/ultralytics/yolov5
   cd yolov5
   python train.py --data pet_data.yaml --weights yolov5n.pt --epochs 100
   ```

3. **TFLite変換**
   ```bash
   python export.py --weights best.pt --include tflite
   ```

### オプション2: 事前学習モデルのクラスマッピング

COCOデータセットで学習済みのモデルを使用する場合：
- COCO class 16: cat
- COCO class 41: cup (水飲み場として流用可能)
- COCO class 46: bowl (餌皿として流用可能)

この場合、完全な精度は得られませんが、プロトタイピングには十分です。

### オプション3: カスタムモデルのトレーニング

完全にゼロから学習する場合は、十分な量のアノテーション済みデータが必要です。

## モデルファイルの配置

モデルファイルをこのディレクトリに配置し、`config/config.yaml`でパスを指定してください：

```yaml
object_detection:
  model_path: "/app/smart-pet-camera/models/pet_detector_v1.tflite"
  model_type: "tflite"
```

## ラベルファイル

クラスラベルを定義したテキストファイルも配置してください。

**labels.txt の例**:
```
cat
food_bowl
water_bowl
```

## モデルの評価

モデルの性能を評価するための指標：

- **mAP (mean Average Precision)**: 0.8以上が望ましい
- **推論速度**: 30fps以上（リアルタイム処理のため）
- **モデルサイズ**: 50MB以下（組み込みデバイスのため）

## テストデータ

モデルをテストするためのサンプル画像・動画を用意することを推奨します。

```
models/
├── pet_detector_v1.tflite
├── labels.txt
└── test_data/
    ├── sample_images/
    │   ├── cat_eating.jpg
    │   ├── cat_drinking.jpg
    │   └── empty_scene.jpg
    └── sample_videos/
        └── test_video.mp4
```

## モデルのバージョン管理

- モデルファイルは大きいため、Gitにはコミットしない（.gitignoreに含まれています）
- バージョン管理には以下の方法を検討：
  - Git LFS (Large File Storage)
  - 外部ストレージ（S3, Google Drive等）
  - DVC (Data Version Control)

## トラブルシューティング

### モデルが読み込めない

- ファイルパスが正しいか確認
- モデル形式（tflite/onnx/pt）と`config.yaml`の`model_type`が一致しているか確認
- 必要なライブラリがインストールされているか確認

### 検出精度が低い

- モデルが適切に学習されているか確認
- 信頼度閾値（`confidence_threshold`）を調整
- カメラの配置や照明条件を改善
- より多くのトレーニングデータでファインチューニング

### 推論が遅い

- より軽量なモデルアーキテクチャを選択（YOLOv5-nano等）
- 入力サイズを小さくする（320x320 → 224x224）
- ハードウェアアクセラレータを有効化（GPU/NPU）
- `inference_interval_frames`を調整してフレームスキップ

## 参考リンク

- [YOLOv5 Documentation](https://docs.ultralytics.com/)
- [TensorFlow Lite](https://www.tensorflow.org/lite)
- [ONNX Runtime](https://onnxruntime.ai/)
- [Roboflow](https://roboflow.com/) - データセット管理・モデル学習プラットフォーム

---

**Note**: このディレクトリは現在空です。上記の手順に従ってモデルを準備してください。
