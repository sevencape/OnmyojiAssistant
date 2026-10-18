/**
 * 标定：把「采集素材 + 写规则」做成程序内可调用的能力，供界面使用。
 *
 * 与 CLI 版 calibrate.js 的关系：
 *   - calibrate.js 是命令行工具，适合批量/脚本化
 *   - 本模块是它的核心逻辑抽离，返回**结构化数据**给界面渲染，
 *     并负责把用户选中的区域保存成素材 + 写 rules.json
 *
 * 共同的三重验证（缺一不可，实测总结）：
 *   1. 自匹配：裁出来的块要能在同帧里精确找到自己（排除无特征/位置歧义）
 *   2. 唯一性：高分候选只能有 1 个（排除会到处误命中的块）
 *   3. 时域稳定性：多帧比较，区域变化 <= 阈值（排除伤害数字/血条/特效）
 *
 * ★ 踩过的两个坑（详见 VERIFIED-FACTS.md 第零之四节）：
 *   - 只做自匹配 = 循环论证，同一帧里找自己必然 100%
 *   - 只在全图盲扫会选中"稳定但不可点"的 HUD 文字（玩家名、等级数字）
 *     所以必须限定在已知按钮区域内找
 */

'use strict';

const fs = require('fs');
const path = require('path');

const native = require('./native');
const capture = require('./capture');
const vision = require('./vision');
const paths = require('./paths');

// ---------------------------------------------------------------- 常量

/**
 * 阴阳师常见可点击区域（按内容区宽高的比例定义，适配不同分辨率）。
 * 顺序即界面里的展示顺序。
 */
const UI_ZONES = [
  { name: 'primary_action', label: '底部中央主按钮', hint: '开始战斗 / 挑战 / 确认', x: 0.30, y: 0.72, w: 0.40, h: 0.24 },
  { name: 'skills', label: '右下技能区', hint: '妖术 / 普攻 / 自动战斗', x: 0.55, y: 0.70, w: 0.45, h: 0.28 },
  { name: 'bottom_left', label: '左下 自动/倍速', hint: '自动挂机开关、倍速', x: 0.00, y: 0.70, w: 0.30, h: 0.28 },
  { name: 'top_right', label: '右上 返回/关闭', hint: '返回、关闭弹窗', x: 0.75, y: 0.00, w: 0.25, h: 0.24 },
  { name: 'center_dialog', label: '中央弹窗按钮', hint: '结算确认、领取奖励', x: 0.25, y: 0.28, w: 0.50, h: 0.42 },
];

/** 候选块的尺寸档位 */
const SCALES = [
  { w: 56, h: 28 },
  { w: 72, h: 32 },
  { w: 96, h: 40 },
  { w: 120, h: 48 },
];

/** 每个区域最多返回几个候选给界面 */
const MAX_PER_ZONE = 6;

/** 稳定性阈值：区域帧间平均变化（0-255 尺度）不超过此值 */
const STABLE_MAX_CHANGE = 5.5;

// ---------------------------------------------------------------- 工具

function zoneToRect(zone, width, height) {
  const x = Math.floor(zone.x * width);
  const y = Math.floor(zone.y * height);
  const w = Math.floor(zone.w * width);
  const h = Math.floor(zone.h * height);
  return {
    x,
    y,
    w: Math.max(8, Math.min(w, width - x)),
    h: Math.max(8, Math.min(h, height - y)),
  };
}

/** 从 BGRA 帧裁一块 */
function cropFrame(frame, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const srcRow = frame.width * 4;
  const dstRow = w * 4;
  for (let row = 0; row < h; row++) {
    const s = (y + row) * srcRow + x * 4;
    frame.bgra.copy(out, row * dstRow, s, s + dstRow);
  }
  return { width: w, height: h, bgra: out };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- 边缘图

/** Sobel 边缘强度 + 积分图，用于 O(1) 求区域边缘密度 */
function buildEdgeIntegral(gray, width, height) {
  const edge = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] + gray[i - width + 1]
        - 2 * gray[i - 1] + 2 * gray[i + 1]
        - gray[i + width - 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1]
        + gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      edge[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  const iw = width + 1;
  const integ = new Float64Array(iw * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += edge[y * width + x];
      integ[(y + 1) * iw + (x + 1)] = integ[y * iw + (x + 1)] + rowSum;
    }
  }

  return {
    sum(ix, iy, w, h) {
      const x1 = ix, y1 = iy, x2 = ix + w, y2 = iy + h;
      return integ[y2 * iw + x2] - integ[y1 * iw + x2] - integ[y2 * iw + x1] + integ[y1 * iw + x1];
    },
  };
}

