"""屏幕截图：从整块虚拟屏幕抓帧，再按窗口矩形裁剪。

为什么不全屏抓一次就完事：游戏窗口可能在副屏、可能被别的窗口遮住一部分，
按窗口矩形裁剪能保证拿到的是"窗口那一块画面"，坐标换算也统一在 window 上。
"""

from __future__ import annotations

import mss
import numpy as np

try:  # OpenCV 只在这里用一次（BGRA→BGR），没装也要能给出清晰报错
    import cv2
except ImportError as exc:  # pragma: no cover
    raise SystemExit("缺少 opencv-python，请先执行: pip install -r requirements.txt") from exc


class ScreenCapture:
    """保持一个 mss 实例复用，反复创建会明显变慢。"""

    def __init__(self) -> None:
        self._sct = mss.mss()
        self.monitors = list(self._sct.monitors)

    def close(self) -> None:
        try:
            self._sct.close()
        except Exception:
            pass

    def __enter__(self) -> "ScreenCapture":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def monitor_for_point(self, x: int, y: int) -> dict:
        """找出包含指定屏幕坐标的显示器。monitors[0] 是所有屏幕的并集，跳过。"""
        for mon in self.monitors[1:]:
            if (
                mon["left"] <= x < mon["left"] + mon["width"]
                and mon["top"] <= y < mon["top"] + mon["height"]
            ):
                return mon
        return self.monitors[1] if len(self.monitors) > 1 else self.monitors[0]

    def grab_window(self, rect: tuple[int, int, int, int]) -> tuple[np.ndarray, tuple[int, int]]:
        """抓取窗口区域，返回 (BGR 图像, 缩放比例 (sx, sy))。

        缩放比例用于把"图像内坐标"换回"屏幕坐标"：当窗口有一部分在屏幕外时，
        抓到的图会被裁小，比例就不等于 1。
        """
        left, top, width, height = rect
        mon = self.monitor_for_point(left + width // 2, top + height // 2)

        # 与显示器可见区域求交集，裁掉屏幕外的部分
        x0 = max(left, mon["left"])
        y0 = max(top, mon["top"])
        x1 = min(left + width, mon["left"] + mon["width"])
        y1 = min(top + height, mon["top"] + mon["height"])

        if x1 - x0 <= 0 or y1 - y0 <= 0:
            raise RuntimeError("窗口完全在屏幕可视区域之外，无法截图")

        region = {"left": x0, "top": y0, "width": x1 - x0, "height": y1 - y0}
        raw = np.asarray(self._sct.grab(region))
        bgr = cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)

        sx = bgr.shape[1] / float(width)
        sy = bgr.shape[0] / float(height)
        return bgr, (sx, sy)
