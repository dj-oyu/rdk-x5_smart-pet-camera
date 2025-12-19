from __future__ import annotations

import sys
from pathlib import Path

# テストからモジュールを直接importできるようにパスを追加
PROJECT_ROOT = Path(__file__).resolve().parents[1]
for relative in ("src", "src/monitor", "src/mock", "src/common/src", "src/capture"):
    sys.path.insert(0, str(PROJECT_ROOT / relative))
