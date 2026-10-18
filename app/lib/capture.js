/**
 * 截图与 PNG 编码。
 *
 * 单独成模块的原因：截图是纯逻辑（不依赖 Electron），
 * 这样可以脱离 Electron 直接跑测试，也便于 probe.js 复用。
 */

'use strict';

const native = require('./native');

/**
 * 判定"全黑/不可用画面"的平均亮度阈值（0-255）。
 * 低于此值就认为这一帧没抓到有效画面，触发降级链的下一级。
 * 实测：抓到真实游戏画面时亮度在 60-120 之间，全黑时是 0。
 */
const BLANK_THRESHOLD = 3;

let PNG = null;
function ensurePng() {
  if (PNG) return PNG;
  try {
    PNG = require('pngjs').PNG;
  } catch (err) {
    throw new Error('pngjs 未安装，无法编码 PNG。请执行: npm install\n原始错误: ' + err.message);
  }
  return PNG;
}

/**
 * 抓取窗口原始像素。
 * @param {number} hwnd
 * @param {object} [rect]
 * @param {'bitblt'|'printwindow'|'printwindow_full'} [method]
 * @returns {{width:number, height:number, bgra:Buffer}}
 */
function grab(hwnd, rect, method) {
  return native.captureWindow(hwnd, rect, method);
}

/**
 * 把 BGRA 像素编码成 PNG。
 *
 * GDI 给的是 BGRA 且 alpha 通道无效（通常全 0），
 * 直接当 RGBA 编码会得到全透明图片，所以必须把 A 强行置 255。
 *
 * @param {{width:number, height:number, bgra:Buffer}} frame
 * @returns {Buffer} PNG 字节
 */
function encodePng(frame) {
  const Png = ensurePng();
  const { width, height, bgra } = frame;

  const png = new Png({ width, height });
  const out = png.data;
  const pixels = width * height;

  for (let i = 0; i < pixels; i++) {
    const s = i * 4;
    const d = i * 4;
    out[d] = bgra[s + 2];     // R <- B 位偏移 2
    out[d + 1] = bgra[s + 1]; // G
    out[d + 2] = bgra[s];     // B <- R 位偏移 0
    out[d + 3] = 255;         // A 强制不透明
  }

  return Png.sync.write(png);
}

/**
 * 抓取并编码，一步到位。
 * @returns {{width:number, height:number, png:Buffer, elapsedMs:number}}
 */
function grabPng(hwnd, rect, method) {
  const t0 = Date.now();
  const frame = grab(hwnd, rect, method);
  const png = encodePng(frame);
  return { width: frame.width, height: frame.height, png, elapsedMs: Date.now() - t0 };
}

/**
 * 计算画面的平均亮度（0-255）。
 *
 * 用途有两个：
 *   1. 判断"全黑" —— 游戏用 GPU 合成时 GDI 会截到黑屏
 *   2. 作为不同截图方式的**有效性指标** —— 亮度高的那种方式更可能拿到了真实画面
 *
 * 抽样统计即可，不必遍历全部像素。
 */
