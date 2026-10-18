/**
 * 窗口几何 & 截图区域诊断
 *
 * 要搞清楚的问题：
 *   1. 屏幕分辨率、DPI 缩放、DPI 感知模式
 *   2. GetWindowRect / DWM 扩展边界 / GetClientRect / 客户区屏幕坐标 四者差多少
 *   3. BitBlt 抓到的图里，真实内容占多大区域
 *
 * 背景：探针抓到 1728x1019 的图，但游戏画面只占左上角 1139x679，其余是黑边。
 * 说明用的矩形不对。
 */
'use strict';

const koffi = require('koffi');
const fs = require('fs');
const path = require('path');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
let shcore = null;
try { shcore = koffi.load('shcore.dll'); } catch (e) { /* */ }

// ---------- PNG 编码 ----------
const { PNG } = require('pngjs');
function encodePng(width, height, bgra) {
  const png = new PNG({ width, height });
  const out = png.data;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const s = i * 4, d = i * 4;
    out[d] = bgra[s + 2];
    out[d + 1] = bgra[s + 1];
    out[d + 2] = bgra[s];
    out[d + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ---------- 结构体与函数 ----------
const RECT = koffi.struct('G_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('G_POINT', { x: 'int32', y: 'int32' });
const BIH = koffi.struct('G_BIH', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
  biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32', biClrImportant: 'uint32',
});

const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ G_RECT *r)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(void *h, _Out_ G_RECT *r)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void *h, _Inout_ G_POINT *p)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const GetWindowDC = user32.func('void * __stdcall GetWindowDC(void *h)');
const GetDC = user32.func('void * __stdcall GetDC(void *h)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(void *h, void *dc)');
const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *dc)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void *dc)');
const CreateCompatibleBitmap = gdi32.func('void * __stdcall CreateCompatibleBitmap(void *dc, int w, int h)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *o)');
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *dc, void *o)');
const BitBlt = gdi32.func('bool __stdcall BitBlt(void *d, int x, int y, int cx, int cy, void *s, int sx, int sy, uint32 rop)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(void *h, void *dc, uint32 flags)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(void *dc, void *bmp, uint32 s, uint32 l, _Out_ void *bits, _Inout_ G_BIH *bmi, uint32 u)');

let dwmapi = null;
try { dwmapi = koffi.load('dwmapi.dll'); } catch (e) { /* */ }
const DwmGetWindowAttribute = dwmapi
  ? dwmapi.func('int __stdcall DwmGetWindowAttribute(void *h, uint32 attr, _Out_ void *data, uint32 size)')
  : null;

// ---------- DPI 感知必须最先声明！ ----------
// ★ 实测教训：如果在窗口测量之后才声明，拿到的坐标是 150% 缩放后的逻辑值，
//   真实值要乘 1.5。这就是"素材坐标总是偏"的根因。
if (shcore) {
  const f = shcore.func('int __stdcall SetProcessDpiAwareness(int v)');
  const hr = f(2);
  console.log('SetProcessDpiAwareness(2) hr =', hr, hr === 0 ? '(成功: per-monitor)' : '(失败)');
  if (hr !== 0) {
    const g = user32.func('bool __stdcall SetProcessDPIAware()');
    console.log('  退回 SetProcessDPIAware:', g());
  }
}

// ---------- 找目标窗口 ----------
koffi.proto('int __stdcall G_EnumProc(void *h, intptr_t lp)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(G_EnumProc *cb, intptr_t lp)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *h)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *h)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *h, _Out_ uint16_t *b, int c)');

/**
 * ★ 关键：koffi 的 void* 参数只接受 BigInt，拒绝回调给的 External 对象。
 * 必须用 koffi.address() 转换。这就是 native.js 里 toHandle 的作用。
 */
const toHandle = (h) => (typeof h === 'bigint' ? h : koffi.address(h));

