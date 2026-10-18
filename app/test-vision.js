/**
 * 视觉模块自测（不需要游戏运行）
 *
 * 覆盖：
 *   A. FFT 正确性（与暴力 DFT 对比）
 *   B. 合成图上模板匹配的**坐标精确性**
 *   C. 亮度变化下的鲁棒性（NCC 应不受整体加减影响）
 *   D. 纯色块不误匹配
 *   E. region 限制生效
 *   F. 真实游戏截图的**自匹配**（裁一块再找回来）
 *   G. 性能（1712×1016 帧上的单模板匹配耗时）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const vision = require('./lib/vision');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name + (detail ? '  ' + detail : ''));
    console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------- PNG 写入

/**
 * 极简 PNG 编码器（灰度/RGB 都走 RGB），避免依赖 pngjs 的写入路径。
 * 只为了测试能生成素材文件。
 */
function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = y * (width * 3 + 1) + 1 + x * 3;
      raw[d] = rgb[s];
      raw[d + 1] = rgb[s + 1];
      raw[d + 2] = rgb[s + 2];
    }
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ---------------------------------------------------------------- 测试图

/** 生成有丰富纹理的合成图，返回 {width,height,gray:Uint8Array} */
function makeScene(width, height, seed = 1) {
  const gray = new Uint8Array(width * height);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s >>> 16) & 0xff;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 大块渐变 + 噪声，保证有足够纹理（纯噪声不利于 NCC 定位）
      const base = 60 + 100 * Math.sin(x / 37) * Math.cos(y / 23);
      gray[y * width + x] = Math.max(0, Math.min(255, base + (rnd() % 40) - 20));
    }
  }
  return { width, height, gray };
}

function grayToBgra(gray, width, height) {
  const bgra = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    bgra[i * 4] = gray[i];
    bgra[i * 4 + 1] = gray[i];
    bgra[i * 4 + 2] = gray[i];
    bgra[i * 4 + 3] = 255;
  }
  return bgra;
}

function ctxFromGray(gray, width, height) {
  return new vision.FrameContext(Float32Array.from(gray), width, height);
}

function writeTemplateFromGray(dir, name, gray, width, height, sx, sy, tw, th) {
  const rgb = Buffer.alloc(tw * th * 3);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const v = gray[(sy + y) * width + (sx + x)];
      const d = (y * tw + x) * 3;
      rgb[d] = v; rgb[d + 1] = v; rgb[d + 2] = v;
    }
  }
  writePng(path.join(dir, name), tw, th, rgb);
}

// ---------------------------------------------------------------- 主流程