function meanBrightness(frame) {
  const { bgra } = frame;
  const pixels = frame.width * frame.height;
  if (!pixels || !bgra || bgra.length < pixels * 4) return 0;

  const step = Math.max(1, Math.floor(pixels / 20000));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pixels; i += step) {
    const o = i * 4;
    // 只用 G 通道近似亮度即可，省两次内存访问
    sum += bgra[o + 1];
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * 判断一张图是不是"全黑/几乎全黑"。
 * @param {object} frame
 * @param {number} threshold 平均亮度阈值（0-255）
 */
function isLikelyBlank(frame, threshold = 3) {
  return meanBrightness(frame) < threshold;
}

// ---------------------------------------------------------------- 内容区探测

/**
 * 从一帧图像里探测真实内容区域（去掉黑边）。
 *
 * ★ 为什么必须要这一步（实测结论）：
 *   MuMu 模拟器的客户区是 1704x960，但阴阳师只渲染在左上角 1141x658，
 *   其余是模拟器填充的纯黑。如果直接按窗口矩形截图并全图做模板匹配：
 *     - 黑边会拉低匹配分数
 *     - 素材坐标和实际点击坐标对不上
 *   所以必须先定位内容区，之后所有匹配和点击都换算到这个 ROI 内部。
 *
 * 算法：逐行逐列求平均亮度，从四边向中间收敛到第一个超过阈值的位置。
 *
 * @param {object} frame {width, height, bgra}
 * @param {number} threshold 亮度阈值，低于此视为黑边
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function detectContentBounds(frame, threshold = 4) {
  const { width: W, height: H, bgra } = frame;
  if (!W || !H || !bgra) return null;

  const rowBright = new Float64Array(H);
  const colBright = new Float64Array(W);

  for (let y = 0; y < H; y++) {
    let s = 0;
    const rowOff = y * W * 4;
    for (let x = 0; x < W; x++) {
      const v = bgra[rowOff + x * 4 + 1]; // G 通道
      s += v;
      colBright[x] += v;
    }
    rowBright[y] = s / W;
  }
  for (let x = 0; x < W; x++) colBright[x] /= H;

  let top = 0;
  while (top < H - 1 && rowBright[top] < threshold) top++;
  let bottom = H - 1;
  while (bottom > top && rowBright[bottom] < threshold) bottom--;

  let left = 0;
  while (left < W - 1 && colBright[left] < threshold) left++;
  let right = W - 1;
  while (right > left && colBright[right] < threshold) right--;

  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < 16 || h < 16) return null; // 太小，判定为探测失败

  return { x: left, y: top, width: w, height: h };
}

/**
 * 带降级链的截图：优先窗口 DC，全黑则退回屏幕 DC。
 *
 * ★ 为什么必须有降级（实测结论）
 *   同一台 MuMu 模拟器窗口，在不同渲染状态下：
 *     窗口 DC BitBlt   -> 亮度 0.0（全黑，抓不到画面）
 *     屏幕 DC 抓同区域 -> 亮度 115.8（有画面）
 *   窗口 DC 是否可用取决于窗口内容是否走 GPU 合成，**会随模拟器状态变化**，
 *   所以不能只依赖一种方式。
 *
 * ★ 顺序修正：PrintWindow 必须排在 screen 后面（踩过的坑，代价是程序卡死）
 *
 *   `PrintWindow` 会对目标窗口发**同步**消息（WM_PRINT），调用方要等对端处理完
 *   才返回。目标程序一忙（进战斗读条、加载资源、编译着色器），这个调用就无限阻塞；
 *   而我们是在 Electron 主进程里同步调用它的 —— 主线程被卡住，窗口不再响应消息，
 *   Windows 判定「未响应」后把程序关掉（事件日志：AppHangB1）。
 *
 *   原来的顺序是 bitblt → printwindow_full → printwindow → screen。
 *   协同合成窗口的 bitblt 每帧都全黑，意味着**每一帧都在调 PrintWindow**，
 *   等于每帧都赌一次「游戏此刻不忙」。
 *
 *   现在改为 bitblt → screen → printwindow_full → printwindow：
 *   screen 又便宜又安全，正常情况走不到 PrintWindow。
 *   另外支持调用方传 `skip`（已验证无效的方式）和 `prefer`（学会的方式），
 *   以及环境变量 OMJ_NO_PRINTWINDOW=1 彻底禁用 PrintWindow。
 *
 * @param {number} hwnd
 * @param {object} [opts]
 * @param {boolean} [opts.allowScreenFallback=true] 是否允许降级到屏幕 DC
 * @param {boolean} [opts.allowPrintWindow=true]    是否允许降级到 PrintWindow
 * @param {string}  [opts.prefer]   优先尝试的方式
 * @param {string[]} [opts.skip]    跳过这些方式
 * @returns {{frame:object, method:string, attempted:string[], failed:Array}}
 */
function captureWithFallback(hwnd, opts = {}) {
  const winBounds = native.getWindowBounds(hwnd);
  if (!winBounds) throw new Error('无法获取窗口边界');

  const attempts = [];
  const errors = [];
  const failed = [];
  const allowScreen = opts.allowScreenFallback !== false;
  const skip = new Set(Array.isArray(opts.skip) ? opts.skip : []);

  // PrintWindow 可能无限阻塞，允许从环境变量里彻底关掉
  const envNoPw = process.env.OMJ_NO_PRINTWINDOW === '1';
  const allowPw = opts.allowPrintWindow !== false && !envNoPw;

  // 默认顺序：便宜且安全的优先，危险的 PrintWindow 垫底
  const methods = ['bitblt'];
  if (allowScreen) methods.push('screen');
  if (allowPw) methods.push('printwindow_full', 'printwindow');

  // 学会的方式先试，其余按默认顺序
  const ordered = [];
  if (opts.prefer && methods.indexOf(opts.prefer) >= 0) ordered.push(opts.prefer);
  for (const m of methods) if (ordered.indexOf(m) < 0) ordered.push(m);

  for (const method of ordered) {
    if (skip.has(method)) {
      failed.push({ method, reason: '此前无效，已跳过' });
      continue;
    }
    attempts.push(method);
    try {
      let frame;
      if (method === 'screen') {
        frame = native.captureScreen(winBounds);
      } else {
        frame = native.captureWindow(hwnd, winBounds, method);
      }
      const bright = meanBrightness(frame);
      if (bright >= BLANK_THRESHOLD) {
        return { frame, method, attempted: attempts, failed };
      }
      const reason = `全黑(亮度 ${bright.toFixed(1)})`;
      errors.push(`${method}: ${reason}`);
      failed.push({ method, reason, black: true });
    } catch (err) {
      errors.push(`${method}: ${err.message}`);
      failed.push({ method, reason: err.message });
    }
  }

  // 全部失败：返回最后拿到的帧（哪怕全黑），让调用方自己决定
  const last = (() => {
    try {
      return native.captureWindow(hwnd, winBounds, 'bitblt');
    } catch (err) {
      try {
        return native.captureScreen(winBounds);
      } catch (err2) {
        throw new Error('所有截图方式均失败:\n  ' + errors.join('\n  '));
      }
    }
  })();

  return {
    frame: last,
    method: 'none-usable',
    attempted: attempts,
    failed,
    warning: '所有截图方式都拿到黑屏:\n  ' + errors.join('\n  ') +
      '\n可能原因：窗口已最小化、被完全遮挡、或使用了独占全屏。',
  };
}

/**
 * 抓取窗口并自动定位内容区，返回裁剪后的帧和映射信息。
 *
 * @param {number} hwnd
 * @param {object} [opts]
 * @param {{x:number,y:number,width:number,height:number}} [opts.roi]
 *        已知内容区就直接用，省一次探测
 * @param {boolean} [opts.allowScreenFallback=true]
 * @returns {{frame:object, roi:object, fullSize:object, windowOrigin:object,
 *            method:string, warning?:string}}
 *   frame        —— 裁剪后的内容区像素，尺寸 = roi 尺寸
 *   roi          —— 内容区在**抓取图内**的相对坐标
 *   fullSize     —— 未裁剪前的抓取图尺寸
 *   windowOrigin —— 抓取区域左上角的屏幕坐标
 *   method       —— 实际生效的截图方式
 *
 * 坐标换算（重要）：
 *   屏幕坐标 = windowOrigin + (roi.x + cx, roi.y + cy)
 *   其中 (cx, cy) 是内容区内的像素坐标。
 *   screen 方式下 windowOrigin 恒为窗口左上角（截的就是窗口那块屏幕），
 *   所以该公式对两种方式都成立。
 */
function grabContent(hwnd, opts = {}) {
  const { frame: full, method, warning, failed, attempted } = captureWithFallback(hwnd, opts);
  const winBounds = native.getWindowBounds(hwnd);

  let roi = opts.roi;
  if (!roi) {
    roi = detectContentBounds(full);
    if (!roi) {
      // 探测失败（纯黑，或整个画面都很暗），退回整窗，保证不崩
      roi = { x: 0, y: 0, width: full.width, height: full.height };
    }
  }

  // 按 ROI 裁剪。逐行用 Buffer 切片 + copy，比逐像素快得多
  const crop = Buffer.alloc(roi.width * roi.height * 4);
  const srcRowBytes = full.width * 4;
  const dstRowBytes = roi.width * 4;
  const srcRow = Buffer.allocUnsafe(srcRowBytes);
  for (let row = 0; row < roi.height; row++) {
    const srcStart = (roi.y + row) * srcRowBytes + roi.x * 4;
    full.bgra.copy(srcRow, 0, srcStart, srcStart + dstRowBytes);
    srcRow.copy(crop, row * dstRowBytes, 0, dstRowBytes);
  }

  const out = {
    frame: { width: roi.width, height: roi.height, bgra: crop },
    roi,
    fullSize: { width: full.width, height: full.height },
    windowOrigin: { left: winBounds.left, top: winBounds.top },
    method,
    // 供 Runner 学习：哪些方式无效、这次试了哪些
    failed: failed || [],
    attempted: attempted || [],
  };
  if (warning) out.warning = warning;
  return out;
}

module.exports = {
  grab,
  grabScreen: native.captureScreen,
  encodePng,
  grabPng,
  meanBrightness,
  isLikelyBlank,
  detectContentBounds,
  captureWithFallback,
  grabContent,
  BLANK_THRESHOLD,
};
