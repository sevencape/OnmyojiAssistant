/**
 * Win32 原生能力封装 —— 通过 koffi 直接调用 user32 / gdi32 / dwmapi / kernel32。
 *
 * 为什么不用 node-window-manager：
 *   它是原生 C++ 模块，安装时走 node-gyp 编译，需要 Visual Studio Build Tools
 *   （几个 GB）。koffi 是预编译好的 FFI 二进制，npm install 即可用，零编译依赖。
 *
 * 本模块是整个程序唯一直接碰 Win32 的地方，出错只影响这里。
 */

'use strict';

const path = require('path');

let koffi = null;
let api = null;
let loadError = null;

// ---------------------------------------------------------------- 常量

/**
 * EnumWindows 回调返回值。
 *
 * 注意：Win32 的 EnumWindowsProc 返回的是 BOOL（4 字节 int），不是 C++ bool。
 * 所以 koffi 里必须声明成 `int`，并且返回 **数字**。
 * 若声明成 bool，koffi 会做严格类型校验，返回 1 会报
 * "Unexpected Number value, expected boolean"。
 */
const ENUM_CONTINUE = 1;
const ENUM_STOP = 0;

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;

/** DwmGetWindowAttribute: 扩展边框边界（不含阴影） */
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
/** PrintWindow 标志：请求窗口把自己画进指定 DC。对部分 GPU 合成的窗口比 BitBlt 有效 */
const PW_RENDERFULLCONTENT = 0x00000002;

const SW_RESTORE = 9;

// ---------------------------------------------------------------- 初始化

/**
 * 懒加载 koffi 并绑定所有需要的 Win32 函数。只执行一次。
 */
