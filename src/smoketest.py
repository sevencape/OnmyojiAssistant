"""开发用冒烟测试：不需要游戏、不需要素材，验证模块能正常导入和逻辑正确。

用法:
    python -m src.smoketest

覆盖点：
1. 所有模块语法与导入正常
2. config.yaml 能被正确解析
3. 状态按 order 排序
4. 模板匹配在合成图上的定位精度
5. 坐标换算（帧内坐标 → 屏幕坐标）正确
6. 文档提到的必须存在的文件都在
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = "src"

from .config import load_config  # noqa: E402
from .vision import Match, TemplateLibrary, annotate, match_all, match_template  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        PASSED.append(name)
        print(f"  [PASS] {name}{'  ' + detail if detail else ''}")
    else:
        FAILED.append(f"{name}  {detail}")
        print(f"  [FAIL] {name}  {detail}")


def test_imports() -> None:
    print("\n[1] 模块导入")
    for mod in ["window", "capture", "vision", "actions", "engine", "config", "main"]:
        try:
            __import__(f"src.{mod}")
            check(f"import src.{mod}", True)
        except Exception as exc:
            check(f"import src.{mod}", False, repr(exc))


def test_config() -> None:
    print("\n[2] 配置解析")
    cfg = load_config(ROOT / "config.yaml")
    check("config.yaml 可解析", True)
    check("states 非空", len(cfg.states) > 0, f"共 {len(cfg.states)} 个状态")
    orders = [s.order for s in cfg.states]
    check("states 已按 order 升序", orders == sorted(orders), str(orders))
    check("title_keywords 已配置", len(cfg.title_keywords) > 0, str(cfg.title_keywords))
    check("loop_interval 合理", 0.02 <= cfg.loop_interval <= 5.0, f"{cfg.loop_interval}s")
    check("click_delay 区间合法", cfg.click_delay[0] <= cfg.click_delay[1], str(cfg.click_delay))
    check("stable_frames >= 1", cfg.stable_frames >= 1, f"{cfg.stable_frames}")
    check("referenced_templates 非空", len(cfg.referenced_templates()) > 0,
          f"{len(cfg.referenced_templates())} 个")

    # 检查没有重复 order（重复会让优先级变得不确定）
    dup = {o for o in orders if orders.count(o) > 1}
    check("没有重复的 order", not dup, f"重复值: {dup}" if dup else "")


def _make_scene() -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """合成一张"假游戏画面"：深色背景 + 一个高对比度按钮。"""
    frame = np.full((720, 1280, 3), 40, dtype=np.uint8)
    frame[300:360, 500:700] = (200, 200, 200)   # 按钮底色
    frame[310:350, 520:680] = (30, 30, 30)      # 按钮内部深色文字区
    frame[330:340, 540:660] = (240, 240, 240)   # 文字笔画
    target = (600, 330)  # 按钮中心
    tpl = frame[305:355, 505:695].copy()
    return frame, tpl, target


def test_matching(tmp_dir: Path) -> None:
    print("\n[3] 模板匹配")
    frame, tpl, target = _make_scene()

    # 把模板写成真实 PNG 文件，走完整加载路径
    import cv2
    assets = tmp_dir / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".png", tpl)
    assert ok
    buf.tofile(str(assets / "fake_button.png"))

    lib = TemplateLibrary(assets)
    check("模板加载成功", lib.load("fake_button.png", False) is not None)
    check("缺失模板返回 None", lib.load("not_exist.png", False) is None)
    check("check() 正确报告缺失", lib.check(["fake_button.png", "nope.png"]) == ["nope.png"])

    # 全局匹配
    m = match_template(frame, _spec("fake_button.png", 0.90), lib, 0.86, False, 0)
    check("全局匹配命中", m is not None)
    if m:
        dx, dy = abs(m.center[0] - target[0]), abs(m.center[1] - target[1])
        check("定位误差 <= 1 像素", dx <= 1 and dy <= 1, f"偏移 ({dx}, {dy}) 分数 {m.score:.4f}")

    # 阈值过高应当匹配失败
    high = match_template(frame, _spec("fake_button.png", 0.999999), lib, 0.86, False, 0)
    check("阈值过高时正确地不命中", high is None)

    # region 生效：框错位置应匹配失败
    wrong_region = match_template(
        frame, _spec("fake_button.png", 0.90, region=(0, 0, 200, 200)), lib, 0.86, False, 0)
    check("region 限制生效（区域外不命中）", wrong_region is None)

    # region 框对位置应命中，且坐标是窗口绝对坐标
    right_region = match_template(
        frame, _spec("fake_button.png", 0.90, region=(400, 250, 500, 200)), lib, 0.86, False, 0)
    check("region 正确时命中", right_region is not None)
    if right_region:
        check("region 内坐标已加回区域偏移",
              abs(right_region.center[0] - target[0]) <= 1,
              f"center={right_region.center}")

    # 灰度匹配
    mg = match_template(frame, _spec("fake_button.png", 0.90), lib, 0.86, True, 0)
    check("灰度匹配命中", mg is not None)

    # 模板比画面还大
    tiny = np.full((50, 50, 3), 10, dtype=np.uint8)
    big = match_template(tiny, _spec("fake_button.png", 0.5), lib, 0.86, False, 0)
    check("模板大于画面时安全返回 None", big is None)

    # match_all 排序
    hits = match_all(frame, [_spec("fake_button.png", 0.90), _spec("nope.png", 0.5)],
                     lib, 0.86, False, 0)
    check("match_all 只返回命中项", len(hits) == 1, f"命中 {len(hits)}")

    # annotate 不应因中文崩溃（模拟状态名带中文的调用）
    hit = Match(spec=_spec("按钮_开始.png", 0.9), score=0.93, center=(600, 330),
                top_left=(505, 305), size=(190, 50))
    try:
        vis = annotate(frame, [hit])
        check("annotate 处理非 ASCII 名称不崩溃", vis.shape == frame.shape)
    except Exception as exc:
        check("annotate 处理非 ASCII 名称不崩溃", False, repr(exc))


def _spec(name: str, threshold: float, region=None):
    from .config import TemplateSpec
    return TemplateSpec(name=name, threshold=threshold, region=region)


def test_coordinate_math() -> None:
    print("\n[4] 坐标换算")
    from .actions import ActionEngine

    eng = ActionEngine(dry_run=True)
    to_screen = eng._to_screen

    # 无缩放，窗口原点 (100, 50)
    check("无缩放换算", to_screen((10, 20), (100, 50), (1.0, 1.0)) == (110, 70),
          str(to_screen((10, 20), (100, 50), (1.0, 1.0))))

    # 窗口一半在屏幕外：截图被裁掉一半，sx=0.5 → 点应该落在更靠右的位置
    # 帧内 x=100, sx=0.5 → 窗口内 x=200 → 屏幕 x=200+原点
    check("裁剪缩放换算", to_screen((100, 0), (0, 0), (0.5, 1.0)) == (200, 0),
          str(to_screen((100, 0), (0, 0), (0.5, 1.0))))

    # scale 为 0 时不应 ZeroDivisionError
    try:
        to_screen((10, 10), (0, 0), (0.0, 0.0))
        check("scale=0 不崩溃", True)
    except ZeroDivisionError:
        check("scale=0 不崩溃", False, "ZeroDivisionError")


def test_state_tracker() -> None:
    print("\n[5] 状态跟踪器")
    from .engine import StateTracker

    cfg = load_config(ROOT / "config.yaml")
    cfg.stable_frames = 3
    tr = StateTracker(cfg)

    check("第 1 帧未稳定", tr.observe("s", 0.0) is False)
    check("第 2 帧未稳定", tr.observe("s", 0.1) is False)
    check("第 3 帧达到稳定", tr.observe("s", 0.2) is True)
    tr.reset("s")
    check("reset 后重新计数", tr.observe("s", 0.3) is False)

    tr.set_cooldown("s", 1.0, 100.0)
    check("冷却期内被拦截", tr.in_cooldown("s", 100.5) is True)
    check("冷却结束后放行", tr.in_cooldown("s", 101.5) is False)

    cfg.state_timeout = 5.0
    tr._last_seen["s"] = 200.0
    check("超时判定", tr.expired("s", 206.0) is True)
    check("未超时判定", tr.expired("s", 203.0) is False)


def test_files_exist() -> None:
    print("\n[6] 交付文件完整性")
    for rel in ["README.md", "ASSETS.md", "config.yaml", "requirements.txt",
                "setup.ps1", ".gitignore", "assets/README.txt"]:
        check(f"存在 {rel}", (ROOT / rel).is_file())
    for rel in ["main.py", "engine.py", "window.py", "capture.py",
                "vision.py", "actions.py", "config.py"]:
        check(f"存在 src/{rel}", (ROOT / "src" / rel).is_file())


def main() -> int:
    print("=" * 58)
    print("  onmyoji-bot 冒烟测试（不需要游戏和素材）")
    print("=" * 58)

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        test_imports()
        test_config()
        test_matching(Path(td))
        test_coordinate_math()
        test_state_tracker()
        test_files_exist()

    print("\n" + "=" * 58)
    print(f"  通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("\n  失败明细：")
        for f in FAILED:
            print(f"    - {f}")
    print("=" * 58)
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