const candidates = [];
EnumWindows((h) => {
  if (!IsWindowVisible(h)) return 1;
  const len = GetWindowTextLengthW(h);
  if (len <= 0) return 1;
  const buf = new Uint16Array(len + 2);
  const n = GetWindowTextW(h, buf, buf.length);
  if (n <= 0) return 1;
  const title = Buffer.from(buf.buffer, 0, n * 2).toString('utf16le');
  if (title.includes('阴阳师') && !title.includes('DeepSeek')) {
    const r = {};
    GetWindowRect(toHandle(h), r);
    const w = r.right - r.left, hh = r.bottom - r.top;
    candidates.push({
      handle: h,
      addr: koffi.address(h),
      title,
      rect: r,
      w, h: hh,
      area: w * hh,
      offscreen: r.left <= -30000 || r.top <= -30000,
    });
  }
  return 1;
}, 0);

console.log('=== 0. 找到的阴阳师候选窗口 ===');
for (const c of candidates) {
  console.log(`  addr=${c.addr} "${c.title}" ${c.w}x${c.h} @(${c.rect.left},${c.rect.top})` +
    ` 面积=${c.area}${c.offscreen ? ' [屏幕外/隐藏]' : ''}`);
}

// 剔除屏幕外的隐藏窗口，取面积最大的那个
const visible = candidates.filter((c) => !c.offscreen && c.w > 200 && c.h > 200);
if (visible.length === 0) {
  console.log('\n没有找到可见的阴阳师窗口。可能游戏已最小化 —— 请把游戏窗口恢复出来再跑本脚本。');
  process.exit(1);
}
visible.sort((a, b) => b.area - a.area);
const target = visible[0];
console.log(`\n选定目标: addr=${target.addr} "${target.title}" ${target.w}x${target.h}`);
const H = target.addr; // 统一用 BigInt 句柄

// 先声明 DPI 感知
if (shcore) {
  const f = shcore.func('int __stdcall SetProcessDpiAwareness(int v)');
  const hr = f(2);
  console.log('SetProcessDpiAwareness(2) hr =', hr, hr === 0 ? '(成功: per-monitor)' : '(失败)');
}

console.log('\n=== 1. 屏幕与 DPI ===');
console.log('  SM_CXSCREEN (主屏宽)      :', GetSystemMetrics(0));
console.log('  SM_CYSCREEN (主屏高)      :', GetSystemMetrics(1));
console.log('  SM_CXVIRTUALSCREEN (虚拟屏宽):', GetSystemMetrics(78));
console.log('  SM_CYVIRTUALSCREEN (虚拟屏高):', GetSystemMetrics(79));

console.log('\n=== 2. 窗口几何 ===');
const wr = {};
GetWindowRect(H, wr);
console.log(`  GetWindowRect          : L=${wr.left} T=${wr.top} R=${wr.right} B=${wr.bottom}` +
  `  => ${wr.right - wr.left}x${wr.bottom - wr.top}`);

if (DwmGetWindowAttribute) {
  try {
    const d = {};
    const hr = DwmGetWindowAttribute(toHandle(H), 9, d, 16); // DWMWA_EXTENDED_FRAME_BOUNDS
    console.log(`  DWM 扩展边界 (hr=${hr})    : L=${d.left} T=${d.top} R=${d.right} B=${d.bottom}` +
      `  => ${d.right - d.left}x${d.bottom - d.top}`);
  } catch (e) {
    console.log('  DWM 扩展边界            : 调用失败 ->', e.message);
  }
}

const cr = {};
GetClientRect(H, cr);
console.log(`  GetClientRect          : ${cr.right - cr.left}x${cr.bottom - cr.top}`);

const pt = { x: 0, y: 0 };
ClientToScreen(H, pt);
console.log(`  客户区(0,0)的屏幕坐标    : (${pt.x}, ${pt.y})`);

