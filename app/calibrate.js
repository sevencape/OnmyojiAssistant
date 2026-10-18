/**
 * 自动标定：从真实游戏画面里自动找出可作素材的区域，并逐块验证。
 *
 * ── 为什么需要它 ──
 * 手工裁素材是最耗时的一步，而且新手容易裁到纯色块、动画中间帧、过大的区域，
 * 导致匹配分数低或到处误命中。这个工具自动做三件事：
 *   1. 用边缘密度找出画面里"有特征的矩形小块"（按钮/图标/文字条通常都满足）
 *   2. 裁成 PNG
 *   3. **逐块自匹配验证**：把裁出来的块放回原图里找，要求能精确定位自己
 *
 * 只有通过了第 3 步的块才输出 —— 这保证产出的素材是可用的。
 *
 * ── 用法 ──
 *   node calibrate.js                 # 标定第一个游戏实例
 *   node calibrate.js --hwnd 123456   # 指定窗口
 *   node calibrate.js --out F:\...    # 指定输出目录
 */

'use strict';

const fs = require('fs');
const path = require('path');

const native = require('./lib/native');
const capture = require('./lib/capture');
const vision = require('./lib/vision');
const gameDetect = require('./lib/gamedetect');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = {
    hwnd: null,
    outDir: null,
    maxTemplates: 8,
    minScore: 0.97,
    samples: 3,
    gapMs: 350,
    maxChange: 0.02, // 区域平均变化阈值：2% 以内视为稳定
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hwnd') out.hwnd = Number(argv[++i]);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--max') out.maxTemplates = Number(argv[++i]);
    else if (a === '--min-score') out.minScore = Number(argv[++i]);
    else if (a === '--samples') out.samples = Number(argv[++i]);
    else if (a === '--gap') out.gapMs = Number(argv[++i]);
    else if (a === '--max-change') out.maxChange = Number(argv[++i]);
  }
  return out;
}

// ---------------------------------------------------------------- 边缘图

/**
 * 计算灰度图的 Sobel 边缘强度，并建积分图用于 O(1) 的区域求和。
 *
 * 用边缘密度而不是亮度或方差来找候选：UI 按钮/图标/文字的特征是**边缘密集**，
 * 而纯色背景、渐变天空亮度方差可能很大但边缘很少。实测这样选区域更准。
 */
function buildEdgeIntegral(gray, width, height) {
  const edge = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      // Sobel
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

  // 积分图
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
    edge,
    sum(ix, iy, w, h) {
      const x1 = ix, y1 = iy, x2 = ix + w, y2 = iy + h;
      return integ[y2 * iw + x2] - integ[y1 * iw + x2] - integ[y2 * iw + x1] + integ[y1 * iw + x1];
    },
  };
}

// ---------------------------------------------------------------- 候选区域

/**
 * 在边缘图上滑动窗口，找出边缘密度高、且尺寸合理的矩形区域。
 *
 * 约束（依据实测的 UI 元素特征）：
 *   - 宽 40–140、高 24–80：覆盖从图标到按钮条
 *   - 宽高比 1.2–4.5：UI 按钮基本是横向长条
 *   - 边缘密度 > 阈值：排除纯色/渐变区域
 */
function findCandidates(edgeInteg, width, height, opts = {}) {
  const scales = [
    { w: 56, h: 28 },
    { w: 72, h: 32 },
    { w: 96, h: 40 },
    { w: 120, h: 48 },
  ];
  const step = opts.step || 10;
  const minDensity = opts.minDensity != null ? opts.minDensity : 26;

  // 限定搜索矩形（用于按 UI 区域分区标定）
  const bx = opts.bounds ? opts.bounds.x : 0;
  const by = opts.bounds ? opts.bounds.y : 0;
  const bw = opts.bounds ? opts.bounds.w : width;
  const bh = opts.bounds ? opts.bounds.h : height;

  const xMin = Math.max(2, bx);
  const yMin = Math.max(2, by);
  const xMax = Math.min(width - 2, bx + bw);
  const yMax = Math.min(height - 2, by + bh);

  const cands = [];
  for (const sc of scales) {
    const { w, h } = sc;
    if (w >= width - 4 || h >= height - 4) continue;
    const area = w * h;
    for (let y = yMin; y + h < yMax; y += step) {
      for (let x = xMin; x + w < xMax; x += step) {
        const s = edgeInteg.sum(x, y, w, h);
        const density = s / area;
        if (density >= minDensity) {
          cands.push({ x, y, w, h, density });
        }
      }
    }
  }
  return cands;
}

