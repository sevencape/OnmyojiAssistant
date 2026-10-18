"""模板匹配。

核心只有一件事：在一帧画面里找出某个素材图出现的位置和相似度。
调参时优先改 config.yaml 里的 threshold / region，而不是改这里的算法。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .config import TemplateSpec


@dataclass
class Match:
    spec: TemplateSpec
    score: float
    # 窗口内相对坐标（即裁剪图里的坐标）
    center: tuple[int, int]
    top_left: tuple[int, int]
    size: tuple[int, int]

    def center_in(self, offset: tuple[int, int]) -> tuple[int, int]:
        return (self.center[0] + offset[0], self.center[1] + offset[1])


class TemplateLibrary:
    """启动时把素材一次性读进内存，避免每帧重复读磁盘。"""

    def __init__(self, assets_dir: Path, warn: bool = True) -> None:
        self.assets_dir = Path(assets_dir)
        self._cache: dict[tuple[str, bool], np.ndarray] = {}
        self.missing: list[str] = []
        if warn:
            self._scan_missing()

    def _scan_missing(self) -> None:
        if not self.assets_dir.is_dir():
            return
        found = {p.name for p in self.assets_dir.glob("*.png")}
        self._present = found

    @property
    def present(self) -> set[str]:
        if not hasattr(self, "_present"):
            self._scan_missing()
        return getattr(self, "_present", set())

    def check(self, names: list[str]) -> list[str]:
        """返回缺失的素材文件名列表。"""
        return [n for n in names if n not in self.present]

    def load(self, name: str, grayscale: bool) -> np.ndarray | None:
        key = (name, grayscale)
        if key in self._cache:
            return self._cache[key]

        path = self.assets_dir / name
        if not path.is_file():
            return None

        # np.fromfile + imdecode：路径含中文时 cv2.imread 会静默返回 None
        buf = np.fromfile(str(path), dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE if grayscale else cv2.IMREAD_COLOR)
        if img is None:
            return None

        self._cache[key] = img
        return img


def _resolve(spec: TemplateSpec, default_threshold: float,
             default_gray: bool) -> tuple[float, bool]:
    threshold = spec.threshold if spec.threshold is not None else default_threshold
    gray = spec.grayscale if spec.grayscale is not None else default_gray
    return threshold, gray


def _scale_template(tpl: np.ndarray, scale: float) -> np.ndarray:
    if abs(scale - 1.0) < 1e-3:
        return tpl
    h, w = tpl.shape[:2]
    return cv2.resize(tpl, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                      interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)


def match_template(
    frame: np.ndarray,
    spec: TemplateSpec,
    library: TemplateLibrary,
    default_threshold: float = 0.86,
    default_gray: bool = True,
    search_margin: int = 0,
) -> Match | None:
    """在 frame 里找 spec 指定的模板，返回最佳匹配；低于阈值返回 None。"""
    threshold, gray = _resolve(spec, default_threshold, default_gray)

    tpl = library.load(spec.name, gray)
    if tpl is None:
        return None
    tpl = _scale_template(tpl, spec.scale)

    # 搜索区域：region 优先，其次全局（可按 search_margin 内缩）
    if spec.region is not None:
        rx, ry, rw, rh = spec.region
        x0, y0 = max(0, rx), max(0, ry)
        x1 = min(frame.shape[1], rx + rw)
        y1 = min(frame.shape[0], ry + rh)
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            return None
        roi = frame[y0:y1, x0:x1]
        off_x, off_y = x0, y0
    else:
        m = max(0, search_margin)
        x0 = min(m, frame.shape[1])
        y0 = min(m, frame.shape[0])
        roi = frame[y0:frame.shape[0] - m, x0:frame.shape[1] - m]
        off_x, off_y = x0, y0
        if roi.size == 0:
            return None

    if gray and roi.ndim == 3:
        roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    if not gray and roi.ndim == 2:
        roi = cv2.cvtColor(roi, cv2.COLOR_GRAY2BGR)

    th, tw = tpl.shape[:2]
    if th > roi.shape[0] or tw > roi.shape[1]:
        return None  # 模板比搜索区域还大，matchTemplate 会直接抛错

    res = cv2.matchTemplate(roi, tpl, cv2.TM_CCOEFF_NORMED)
    _, score, _, loc = cv2.minMaxLoc(res)
    if score < threshold:
        return None

    cx = off_x + loc[0] + tw // 2
    cy = off_y + loc[1] + th // 2
    return Match(
        spec=spec,
        score=float(score),
        center=(cx, cy),
        top_left=(off_x + loc[0], off_y + loc[1]),
        size=(tw, th),
    )


def match_all(
    frame: np.ndarray,
    specs: list[TemplateSpec],
    library: TemplateLibrary,
    default_threshold: float = 0.86,
    default_gray: bool = True,
    search_margin: int = 0,
) -> list[Match]:
    """逐个匹配，返回所有命中的结果（按分数从高到低）。"""
    hits: list[Match] = []
    for spec in specs:
        m = match_template(frame, spec, library, default_threshold, default_gray, search_margin)
        if m is not None:
            hits.append(m)
    hits.sort(key=lambda m: m.score, reverse=True)
    return hits


def annotate(frame: np.ndarray, hits: list[Match]) -> np.ndarray:
    """把命中位置画在帧上，用于调试截图。

    注意：cv2.putText 不支持中文，直接传中文会渲染成 '???'，
    所以这里只画 ASCII（素材文件名本来就是英文）。
    """
    vis = frame.copy()
    for m in hits:
        x, y = m.top_left
        w, h = m.size
        cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 255, 0), 2)
        label = f"{m.spec.name} {m.score:.2f}"
        label = label.encode("ascii", "replace").decode("ascii")
        cv2.putText(vis, label, (x, max(12, y - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)
    return vis