function ensureApi() {
  if (api) return api;
  if (loadError) throw loadError;

  try {
    koffi = require('koffi');
  } catch (err) {
    loadError = new Error(
      'koffi 未安装，无法调用 Win32 API。请先执行: npm install\n原始错误: ' + err.message
    );
    throw loadError;
  }

  try {
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    // advapi32 用来读进程令牌的提权状态（UIPI 诊断）
    let advapi32 = null;
    try { advapi32 = koffi.load('advapi32.dll'); } catch (err) { advapi32 = null; }

    // dwmapi / shcore 在部分系统上可能缺失，缺失时优雅退化
    let dwmapi = null;
    try { dwmapi = koffi.load('dwmapi.dll'); } catch (err) { dwmapi = null; }
    let shcore = null;
    try { shcore = koffi.load('shcore.dll'); } catch (err) { shcore = null; }

    // ---------- 结构体 ----------
    const RECT = koffi.struct('DSH_RECT', {
      left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
    });

    // POINT：坐标转换用（ScreenToClient / ClientToScreen）
    // 单独起名 DSH_POINT，避免和 input.js 里注册的 OMJ_POINT 冲突
    try {
      koffi.struct('DSH_POINT', { x: 'int32', y: 'int32' });
    } catch (err) {
      // 已注册过（多实例/重复初始化）就忽略
    }

    const BITMAPINFOHEADER = koffi.struct('DSH_BITMAPINFOHEADER', {
      biSize: 'uint32',
      biWidth: 'int32',
      biHeight: 'int32',
      biPlanes: 'uint16',
      biBitCount: 'uint16',
      biCompression: 'uint32',
      biSizeImage: 'uint32',
      biXPelsPerMeter: 'int32',
      biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32',
      biClrImportant: 'uint32',
    });

    // ---------- EnumWindows 回调类型 ----------
    // 必须用 "EnumWindowsProc *" 这种内联指针写法。
    // 不要写成 koffi.pointer(EnumWindowsProc) 得到的对象再塞进签名——
    // 那个对象没有类型名，koffi 会报 Unknown or invalid type name。
    // 返回值必须是 int（BOOL），不能是 bool，见文件顶部常量处的说明。
    koffi.proto('int __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');

    const f = {
      // DPI
      SetProcessDpiAwareness: shcore
        ? shcore.func('int __stdcall SetProcessDpiAwareness(int value)')
        : null,
      SetProcessDPIAware: user32.func('bool __stdcall SetProcessDPIAware()'),

      // 窗口枚举与查询
      // 调用时直接传 JS 函数作为回调，koffi 会自动转换
      EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(void *hwnd)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      IsZoomed: user32.func('bool __stdcall IsZoomed(void *hwnd)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int maxCount)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ DSH_RECT *rect)'),
      GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'),
      GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)'),

      // 窗口操作
      // 注意返回值声明为 int：Win32 的 BOOL 就是 4 字节 int，
      // 声明 bool 会让 koffi 做严格布尔校验，和数字比较时出错
      SetWindowPos: user32.func('int __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32 flags)'),
      ShowWindow: user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hwnd)'),

      // 消息投递（不移动物理鼠标的点击方式）
      // PostMessage 把消息放进目标窗口的消息队列就返回，不碰光标、不需要窗口在前台。
      PostMessageW: user32.func('bool __stdcall PostMessageW(void *hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)'),
      SendMessageW: user32.func('intptr_t __stdcall SendMessageW(void *hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)'),
      ScreenToClient: user32.func('bool __stdcall ScreenToClient(void *hwnd, _Inout_ DSH_POINT *pt)'),
      ClientToScreen: user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ DSH_POINT *pt)'),
      GetClientRect: user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ DSH_RECT *rect)'),

      // 权限检测（UIPI：低权限进程不能给高权限窗口发键鼠输入）
      GetCurrentProcess: kernel32.func('void * __stdcall GetCurrentProcess()'),
      OpenProcessToken: advapi32
        ? advapi32.func('bool __stdcall OpenProcessToken(void *proc, uint32 access, _Out_ void **token)')
        : null,
      GetTokenInformation: advapi32
        ? advapi32.func('bool __stdcall GetTokenInformation(void *token, int cls, _Out_ void *buf, uint32 len, _Out_ uint32 *retLen)')
        : null,

      // 进程
      OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *handle)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(void *proc, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)'
      ),

      // DWM
      DwmGetWindowAttribute: dwmapi
        ? dwmapi.func('int __stdcall DwmGetWindowAttribute(void *hwnd, uint32 attr, _Out_ void *data, uint32 size)')
        : null,

      // GDI 截图
      GetWindowDC: user32.func('void * __stdcall GetWindowDC(void *hwnd)'),
      // GetDC(NULL) 取整个屏幕的 DC —— 窗口 DC 抓不到画面时靠它降级
      GetDC: user32.func('void * __stdcall GetDC(void *hwnd)'),
      ReleaseDC: user32.func('int __stdcall ReleaseDC(void *hwnd, void *hdc)'),
      CreateCompatibleDC: gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)'),
      DeleteDC: gdi32.func('bool __stdcall DeleteDC(void *hdc)'),
      CreateCompatibleBitmap: gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)'),
      DeleteObject: gdi32.func('bool __stdcall DeleteObject(void *obj)'),
      SelectObject: gdi32.func('void * __stdcall SelectObject(void *hdc, void *obj)'),
      BitBlt: gdi32.func('bool __stdcall BitBlt(void *dst, int x, int y, int cx, int cy, void *src, int sx, int sy, uint32 rop)'),
      PrintWindow: user32.func('bool __stdcall PrintWindow(void *hwnd, void *hdc, uint32 flags)'),
      GetDIBits: gdi32.func('int __stdcall GetDIBits(void *hdc, void *bmp, uint32 start, uint32 lines, _Out_ void *bits, _Inout_ DSH_BITMAPINFOHEADER *bmi, uint32 usage)'),
    };

    // 注意：koffi 的回调**直接传 JS 函数**即可，不要用 koffi.alloc + koffi.register
    // 那套。实测 alloc 出来的 External 指针传给声明为 "CB *" 的形参会报
    // "Unexpected External value, expected CB *"。直接传函数最简且可用。
    api = {
      koffi,
      // koffi.address 是 External 指针对象 → 整数地址 的唯一方式。
      // 见 toHandle 的说明。
      address: koffi.address,
      f,
      RECT,
      BITMAPINFOHEADER,
    };
  } catch (err) {
    loadError = new Error('绑定 Win32 API 失败: ' + err.message);
    throw loadError;
  }

  return api;
}

// 枚举期间收集结果
const state = { results: [] };

// ---------------------------------------------------------------- HWND 处理