// ---------- 截图对比 ----------
function shoot(label, x, y, w, h, usePrintWindow) {
  const hdcWin = usePrintWindow ? GetDC(null) : GetWindowDC(H);
  const hdcMem = CreateCompatibleDC(hdcWin);
  const hbm = CreateCompatibleBitmap(hdcWin, w, h);
  const old = SelectObject(hdcMem, hbm);

  let ok;
  if (usePrintWindow) {
    ok = PrintWindow(H, hdcMem, 0);
  } else {
    ok = BitBlt(hdcMem, 0, 0, w, h, hdcWin, x, y, 0x00cc0020);
  }

  const hdr = {
    biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32,
    biCompression: 0, biSizeImage: w * h * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
    biClrUsed: 0, biClrImportant: 0,
  };
  const bits = Buffer.alloc(w * h * 4);
  const lines = GetDIBits(hdcMem, hbm, 0, h, bits, hdr, 0);

  // 统计亮度
  let sum = 0, cnt = 0;
  const pixels = w * h;
  const step = Math.max(1, Math.floor(pixels / 20000));
  for (let i = 0; i < pixels; i += step) { sum += bits[i * 4 + 1]; cnt++; }
  const bright = cnt ? sum / cnt : 0;

  SelectObject(hdcMem, old);
  DeleteObject(hbm);
  DeleteDC(hdcMem);
  ReleaseDC(H, hdcWin);

  console.log(`  ${label.padEnd(34)} BitBlt/PW=${ok} GetDIBits=${lines} 平均亮度=${bright.toFixed(1)}`);

  try {
    const outDir = path.join(__dirname, 'debug');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `geom_${label.replace(/[^\w]/g, '_')}.png`), encodePng(w, h, bits));
  } catch (e) { /* */ }

  return bright;
}

console.log('\n=== 3. 三种截图区域对比 ===');
const wW = wr.right - wr.left, wH = wr.bottom - wr.top;
shoot('A_windowrect', wr.left, wr.top, wW, wH, false);

const cW = cr.right - cr.left, cH = cr.bottom - cr.top;
shoot('B_clientrect', pt.x, pt.y, cW, cH, false);

// 客户区裁剪到屏幕内
const cx0 = Math.max(pt.x, 0), cy0 = Math.max(pt.y, 0);
shoot('C_client_clipped', cx0, cy0,
  Math.max(1, Math.min(pt.x + cW, GetSystemMetrics(78)) - cx0),
  Math.max(1, Math.min(pt.y + cH, GetSystemMetrics(79)) - cy0), false);

shoot('D_printwindow', 0, 0, cW, cH, true);

// ---------- 用整屏截图再裁客户区（最可靠的兜底方案） ----------
console.log('\n=== 4. 整屏截图后裁剪客户区 ===');
{
  const SW = GetSystemMetrics(78), SH = GetSystemMetrics(79);
  const hdcScreen = GetDC(null);
  const hdcMem = CreateCompatibleDC(hdcScreen);
  const hbm = CreateCompatibleBitmap(hdcScreen, SW, SH);
  const old = SelectObject(hdcMem, hbm);
  const ok = BitBlt(hdcMem, 0, 0, SW, SH, hdcScreen, 0, 0, 0x00cc0020);

  const hdr = {
    biSize: 40, biWidth: SW, biHeight: -SH, biPlanes: 1, biBitCount: 32,
    biCompression: 0, biSizeImage: SW * SH * 4, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
    biClrUsed: 0, biClrImportant: 0,
  };
  const bits = Buffer.alloc(SW * SH * 4);
  const lines = GetDIBits(hdcMem, hbm, 0, SH, bits, hdr, 0);
  console.log(`  整屏 BitBlt=${ok} GetDIBits=${lines}  屏幕 ${SW}x${SH}`);

  // 从整屏里裁出客户区
  const cw = Math.min(cW, SW - pt.x), ch = Math.min(cH, SH - pt.y);
  if (cw > 0 && ch > 0) {
    const crop = Buffer.alloc(cw * ch * 4);
    for (let row = 0; row < ch; row++) {
      const srcOff = ((pt.y + row) * SW + pt.x) * 4;
      bits.copy(crop, row * cw * 4, srcOff, srcOff + cw * 4);
    }
    let sum = 0, cnt = 0;
    const pixels = cw * ch;
    const step = Math.max(1, Math.floor(pixels / 20000));
    for (let i = 0; i < pixels; i += step) { sum += crop[i * 4 + 1]; cnt++; }
    console.log(`  裁剪客户区 ${cw}x${ch} 平均亮度=${(sum / cnt).toFixed(1)}`);
    try {
      fs.writeFileSync(path.join(__dirname, 'debug', 'geom_E_screen_crop.png'), encodePng(cw, ch, crop));
    } catch (e) { /* */ }
  }

  SelectObject(hdcMem, old);
  DeleteObject(hbm);
  DeleteDC(hdcMem);
  ReleaseDC(null, hdcScreen);
}

console.log('\n生成的文件在 debug/geom_*.png，请人工比对哪一张内容完整。');
