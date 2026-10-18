/**
 * 模板匹配（归一化互相关 NCC，FFT 加速）。
 *
 * ── 为什么用 NCC 而不是简单像素差 ──
 * NCC 对整体亮度变化不敏感。游戏画面会因为特效、屏幕亮度、渲染后处理而变化，
 * 用 SAD/SSD（逐像素差）很容易因为整体变亮变暗就匹配失败。
 *
 * ── 为什么用 FFT ──
 * 直接算 NCC 是 O(W·H·w·h)。以 1712×1016 的画面 + 100×40 的模板为例，
 * 裸算是 1700 万 × 4000 ≈ 680 亿次运算，纯 JS 根本跑不动。
 * 用 FFT 把交叉相关降到 O(WH log(WH))，同一帧约几十毫秒，可以做到实时。
 *
 * ── 坐标系约定（很重要） ──
 * 输入帧是 capture.grabContent() 裁好的**内容区像素**，坐标原点在内容区左上角。
 * 点击时要换算成屏幕坐标：
 *   屏幕坐标 = windowOrigin + (roi.x + 匹配x, roi.y + 匹配y)
 * 换算由调用方（runner）负责，本模块只认内容区内坐标。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- PNG 解码

let PNG = null;
function ensurePng() {
  if (PNG) return PNG;
  try {
    PNG = require('pngjs').PNG;
  } catch (err) {
    throw new Error('pngjs 未安装，无法读取模板素材。请执行: npm install\n原始错误: ' + err.message);
  }
  return PNG;
}

/**
 * 读 PNG 并转成灰度 Float32Array。
 * 用 Buffer 读文件而不是路径直读，避免中文路径问题。
 */
function loadPngGray(filePath) {
  const Png = ensurePng();
  const buf = fs.readFileSync(filePath);
  const png = Png.sync.read(buf);
  const { width, height, data } = png;
  const gray = new Float32Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    // 亮度权重用常见的 Rec.601
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { width, height, gray };
}

// ---------------------------------------------------------------- 1D FFT

/**
 * 原地基-2 FFT。
 * @param {Float64Array} re 实部
 * @param {Float64Array} im 虚部
 * @param {boolean} inverse 是否逆变换（含 1/N 归一化）
 */
function fft1d(re, im, inverse) {
  const n = re.length;
  if (n <= 1) return;

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  // 蝶形运算
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * 原地 2D FFT（按行再按列）。
 * 宽高都必须是 2 的幂。
 */
function fft2d(re, im, width, height, inverse) {
  const rowRe = new Float64Array(width);
  const rowIm = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const off = y * width;
    rowRe.set(re.subarray(off, off + width));
    rowIm.set(im.subarray(off, off + width));
    fft1d(rowRe, rowIm, inverse);
    re.set(rowRe, off);
    im.set(rowIm, off);
  }

  const colRe = new Float64Array(height);
  const colIm = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colRe[y] = re[y * width + x];
      colIm[y] = im[y * width + x];
    }
    fft1d(colRe, colIm, inverse);
    for (let y = 0; y < height; y++) {
      re[y * width + x] = colRe[y];
      im[y * width + x] = colIm[y];
    }
  }
}

/** 向上取到 2 的幂 */
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ---------------------------------------------------------------- 预计算

/**
 * 一帧画面只需要算一次 FFT，多个模板可以复用。
 * 这是性能关键：一帧通常要匹配好几个模板。
 */
class FrameContext {
  constructor(gray, width, height) {
    this.width = width;
    this.height = height;
    this.gray = gray;

    // 积分图：O(1) 求任意窗口的 和 / 平方和
    this.integral = new Float64Array((width + 1) * (height + 1));
    this.integralSq = new Float64Array((width + 1) * (height + 1));
    const iw = width + 1;
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      let rowSumSq = 0;
      for (let x = 0; x < width; x++) {
        const v = gray[y * width + x];
        rowSum += v;
        rowSumSq += v * v;
        this.integral[(y + 1) * iw + (x + 1)] = this.integral[y * iw + (x + 1)] + rowSum;
        this.integralSq[(y + 1) * iw + (x + 1)] = this.integralSq[y * iw + (x + 1)] + rowSumSq;
      }
    }

