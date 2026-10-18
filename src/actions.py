"""动作执行：点击、按键、等待、急停。

关于输入方式的风险提示见 README。这里统一走 actions 层，
以后想从 pydirectinput 换成硬件级输入，只改这个文件即可。
"""

from __future__ import annotations

import logging
import random
import time

import pydirectinput

from .config import ActionSpec
from .vision import Match

log = logging.getLogger(__name__)

pydirectinput.FAILSAFE = False  # 关掉"鼠标甩到左上角就抛异常"，脚本会自己控制急停
pydirectinput.PAUSE = 0.0       # 我们自己控制节奏，不要它的固定延迟


def rand_delay(rng: tuple[float, float]) -> None:
    lo, hi = rng
    if hi <= 0:
        return
    lo = max(0.0, lo)
    time.sleep(random.uniform(lo, max(lo, hi)))


class StopRequested(Exception):
    """需要停止脚本时抛出，由主循环捕获并收尾。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ActionEngine:
    def __init__(self, dry_run: bool = False,
                 click_delay: tuple[float, float] = (0.18, 0.45),
                 action_gap: tuple[float, float] = (0.12, 0.30)) -> None:
        self.dry_run = dry_run
        self.click_delay = click_delay
        self.action_gap = action_gap
        self.action_count = 0

    # ---------- 基础操作 ----------

    def click(self, x: int, y: int) -> None:
        if self.dry_run:
            log.info("[dry-run] 点击 (%d, %d)", x, y)
            self.action_count += 1
            return
        pydirectinput.moveTo(int(x), int(y))
        time.sleep(random.uniform(0.03, 0.09))  # 移动和按下之间留一点间隔，更像真人
        pydirectinput.mouseDown()
        time.sleep(random.uniform(0.04, 0.11))
        pydirectinput.mouseUp()
        self.action_count += 1
        log.info("点击 (%d, %d)", x, y)
        rand_delay(self.click_delay)

    def press(self, key: str, presses: int = 1) -> None:
        if self.dry_run:
            log.info("[dry-run] 按键 %s x%d", key, presses)
            self.action_count += 1
            return
        for _ in range(max(1, presses)):
            pydirectinput.press(key)
            time.sleep(random.uniform(0.04, 0.10))
        self.action_count += 1
        log.info("按键 %s x%d", key, presses)

    # ---------- 动作分发 ----------

    def run(self, spec: ActionSpec, hit: Match | None,
            window_origin: tuple[int, int], scale: tuple[float, float]) -> None:
        """执行单个动作。

        hit: 触发本状态的匹配结果，`click_hit` 用它作为点击目标。
        window_origin/scale: 把"帧内坐标"换算成"屏幕坐标"。
        """
        kind = spec.type

        if kind == "click_hit":
            if hit is None:
                log.warning("click_hit 被调用但没有匹配结果，跳过")
                return
            self._click_frame_point(hit.center, window_origin, scale)

        elif kind == "click_template":
            # 在当前帧里重新定位指定模板再点（避免点到"刚才那个位置"）
            if hit is not None and spec.template and hit.spec.name == spec.template:
                self._click_frame_point(hit.center, window_origin, scale)
            else:
                log.warning("click_template %s 未能在当前帧定位，跳过", spec.template)

        elif kind == "click_at":
            if spec.x is None or spec.y is None:
                log.warning("click_at 缺少 x/y，跳过")
                return
            x, y = self._to_screen((int(spec.x), int(spec.y)), window_origin, scale)
            self.click(x, y)

        elif kind == "click":
            if hit is None:
                log.warning("click 动作缺少可用的匹配结果，跳过")
                return
            self._click_frame_point(hit.center, window_origin, scale)

        elif kind == "key":
            if not spec.key:
                log.warning("key 动作缺少 key，跳过")
                return
            self.press(spec.key, int(spec.params.get("presses", 1)))

        elif kind == "wait":
            seconds = spec.seconds if spec.seconds is not None else 0.5
            time.sleep(max(0.0, seconds))

        elif kind == "stop":
            raise StopRequested(spec.reason or "配置要求停止")

        else:
            log.warning("未知动作类型: %s", kind)

    # ---------- 坐标换算 ----------

    @staticmethod
    def _to_screen(point: tuple[int, int], origin: tuple[int, int],
                   scale: tuple[float, float]) -> tuple[int, int]:
        sx, sy = scale
        x = origin[0] + point[0] / (sx if sx else 1.0)
        y = origin[1] + point[1] / (sy if sy else 1.0)
        return (int(round(x)), int(round(y)))

    def _click_frame_point(self, point: tuple[int, int], origin: tuple[int, int],
                           scale: tuple[float, float]) -> None:
        x, y = self._to_screen(point, origin, scale)
        self.click(x, y)

    def gap(self) -> None:
        """同一状态内两个动作之间的短延迟。"""
        rand_delay(self.action_gap)