/** 贪心非极大值抑制：去掉重叠的候选，保留密度高的 */
function suppress(cands, maxKeep) {
  cands.sort((a, b) => b.density - a.density);
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
      if (kept.length >= maxKeep) break;
    }
  }
  return kept;
}

// ---------------------------------------------------------------- 时域稳定性

/**
 * 多帧采样，判断一个区域是否**时间稳定**。
 *
 * ★ 为什么必须做这一步（实测教训）：
 *   只靠"自匹配"验证会有循环论证问题 —— 在同一帧里找自己当然 100% 命中。
 *   实测自动选出的 6 个区域全落在战斗画面中央的「300000 300000」伤害数字上，
 *   那些数字每回合都在变，当模板毫无意义。
 *
 * 做法：间隔一段时间连抓 N 帧，逐像素比较同一区域。
 * 稳定 UI（按钮、图标、边框）几乎不变；动态内容（伤害数字、血条、动画）变化很大。
 *
 * @param {number} hwnd
 * @param {number} [samples=3] 采样帧数
 * @param {number} [gapMs=350] 帧间隔
 * @returns {Array<{width:number,height:number,bgra:Buffer}>}
 */
async function sampleFrames(hwnd, samples = 3, gapMs = 350) {
  const frames = [];
  for (let i = 0; i < samples; i++) {
    try {
      const g = capture.grabContent(hwnd);
      frames.push(g.frame);
    } catch (err) {
      // 单帧失败跳过
    }
    if (i < samples - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return frames;
}

/**
 * 计算 region 在多帧之间的平均变化程度（0 = 完全不变）。
 *
 * 用"平均绝对差 / 255"归一化，便于设阈值。
 *
 * @param {Array} frames 同尺寸的帧数组
 * @param {{x:number,y:number,w:number,h:number}} r
 * @returns {number} 0..1
 */
function regionChange(frames, r) {
  if (frames.length < 2) return 1; // 没有对比帧，保守认为不稳定

  const base = frames[0];
  let totalDiff = 0;
  let count = 0;

  for (let row = 0; row < r.h; row++) {
    const y = r.y + row;
    if (y >= base.height) break;
    for (let col = 0; col < r.w; col++) {
      const x = r.x + col;
      if (x >= base.width) break;
      const off = (y * base.width + x) * 4;
      // 用 G 通道代表亮度，够用且省内存访问
      const v0 = base.bgra[off + 1];
      for (let f = 1; f < frames.length; f++) {
        const fr = frames[f];
        if (y >= fr.height || x >= fr.width) continue;
        totalDiff += Math.abs(fr.bgra[off + 1] - v0);
        count++;
      }
    }
  }

  if (count === 0) return 1;
  return (totalDiff / count) / 255;
}

/**
 * 构建**逐像素变化图**（低分辨率，用于快速筛选候选）。
 *
 * ★ 为什么需要它（实测教训）：
 *   只按边缘密度排序会优先选到伤害数字/血条这些"高对比度但每帧都变"的区域。
 *   实测排名前 24 的候选全在动态文字上，真正的按钮因为边缘密度略低被挤出。
 *   所以必须先算出"哪里不变"，再用"稳定 + 有特征"综合排序。
 *
 * 做法：把多帧都缩到约 1/8 分辨率，逐像素算平均绝对差，得到一张变化热力图。
 *
 * @param {Array} frames
 * @param {number} factor 降采样倍率
 * @returns {{width:number,height:number,change:Float32Array,factor:number}|null}
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
      // 在每个降采样格子里抽样几个点即可，不必全算
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

/**
 * 用变化图快速估算一个区域的平均变化（0-255 尺度）。
 */
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

// ---------------------------------------------------------------- 区域定义

/**
 * 阴阳师常见可点击区域（按内容区宽高的**比例**定义，适配不同分辨率）。
 *
 * ★ 为什么需要这个（实测教训）：
 *   纯按"边缘密度 + 内容稳定"选区域，会选中玩家名、等级数字这类
 *   **稳定但不可点**的 HUD 文字（实测就选中了「海角染虢」「60」）。
 *   自动化的目标是**按钮**，而按钮在阴阳师里有很固定的位置规律。
 *   所以把标定范围收窄到这些区域，命中率远高于全图盲扫。
 *
 * 比例以内容区左上角为原点，{ x, y, w, h } 都是 0-1 的比例。
 */
const UI_ZONES = [
  {
    name: 'primary_action',   // 底部中央主操作按钮（开始战斗/挑战/确认）
    x: 0.30, y: 0.72, w: 0.40, h: 0.22,
    desc: '底部中央主按钮',
  },
  {
    name: 'skills',           // 右下技能区（妖术/普攻/自动战斗开关）
    x: 0.55, y: 0.70, w: 0.45, h: 0.28,
    desc: '右下技能/自动战斗',
  },
  {
    name: 'bottom_left',      // 左下（自动、倍速）
    x: 0.00, y: 0.70, w: 0.30, h: 0.28,
    desc: '左下 自动/倍速',
  },
  {
    name: 'top_right',        // 右上（返回、关闭、设置）
    x: 0.75, y: 0.00, w: 0.25, h: 0.22,
    desc: '右上 返回/关闭',
  },
  {
    name: 'center_dialog',    // 中央弹窗区（结算确认、奖励领取）
    x: 0.25, y: 0.30, w: 0.50, h: 0.40,
    desc: '中央弹窗按钮',
  },
];

/** 把比例区域转成像素区域 */
function zoneToRect(zone, width, height) {
  const x = Math.floor(zone.x * width);
  const y = Math.floor(zone.y * height);
  const w = Math.floor(zone.w * width);
  const h = Math.floor(zone.h * height);
  return {
    x, y,
    w: Math.max(8, Math.min(w, width - x)),
    h: Math.max(8, Math.min(h, height - y)),
  };
}

// ---------------------------------------------------------------- 裁块

/** 从 BGRA 帧里裁出一块，返回可编码的 frame 对象 */
function cropFrame(frame, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const srcRow = frame.width * 4;
  const dstRow = w * 4;
  for (let row = 0; row < h; row++) {
    const srcStart = (y + row) * srcRow + x * 4;
    frame.bgra.copy(out, row * dstRow, srcStart, srcStart + dstRow);
  }
  return { width: w, height: h, bgra: out };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));

  native.enableDpiAwareness();

  // 找目标窗口
  let hwnd = args.hwnd;
  if (!hwnd) {
    const windows = native.listWindows();
    const games = gameDetect.pickGameWindows(windows, process.pid)
      .filter((w) => (w.processName || '').toLowerCase().includes('onmyoji'));
    if (games.length === 0) {
      console.error('未找到阴阳师窗口。请先启动游戏，或用 --hwnd 指定句柄。');
      process.exit(2);
    }
    hwnd = games[0].hwnd;
    console.log(`使用实例 hwnd=${hwnd} (共 ${games.length} 个游戏窗口)`);
  }

  console.log('='.repeat(66));
  console.log('  自动标定：找出可用作素材的区域并逐块验证');
  console.log('='.repeat(66));

  // 抓帧
  const t0 = Date.now();
  const grab = capture.grabContent(hwnd);
  console.log(`\n抓帧 ${Date.now() - t0}ms  方式=${grab.method}`);
  console.log(`  窗口 ${grab.fullSize.width}x${grab.fullSize.height} → ` +
    `内容区 ${grab.roi.width}x${grab.roi.height}@(${grab.roi.x},${grab.roi.y})`);
  console.log(`  屏幕基准 (${grab.windowOrigin.left + grab.roi.x},${grab.windowOrigin.top + grab.roi.y})`);

  const frame = grab.frame;
  const brightness = capture.meanBrightness(frame);
  console.log(`  平均亮度 ${brightness.toFixed(1)}/255`);
  if (brightness < 3) {
    console.error('\n截图为全黑，无法标定。请确认游戏窗口未最小化、未被完全遮挡。');
    process.exit(3);
  }

  // 灰度 + 边缘
  const t1 = Date.now();
  const ctx = vision.createFrameContext(frame);
  const gray = ctx.gray;
  const W = ctx.width;
  const H = ctx.height;
  const edgeInteg = buildEdgeIntegral(gray, W, H);
  console.log(`\n边缘分析 ${Date.now() - t1}ms`);

  // ---- 按 UI 区域分区找候选 ----
  // 全图盲扫会选中玩家名、等级这些"稳定但不可点"的 HUD 文字（实测踩过），
  // 所以只在已知按钮区域里找。
  const t2 = Date.now();
  const zoneCands = [];
  console.log('\n按 UI 区域扫描候选：');
  for (const zone of UI_ZONES) {
    const rect = zoneToRect(zone, W, H);
    const found = findCandidates(edgeInteg, W, H, { step: 8, bounds: rect });
    console.log(`  ${zone.name.padEnd(16)} ${zone.desc.padEnd(18)} ` +
      `区域(${rect.x},${rect.y}) ${rect.w}x${rect.h}  候选 ${found.length}`);
    for (const c of found) zoneCands.push({ ...c, zone: zone.name });
  }
  console.log(`  合计候选 ${zoneCands.length} 个  (${Date.now() - t2}ms)`);

  // 输出目录
  const outDir = args.outDir || path.join(__dirname, 'calibrated');
  fs.mkdirSync(outDir, { recursive: true });

  // 多帧采样：用于时域稳定性检验
  console.log(`\n采样 ${args.samples} 帧（间隔 ${args.gapMs}ms）用于稳定性检验...`);
  const t3 = Date.now();
  const samples = await sampleFrames(hwnd, args.samples, args.gapMs);
  console.log(`  实际采到 ${samples.length} 帧  (${Date.now() - t3}ms)`);

  // 变化图
  const changeMap = buildChangeMap(samples, 8);
  if (!changeMap) {
    console.log('  警告：帧数不足，无法做稳定性筛选，将只依赖自匹配验证');
  }

  // ---- 稳定性优先的候选筛选 ----
  // 在区域内再按"边缘密度高 + 内容稳定"综合排序，然后 NMS。
  const maxChangeRaw = args.maxChange * 255;
  const filtered = [];
  for (const c of zoneCands) {
    const ch0 = changeMap ? changeOfRegion(changeMap, c) : 0;
    if (ch0 > maxChangeRaw) continue;         // 明显在变的，直接丢
    c.goodness = c.density * (1 - Math.min(1, ch0 / maxChangeRaw) * 0.35);
    c.preChange = ch0;
    filtered.push(c);
  }
  console.log(`\n稳定性预筛：${zoneCands.length} → ${filtered.length} 个（丢弃明显动态区域）`);

  filtered.sort((a, b) => b.goodness - a.goodness);

  // NMS 去重，并限制每个区域最多取几个，保证覆盖多个区域
  const perZone = new Map();
  const cands = [];
  for (const c of filtered) {
    const used = perZone.get(c.zone) || 0;
    if (used >= 3) continue;                  // 每个区域最多 3 个候选
    let overlap = false;
    for (const k of cands) {
      const ix = Math.max(0, Math.min(c.x + c.w, k.x + k.w) - Math.max(c.x, k.x));
      const iy = Math.max(0, Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y));
      const inter = ix * iy;
      const union = c.w * c.h + k.w * k.h - inter;
      if (union > 0 && inter / union > 0.3) { overlap = true; break; }
    }
    if (!overlap) {
      cands.push(c);
      perZone.set(c.zone, used + 1);
    }
    if (cands.length >= args.maxTemplates * 3) break;
  }
  console.log(`  去重后候选 ${cands.length} 个`);

  // 逐块裁剪 + 自匹配验证
  console.log(`\n逐块验证（自匹配 >= ${args.minScore}，区域变化 <= ${(args.maxChange * 100).toFixed(1)}%）:`);
  const accepted = [];
  const rejected = [];
  for (const c of cands) {
    if (accepted.length >= args.maxTemplates) break;

    const crop = cropFrame(frame, c.x, c.y, c.w, c.h);

    // 建模板并自匹配
    let hit = null;
    try {
      const g = new Float32Array(c.w * c.h);
      for (let i = 0, n = c.w * c.h; i < n; i++) {
        const o = i * 4;
        g[i] = 0.299 * crop.bgra[o + 2] + 0.587 * crop.bgra[o + 1] + 0.114 * crop.bgra[o];
      }
      const tpl = new vision.Template('cand', g, c.w, c.h);
      // 用全分辨率匹配（不降采样），保证验证严格
      hit = vision.matchFullRes(ctx, tpl, null, 0.9);
    } catch (err) {
      console.log(`  (${c.x},${c.y}) ${c.w}x${c.h}  验证异常: ${err.message}`);
      continue;
    }

    if (!hit) {
      console.log(`  (${c.x},${c.y}) ${c.w}x${c.h}  未通过：自匹配失败`);
      continue;
    }

    // 自匹配必须落在原位（误差 <= 1px）
    const exact = Math.abs(hit.x - c.x) <= 1 && Math.abs(hit.y - c.y) <= 1;
    const strong = hit.score >= args.minScore;
    const unique = !hit.all || hit.all.filter((h) => h.score >= hit.score - 0.02).length <= 1;

    if (!exact || !strong || !unique) {
      const why = [];
      if (!exact) why.push(`位置偏(${hit.x},${hit.y})`);
      if (!strong) why.push(`分数${hit.score.toFixed(3)}`);
      if (!unique) why.push('位置不唯一');
      console.log(`  (${c.x},${c.y}) ${c.w}x${c.h}  未通过：${why.join(' ')}`);
      continue;
    }

    // ---- 时域稳定性检验（关键）----
    const change = regionChange(samples, { x: c.x, y: c.y, w: c.w, h: c.h });
    if (change > args.maxChange) {
      console.log(`  (${c.x},${c.y}) ${c.w}x${c.h}  未通过：内容在变化 ` +
        `(变化率 ${(change * 100).toFixed(2)}% > ${(args.maxChange * 100).toFixed(1)}%)`);
      rejected.push({ ...c, change });
      continue;
    }

    accepted.push({ ...c, score: hit.score, change });
    console.log(`  [${String(c.zone || '-').padEnd(15)}] (${c.x},${c.y}) ${c.w}x${c.h}  ` +
      `通过 score=${hit.score.toFixed(4)} 变化=${(change * 100).toFixed(2)}% 密度=${c.density.toFixed(1)}`);
  }

  if (rejected.length > 0) {
    console.log(`\n  被稳定性检验拒绝 ${rejected.length} 个区域（多半是伤害数字/血条/特效）`);
  }

  if (accepted.length === 0) {
    console.log('\n没有区域通过验证。可能这个界面的 UI 元素太少（比如在过场画面）。');
    console.log('建议：切到副本选择 / 战斗结算这类有按钮的界面再跑一次。');
    return 4;
  }

  // 写文件
  console.log(`\n写出素材到 ${outDir}:`);
  const manifest = [];
  accepted.forEach((c, i) => {
    const name = `auto_${String(i + 1).padStart(2, '0')}_${c.x}_${c.y}.png`;
    const crop = cropFrame(frame, c.x, c.y, c.w, c.h);
    const png = capture.encodePng(crop);
    fs.writeFileSync(path.join(outDir, name), png);
    console.log(`  ${name}  ${c.w}x${c.h}  ${(png.length / 1024).toFixed(1)}KB  ` +
      `score=${c.score.toFixed(4)} 变化=${(c.change * 100).toFixed(2)}%`);
    manifest.push({
      file: name,
      zone: c.zone || null,
      x: c.x, y: c.y, width: c.w, height: c.h,
      score: Number(c.score.toFixed(4)),
      changePercent: Number((c.change * 100).toFixed(3)),
      edgeDensity: Number(c.density.toFixed(1)),
    });
  });

  // 写清单
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    source: {
      hwnd,
      capturedAt: new Date().toISOString(),
      windowSize: grab.fullSize,
      contentRoi: grab.roi,
      screenOrigin: {
        left: grab.windowOrigin.left + grab.roi.x,
        top: grab.windowOrigin.top + grab.roi.y,
      },
      brightness: Number(brightness.toFixed(1)),
    },
    templates: manifest,
  }, null, 2), 'utf8');
  console.log(`  manifest.json`);

  // 保存整帧供参考
  const framePath = path.join(outDir, 'frame_reference.png');
  fs.writeFileSync(framePath, capture.encodePng(frame));
  console.log(`  frame_reference.png（整帧参考图）`);

  console.log(`\n完成：产出 ${accepted.length} 个已验证素材。`);
  console.log('下一步：');
  console.log('  1. 打开 frame_reference.png，确认每个 auto_*.png 框住的是你要点的元素');
  console.log('  2. 把有用的改名成语义名（如 btn_start_battle.png）放进 app/assets/');
  console.log('  3. 在 rules.json 里按语义名配规则');
  console.log('');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('标定失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
