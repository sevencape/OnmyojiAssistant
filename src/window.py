"""游戏窗口的查找、激活与几何信息。

Windows 坐标相关的坑都集中在这里：
- DPI 缩放：必须先声明 DPI 感知，否则 150% 缩放屏上拿到的坐标是缩放后的逻辑值，点击会整体偏移。
- 窗口矩形：用 DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) 拿到不含阴影的真实边界，
  比 GetWindowRect 更准（GetWindowRect 会把不可见的阴影边框算进去）。
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from dataclasses import dataclass

import win32con
import win32gui


DWMWA_EXTENDED_FRAME_BOUNDS = 9


def enable_dpi_awareness() -> None:
    """声明进程 DPI 感知。必须在任何窗口/屏幕坐标 API 之前调用，且只生效一次。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


@dataclass(frozen=True)
class WindowInfo:
    hwnd: int
    title: str
    left: int
    top: int
    width: int
    height: int

    @property
    def rect(self) -> tuple[int, int, int, int]:
        return (self.left, self.top, self.width, self.height)

    @property
    def center(self) -> tuple[int, int]:
        return (self.left + self.width // 2, self.top + self.height // 2)

    def to_screen(self, x: int, y: int) -> tuple[int, int]:
        """窗口内相对坐标 → 屏幕绝对坐标。"""
        return (self.left + x, self.top + y)


def list_visible_windows() -> list[tuple[int, str]]:
    """列出所有有标题的可见顶层窗口，供第一次配置时确认游戏窗口标题用。"""
    result: list[tuple[int, str]] = []

    def _cb(hwnd: int, _param) -> bool:
        if win32gui.IsWindowVisible(hwnd):
            title = win32gui.GetWindowText(hwnd)
            if title.strip():
                result.append((hwnd, title))
        return True

    win32gui.EnumWindows(_cb, None)
    return result


def _extended_frame_bounds(hwnd: int) -> tuple[int, int, int, int] | None:
    rect = wintypes.RECT()
    try:
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            wintypes.HWND(hwnd),
            ctypes.c_uint(DWMWA_EXTENDED_FRAME_BOUNDS),
            ctypes.byref(rect),
            ctypes.sizeof(rect),
        )
    except Exception:
        return None
    if hr != 0:
        return None
    return (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)


def find_window(title_keywords: list[str]) -> WindowInfo | None:
    """按标题关键字查找游戏窗口。找不到返回 None。

    优先精确匹配（标题等于关键字）以避开浏览器标签、聊天窗口之类的同名干扰。
    """
    if not title_keywords:
        return None

    lowered = [k.lower() for k in title_keywords if k.strip()]
    candidates: list[tuple[int, str]] = []
    for hwnd, title in list_visible_windows():
        tl = title.lower()
        if any(k in tl for k in lowered):
            if win32gui.IsIconic(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            candidates.append((hwnd, title))

    if not candidates:
        return None

    def rank(item: tuple[int, str]) -> tuple[int, int]:
        hwnd, title = item
        tl = title.lower()
        exact = 0 if any(tl == k for k in lowered) else 1
        # IsZoomed 为真说明是最大化窗口，优先（通常就是游戏本体）
        maximized = 0 if win32gui.IsZoomed(hwnd) else 1
        return (exact, maximized)

    candidates.sort(key=rank)
    hwnd, title = candidates[0]

    bounds = _extended_frame_bounds(hwnd)
    if bounds is None:
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        bounds = (left, top, right - left, bottom - top)

    left, top, width, height = bounds
    if width <= 0 or height <= 0:
        return None

    return WindowInfo(hwnd=hwnd, title=title, left=left, top=top, width=width, height=height)


def activate_window(hwnd: int) -> None:
    """把窗口置前。最小化时先恢复。失败不抛异常——置前失败只影响后台截图场景。"""
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