// ---------------------------------------------------------------- 稳定性

/**
 * 逐像素变化图（低分辨率）。
 *
 * 为什么用整帧变化图而不是每次重算区域：
 *   候选有上万个，逐个跨帧比较代价太高。先算一张 1/8 的变化图，
 *   之后每个候选只需查几个格子就能估出变化程度。
 */
function buildChangeMap(frames, factor = 8) {
  if (frames.length < 2) return null;
  const w0 = frames[0].width;
  const h0 = frames[0].height;
  const w = Math.max(1, Math.floor(w0 / factor));
  const h = Math.max(1, Math.floor(h0 / factor));
  const change = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx0 = x * factor;
      const sy0 = y * factor;
      let diff = 0;
      let cnt = 0;
      for (let dy = 0; dy < factor; dy += 2) {
        for (let dx = 0; dx < factor; dx += 2) {
          const sx = sx0 + dx;
          const sy = sy0 + dy;
          if (sx >= w0 || sy >= h0) continue;
          const off = (sy * w0 + sx) * 4 + 1;
          const v0 = frames[0].bgra[off];
          for (let f = 1; f < frames.length; f++) {
            const fr = frames[f];
            if (sx >= fr.width || sy >= fr.height) continue;
            diff += Math.abs(fr.bgra[off] - v0);
            cnt++;
          }
        }
      }
      change[y * w + x] = cnt > 0 ? diff / cnt : 0;
    }
  }

  return { width: w, height: h, change, factor };
}

/** 估一个区域在变化图上的平均变化 */
function changeOfRegion(changeMap, r) {
  if (!changeMap) return 255;
  const { width: cw, height: ch, change, factor } = changeMap;
  const x0 = Math.max(0, Math.floor(r.x / factor));
  const y0 = Math.max(0, Math.floor(r.y / factor));
  const x1 = Math.min(cw - 1, Math.floor((r.x + r.w) / factor));
  const y1 = Math.min(ch - 1, Math.floor((r.y + r.h) / factor));
  if (x1 < x0 || y1 < y0) return 255;

  let sum = 0;
  let cnt = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      sum += change[y * cw + x];
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : 255;
}

// ---------------------------------------------------------------- 候选

function findCandidates(edgeInteg, width, height, bounds, step = 8, minDensity = 26) {
  const xMin = Math.max(2, bounds.x);
  const yMin = Math.max(2, bounds.y);
  const xMax = Math.min(width - 2, bounds.x + bounds.w);
  const yMax = Math.min(height - 2, bounds.y + bounds.h);

  const cands = [];
  for (const sc of SCALES) {
    const { w, h } = sc;
    if (w >= width - 4 || h >= height - 4) continue;
    const area = w * h;
    for (let y = yMin; y + h < yMax; y += step) {
      for (let x = xMin; x + w < xMax; x += step) {
        const density = edgeInteg.sum(x, y, w, h) / area;
        if (density >= minDensity) cands.push({ x, y, w, h, density });
      }
    }
  }
  return cands;
}

/** 贪心 NMS，去掉重叠候选 */
function suppress(cands, limit) {
  const kept = [];
  for (const c of cands) {
    let overlap = false;
    for (const k of kept) {
      const ix = Math.max(0, Math.min(c.x + c.w, k.x + k.w) - Math.max(c.x, k.x));
      const iy = Math.max(0, Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y));
      const inter = ix * iy;
      const union = c.w * c.h + k.w * k.h - inter;
      if (union > 0 && inter / union > 0.3) { overlap = true; break; }
    }
    if (!overlap) {
      kept.push(c);
      if (kept.length >= limit) break;
    }
  }
  return kept;
}

// ---------------------------------------------------------------- 主入口

/**
 * 抓帧并给出候选区域建议。
 *
 * ★ 必须是 async：采样需要等帧间隔（约 0.5-1 秒）。
 *   最初用 Atomics.wait 做同步睡眠，结果阻塞 Electron 主进程，
 *   面板会卡死 2.5 秒连加载动画都不动。改用真正的 await。
 *
 * @param {number} hwnd
 * @param {object} [opts]
 * @param {number} [opts.samples=3] 稳定性采样帧数
 * @param {number} [opts.gapMs=350]
 * @returns {Promise<object>}
 */
