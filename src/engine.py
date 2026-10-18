"""主循环：截图 → 判断状态 → 执行动作。

设计上是"优先级状态机"而不是"线性流程"：
每一轮都从最高优先级往下问一遍，谁先命中就执行谁。
这样对抗弹窗、动画延迟、时序漂移的能力比写死顺序强得多。
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from .actions import ActionEngine, StopRequested
from .capture import ScreenCapture
from .config import Config, StateSpec
from .vision import Match, TemplateLibrary, annotate, match_all
from .window import WindowInfo, activate_window, find_window

log = logging.getLogger(__name__)


class StateTracker:
    """记录每个状态的命中连续帧数与冷却剩余时间。"""

    def __init__(self, config: Config) -> None:
        self._streak: dict[str, int] = {}
        self._cooldown_until: dict[str, float] = {}
        self._last_seen: dict[str, float] = {}
        self.config = config

    def observe(self, state_name: str, now: float) -> bool:
        """记录一次命中，返回是否达到 stable_frames（可以执行）。"""
        self._streak[state_name] = self._streak.get(state_name, 0) + 1
        self._last_seen[state_name] = now
        return self._streak[state_name] >= self.config.stable_frames

    def reset(self, state_name: str) -> None:
        self._streak[state_name] = 0

    def expired(self, state_name: str, now: float) -> bool:
        last = self._last_seen.get(state_name)
        return last is not None and (now - last) > self.config.state_timeout

    def set_cooldown(self, state_name: str, seconds: float, now: float) -> None:
        self._cooldown_until[state_name] = now + max(0.0, seconds)

    def in_cooldown(self, state_name: str, now: float) -> bool:
        return now < self._cooldown_until.get(state_name, 0.0)


class Engine:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.library = TemplateLibrary(config.assets_dir)
        self.capture = ScreenCapture()
        self.actions = ActionEngine(
            dry_run=config.dry_run,
            click_delay=config.click_delay,
            action_gap=config.action_gap,
        )
        self.tracker = StateTracker(config)
        self.window: WindowInfo | None = None
        self.debug_dir = config.root / config.debug_dir
        self.debug_dir.mkdir(parents=True, exist_ok=True)

        self.started_at = time.monotonic()
        self.error_streak = 0
        self.stop_reason: str | None = None
        self._size_warned = False

    # ---------- 启动检查 ----------

    def preflight(self) -> None:
        missing = self.library.check(self.config.referenced_templates())
        if missing:
            log.warning("以下素材缺失（相关状态不会被触发）：")
            for name in missing:
                log.warning("  - %s", name)
            log.warning("素材采集规范见 README.md 的「素材采集」章节")
        if not self.config.states:
            raise SystemExit("配置中没有定义任何状态，脚本无事可做")

    def locate_window(self) -> bool:
        win = find_window(self.config.title_keywords)
        if win is None:
            self.window = None
            return False
        if self.window is None or win.hwnd != self.window.hwnd:
            log.info("已锁定游戏窗口: %r (%dx%d @ %d,%d)",
                     win.title, win.width, win.height, win.left, win.top)
        self.window = win

        expected = self.config.expected_size
        if expected and (win.width, win.height) != expected and not self._size_warned:
            log.warning("窗口尺寸 %dx%d 与配置的 %dx%d 不一致，素材和坐标都可能失效",
                        win.width, win.height, expected[0], expected[1])
            self._size_warned = True
        return True

    # ---------- 单轮循环 ----------

    def grab(self) -> tuple[np.ndarray, tuple[int, int], tuple[float, float]]:
        assert self.window is not None
        if self.config.activate_before_capture:
            activate_window(self.window.hwnd)
            time.sleep(0.02)  # 给窗口一点时间完成置前绘制
        frame, scale = self.capture.grab_window(self.window.rect)
        return frame, (self.window.left, self.window.top), scale

    def evaluate(self, frame: np.ndarray) -> tuple[StateSpec, Match | None] | None:
        """按优先级找出当前应当执行的状态。"""
        now = time.monotonic()

        for state in self.config.states:
            if self.tracker.expired(state.name, now):
                self.tracker.reset(state.name)

            # when.all：所有模板都必须命中，取分数最高的作为 hit
            if state.when_all:
                hits = match_all(frame, state.when_all, self.library,
                                 self.config.default_threshold, self.config.use_grayscale,
                                 self.config.search_margin)
                if len(hits) < len(state.when_all):
                    self.tracker.reset(state.name)
                    continue
                hit = hits[0]
            else:
                hits = match_all(frame, state.when_any, self.library,
                                 self.config.default_threshold, self.config.use_grayscale,
                                 self.config.search_margin)
                if not hits:
                    self.tracker.reset(state.name)
                    continue
                hit = hits[0]

            if not self.tracker.observe(state.name, now):
                return None  # 还没连续稳定足够帧数，本轮先不动

            if self.tracker.in_cooldown(state.name, now):
                return None

            return state, hit

        return None

    def run_state(self, state: StateSpec, hit: Match | None,
                  origin: tuple[int, int], scale: tuple[float, float]) -> None:
        cooldown = state.cooldown if state.cooldown is not None else self.config.state_cooldown
        self.tracker.set_cooldown(state.name, cooldown, time.monotonic())
        log.info("触发状态: %s (命中 %s %.3f)", state.name,
                 hit.spec.name if hit else "-", hit.score if hit else 0.0)

        for act in state.actions:
            self.actions.run(act, hit, origin, scale)
            self.actions.gap()

    # ---------- 调试截图 ----------

    def dump(self, frame: np.ndarray, tag: str, hits: list[Match] | None = None) -> None:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        path = self.debug_dir / f"{stamp}_{tag}.png"
        img = annotate(frame, hits) if hits else frame
        ok, buf = cv2.imencode(".png", img)
        if ok:
            buf.tofile(str(path))
            log.info("已保存调试截图: %s", path)

    # ---------- 主循环 ----------

    def run(self) -> None:
        self.preflight()
        log.info("脚本启动 | 状态数 %d | dry_run=%s | 按 Ctrl+C 或 Esc 停止",
                 len(self.config.states), self.config.dry_run)

        limit_seconds = self.config.max_minutes * 60 if self.config.max_minutes > 0 else None
        last_frame: np.ndarray | None = None

        while True:
            loop_start = time.monotonic()

            # 时长上限
            if limit_seconds and (loop_start - self.started_at) >= limit_seconds:
                self.stop_reason = f"达到运行时长上限 {self.config.max_minutes} 分钟"
                break

            # 动作次数上限
            if self.config.max_actions and self.actions.action_count >= self.config.max_actions:
                self.stop_reason = f"达到动作次数上限 {self.config.max_actions}"
                break

            try:
                if not self.locate_window():
                    self.error_streak += 1
                    if self.error_streak == 1:
                        log.warning("未找到游戏窗口（关键字 %s），等待中……",
                                    self.config.title_keywords)
                    if self.error_streak >= self.config.error_streak_limit:
                        self.stop_reason = "长时间找不到游戏窗口"
                        break
                    time.sleep(1.0)
                    continue

                frame, origin, scale = self.grab()
                last_frame = frame
                self.error_streak = 0

                decided = self.evaluate(frame)
                if decided is not None:
                    state, hit = decided
                    if self.config.save_frames_on_match:
                        self.dump(frame, f"match_{state.name}", [hit] if hit else None)
                    self.run_state(state, hit, origin, scale)
                else:
                    # 没有任何状态命中：可能正在战斗动画中，属于正常情况
                    pass

            except StopRequested as exc:
                self.stop_reason = exc.reason
                break
            except KeyboardInterrupt:
                self.stop_reason = "用户中断 (Ctrl+C)"
                break
            except Exception as exc:  # 单帧异常不应该让整个脚本崩掉
                self.error_streak += 1
                log.exception("循环异常 (%d/%d): %s",
                              self.error_streak, self.config.error_streak_limit, exc)
                if last_frame is not None and self.config.save_frames_on_error:
                    self.dump(last_frame, "error")
                if self.error_streak >= self.config.error_streak_limit:
                    self.stop_reason = f"连续异常超过上限: {exc}"
                    break
                time.sleep(0.5)

            elapsed = time.monotonic() - loop_start
            sleep_for = self.config.loop_interval - elapsed
            if sleep_for > 0:
                time.sleep(sleep_for)

        self.shutdown()

    def shutdown(self) -> None:
        self.capture.close()
        ran = time.monotonic() - self.started_at
        log.info("=" * 52)
        log.info("脚本结束 | 原因: %s", self.stop_reason or "未知")
        log.info("运行时长: %.1f 秒 | 累计动作: %d 次", ran, self.actions.action_count)
        log.info("调试截图目录: %s", self.debug_dir)
        log.info("=" * 52)