function main() {
  const tmpDir = 'F:\\WorkSpace\\vision-test';
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('='.repeat(60));
  console.log('  视觉模块自测');
  console.log('='.repeat(60));

  // ---------- A. FFT 正确性 ----------
  console.log('\n[A] FFT 正确性');
  {
    const n = 8;
    const re = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const im = new Float64Array(n);
    const orig = Float64Array.from(re);
    vision.fft1d(re, im, false);
    vision.fft1d(re, im, true);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]));
    check('FFT 正逆变换可还原', maxErr < 1e-9, `最大误差 ${maxErr.toExponential(2)}`);

    const p2 = vision.nextPow2(1000);
    check('nextPow2(1000)=1024', p2 === 1024, String(p2));
    check('nextPow2(1024)=1024', vision.nextPow2(1024) === 1024);
  }

  // ---------- B. 合成图坐标精确性 ----------
  console.log('\n[B] 合成图模板匹配');
  const W = 640, H = 480;
  const scene = makeScene(W, H, 7);
  const ctx = ctxFromGray(scene.gray, W, H);

  const TW = 80, TH = 40;
  const TARGET_X = 377, TARGET_Y = 211;

  // 从场景里裁模板
  const tplGray = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      tplGray[y * TW + x] = scene.gray[(TARGET_Y + y) * W + (TARGET_X + x)];
    }
  }
  const tpl = new vision.Template('synthetic.png', tplGray, TW, TH);

  const t0 = Date.now();
  const hit = vision.matchTemplate(ctx, tpl, null, 0.9);
  const ms = Date.now() - t0;

  check('合成图上命中', hit !== null, hit ? `score=${hit.score.toFixed(4)}` : '未命中');
  if (hit) {
    const dx = Math.abs(hit.x - TARGET_X);
    const dy = Math.abs(hit.y - TARGET_Y);
    check('定位精确（误差<=1px）', dx <= 1 && dy <= 1, `目标(${TARGET_X},${TARGET_Y}) 实测(${hit.x},${hit.y}) 偏差(${dx},${dy})`);
    check('分数足够高', hit.score > 0.98, hit.score.toFixed(4));
    check('返回中心点', hit.cx === hit.x + 40 && hit.cy === hit.y + 20, `(${hit.cx},${hit.cy})`);
  }

  // ---------- C. 亮度鲁棒性 ----------
  console.log('\n[C] 亮度变化鲁棒性');
  {
    // 整体 +30，NCC 应基本不受影响
    const brighter = new Uint8Array(scene.gray.length);
    for (let i = 0; i < scene.gray.length; i++) {
      brighter[i] = Math.min(255, scene.gray[i] + 30);
    }
    const ctxB = ctxFromGray(brighter, W, H);
    const hitB = vision.matchTemplate(ctxB, tpl, null, 0.9);
    check('整体变亮后仍命中', hitB !== null,
      hitB ? `score=${hitB.score.toFixed(4)} 位置(${hitB.x},${hitB.y})` : '未命中');
    if (hitB) {
      check('变亮后位置不变', Math.abs(hitB.x - TARGET_X) <= 1 && Math.abs(hitB.y - TARGET_Y) <= 1,
        `(${hitB.x},${hitB.y})`);
    }
  }

  // ---------- D. 纯色块不应误匹配 ----------
  console.log('\n[D] 纯色块防误匹配');
  {
    const flat = new Float32Array(64 * 32);
    flat.fill(128);
    const flatTpl = new vision.Template('flat.png', flat, 64, 32);
    const flatHit = vision.matchTemplate(ctx, flatTpl, null, 0.5);
    check('纯色模板不命中（方差为0）', flatHit === null,
      flatHit ? `误命中 score=${flatHit.score.toFixed(3)}` : '正确拒绝');
  }

  // ---------- E. region 限制 ----------
  console.log('\n[E] region 搜索区域限制');
  {
    // 只在目标附近搜索 -> 命中
    const near = { x: TARGET_X - 30, y: TARGET_Y - 30, width: 160, height: 100 };
    const hitNear = vision.matchTemplate(ctx, tpl, near, 0.9);
    check('region 包含目标时命中', hitNear !== null,
      hitNear ? `(${hitNear.x},${hitNear.y})` : '未命中');

    // 在远离目标的区域搜索 -> 不命中
    const far = { x: 0, y: 0, width: 100, height: 80 };
    const hitFar = vision.matchTemplate(ctx, tpl, far, 0.9);
    check('region 不含目标时不命中', hitFar === null,
      hitFar ? `误命中 (${hitFar.x},${hitFar.y})` : '正确拒绝');
  }

  // ---------- F. 真实游戏截图自匹配 ----------
  console.log('\n[F] 真实游戏截图自匹配');
  const realShot = 'F:\\WorkSpace\\onmyoji-bot\\app\\debug\\probe_15272724.png';
  if (fs.existsSync(realShot)) {
    try {
      const real = vision.loadPngGray(realShot);
      const rctx = new vision.FrameContext(real.gray, real.width, real.height);
      console.log(`         真实截图: ${real.width}x${real.height}`);

      // 从真实截图里裁一块当模板（模拟"用户从截图裁素材"）
      const rtw = 90, rth = 36;
      const rx = Math.floor(real.width * 0.1);
      const ry = Math.floor(real.height * 0.06);
      const rg = new Float32Array(rtw * rth);
      for (let y = 0; y < rth; y++) {
        for (let x = 0; x < rtw; x++) {
          rg[y * rtw + x] = real.gray[(ry + y) * real.width + (rx + x)];
        }
      }
      const rtpl = new vision.Template('real.png', rg, rtw, rth);
      const rhit = vision.matchTemplate(rctx, rtpl, null, 0.9);
      check('真实截图自匹配命中', rhit !== null,
        rhit ? `score=${rhit.score.toFixed(4)} 位置(${rhit.x},${rhit.y}) 期望(${rx},${ry})` : '未命中');
      if (rhit) {
        check('真实截图定位精确', Math.abs(rhit.x - rx) <= 1 && Math.abs(rhit.y - ry) <= 1,
          `偏差(${Math.abs(rhit.x - rx)},${Math.abs(rhit.y - ry)})`);
      }
    } catch (err) {
      check('真实截图自匹配', false, err.message);
    }
  } else {
    console.log('         (无真实截图，跳过 —— 先跑 npm run probe 生成)');
  }

  // ---------- G. 性能 ----------
  console.log('\n[G] 性能');
  {
    const PW = 1712, PH = 1016;
    const perfScene = makeScene(PW, PH, 3);
    const pctx = ctxFromGray(perfScene.gray, PW, PH);
    const px = 900, py = 500;
    const pg = new Float32Array(100 * 40);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 100; x++) pg[y * 100 + x] = perfScene.gray[(py + y) * PW + (px + x)];
    }
    const ptpl = new vision.Template('perf.png', pg, 100, 40);

    const p0 = Date.now();
    const phit = vision.matchTemplate(pctx, ptpl, null, 0.85);
    const pms = Date.now() - p0;
    check('1712×1016 单模板匹配 < 800ms', pms < 800, `${pms}ms`);
    check('性能测试命中正确位置', phit !== null && Math.abs(phit.x - px) <= 1 && Math.abs(phit.y - py) <= 1,
      phit ? `(${phit.x},${phit.y}) 期望(${px},${py})` : '未命中');

    // 同帧第二次匹配应保持同样水平（粗搜 FFT 已缓存）
    const p1 = Date.now();
    vision.matchTemplate(pctx, ptpl, null, 0.85);
    const pms2 = Date.now() - p1;
    check('重复匹配稳定在 200ms 内', pms2 < 200, `首次 ${pms}ms → 再次 ${pms2}ms`);
  }

  // ---------- H. 大模板不能掉进全分辨率路径 ----------
  //
  // ★ 这条是为了防一次「程序无响应被 Windows 关掉」的事故。
  //
  //   粗搜的启用条件以前写成 `rw >= tpl.width * factor * 2`，
  //   结果是**模板越大越不满足条件**，大模板反而被迫走全分辨率 FFT：
  //     370×171 的模板 → FFT 4096×2048（8.4M 点）→ 单模板 1.7 秒
  //   三个模板串起来一帧 3.2 秒，主线程被完全占满，Windows 判定未响应后关闭程序。
  //
  //   上面的 [G] 用的是 100×40 的小模板，一直走粗搜，所以从来抓不到这个问题。
  //   这里用真实尺寸的大模板，锁死「大模板也必须走粗搜」和「坐标仍然准确」。
  console.log('\n[H] 大模板（不能掉进全分辨率路径）');
  {
    const BW = 1712, BH = 1016;
    const bigScene = makeScene(BW, BH, 7);
    const bx = 700, by = 400;

    const cases = [
      { w: 228, h: 126, budget: 900 },   // 事故里的中等模板
      { w: 370, h: 171, budget: 900 },   // 事故里最大的模板：修复前 1776ms
    ];

    for (const c of cases) {
      const tg = new Float32Array(c.w * c.h);
      for (let y = 0; y < c.h; y++) {
        for (let x = 0; x < c.w; x++) {
          tg[y * c.w + x] = bigScene.gray[(by + y) * BW + (bx + x)];
        }
      }
      const tpl = new vision.Template(`big_${c.w}x${c.h}.png`, tg, c.w, c.h);
      const bctx = ctxFromGray(bigScene.gray, BW, BH);

      const t0 = Date.now();
      const hit = vision.matchTemplate(bctx, tpl, null, 0.85);
      const ms = Date.now() - t0;

      check(`${c.w}×${c.h} 模板匹配 < ${c.budget}ms`, ms < c.budget, `${ms}ms`);
      check(`${c.w}×${c.h} 模板命中位置准确`,
        hit !== null && Math.abs(hit.x - bx) <= 1 && Math.abs(hit.y - by) <= 1,
        hit ? `(${hit.x},${hit.y}) 期望(${bx},${by}) 分数 ${hit.score.toFixed(3)}` : '未命中');
    }
  }

  // ---------- [I] 缩放鲁棒性（窗口改大小的救命功能）----------
  console.log('\n[I] 画面缩放 / 素材自动缩放');
  {
    // 合成一个 40x20 的模板，贴到画布上时按 s 倍缩放
    const TW = 40, TH = 20;
    const tplGray = new Float32Array(TW * TH);
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        tplGray[y * TW + x] = ((x >> 3) + (y >> 3)) % 2 === 0 ? 220 : 40;
      }
    }

    const CW = 300, CH = 200, PX = 120, PY = 80;
    function canvasWithScaled(scale) {
      const bg = new Float32Array(CW * CH).fill(90);
      const nw = Math.round(TW * scale), nh = Math.round(TH * scale);
      const g = vision.resizeGray(tplGray, TW, TH, nw, nh);
      for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) bg[(PY + y) * CW + (PX + x)] = g[y * nw + x];
      }
      return { gray: bg, nw, nh };
    }

    // resizeGray 自身
    const half = vision.resizeGray(tplGray, TW, TH, 20, 10);
    check('resizeGray 输出尺寸正确', half.length === 200, `${half.length} 像素`);
    const back = vision.resizeGray(half, 20, 10, TW, TH);
    // 缩放再复原必然有损（硬边棋盘格缩一半再放大，边缘会糊）。
    // 所以看**平均**误差而不是最大误差 —— 最大误差集中在那几个边缘像素上。
    let sumDiff = 0;
    for (let i = 0; i < tplGray.length; i++) sumDiff += Math.abs(back[i] - tplGray[i]);
    const meanDiff = sumDiff / tplGray.length;
    check('缩放再复原的平均误差可接受', meanDiff < 30, `平均像素差 ${meanDiff.toFixed(1)}`);

    const orig = new vision.Template('t.png', tplGray, TW, TH);

    for (const s of [1.0, 0.95, 0.9, 0.874]) {
      const c = canvasWithScaled(s);
      const ctx = ctxFromGray(c.gray, CW, CH);

      // 用原始尺寸素材匹配：画面被缩放过就会失效
      const rawHit = vision.matchTemplate(ctx, orig, null, 0);

      // 把素材按同样比例缩放后再匹配
      const scaled = new vision.Template('t.png',
        vision.resizeGray(tplGray, TW, TH, Math.round(TW * s), Math.round(TH * s)),
        Math.round(TW * s), Math.round(TH * s));
      const fitHit = vision.matchTemplate(ctx, scaled, null, 0);

      const rawScore = rawHit ? rawHit.score : 0;
      const fitScore = fitHit ? fitHit.score : 0;

      if (s === 1.0) {
        check('缩放 1.0 时原始素材命中', rawScore > 0.99, `分数 ${rawScore.toFixed(3)}`);
      } else {
        check(`画面缩到 ${s} 时原始素材明显失效`, rawScore < 0.9, `分数 ${rawScore.toFixed(3)}`);
      }
      check(`画面缩到 ${s} 时按比例缩放素材能命中`, fitScore > 0.99,
        `分数 ${fitScore.toFixed(3)}`);
    }
  }

  // ---------- 汇总 ----------  console.log('\n' + '='.repeat(60));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败项：');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(60));
  return fail === 0 ? 0 : 1;
}

process.exit(main());