async function captureAndSuggest(hwnd, opts = {}) {
  const samples = opts.samples || 3;
  const gapMs = opts.gapMs || 350;

  const grab = capture.grabContent(hwnd);
  const frame = grab.frame;
  const brightness = capture.meanBrightness(frame);
  if (brightness < 3) {
    throw new Error('截图为全黑，无法标定。请确认游戏窗口未最小化、未被完全遮挡');
  }

  const W = frame.width;
  const H = frame.height;

  // 灰度（供边缘分析）
  const gray = new Float32Array(W * H);
  for (let i = 0, n = W * H; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * frame.bgra[o + 2] + 0.587 * frame.bgra[o + 1] + 0.114 * frame.bgra[o];
  }
  const ctx = new vision.FrameContext(gray, W, H);
  const edgeInteg = buildEdgeIntegral(gray, W, H);

  // 多帧采样做稳定性（异步等待，不阻塞主进程事件循环）
  const frames = [frame];
  for (let i = 1; i < samples; i++) {
    await sleep(gapMs);
    try {
      frames.push(capture.grabContent(hwnd).frame);
    } catch (err) { /* 单帧失败跳过 */ }
  }

  const changeMap = buildChangeMap(frames, 8);

  // 按区域找候选并验证
  const zones = [];
  let total = 0;

  for (const zone of UI_ZONES) {
    const rect = zoneToRect(zone, W, H);
    const raw = findCandidates(edgeInteg, W, H, rect, 8, 26);

    // 稳定性预筛
    const stable = [];
    for (const c of raw) {
      const ch0 = changeMap ? changeOfRegion(changeMap, c) : 0;
      if (ch0 > STABLE_MAX_CHANGE) continue;
      c.change = ch0;
      c.goodness = c.density * (1 - Math.min(1, ch0 / STABLE_MAX_CHANGE) * 0.35);
      stable.push(c);
    }
    stable.sort((a, b) => b.goodness - a.goodness);

    // NMS + 逐块验证
    //
    // ★ 性能关键（实测教训）：
    //   最初对每个候选都调 matchFullRes（全帧 2048×2048 FFT），
    //   单次约 1 秒，5 个区域跑下来要 22 秒，界面完全没法用。
    //   改成：
    //     1. 先用「密度 + 稳定性」做廉价排序，每区域只留少量候选
    //     2. 验证用 matchTemplate（粗搜降采样 1/4 + 精修），单次约 74ms
    //   总耗时从 22 秒降到 3 秒左右。
    const candidates = [];
    const pool = suppress(stable, MAX_PER_ZONE * 2);
    for (const c of pool) {
      if (candidates.length >= MAX_PER_ZONE) break;

      const crop = cropFrame(frame, c.x, c.y, c.w, c.h);
      let hit = null;
      try {
        const g = new Float32Array(c.w * c.h);
        for (let i = 0, n = c.w * c.h; i < n; i++) {
          const o = i * 4;
          g[i] = 0.299 * crop.bgra[o + 2] + 0.587 * crop.bgra[o + 1] + 0.114 * crop.bgra[o];
        }
        // 粗到精：全帧搜索但只在降采样图上做 FFT，快得多
        hit = vision.matchTemplate(ctx, new vision.Template('c', g, c.w, c.h), null, 0.9);
      } catch (err) {
        continue;
      }
      if (!hit) continue;
      // 自匹配必须回到原位且分数够高
      if (Math.abs(hit.x - c.x) > 1 || Math.abs(hit.y - c.y) > 1) continue;
      if (hit.score < 0.97) continue;
      const strong = hit.all ? hit.all.filter((h) => h.score >= hit.score - 0.02).length : 1;
      if (strong > 1) continue;

      candidates.push({
        x: c.x, y: c.y, w: c.w, h: c.h,
        score: Number(hit.score.toFixed(4)),
        changePercent: Number(((c.change || 0) / 255 * 100).toFixed(3)),
        density: Number(c.density.toFixed(1)),
        // 每块单独编码成 PNG base64，界面直接显示缩略图
        pngBase64: capture.encodePng(crop).toString('base64'),
      });
    }

    total += candidates.length;
    zones.push({
      name: zone.name,
      label: zone.label,
      hint: zone.hint,
      rect,
      rawCount: raw.length,
      stableCount: stable.length,
      candidates,
    });
  }

  return {
    hwnd,
    method: grab.method,
    brightness: Number(brightness.toFixed(1)),
    fullSize: grab.fullSize,
    framePng: capture.encodePng(frame).toString('base64'),
    roi: grab.roi,
    screenOrigin: {
      left: grab.windowOrigin.left + grab.roi.x,
      top: grab.windowOrigin.top + grab.roi.y,
    },
    samples: frames.length,
    zones,
    totalCandidates: total,
  };
}

