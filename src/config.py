"""配置加载与校验。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class TemplateSpec:
    """一个模板素材的配置。"""

    name: str
    threshold: float | None = None
    region: tuple[int, int, int, int] | None = None  # (x, y, w, h)，窗口内相对坐标
    grayscale: bool | None = None
    scale: float = 1.0  # 素材与当前分辨率不一致时，按此比例缩放素材


@dataclass
class ActionSpec:
    type: str
    template: str | None = None
    key: str | None = None
    seconds: float | None = None
    reason: str | None = None
    x: int | None = None
    y: int | None = None
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class StateSpec:
    name: str
    order: int
    when_any: list[TemplateSpec] = field(default_factory=list)
    when_all: list[TemplateSpec] = field(default_factory=list)
    actions: list[ActionSpec] = field(default_factory=list)
    cooldown: float | None = None


@dataclass
class Config:
    path: Path
    root: Path
    raw: dict[str, Any]

    title_keywords: list[str] = field(default_factory=list)
    activate_before_capture: bool = True
    expected_size: tuple[int, int] | None = None

    default_threshold: float = 0.86
    use_grayscale: bool = True
    stable_frames: int = 2
    search_margin: int = 0

    loop_interval: float = 0.10
    click_delay: tuple[float, float] = (0.18, 0.45)
    action_gap: tuple[float, float] = (0.12, 0.30)
    state_cooldown: float = 0.80
    state_timeout: float = 25.0

    max_actions: int = 0
    max_minutes: float = 0.0
    error_streak_limit: int = 12

    save_frames_on_error: bool = True
    save_frames_on_match: bool = False
    debug_dir: str = "debug"
    dry_run: bool = False

    states: list[StateSpec] = field(default_factory=list)

    @property
    def assets_dir(self) -> Path:
        return self.root / "assets"

    def referenced_templates(self) -> list[str]:
        names: list[str] = []
        for state in self.states:
            for tpl in [*state.when_any, *state.when_all]:
                if tpl.name not in names:
                    names.append(tpl.name)
            for act in state.actions:
                if act.template and act.template not in names:
                    names.append(act.template)
        return names


def _pair(value: Any, default: tuple[float, float]) -> tuple[float, float]:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return (float(value[0]), float(value[1]))
    return default


def _template_spec(item: Any) -> TemplateSpec:
    if isinstance(item, str):
        return TemplateSpec(name=item)
    if isinstance(item, dict):
        name = item.get("name") or item.get("template")
        if not name:
            raise ValueError(f"模板配置缺少 name 字段: {item!r}")
        region = item.get("region")
        if region is not None:
            if not (isinstance(region, (list, tuple)) and len(region) == 4):
                raise ValueError(f"region 必须是 [x, y, w, h]: {item!r}")
            region = tuple(int(v) for v in region)
        return TemplateSpec(
            name=str(name),
            threshold=float(item["threshold"]) if "threshold" in item else None,
            region=region,  # type: ignore[arg-type]
            grayscale=bool(item["grayscale"]) if "grayscale" in item else None,
            scale=float(item.get("scale", 1.0)),
        )
    raise ValueError(f"无法解析的模板项: {item!r}")


def _action_spec(item: dict[str, Any]) -> ActionSpec:
    if "type" not in item:
        raise ValueError(f"动作缺少 type 字段: {item!r}")
    known = {"type", "template", "key", "seconds", "reason", "x", "y"}
    return ActionSpec(
        type=str(item["type"]),
        template=item.get("template"),
        key=item.get("key"),
        seconds=float(item["seconds"]) if item.get("seconds") is not None else None,
        reason=item.get("reason"),
        x=item.get("x"),
        y=item.get("y"),
        params={k: v for k, v in item.items() if k not in known},
    )


def _state_spec(item: dict[str, Any], index: int) -> StateSpec:
    if "name" not in item:
        raise ValueError(f"第 {index + 1} 个状态缺少 name 字段")
    when = item.get("when") or {}
    if not when:
        raise ValueError(f"状态 {item['name']} 缺少 when 条件")

    actions_raw = item.get("actions")
    if not isinstance(actions_raw, list) or not actions_raw:
        raise ValueError(f"状态 {item['name']} 缺少 actions")

    return StateSpec(
        name=str(item["name"]),
        order=int(item.get("order", index * 10)),
        when_any=[_template_spec(t) for t in when.get("any", [])],
        when_all=[_template_spec(t) for t in when.get("all", [])],
        actions=[_action_spec(a) for a in actions_raw],
        cooldown=float(item["cooldown"]) if "cooldown" in item else None,
    )


def load_config(path: str | Path) -> Config:
    cfg_path = Path(path).resolve()
    if not cfg_path.is_file():
        raise SystemExit(f"找不到配置文件: {cfg_path}")

    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8-sig")) or {}
    root = cfg_path.parent

    window = raw.get("window") or {}
    vision = raw.get("vision") or {}
    timing = raw.get("timing") or {}
    limits = raw.get("limits") or {}
    debug = raw.get("debug") or {}

    expected = window.get("expected_size")
    cfg = Config(
        path=cfg_path,
        root=root,
        raw=raw,
        title_keywords=[str(k) for k in window.get("title_keywords", [])],
        activate_before_capture=bool(window.get("activate_before_capture", True)),
        expected_size=(int(expected[0]), int(expected[1]))
        if isinstance(expected, (list, tuple)) and len(expected) == 2
        else None,
        default_threshold=float(vision.get("default_threshold", 0.86)),
        use_grayscale=bool(vision.get("use_grayscale", True)),
        stable_frames=max(1, int(vision.get("stable_frames", 2))),
        search_margin=int(vision.get("search_margin", 0)),
        loop_interval=float(timing.get("loop_interval", 0.10)),
        click_delay=_pair(timing.get("click_delay"), (0.18, 0.45)),
        action_gap=_pair(timing.get("action_gap"), (0.12, 0.30)),
        state_cooldown=float(timing.get("state_cooldown", 0.80)),
        state_timeout=float(timing.get("state_timeout", 25.0)),
        max_actions=int(limits.get("max_actions", 0) or 0),
        max_minutes=float(limits.get("max_minutes", 0) or 0.0),
        error_streak_limit=int(limits.get("error_streak_limit", 12)),
        save_frames_on_error=bool(debug.get("save_frames_on_error", True)),
        save_frames_on_match=bool(debug.get("save_frames_on_match", False)),
        debug_dir=str(debug.get("debug_dir", "debug")),
        dry_run=bool(debug.get("dry_run", False)),
        states=[
            _state_spec(item, i)
            for i, item in enumerate(raw.get("states") or [])
        ],
    )

    cfg.states.sort(key=lambda s: s.order)
    return cfg
