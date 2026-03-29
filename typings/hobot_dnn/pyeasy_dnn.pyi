"""
pyeasy_dnn.pyi - IDE STUB ONLY (D-Robotics RDK-X5 BPU inference API)

Stub for Pylance/Pyright on dev machines without hobot_dnn installed.
NOT installed or loaded at runtime on the board.

Usage in project (yolo_detector.py):
    from hobot_dnn import pyeasy_dnn as dnn
    model = dnn.load(model_path)           # list[Model]
    outputs = model[0].forward(tensor)     # list[np.ndarray]
    h, w = model[0].inputs[0].properties.shape[2:4]
"""

from __future__ import annotations
from typing import Any
import numpy as np

class TensorProperties:
    shape: tuple[int, ...]
    dtype: Any
    def __init__(self) -> None: ...

class TensorInfo:
    properties: TensorProperties
    name: str
    def __init__(self) -> None: ...

class Model:
    inputs: list[TensorInfo]
    outputs: list[TensorInfo]
    def forward(self, input: np.ndarray | list[np.ndarray]) -> list[np.ndarray]: ...

def load(model_file: str) -> list[Model]: ...
