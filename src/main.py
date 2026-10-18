"""命令行入口。

用法：
    python -m src.main --list-windows          # 第一步：确认游戏窗口标题
    python -m src.main --check-assets          # 第二步：检查素材是否齐了
    python -m src.main --dump-frame            # 第三步：抓一张窗口截图看看对不对
    python -m src.main --dry-run               # 第四步：只识别不点击，验证阈值
    python -m src.main                         # 正式运行
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

# 允许用 `python src/main.py` 直接跑（否则相对导入会失败）
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "src"

from .capture import ScreenCapture  # noqa: E402
from .config import load_config  # noqa: E402
from .engine import Engine  # noqa: E402
from .vision import TemplateLibrary  # noqa: E402
from .window import enable_dpi_awareness, find_window, list_visible_windows  # noqa: E402


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="onmyoji-bot",
        description="阴阳师 PC 客户端图像识别自动化脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("-c", "--config", default="config.yaml", help="配置文件路径（默认 config.yaml）")
    p.add_argument("--dry-run", action="store_true", help="只识别不点击，用于验证素材和阈值")
    p.add_argument("--list-windows", action="store_true", help="列出可见窗口标题后退出")
    p.add_argument("--check-assets", action="store_true", help="检查素材缺失情况后退出")
    p.add_argument("--dump-frame", action="store_true", help="抓取一张游戏窗口截图保存到 debug/ 后退出")
    p.add_argument("-v", "--verbose", action="store_true", help="输出调试日志")
    return p


def cmd_list_windows() -> int:
    print("当前可见窗口（找游戏窗口标题，填进 config.yaml 的 window.title_keywords）：")
    for hwnd, title in list_visible_windows():
        print(f"  hwnd={hwnd:<10} {title}")
    return 0


def cmd_check_assets(config) -> int:
    lib = TemplateLibrary(config.assets_dir)
    print(f"素材目录: {config.assets_dir}")
    if not config.assets_dir.is_dir():
        print("  [错误] 目录不存在，请先创建并放入 PNG 素材")
        return 1
    referenced = config.referenced_templates()
    missing = lib.check(referenced)
    for name in referenced:
        mark = "OK  " if name not in missing else "缺失"
        print(f"  [{mark}] {name}")
    extra = sorted(lib.present - set(referenced))
    for name in extra:
        print(f"  [多余] {name}  （配置里没有引用）")
    print(f"\n共引用 {len(referenced)} 个素材，缺失 {len(missing)} 个")
    return 1 if missing else 0


def cmd_dump_frame(config) -> int:
    win = find_window(config.title_keywords)
    if win is None:
        print(f"[错误] 未找到窗口，关键字: {config.title_keywords}")
        print("       先跑 --list-windows 确认标题")
        return 1
    print(f"找到窗口: {win.title!r} 面积 {win.width}x{win.height} @ ({win.left}, {win.top})")
    with ScreenCapture() as cap:
        frame, scale = cap.grab_window(win.rect)
    out_dir = config.root / config.debug_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "dump_frame.png"
    import cv2
    ok, buf = cv2.imencode(".png", frame)
    if not ok:
        print("[错误] 编码失败")
        return 1
    buf.tofile(str(out))
    print(f"截图尺寸: {frame.shape[1]}x{frame.shape[0]}  缩放比例: {scale}")
    print(f"已保存: {out}")
    print("用这张图对照实物检查：窗口是否被遮挡、画面是否完整、坐标是否匹配")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    setup_logging(args.verbose)
    enable_dpi_awareness()

    if args.list_windows:
        return cmd_list_windows()

    config = load_config(args.config)
    if args.dry_run:
        config.dry_run = True

    if args.check_assets:
        return cmd_check_assets(config)
    if args.dump_frame:
        return cmd_dump_frame(config)

    engine = Engine(config)
    try:
        engine.run()
    except SystemExit:
        raise
    except Exception as exc:
        logging.getLogger(__name__).exception("脚本异常退出: %s", exc)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