/**
 * 把各种形式的窗口句柄统一成 BigInt，用于回传 Win32。
 *
 * ★ 这是本项目最容易踩的坑，务必理解：
 *
 * koffi 传给回调的 `void *` 参数是一个 **External 指针对象**，它：
 *   - 没有 valueOf / toString，所以 Number(hwnd) 和 String(hwnd) 都会抛
 *     "Cannot convert object to primitive value"
 *   - 用 util.inspect 看是 [External: 2284f9a63e0]
 *   - 只有 koffi.address(hwnd) 能拿到它的整数地址（返回 BigInt，如 328778n）
 *
 * 而 koffi 生成的 Win32 函数在接收 `void *` 时，**只接受 BigInt**。
 * 传 Number 会报 "Unexpected Number value, expected void *"。
 *
 * 所以约定：
 *   - 对外暴露的 hwnd 用 Number（便于 JSON、日志、界面显示）
 *   - 调用 Win32 之前一律经过 toHandle() 转成 BigInt
 *
 * HWND 实际值远小于 2^53，Number 存储不会丢精度。
 */
function toHandle(hwnd) {
  if (typeof hwnd === 'bigint') return hwnd;
  if (typeof hwnd === 'number') return BigInt(Math.trunc(hwnd));
  // External 指针对象
  const a = ensureApi();
  return a.address(hwnd);
}

/** 把 External 指针对象或任意形式转成对外使用的 Number 句柄 */
function toNumberHandle(hwnd) {
  if (typeof hwnd === 'number') return hwnd;
  if (typeof hwnd === 'bigint') return Number(hwnd);
  return Number(ensureApi().address(hwnd));
}

// ---------------------------------------------------------------- DPI

/**
 * 声明进程 DPI 感知。必须在任何窗口坐标 API 之前、且只调用一次。
 * 不做这一步，150% 缩放屏上所有窗口坐标都会偏。
 * @returns {string} 实际生效的方式
 */
function enableDpiAwareness() {
  const a = ensureApi();
  if (a.f.SetProcessDpiAwareness) {
    try {
      const hr = a.f.SetProcessDpiAwareness(2); // PROCESS_PER_MONITOR_DPI_AWARE
      if (hr === 0) return 'per-monitor (shcore)';
    } catch (err) { /* 落到下面 */ }
  }
  try {
    if (a.f.SetProcessDPIAware()) return 'system (user32)';
  } catch (err) { /* ignore */ }
  return '未生效（坐标可能偏移）';
}

// ---------------------------------------------------------------- 窗口查询

// ---------------------------------------------------------------- 窗口查询
//
// 命名约定（很重要，别搞混）：
//   xxxBig(h) —— 内部函数，h 必须是 BigInt，直接喂给 Win32
//   xxx(h)    —— 导出函数，h 可以是 Number / BigInt / 指针对象，内部自动转换
//
// 这样回调路径（拿到的本来就是指针对象）和外部调用路径（通常是 Number）
// 各走各的，不用来回转换。

function readTitleBig(h) {
  const a = ensureApi();
  const len = a.f.GetWindowTextLengthW(h);
  if (len <= 0) return '';
  const buf = new Uint16Array(len + 2);
  const n = a.f.GetWindowTextW(h, buf, buf.length);
  if (n <= 0) return '';
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le');
}

/** 取窗口真实边界（DWM 扩展边界优先，退回 GetWindowRect） */
function getWindowBoundsBig(h) {
  const a = ensureApi();

  if (a.f.DwmGetWindowAttribute) {
    try {
      const r = { left: 0, top: 0, right: 0, bottom: 0 };
      const hr = a.f.DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16);
      if (hr === 0 && r.right > r.left && r.bottom > r.top) {
        return { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top };
      }
    } catch (err) { /* 落到 user32 */ }
  }

  try {
    const r = { left: 0, top: 0, right: 0, bottom: 0 };
    if (a.f.GetWindowRect(h, r)) {
      const width = r.right - r.left;
      const height = r.bottom - r.top;
      if (width > 0 && height > 0) return { left: r.left, top: r.top, width, height };
    }
  } catch (err) { /* ignore */ }
  return null;
}

function getWindowPidBig(h) {
  const a = ensureApi();
  const ref = [0];
  a.f.GetWindowThreadProcessId(h, ref);
  return ref[0];
}

