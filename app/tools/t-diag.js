/**
 * listWindows 过滤环节诊断（一次性脚本）
 * 逐个过滤条件统计，找出是哪一环把窗口全吃掉了。
 */
'use strict';

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shcore = (() => { try { return koffi.load('shcore.dll'); } catch (e) { return null; } })();

// ---------- DPI ----------
console.log('=== DPI 感知 ===');
if (shcore) {
  try {
    const f = shcore.func('int __stdcall SetProcessDpiAwareness(int value)');
    const hr = f(2);
    console.log('  shcore.SetProcessDpiAwareness(2) 返回 hr =', hr, hr === 0 ? '(成功)' : '(失败)');
  } catch (e) {
    console.log('  shcore 调用异常:', e.message);
  }
} else {
  console.log('  shcore.dll 未加载');
}

// ---------- 绑定 ----------
koffi.proto('int __stdcall DiagEnumProc(void *hwnd, intptr_t lp)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(DiagEnumProc *cb, intptr_t lp)');

const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int maxCount)');
const RECT = koffi.struct('DIAG_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ DIAG_RECT *r)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)');

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;

const stats = {
  visited: 0,
  visible: 0,
  notToolWindow: 0,
  hasTitle: 0,
  hasBounds: 0,
  bigEnough: 0,
  passed: [],
  exstyleErrors: 0,
  rectFail: 0,
  sampleEx: [],
};

console.log('\n=== 过滤环节统计 ===');

// 关键：检查回调返回值的类型要求
let ret = null;
ret = EnumWindows((hwnd) => {
  stats.visited++;

  const vis = IsWindowVisible(hwnd);
  if (!vis) return 1;
  stats.visible++;

  let ex;
  try {
    ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  } catch (e) {
    stats.exstyleErrors++;
    ex = 0;
  }
  if (stats.sampleEx.length < 5) stats.sampleEx.push('0x' + ex.toString(16));
  if (ex & WS_EX_TOOLWINDOW) return 1;
  stats.notToolWindow++;

  const len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return 1;
  const buf = new Uint16Array(len + 2);
  const n = GetWindowTextW(hwnd, buf, buf.length);
  if (n <= 0) return 1;
  const title = Buffer.from(buf.buffer, 0, n * 2).toString('utf16le').trim();
  if (!title) return 1;
  stats.hasTitle++;

  const r = {};
  if (!GetWindowRect(hwnd, r)) { stats.rectFail++; return 1; }
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  if (w <= 0 || h <= 0) { stats.rectFail++; return 1; }
  stats.hasBounds++;

  if (w < 400 || h < 300) return 1;
  stats.bigEnough++;

  let pid = 0;
  const pidRef = [0];
  GetWindowThreadProcessId(hwnd, pidRef);
  pid = pidRef[0];

  stats.passed.push({ hwnd: Number(hwnd), title, w, h, pid });
  return 1;
}, 0);

console.log('  EnumWindows 返回:', ret);
console.log('  遍历到的窗口总数        :', stats.visited);
console.log('  可见的                  :', stats.visible);
console.log('  非 tool window          :', stats.notToolWindow);
console.log('  有标题                  :', stats.hasTitle);
console.log('  有有效矩形              :', stats.hasBounds, '(GetWindowRect 失败', stats.rectFail, '次)');
console.log('  尺寸 >= 400x300         :', stats.bigEnough);
console.log('  GetWindowLongPtrW 异常   :', stats.exstyleErrors);
console.log('  exstyle 样本            :', stats.sampleEx.join(', '));

console.log('\n=== 通过全部过滤的窗口 ===');
for (const p of stats.passed) {
  console.log(`  hwnd=${p.hwnd} ${p.w}x${p.h} pid=${p.pid} "${p.title}"`);
}
console.log('  共', stats.passed.length, '个');

// ---------- 验证回调用 bool 声明是否可用 ----------
console.log('\n=== 回调返回值类型对照 ===');
try {
  koffi.proto('bool __stdcall BoolEnumProc(void *hwnd, intptr_t lp)');
  const Enum2 = user32.func('bool __stdcall EnumWindows(BoolEnumProc *cb, intptr_t lp)');
  let n = 0;
  const r2 = Enum2((hwnd) => { n++; return true; }, 0);
  console.log('  用 bool 返回 + 返回 true  : 成功, 遍历', n, '个, EnumWindows 返回', r2);
} catch (e) {
  console.log('  用 bool 返回 + 返回 true  : 失败 ->', e.message);
}