    this._fftCache = new Map();
  }

  /** 窗口 (x,y,w,h) 的和 */
  sum(x, y, w, h) {
    const iw = this.width + 1;
    const I = this.integral;
    return I[(y + h) * iw + (x + w)] - I[y * iw + (x + w)]
      - I[(y + h) * iw + x] + I[y * iw + x];
  }

  /** 窗口 (x,y,w,h) 的平方和 */
  sumSq(x, y, w, h) {
    const iw = this.width + 1;
    const I = this.integralSq;
    return I[(y + h) * iw + (x + w)] - I[y * iw + (x + w)]
      - I[(y + h) * iw + x] + I[y * iw + x];
  }

  /** 取（或建）本帧的 FFT 表示，尺寸取决于模板，按 (pw,ph) 缓存 */
  fftFor(fftW, fftH) {
    const key = fftW + 'x' + fftH;
    const hit = this._fftCache.get(key);
    if (hit) return hit;

    const re = new Float64Array(fftW * fftH);
    const im = new Float64Array(fftW * fftH);
    // 把帧放进左上角，其余补零
    for (let y = 0; y < this.height; y++) {
      const src = y * this.width;
      const dst = y * fftW;
      for (let x = 0; x < this.width; x++) re[dst + x] = this.gray[src + x];
    }
    fft2d(re, im, fftW, fftH, false);
    const out = { re, im, fftW, fftH };
    this._fftCache.set(key, out);
    return out;
  }
}

// ---------------------------------------------------------------- 模板

/**
 * 一个素材模板。
 * 首次使用时预计算 FFT 和统计量，之后复用。
 */
class Template {
  constructor(name, gray, width, height) {
    this.name = name;
    this.gray = gray;
    this.width = width;
    this.height = height;

    this._cache = new Map();

    // 模板自身的统计量：均值和去均值后的平方和
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < gray.length; i++) {
      sum += gray[i];
      sumSq += gray[i] * gray[i];
    }
    const n = gray.length;
    this.mean = sum / n;
    // 去均值后的平方和 = Σx² - n·mean²
    this.centeredSq = sumSq - n * this.mean * this.mean;
    this.centered = new Float32Array(n);
    for (let i = 0; i < n; i++) this.centered[i] = gray[i] - this.mean;
  }

  /** 取（或建）模板的 FFT（不做空间翻转，相关靠频域取共轭实现） */
  fftFor(fftW, fftH) {
    const key = fftW + 'x' + fftH;
    const hit = this._cache.get(key);
    if (hit) return hit;

    const re = new Float64Array(fftW * fftH);
    const im = new Float64Array(fftW * fftH);

    // 直接把去均值模板放在原点，不做翻转。
    // 频域里用 A·conj(B) 得到相关；若这里再做空间翻转，就变成卷积了
    // ——实测那样会导致峰值错位、分数溢出 1.0。
    const w = this.width;
    const h = this.height;
    const c = this.centered;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        re[y * fftW + x] = c[y * w + x];
      }
    }

    fft2d(re, im, fftW, fftH, false);
    const out = { re, im, fftW, fftH };
    this._cache.set(key, out);
    return out;
  }
}

// ---------------------------------------------------------------- 降采样

/**
 * 整数倍盒式降采样（box filter）。
 *
 * 用途：粗搜。原尺寸 1712×1016 做全图 FFT 要 1 秒（纯 JS），
 * 缩到 1/4 后只有 428×254，FFT 规模小 16 倍，耗时降到几十毫秒。
 * 盒式平均能保留亮度结构、抑制高频噪声，比跳点采样稳定得多。
 *
 * @param {Float32Array} gray
 * @param {number} width
 * @param {number} height
 * @param {number} factor 整数倍率
 * @returns {{width:number, height:number, gray:Float32Array}}
 */
function downsample(gray, width, height, factor) {
  if (factor <= 1) return { width, height, gray };
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = new Float32Array(w * h);
  const inv = 1 / (factor * factor);

  for (let y = 0; y < h; y++) {
    const sy0 = y * factor;
    for (let x = 0; x < w; x++) {
      const sx0 = x * factor;
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (sy0 + dy) * width + sx0;
        for (let dx = 0; dx < factor; dx++) sum += gray[row + dx];
      }
      out[y * w + x] = sum * inv;
    }
  }
  return { width: w, height: h, gray: out };
}