function getProcessPath(pid) {
  if (!pid) return '';
  const a = ensureApi();
  const proc = a.f.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!proc) return '';
  try {
    const buf = new Uint16Array(1024);
    const sizeRef = [buf.length];
    if (a.f.QueryFullProcessImageNameW(proc, 0, buf, sizeRef)) {
      return Buffer.from(buf.buffer, 0, sizeRef[0] * 2).toString('utf16le');
    }
    return '';
  } catch (err) {
    return '';
  } finally {
    a.f.CloseHandle(proc);
  }
}

/**
 * EnumWindows 回调体：过滤出"像游戏主窗口"的顶层窗口。
 * @param {object} hBig 指针对象或 BigInt（直接来自 koffi 回调）
 */
function handleWindow(hBig, results, f) {
  // 注意：这里的 hBig 是 koffi 的 External 指针对象，可以直接传给其他 Win32 函数，
  // 但要存进结果里必须先转成数值。
  if (!f.IsWindowVisible(hBig)) return;

  const ex = Number(f.GetWindowLongPtrW(hBig, GWL_EXSTYLE));
  if (ex & WS_EX_TOOLWINDOW) return;

  const title = readTitleBig(hBig);
  if (!title || !title.trim()) return;

  const bounds = getWindowBoundsBig(hBig);
  if (!bounds) return;
  if (bounds.width < 400 || bounds.height < 300) return; // 排除各种浮层

  const pid = getWindowPidBig(hBig);
  const processPath = getProcessPath(pid);

  results.push({
    // ★ 必须用 toNumberHandle：指针对象无法 Number() 转换，
    //   写 Number(hBig) 会抛 "Cannot convert object to primitive value"
    hwnd: toNumberHandle(hBig),
    title: title.trim(),
    pid,
    processPath,
    processName: processPath ? path.basename(processPath) : '',
    bounds,
    minimized: !!f.IsIconic(hBig),
    maximized: !!f.IsZoomed(hBig),
  });
}

/**
 * 枚举所有符合条件的顶层窗口。
 * @returns {Array<object>}
 */
function listWindows() {
  const a = ensureApi();
  state.results = [];
  const returned = a.f.EnumWindows((hwnd) => {
    try {
      handleWindow(hwnd, state.results, a.f);
    } catch (err) {
      // 单个窗口出错不能中断整个枚举
    }
    // 返回值必须是数字 1/0（回调声明成 int），返回 true 会被 koffi 拒绝
    return ENUM_CONTINUE;
  }, 0);

  if (returned === false && state.results.length === 0) {
    throw new Error('EnumWindows 调用失败');
  }
  return state.results.slice();
}