/** 渲染某个区域的预览图（给界面用） */
function renderRegionPreview(hwnd, rect) {
  const grab = capture.grabContent(hwnd);
  const frame = grab.frame;
  const x = Math.max(0, Math.min(frame.width - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(frame.height - 1, Math.round(rect.y)));
  const w = Math.max(1, Math.min(frame.width - x, Math.round(rect.w || rect.width)));
  const h = Math.max(1, Math.min(frame.height - y, Math.round(rect.h || rect.height)));
  return capture.encodePng(cropFrame(frame, x, y, w, h));
}

// ---------------------------------------------------------------- 保存

/**
 * 从 PNG 字节里读出宽高（解析 IHDR）。
 * 只做最小校验，不依赖解码库 —— 我们只是想把界面传来的 PNG 原样落盘。
 * @returns {{width:number, height:number}|null}
 */
function pngDimensions(buf) {
  if (!buf || buf.length < 33) return null;
  // PNG 魔数
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  // 第一个 chunk 必须是 IHDR，数据从第 16 字节开始（宽 4 字节，高 4 字节）
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 保存标定结果：把选中的块写成 assets 素材，并更新 rules.json。
 *
 * @param {object} payload
 * @param {number} payload.hwnd
 * @param {Array<{name:string, x:number,y:number,w:number,h:number,
 *                threshold?:number, cooldownMs?:number, isBattleEnd?:boolean,
 *                action?:object}>} payload.items
 *   每个 item 是一条要保存的素材 + 规则。name 是文件名（不含 .png）。
 * @param {string} [payload.assetsDir] 默认用项目的 assets 目录
 * @param {string} [payload.rulesPath] 默认用项目的 rules.json
 * @param {boolean} [payload.replaceRules=false] true=覆盖，false=合并
 * @returns {{ok:boolean, saved:Array, rulesPath:string, assetsDir:string, warnings:Array}}
 */
function saveCalibration(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    return { ok: false, error: '没有选中任何素材' };
  }

  const assetsDir = payload.assetsDir ||
    paths.assetsDirFor(payload.dataRoot || paths.resolveDataRoot());
  const rulesPath = payload.rulesPath ||
    paths.rulesPathFor(payload.dataRoot || paths.resolveDataRoot());

  const warnings = [];

  // ---- 先做参数校验，再抓帧 ----
  // 实测教训：最初先抓帧后校验，hwnd 无效时会抛异常而不是返回错误，
  // 界面层拿到的是未捕获异常。校验必须前置。
  const valid = [];
  for (const it of items) {
    // 规范名称：用户输入 btn_start_battle.png 也当 btn_start_battle 处理，
    // 不再像早期那样整条拒绝（用户看不到原因，只觉得「没保存成功」）。
    const rawName = paths.normalizeAssetName(it.name);
    if (!rawName) {
      warnings.push('有一项缺少名称，已跳过');
      continue;
    }
    // 文件名净化：只允许字母数字下划线横线中文，避免路径穿越
    if (!/^[\w\u4e00-\u9fa5-]+$/.test(rawName)) {
      warnings.push(`名称「${it.name}」含非法字符，已跳过（只允许中英文、数字、下划线、横线）`);
      continue;
    }

    const x = Math.round(Number(it.x));
    const y = Math.round(Number(it.y));
    const w = Math.round(Number(it.w != null ? it.w : it.width));
    const h = Math.round(Number(it.h != null ? it.h : it.height));

    if (!Number.isFinite(x) || !Number.isFinite(y) ||
      !Number.isFinite(w) || !Number.isFinite(h)) {
      warnings.push(`「${rawName}」坐标或尺寸非法，已跳过`);
      continue;
    }
    if (w < 8 || h < 8) {
      warnings.push(`「${rawName}」尺寸过小（${w}x${h}），已跳过`);
      continue;
    }
    if (x < 0 || y < 0) {
      warnings.push(`「${rawName}」坐标不能为负（${x},${y}），已跳过`);
      continue;
    }

    valid.push({ it, rawName, x, y, w, h });
  }

  if (valid.length === 0) {
    return { ok: false, error: '没有通过校验的素材', warnings };
  }

  // 抓帧只用于「没带裁剪图」的项。
  // ★ 界面把用户选中的那块图（pngBase64）一起传过来了，那是**用户真正看到的像素**。
  //   原来这里无条件重新抓一帧来裁剪，会有两个问题：
  //     1) 游戏画面是动的，保存下来的图可能和用户选的那块不一致（文字/特效变了）
  //     2) 没有可用窗口时无法保存，也没法测试
  //   现在优先直接用传进来的 PNG，只在缺失时才回退到抓帧。
  const needFrame = valid.some((v) => !v.it.pngBase64);
  let frame = null;
  if (needFrame) {
    try {
      frame = capture.grabContent(payload.hwnd).frame;
    } catch (err) {
      return {
        ok: false,
        error: `无法抓取画面，素材未保存: ${err.message}`,
        warnings,
      };
    }
  }

  fs.mkdirSync(assetsDir, { recursive: true });

  const saved = [];

  for (const v of valid) {
    const { rawName, x, y, w, h } = v;
    let pngBuf = null;

    if (v.it.pngBase64) {
      // 用界面传来的裁剪图：只校验它是合法 PNG，尺寸以像素头为准
      let buf;
      try {
        buf = Buffer.from(String(v.it.pngBase64), 'base64');
      } catch (err) {
        warnings.push(`「${rawName}」传来的是无效数据，已跳过`);
        continue;
      }
      const dim = pngDimensions(buf);
      if (!dim) {
        warnings.push(`「${rawName}」传来的是无效 PNG，已跳过`);
        continue;
      }
      if (dim.width !== w || dim.height !== h) {
        warnings.push(`「${rawName}」图片尺寸 ${dim.width}x${dim.height} 与声明的 ${w}x${h} 不符，已按图片为准`);
      }
      pngBuf = buf;
    } else {
      if (!frame) {
        warnings.push(`「${rawName}」缺少画面也缺少图片，已跳过`);
        continue;
      }
      if (x + w > frame.width || y + h > frame.height) {
        warnings.push(`「${rawName}」超出画面范围（画面 ${frame.width}x${frame.height}），已跳过`);
        continue;
      }
      pngBuf = capture.encodePng(cropFrame(frame, x, y, w, h));
    }

    const fileName = `${rawName}.png`;
    fs.writeFileSync(path.join(assetsDir, fileName), pngBuf);
    saved.push({
      file: fileName,
      name: rawName,
      x, y, width: w, height: h,
      threshold: v.it.threshold != null ? Number(v.it.threshold) : 0.86,
    });
  }

  if (saved.length === 0) {
    return { ok: false, error: '没有成功保存任何素材', warnings };
  }

  // 更新 rules.json
  let rulesDoc = { rules: [] };
  if (!payload.replaceRules && fs.existsSync(rulesPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      rulesDoc = Array.isArray(raw) ? { rules: raw } : raw;
      if (!Array.isArray(rulesDoc.rules)) rulesDoc.rules = [];
    } catch (err) {
      warnings.push(`原 rules.json 解析失败（${err.message}），将重建`);
      rulesDoc = { rules: [] };
    }
  }

  for (const s of saved) {
    const src = items.find((i) => String(i.name || '').trim() === s.name) || {};
    const rule = {
      state: src.state || s.name,
      template: s.file,
      threshold: s.threshold,
      action: src.action || { type: 'tap' },
      cooldownMs: src.cooldownMs != null ? src.cooldownMs : 1200,
    };
    if (src.region) rule.region = src.region; // 可选：限制搜索范围
    if (src.isBattleEnd) rule.isBattleEnd = true;

    // 同名规则替换，避免重复
    const idx = rulesDoc.rules.findIndex((r) => r && r.template === s.file);
    if (idx >= 0) rulesDoc.rules[idx] = rule;
    else rulesDoc.rules.push(rule);
  }

  fs.writeFileSync(rulesPath, JSON.stringify(rulesDoc, null, 2), 'utf8');

  return {
    ok: true,
    saved,
    rulesPath,
    assetsDir,
    ruleCount: rulesDoc.rules.length,
    warnings,
  };
}

module.exports = {
  UI_ZONES,
  captureAndSuggest,
  renderRegionPreview,
  saveCalibration,
  // 导出以便测试
  buildEdgeIntegral,
  buildChangeMap,
  changeOfRegion,
  zoneToRect,
  cropFrame,
  suppress,
  findCandidates,
  STABLE_MAX_CHANGE,
};