/** 在帧上做一次局部精修：直接计算 NCC（范围小，裸算足够快） */
function refineNcc(ctx, tpl, cx, cy, radiusX, radiusY, threshold) {
  const tw = tpl.width;
  const th = tpl.height;
  const tplArea = tw * th;
  const tplNorm = Math.sqrt(tpl.centeredSq);
  const c = tpl.centered;
  const gray = ctx.gray;
  const W = ctx.width;

  let bestScore = -2;
  let bestX = cx;
  let bestY = cy;

  const x0 = Math.max(0, cx - radiusX);
  const x1 = Math.min(ctx.width - tw, cx + radiusX);
  const y0 = Math.max(0, cy - radiusY);
  const y1 = Math.min(ctx.height - th, cy + radiusY);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 分子：去均值模板 与 帧窗口 的点积（帧窗口用均值中心化等价处理）
      let num = 0;
      const s = ctx.sum(x, y, tw, th);
      const mean = s / tplArea;
      for (let ty = 0; ty < th; ty++) {
        const row = (y + ty) * W + x;
        let acc = 0;
        for (let tx = 0; tx < tw; tx++) acc += gray[row + tx] * c[ty * tw + tx];
        num += acc - mean * 0; // 模板已去均值，常数项为 0
      }
      const sSq = ctx.sumSq(x, y, tw, th);
      const frameVar = sSq - (s * s) / tplArea;
      if (frameVar <= 1e-6) continue;
      const score = num / (Math.sqrt(frameVar) * tplNorm);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestScore < threshold) return null;
  return {
    x: bestX,
    y: bestY,
    width: tw,
    height: th,
    score: Math.min(1, bestScore),
    cx: bestX + Math.floor(tw / 2),
    cy: bestY + Math.floor(th / 2),
  };
}

// ---------------------------------------------------------------- 匹配核心

const MAX_CANDIDATES = 24;

/** 粗搜降采样倍率。4 → 面积缩 16 倍，实测精度足够（粗搜只需定位到 ±factor 像素） */
const COARSE_FACTOR = 4;

/**
 * 在帧里匹配一个模板。
 *
 * 采用**由粗到精**两级策略：
 *   1. 粗搜：帧和模板都降采样 1/COARSE_FACTOR，用 FFT 做全图 NCC
 *   2. 精修：对粗搜的前若干候选，在原始分辨率上做局部 NCC
 *
 * 这样既保住全图搜索能力，又避免纯 JS 在 1712×1016 上做两次大 FFT（约 1 秒）。
 *
 * @param {FrameContext} ctx
 * @param {Template} tpl
 * @param {object} [region] {x,y,width,height} 限制搜索区域（内容区内坐标）
 * @param {number} [threshold] 达到此分数才算命中
 * @param {object} [opts]
 * @param {number} [opts.factor] 粗搜倍率，默认 4；设 1 则直接全分辨率匹配
 * @param {number} [opts.maxRefine] 精修候选数，默认 5
 * @returns {{x,y,width,height,score,cx,cy,all}|null}
 */