/** 窗口是否仍存在 */
function isWindow(hwnd) {
  try {
    return !!ensureApi().f.IsWindow(toHandle(hwnd));
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------- GDI 截图

/**
 * 抓取指定窗口像素（内部版，需传 BigInt）。
 *
 * 提供三种抓取方式。为什么需要三种：
 *   BitBlt 从窗口 DC 拷贝，依赖窗口"愿意"把内容画到 DC 上。
 *   现代游戏和 Electron 常用 DirectComposition / GPU 合成，画面存在显存里，
 *   BitBlt 会得到**全黑**。这时 PrintWindow 让窗口自己重绘到我们给的 DC，
 *   往往能拿到真实画面。
 *
 * @param {bigint} hBig
 * @param {object} [rect]
 * @param {'bitblt'|'printwindow'|'printwindow_full'} [method='bitblt']
 * @returns {{width:number, height:number, bgra:Buffer}}
 */
function captureWindowBig(hBig, rect, method = 'bitblt') {
  const a = ensureApi();
  const b = rect || getWindowBoundsBig(hBig);
  if (!b || b.width <= 0 || b.height <= 0) {
    throw new Error('窗口尺寸无效，无法截图');
  }

  const width = Math.floor(b.width);
  const height = Math.floor(b.height);

  // BitBlt 需要窗口 DC + 绝对屏幕坐标；
  // PrintWindow 用内存 DC 即可（窗口自己画，不需要屏幕坐标）
  const needWindowDc = method === 'bitblt';
  const hdcWindow = needWindowDc ? a.f.GetWindowDC(hBig) : null;
  if (needWindowDc && !hdcWindow) throw new Error('GetWindowDC 失败');

  let hdcMem = null;
  let hbm = null;
  let oldObj = null;

  try {
    // PrintWindow 需要参考 DC 来建兼容位图，用屏幕 DC 即可
    const refDc = hdcWindow || a.f.GetWindowDC(null);
    hdcMem = a.f.CreateCompatibleDC(refDc);
    if (!hdcMem) throw new Error('CreateCompatibleDC 失败');

    hbm = a.f.CreateCompatibleBitmap(refDc, width, height);
    if (!hbm) throw new Error(`CreateCompatibleBitmap 失败 (${width}x${height})`);

    oldObj = a.f.SelectObject(hdcMem, hbm);

    if (method === 'bitblt') {
      const ok = a.f.BitBlt(hdcMem, 0, 0, width, height, hdcWindow, b.left, b.top, SRCCOPY);
      if (!ok) throw new Error('BitBlt 失败');
    } else {
      const flags = method === 'printwindow_full' ? PW_RENDERFULLCONTENT : 0;
      const ok = a.f.PrintWindow(hBig, hdcMem, flags);
      if (!ok) throw new Error('PrintWindow 返回失败');
    }

    // biHeight 用负值 = top-down，省掉一次逐行翻转
    const hdr = {
      biSize: 40,
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0, // BI_RGB
      biSizeImage: width * height * 4,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };

    const bits = Buffer.alloc(width * height * 4);
    const lines = a.f.GetDIBits(hdcMem, hbm, 0, height, bits, hdr, DIB_RGB_COLORS);
    if (!lines) throw new Error('GetDIBits 失败');

    return { width, height, bgra: bits, method };
  } finally {
    if (oldObj) a.f.SelectObject(hdcMem, oldObj);
    if (hbm) a.f.DeleteObject(hbm);
    if (hdcMem) a.f.DeleteDC(hdcMem);
    if (hdcWindow) a.f.ReleaseDC(hBig, hdcWindow);
  }
}

// ---------------------------------------------------------------- 窗口操作

/** 移动/调整窗口位置，不改变 Z 序、不抢焦点 */
function setWindowPosBig(hBig, x, y, width, height) {
  const a = ensureApi();
  // 注意 SetWindowPos 的返回值声明成 int，所以这里不能跟 bool 比较
  const r = a.f.SetWindowPos(hBig, null, Math.round(x), Math.round(y),
    Math.round(width), Math.round(height), SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  return r !== 0;
}

function bringToFrontBig(hBig) {
  const a = ensureApi();
  try {
    if (a.f.IsIconic(hBig)) a.f.ShowWindow(hBig, SW_RESTORE);
    return !!a.f.SetForegroundWindow(hBig);
  } catch (err) {
    return false;
  }
}

/**
 * 从**屏幕 DC** 抓取指定屏幕区域。
 *
 * ★ 为什么需要它（实测结论）：
 *   `GetWindowDC` + BitBlt 对某些窗口会得到**全黑** —— 窗口内容走 GPU 合成、
 *   或模拟器渲染后端变化时就会这样。实测同一台 MuMu 窗口：
 *     窗口 DC BitBlt     -> 亮度 0.0（全黑）
 *     屏幕 DC 抓同区域   -> 亮度 115.8（有画面）
 *   所以窗口 DC 失败时必须能退回屏幕 DC。
 *
 * 代价：抓的是**屏幕像素**，窗口被其他窗口遮挡时会连带抓进来。
 * 因此调用方应先试窗口 DC，全黑再用这个。
 *
 * @param {{left:number,top:number,width:number,height:number}} rect 屏幕绝对坐标
 * @returns {{width:number, height:number, bgra:Buffer, method:string}}
 */
function captureScreen(rect) {
  const a = ensureApi();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error('屏幕区域无效，无法截图');
  }

  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  const x = Math.round(rect.left);
  const y = Math.round(rect.top);

  const hdcScreen = a.f.GetDC(null);
  if (!hdcScreen) throw new Error('GetDC(NULL) 失败');

  let hdcMem = null;
  let hbm = null;
  let oldObj = null;

  try {
    hdcMem = a.f.CreateCompatibleDC(hdcScreen);
    if (!hdcMem) throw new Error('CreateCompatibleDC 失败');

    hbm = a.f.CreateCompatibleBitmap(hdcScreen, width, height);
    if (!hbm) throw new Error(`CreateCompatibleBitmap 失败 (${width}x${height})`);

    oldObj = a.f.SelectObject(hdcMem, hbm);

    // 从屏幕 DC 拷贝：源坐标就是屏幕绝对坐标
    const ok = a.f.BitBlt(hdcMem, 0, 0, width, height, hdcScreen, x, y, SRCCOPY);
    if (!ok) throw new Error('BitBlt(屏幕) 失败');

    const hdr = {
      biSize: 40,
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0, // BI_RGB
      biSizeImage: width * height * 4,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };

    const bits = Buffer.alloc(width * height * 4);
    const lines = a.f.GetDIBits(hdcMem, hbm, 0, height, bits, hdr, DIB_RGB_COLORS);
    if (!lines) throw new Error('GetDIBits(屏幕) 失败');

    return { width, height, bgra: bits, method: 'screen' };
  } finally {
    if (oldObj) a.f.SelectObject(hdcMem, oldObj);
    if (hbm) a.f.DeleteObject(hbm);
    if (hdcMem) a.f.DeleteDC(hdcMem);
    a.f.ReleaseDC(null, hdcScreen);
  }
}

// ---------------------------------------------------------------- 导出包装
// 统一在这里做 句柄形式转换，内部实现一律只认 BigInt

function getWindowBounds(hwnd) {
  return getWindowBoundsBig(toHandle(hwnd));
}

function getWindowText(hwnd) {
  return readTitleBig(toHandle(hwnd));
}

function getWindowPid(hwnd) {
  return getWindowPidBig(toHandle(hwnd));
}

function captureWindow(hwnd, rect, method) {
  return captureWindowBig(toHandle(hwnd), rect, method);
}

function setWindowPos(hwnd, x, y, width, height) {
  return setWindowPosBig(toHandle(hwnd), x, y, width, height);
}

function bringToFront(hwnd) {
  return bringToFrontBig(toHandle(hwnd));
}

/** 当前进程是否以管理员身份运行（提权的 High 完整性） */
function isElevated() {
  try {
    const api = ensureApi();
    if (!api.f.OpenProcessToken || !api.f.GetTokenInformation) return null;
    const token = [null];
    // TOKEN_QUERY = 0x0008
    if (!api.f.OpenProcessToken(api.f.GetCurrentProcess(), 0x0008, token)) return null;
    const hToken = token[0];
    if (!hToken) return null;
    // TokenElevation = 20, TOKEN_ELEVATION { DWORD TokenIsElevated }
    const buf = Buffer.alloc(4);
    const retLen = [0];
    const ok = api.f.GetTokenInformation(hToken, 20, buf, 4, retLen);
    try { api.f.CloseHandle(hToken); } catch (e) { /* ignore */ }
    if (!ok) return null;
    return buf.readUInt32LE(0) !== 0;
  } catch (err) {
    return null;
  }
}

/**
 * 把 PostMessage 失败翻译成人话。
 *
 * 最常见的失败是 ERROR_ACCESS_DENIED(5)：目标进程权限比我们高（UIPI）。
 * 实测：游戏以管理员运行（High）、本程序普通权限（Medium）时，
 * 连 WM_MOUSEMOVE 都会返回 5 —— 这不是代码问题，必须提权才能发输入。
 */
function describePostFailure(code, thrownMsg) {
  const extra = '如果游戏以管理员身份运行，本程序也必须以管理员身份运行，否则 Win32 会拒绝输入（UIPI）。';
  if (thrownMsg) return `调用异常: ${thrownMsg}。${extra}`;
  if (code === 5) return `被系统拒绝 (ERROR_ACCESS_DENIED)。${extra}`;
  if (code > 0) return `PostMessage 失败（Win32 错误码 ${code}）。${extra}`;
  return `窗口拒绝了该消息。${extra}`;
}

// ---------------------------------------------------------------- 消息投递点击
//
// 为什么需要这条路：SendInput 是**系统级注入**，必须移动物理光标。
// 用户一边用鼠标一边挂机时会被抢光标，体验很差。
// PostMessage 只是把鼠标消息放进目标窗口的消息队列，不碰光标、不要前台。
//
// 代价：部分游戏用 Raw Input / DirectInput 读硬件状态，会忽略投递消息。
// 所以这里只负责「发」，是否被响应由调用方实测判断。

const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const MK_LBUTTON = 0x0001;

/** MAKELPARAM：把客户区坐标打包成 lParam（低 16 位 x，高 16 位 y） */
function makeLParam(x, y) {
  const cx = (x | 0) & 0xFFFF;
  const cy = (y | 0) & 0xFFFF;
  return (cy << 16) | cx;
}

/** 屏幕坐标 → 客户区坐标 */
function screenToClient(hwnd, x, y) {
  const api = ensureApi();
  const h = toHandle(hwnd);
  const pt = { x: Math.round(x), y: Math.round(y) };
  const ok = api.f.ScreenToClient(h, pt);
  if (!ok) return null;
  return { x: pt.x, y: pt.y };
}

/** 客户区坐标 → 屏幕坐标 */
function clientToScreen(hwnd, x, y) {
  const api = ensureApi();
  const h = toHandle(hwnd);
  const pt = { x: Math.round(x), y: Math.round(y) };
  const ok = api.f.ClientToScreen(h, pt);
  if (!ok) return null;
  return { x: pt.x, y: pt.y };
}

/**
 * 向窗口投递一次左键点击（不移动物理鼠标）。
 *
 * @param {number|bigint} hwnd
 * @param {number} screenX 屏幕坐标
 * @param {number} screenY
 * @param {{sync?:boolean, withMove?:boolean}} [opts]
 *        sync=true 用 SendMessage（同步等目标处理），默认用 PostMessage
 * @returns {{ok:boolean, clientX:number, clientY:number, steps:number[], error?:string}}
 */
function postClick(hwnd, screenX, screenY, opts = {}) {
  const api = ensureApi();
  const h = toHandle(hwnd);
  const sync = opts.sync === true;
  const withMove = opts.withMove !== false;

  // ★ 每次调用后**立刻**读 GetLastError。
  //   Win32 的 last error 是线程级的，任何后续调用（包括 koffi 内部）都可能覆盖它；
  //   如果等到最后再读，经常拿到 0，导致把「UIPI 拒绝」误报成「窗口已关闭」。
  const send = (msg, wp, lp) => {
    try {
      if (sync) return { ret: api.f.SendMessageW(h, msg, wp, lp), err: 0 };
      const ok = api.f.PostMessageW(h, msg, wp, lp);
      return { ret: ok ? 1 : 0, err: ok ? 0 : (api.f.GetLastError ? api.f.GetLastError() : 0) };
    } catch (err) {
      return { ret: 0, err: -1, thrown: err.message };
    }
  };

  const cp = screenToClient(h, screenX, screenY);
  if (!cp) {
    return { ok: false, clientX: 0, clientY: 0, steps: [], error: 'ScreenToClient 失败（窗口可能已关闭）' };
  }

  const lp = makeLParam(cp.x, cp.y);
  const steps = [];
  let firstErr = 0;
  let thrownMsg = '';

  try {
    if (withMove) {
      const r = send(WM_MOUSEMOVE, 0, lp);
      if (r.ret) steps.push('move');
      else if (!firstErr) { firstErr = r.err; thrownMsg = r.thrown || ''; }
    }
    // 按下必须带 MK_LBUTTON，否则很多窗口认为不是按键状态
    const downR = send(WM_LBUTTONDOWN, MK_LBUTTON, lp);
    if (downR.ret) steps.push('down');
    else if (!firstErr) { firstErr = downR.err; thrownMsg = downR.thrown || ''; }

    const upR = send(WM_LBUTTONUP, 0, lp);
    if (upR.ret) steps.push('up');
    else if (!firstErr) { firstErr = upR.err; thrownMsg = upR.thrown || ''; }

    const ok = steps.indexOf('down') >= 0 && steps.indexOf('up') >= 0;
    return {
      ok,
      clientX: cp.x,
      clientY: cp.y,
      steps,
      win32Error: firstErr || undefined,
      error: ok ? undefined : describePostFailure(firstErr, thrownMsg),
    };
  } catch (err) {
    return { ok: false, clientX: cp.x, clientY: cp.y, steps, error: err.message };
  }
}

module.exports = {
  ensureApi,
  enableDpiAwareness,
  toHandle,
  toNumberHandle,
  listWindows,
  getWindowBounds,
  getWindowText,
  getWindowPid,
  getProcessPath,
  captureWindow,
  captureScreen,
  setWindowPos,
  bringToFront,
  isWindow,
  // 消息投递点击（不移动物理鼠标）
  postClick,
  isElevated,
  screenToClient,
  clientToScreen,
  makeLParam,
};
