/**
 * koffi 回调类型写法实测 v2 —— 全部用真实存在的 Win32 符号名
 */
'use strict';

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const isVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');

function attempt(label, fn) {
  try {
    const extra = fn();
    console.log('OK   ' + label + (extra ? '  -> ' + extra : ''));
    return true;
  } catch (e) {
    console.log('FAIL ' + label + '  -> ' + e.message);
    return false;
  }
}

// ---------- 方案 A：koffi.pointer("已注册 proto 名") + koffi.alloc + 直接传 alloc ----------
attempt('A. pointer("CB_A") 命名指针，签名引用 CB_A *', () => {
  koffi.proto('bool __stdcall CB_A(void *hwnd, intptr_t lp)');
  const Ptr = koffi.pointer('CB_A');
  const storage = koffi.alloc(Ptr, 1);
  const enumFn = user32.func('bool __stdcall EnumWindows(CB_A *cb, intptr_t lp)');
  let n = 0;
  enumFn(storage, 0);
  return 'alloc 方式枚举完成（回调未绑定，n=' + n + '）';
});

// ---------- 方案 B：直接传 JS 函数 ----------
attempt('B. 直接传 JS 函数给 EnumWindows', () => {
  koffi.proto('bool __stdcall CB_B(void *hwnd, intptr_t lp)');
  const enumFn = user32.func('bool __stdcall EnumWindows(CB_B *cb, intptr_t lp)');
  let n = 0;
  let visible = 0;
  enumFn((hwnd) => {
    n++;
    if (isVisible(hwnd)) visible++;
    return true;
  }, 0);
  return '枚举 ' + n + ' 个窗口，其中可见 ' + visible + ' 个';
});

// ---------- 方案 C：回调里用结构体 + 字符串缓冲 ----------
attempt('C. 回调内用结构体与字符串缓冲', () => {
  const RECT = koffi.struct('TEST_RECT2', {
    left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
  });
  const getRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ TEST_RECT2 *r)');
  const getLen = user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)');
  const getText = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int maxCount)');
  koffi.proto('bool __stdcall CB_C(void *hwnd, intptr_t lp)');
  const enumFn = user32.func('bool __stdcall EnumWindows(CB_C *cb, intptr_t lp)');

  const withTitle = [];
  enumFn((hwnd) => {
    if (!isVisible(hwnd)) return true;
    const len = getLen(hwnd);
    if (len <= 0) return true;
    const buf = new Uint16Array(len + 2);
    const n = getText(hwnd, buf, buf.length);
    if (n <= 0) return true;
    const title = Buffer.from(buf.buffer, 0, n * 2).toString('utf16le');
    const r = {};
    getRect(hwnd, r);
    withTitle.push(title + ' [' + (r.right - r.left) + 'x' + (r.bottom - r.top) + ']');
    return true;
  }, 0);

  console.log('      枚举到 ' + withTitle.length + ' 个有标题的可见窗口：');
  for (const t of withTitle.slice(0, 12)) console.log('        ' + t);
  return '结构体 + UTF-16 读取正常';
});

// ---------- 方案 D：验证 alloc 出来的指针能否配合 koffi.register ----------
attempt('D. koffi.register 是否存在', () => {
  return 'koffi.register 类型 = ' + typeof koffi.register +
    ', koffi.unregister 类型 = ' + typeof koffi.unregister;
});

// ---------- 方案 E：回调返回值语义（false 是否真的停止枚举） ----------
attempt('E. 回调返回 false 是否停止枚举', () => {
  koffi.proto('bool __stdcall CB_E(void *hwnd, intptr_t lp)');
  const enumFn = user32.func('bool __stdcall EnumWindows(CB_E *cb, intptr_t lp)');
  let n = 0;
  enumFn((hwnd) => {
    n++;
    return n < 3 ? true : false; // 第 3 个之后停止
  }, 0);
  return '回调返回 false 后共收到 ' + n + ' 次调用（应为 3）';
});

// ---------- 方案 F：DWN 属性 + BITMAPINFOHEADER 结构体 ----------
attempt('F. BITMAPINFOHEADER 结构体注册', () => {
  const BIH = koffi.struct('TEST_BIH', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32',
    biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
    biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  });
  const gdi32 = koffi.load('gdi32.dll');
  gdi32.func('bool __stdcall GetDIBits(void *hdc, void *bmp, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ TEST_BIH *bmi, uint32 usage)');
  return '结构体注册与函数绑定成功';
});