function matchTemplate(ctx, tpl, region, threshold = 0.8, opts = {}) {
  const factor = Math.max(1, Math.floor(opts.factor || COARSE_FACTOR));
  const maxRefine = Math.max(1, Math.floor(opts.maxRefine || 5));

  const ox = region ? region.x : 0;
  const oy = region ? region.y : 0;
  const rw = region ? region.width : ctx.width - ox;
  const rh = region ? region.height : ctx.height - oy;

  if (rw < tpl.width || rh < tpl.height) return null;

  // ★ 判定「能不能用粗搜」——这里以前写反了，导致大模板反而最慢（踩过的坑）
  //
  //   旧条件： rw >= tpl.width * factor * 2 && rh >= tpl.height * factor * 2
  //   问题：  模板越大越难满足 → **大模板被踢到全分辨率路径**，而它恰恰最贵。
  //   实测（1718×1009 内容区，factor=4）：
  //     btn_start_battle   134×62   → 粗搜  512×512        （几十毫秒）
  //     title_battle_result 228×126 → 全分辨率 2048×2048   （4.2M 点）
  //     btn_result_confirm 370×171  → 全分辨率 4096×2048   （8.4M 点）
  //   纯 JS 跑 8.4M 点的正+逆 FFT，单帧就要数秒；几帧连起来主线程被完全占满，
  //   Windows 判定窗口「未响应」并把程序关掉（事件日志 AppHangB1）。
  //   用户看到的就是「点开始后过一会儿整个程序无响应崩掉」。
  //
  //   新条件只要求：降采样后模板还有足够细节，且降采样后的帧比模板大（有搜索空间）。
  //   粗搜只负责定位大致位置，精确坐标由 refineNcc 在全分辨率上补回，
  //   所以放宽这个条件不影响精度（已有测试覆盖坐标误差 ≤1px）。
  const dsTw = Math.max(1, Math.floor(tpl.width / factor));
  const dsTh = Math.max(1, Math.floor(tpl.height / factor));
  const dsW = Math.floor(rw / factor);
  const dsH = Math.floor(rh / factor);

  const useCoarse = factor > 1
    && dsTw >= 6 && dsTh >= 6      // 降采样后模板不能太小，否则找不到可靠峰值
    && dsW > dsTw && dsH > dsTh;   // 降采样后的帧必须比模板大，否则没有搜索空间

  if (!useCoarse) {
    return matchFullRes(ctx, tpl, region, threshold);
  }

  // ---------- 1. 粗搜 ----------
  const ctxKey = `ds${factor}`;
  let coarseCtx;
  let cached = ctx._coarseCache && ctx._coarseCache.get(ctxKey);
  if (cached) {
    coarseCtx = cached;
  } else {
    const ds = downsample(ctx.gray, ctx.width, ctx.height, factor);
    coarseCtx = new FrameContext(ds.gray, ds.width, ds.height);
    if (!ctx._coarseCache) ctx._coarseCache = new Map();
    ctx._coarseCache.set(ctxKey, coarseCtx);
  }

  // 模板也缩到同一尺度
  const tplDs = downsample(tpl.gray, tpl.width, tpl.height, factor);
  const coarseTpl = new Template(
    tpl.name + `@1/${factor}`,
    tplDs.gray, tplDs.width, tplDs.height
  );

  const coarseRegion = {
    x: Math.floor(ox / factor),
    y: Math.floor(oy / factor),
    width: Math.max(1, Math.floor(rw / factor)),
    height: Math.max(1, Math.floor(rh / factor)),
  };

  // 粗搜用宽松阈值，只要候选
  const coarse = matchFullRes(coarseCtx, coarseTpl, coarseRegion, 0.35);
  if (!coarse) return null;

  const cands = (coarse.all && coarse.all.length ? coarse.all : [{ x: coarse.x, y: coarse.y }])
    .slice(0, maxRefine);

  // ---------- 2. 精修 ----------
  const refined = [];
  for (const c of cands) {
    // 粗搜坐标 → 原始坐标（取中心，避免倍数换算的边界误差）
    const approxX = c.x * factor;
    const approxY = c.y * factor;
    const hit = refineNcc(ctx, tpl, approxX, approxY, factor + 1, factor + 1, threshold);
    if (hit) refined.push(hit);
  }

  if (refined.length === 0) return null;

  refined.sort((a, b) => b.score - a.score);
  const best = refined[0];
  best.all = refined;
  return best;
}

/** 全分辨率（或不做降采样的尺度）上做一次 FFT NCC */
function matchFullRes(ctx, tpl, region, threshold) {
  const ox = region ? region.x : 0;
  const oy = region ? region.y : 0;
  const W = region ? region.width : ctx.width;
  const H = region ? region.height : ctx.height;

  if (W < tpl.width || H < tpl.height) return null;

  const fftW = nextPow2(W + tpl.width);
  const fftH = nextPow2(H + tpl.height);

  if (region) {
    const sub = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (oy + y) * ctx.width + ox;
      sub.set(ctx.gray.subarray(src, src + W), y * W);
    }
    const subCtx = new FrameContext(sub, W, H);
    const frameFft = subCtx.fftFor(fftW, fftH);
    return finalize(subCtx, tpl, frameFft, fftW, fftH, ox, oy, threshold);
  }

  const frameFft = ctx.fftFor(fftW, fftH);
  return finalize(ctx, tpl, frameFft, fftW, fftH, 0, 0, threshold);
}

