# monitor — Python Web Monitor (Legacy)

## Overview
Flask/Python版のWebモニター。現在はGo web_monitorに主要機能を移行済み。

## Status
- `h264_recorder.py` — Python版レコーダー（レガシー、未使用）
- `h264_track.py` — H.264トラック処理（レガシー）
- Flask UIプロキシとしての役割のみ残存

## Note
新規機能はsrc/streaming_server/ (Go) に実装すること。
