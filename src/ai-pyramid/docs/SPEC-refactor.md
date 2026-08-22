# AI Pyramid Refactoring Notes (Archived)

この文書にあった初期リファクタリング案は、2026-08-23時点の実装を反映しておらず、
重複作業を招くためアーカイブした。実施履歴、互換性境界、検証ゲート、残作業は
[`refactoring-closed-loop-plan.md`](refactoring-closed-loop-plan.md) を正とする。

すでに完了した主な項目:

- `main.rs`から起動構成を`bootstrap/`へ抽出
- `server/mod.rs`をroute domain別moduleへ分割し、診断用assetも分離
- training API、local detector、VLM、DB command dispatchを責務別moduleへ分割
- album DBの統計query統合と、反復実行される静的SQLへの`prepare_cached`導入
- EventDetailのmetadata editorとdetection listの分離
- characterization tests、aarch64 CI build、隔離環境および実機でのsmoke test
- training frameのraw NV12 / lossless WebP両対応

未完または実測後に判断する項目:

- Rust line/branch coverageをCIでbaseline化し、低下を検出する
- `ingest_with_detections`など複数SQL更新のtransaction化とfailure-path test
- VLM、daily summary、MCP、WebP training workflowの継続的な実データsmoke test
- UIの残る大規模componentを、外部挙動を変えず責務単位に分割する
- 動的WHERE句の`Vec<Box<dyn ToSql>>`除去は、代表queryの計測と
  `EXPLAIN QUERY PLAN`で改善が確認できた場合だけ行う

`Cow<str>`、Preact Signals、clone削減など、効果未計測のmicro optimizationは
現在もnon-goalである。