/**
 * 频域相乘 + 逆变换 + NCC 归一化 + 取峰值。
 *
 * NCC 公式（每个候选位置 (x,y)）：
 *   score = Σ[(I-Ī)·(T-T̄)] / sqrt( Σ(I-Ī)² · Σ(T-T̄)² )
 * 分子由 FFT 相关得到；分母的两项分别来自帧的积分图和模板的预计算值。
 */
function finalize(ctx, tpl, frameFft, fftW, fftH, offX, offY, threshold) {
  const tplFft = tpl.fftFor(fftW, fftH);

  const re = new Float64Array(fftW * fftH);
  const im = new Float64Array(fftW * fftH);
  const n = fftW * fftH;
  const aRe = frameFft.re;
  const aIm = frameFft.im;
  const bRe = tplFft.re;
  const bIm = tplFft.im;

  // 频域相乘，模板取共轭 → 结果为相关（cross-correlation）
  //   A·conj(B) 的逆变换，其 (x,y) 处正是"帧在 (x,y) 处与模板的未归一化相关"。
  // 注意：不能对模板做空间翻转后再相乘，那样得到的是卷积，峰值会错位。
  for (let i = 0; i < n; i++) {
    re[i] = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    im[i] = aIm[i] * bRe[i] - aRe[i] * bIm[i];
  }

  fft2d(re, im, fftW, fftH, true);

  const tw = tpl.width;
  const th = tpl.height;
  const tplArea = tw * th;
  const tplNorm = Math.sqrt(tpl.centeredSq);
  const tplMeanSum = tplArea * tpl.mean;

  const maxX = ctx.width - tw;
  const maxY = ctx.height - th;
  const resW = maxX + 1;
  const resH = maxY + 1;

  // 收集候选峰值（只保留明显高于阈值的，便于调试时看多个命中）
  const candidates = [];
  const minScore = Math.max(0.3, threshold - 0.35);

  for (let y = 0; y <= maxY; y++) {
    const rowOff = y * fftW;
    for (let x = 0; x <= maxX; x++) {
      // 模板空间翻转后放在原点，所以峰值直接出现在 (x, y)
      const numerator = re[rowOff + x];
      if (numerator <= 0) continue;

      const s = ctx.sum(x, y, tw, th);
      const sSq = ctx.sumSq(x, y, tw, th);
      // 帧窗口去均值后的平方和
      const frameVar = sSq - (s * s) / tplArea;
      if (frameVar <= 1e-6) continue; // 纯色块，无特征

      const score = numerator / (Math.sqrt(frameVar) * tplNorm);
      if (score >= minScore) {
        candidates.push({ x: x + offX, y: y + offY, score });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);

  // 非极大值抑制：去掉与已选峰值距离过近的候选
  const picked = [];
  const minDistX = Math.max(2, tw / 2);
  const minDistY = Math.max(2, th / 2);
  for (const c of candidates) {
    if (picked.length >= MAX_CANDIDATES) break;
    let tooClose = false;
    for (const p of picked) {
      if (Math.abs(p.x - c.x) < minDistX && Math.abs(p.y - c.y) < minDistY) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) picked.push(c);
  }

  const best = picked[0];
  if (!best || best.score < threshold) return null;

  return {
    x: best.x,
    y: best.y,
    width: tw,
    height: th,
    score: Math.min(1, best.score),
    // 中心点，点击时通常用这个
    cx: best.x + Math.floor(tw / 2),
    cy: best.y + Math.floor(th / 2),
    // 所有超过阈值的命中（调试用）
    all: picked.filter((c) => c.score >= threshold),
  };
}

// ---------------------------------------------------------------- 素材库

/**
 * 素材库：从 assets/ 加载 PNG，按需转灰度并缓存 Template。
 *
 * 素材规范（见 README）：
 *   - 必须是**内容区**里裁出来的图（不是整窗截图）
 *   - PNG 格式，宽高 20-120 像素
 *   - 文件名就是配置里引用的名字
 */
class TemplateLibrary {
  constructor(assetsDir, opts = {}) {
    this.dir = assetsDir;
    this.grayscale = opts.grayscale !== false;
    /** @type {Map<string, Template>} */
    this._templates = new Map();
    /** @type {Map<string, Template>} 按当前 scale 缩放后的副本 */
    this._scaled = new Map();
    this.loadErrors = new Map();
    // 1.0 = 素材原始尺寸。游戏窗口大小变了就要相应调整，否则全部匹配不上。
    this.scale = 1;
    /** 缩放后尺寸的上下限，防止极端比例把模板缩成 1px 或撑爆内存 */
    this.minSide = 6;
    this.maxSide = 900;
  }

  /** 列出目录里的 PNG 文件名 */
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.png'));
  }

  /** 检查缺失的素材名 */
  missing(names) {
    const present = new Set(this.list());
    return names.filter((n) => !present.has(n));
  }

  /**
   * 设置全局缩放比（= 当前内容区宽 / 素材采集时的内容区宽）。
   *
   * 为什么需要：模板匹配对**平移**不敏感，但对**缩放**非常敏感。
   * 实测同一个「挑战」按钮，窗口从 1718 缩到 1501（比例 0.874）后，
   * 匹配分数直接从 1.0 掉到 0.34 —— 所有素材一起失效，看起来像"素材坏了"。
   *
   * 把模板缩放到当前尺寸后，一个缩放比就能救回全部素材。
   */
  setScale(scale) {
    const s = Number(scale);
    if (!Number.isFinite(s) || s <= 0) return;
    // 变化小于 1% 就不折腾（避免每帧重建）
    if (Math.abs(s - this.scale) < 0.01 && this._scaled.size > 0) return;
    this.scale = s;
    this._scaled.clear();
  }

  /**
   * 取模板，没加载过就加载。
   * @param {string} name
   * @param {{raw?:boolean}} [opts] raw=true 返回原始尺寸（不缩放）
   * @returns {Template|null} 文件不存在或解码失败返回 null
   */
  get(name, opts) {
    const tpl = this._getRaw(name);
    if (!tpl) return null;
    if ((opts && opts.raw) || Math.abs(this.scale - 1) < 0.01) return tpl;

    const hit = this._scaled.get(name);
    if (hit) return hit;

    const nw = Math.round(tpl.width * this.scale);
    const nh = Math.round(tpl.height * this.scale);
    if (nw < this.minSide || nh < this.minSide || nw > this.maxSide || nh > this.maxSide) {
      // 比例太离谱：宁可用原尺寸，也不要产生一个匹配不上的怪模板
      return tpl;
    }
    const scaled = new Template(
      name, resizeGray(tpl.gray, tpl.width, tpl.height, nw, nh), nw, nh);
    this._scaled.set(name, scaled);
    return scaled;
  }

  _getRaw(name) {
    if (this._templates.has(name)) return this._templates.get(name);
    if (this.loadErrors.has(name)) return null;

    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) {
      this.loadErrors.set(name, '文件不存在');
      return null;
    }
    try {
      const { width, height, gray } = loadPngGray(file);
      const tpl = new Template(name, gray, width, height);
      this._templates.set(name, tpl);
      return tpl;
    } catch (err) {
      this.loadErrors.set(name, err.message);
      return null;
    }
  }
}

/** 双线性缩放灰度数组 */
function resizeGray(gray, w, h, nw, nh) {
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * h / nh - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * w / nw - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, sx - x0));
      const a = gray[y0 * w + x0], b = gray[y0 * w + x1];
      const c = gray[y1 * w + x0], d = gray[y1 * w + x1];
      out[y * nw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

/** 从一帧像素建 FrameContext（供多次匹配复用 FFT） */
function createFrameContext(frame) {
  const { width, height, bgra } = frame;
  const gray = new Float32Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * bgra[o + 2] + 0.587 * bgra[o + 1] + 0.114 * bgra[o];
  }
  return new FrameContext(gray, width, height);
}

module.exports = {
  FrameContext,
  Template,
  TemplateLibrary,
  resizeGray,
  createFrameContext,
  matchTemplate,
  matchFullRes,
  downsample,
  refineNcc,
  loadPngGray,
  COARSE_FACTOR,
  // 导出底层函数便于单独测试
  nextPow2,
  fft1d,
  fft2d,
};
