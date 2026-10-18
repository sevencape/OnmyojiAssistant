/**
 * 输入后端：ADB（模拟器内部注入）+ Win32 SendInput（桌面注入）。
 *
 * ── 为什么有两个后端 ──
 * 实测发现阴阳师有两种安装形态，输入通道完全不同：
 *
 *   A. 跑在 MuMu / 雷电等**运行中的模拟器**里
 *      → 有 ADB 通道，用 `adb shell input tap`，从模拟器内部注入，隐蔽性更好
 *
 *   B. 「阴阳师-MuMu模拟器专版」这种**独立 PC 客户端**
 *      （安装目录 C:\Program Files (x86)\Netease\OnmyojiLauncher）
 *      → 它把模拟器打包进 exe 了，**没有运行中的 Android VM**，
 *        MuMuManager 显示 is_android_started=false，ADB 无设备可连
 *      → 只能用 Windows 桌面输入（SendInput / 消息投递）
 *
 * 所以自动探测：优先 ADB，连不上就用 Windows 原生输入。
 *
 * ── 风险差异（重要）──
 * SendInput 属于桌面软件注入，比 ADB 更容易被反作弊识别。
 * 程序会在日志里明确标注当前用的是哪种后端，不做静默降级。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const native = require('./native');

// ================================================================ ADB

/** MuMu 常见安装路径下的 adb，按优先级排列 */
const ADB_CANDIDATES = [
  'C:\\Program Files\\NetEase\\MuMu\\nx_device\\15.0\\shell\\adb.exe',
  'C:\\Program Files\\NetEase\\MuMu\\nx_main\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\Netease\\MuMu Player 12\\shell\\adb.exe',
  'C:\\Program Files (x86)\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\MuMu\\emulator\\nemu\\adb.exe',
];

/** MuMu 常见 ADB 端口 */
const PORT_CANDIDATES = [16384, 16416, 7555, 5555, 21503, 17997];

class AdbInput {
  constructor(opts = {}) {
    this.adbPath = opts.adbPath || findAdb();
    this.port = opts.port || null;
    this.log = opts.log || (() => {});
    this._connected = false;
    this._lastError = '';
  }

  isAvailable() {
    return !!this.adbPath && fs.existsSync(this.adbPath);
  }

  status() {
    return {
      backend: 'adb',
      available: this.isAvailable(),
      adbPath: this.adbPath,
      port: this.port,
      connected: this._connected,
      lastError: this._lastError,
    };
  }

  _run(args, timeoutMs = 8000) {
    if (!this.isAvailable()) {
      throw new Error('未找到 adb.exe');
    }
    const res = spawnSync(this.adbPath, args, {
      windowsHide: true, timeout: timeoutMs, encoding: 'utf8',
    });
    if (res.error) throw new Error(`执行 adb 失败: ${res.error.message}`);
    return { code: res.status, out: ((res.stdout || '') + (res.stderr || '')).trim() };
  }

  /**
   * 尝试连上可用设备。
   *
   * 性能注意：每试一个端口都要 connect + 复查 devices，实测 6 个端口最坏要 10 秒。
   * 所以这里做了两件事：
   *   1. 先扫一遍 devices，如果已有 online 设备直接返回，不试端口
   *   2. 只对**当前实际监听**的端口做尝试（由外部传入 portsHint 可跳过盲试）
   *
   * @param {number[]} [portsHint] 优先尝试的端口
   * @returns {boolean}
   */
  connect(portsHint) {
    if (!this.isAvailable()) {
      this._lastError = '未找到 adb.exe';
      return false;
    }

    // 已有在线设备就直接用
    try {
      const dev = this._run(['devices']);
      const online = dev.out.split(/\r?\n/)
        .filter((l) => l && !l.startsWith('List of devices') && /\tdevice\b/.test(l.trim()));
      if (online.length > 0) {
        this._connected = true;
        this._lastError = '';
        this.log(`ADB 已有在线设备: ${online[0].split('\t')[0]}`);
        return true;
      }
    } catch (err) {
      this._lastError = err.message;
    }

    const ports = this.port
      ? [this.port]
      : (Array.isArray(portsHint) && portsHint.length ? portsHint : PORT_CANDIDATES);

    for (const p of ports) {
      try {
        this._run(['connect', `127.0.0.1:${p}`]);
        // 单次 devices 复查，避免每端口都多花一次进程启动
        const dev = this._run(['devices']);
        if (dev.out.split(/\r?\n/).some((l) => l.includes(`127.0.0.1:${p}`) && /\tdevice\b/.test(l))) {
          this.port = p;
          this._connected = true;
          this._lastError = '';
          this.log(`ADB 已连接 127.0.0.1:${p}`);
          return true;
        }
      } catch (err) {
        this._lastError = err.message;
      }
    }

    this._connected = false;
    this._lastError = '所有候选端口都没有可用（online）设备。' +
      '若游戏是「阴阳师-MuMu模拟器专版」这种独立客户端，' +
      '它没有运行中的 Android 虚拟机，ADB 天然不可用，应使用 Windows 输入';
    return false;
  }

  _ensure() {
    if (this._connected) return true;
    return this.connect();
  }

  tap(x, y) {
    if (!this._ensure()) throw new Error(`ADB 未连接: ${this._lastError}`);
    const r = this._run(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
    if (r.code !== 0) {
      this._connected = false;
      throw new Error(`adb input tap 失败: ${r.out || 'code ' + r.code}`);
    }
    return true;
  }

  swipe(x1, y1, x2, y2, durationMs = 300) {
    if (!this._ensure()) throw new Error(`ADB 未连接: ${this._lastError}`);
    this._run(['shell', 'input', 'swipe',
      String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)),
      String(Math.round(durationMs))]);
    return true;
  }

  back() {
    if (!this._ensure()) throw new Error(`ADB 未连接: ${this._lastError}`);
    this._run(['shell', 'input', 'keyevent', '4']);
    return true;
  }

  deviceSize() {
    if (!this._ensure()) return null;
    try {
      const r = this._run(['shell', 'wm', 'size']);
      const m = /(\d+)x(\d+)/.exec(r.out);
      if (m) return { width: Number(m[1]), height: Number(m[2]) };
    } catch (err) { /* ignore */ }
    return null;
  }
}

// ================================================================ Win32 SendInput

/** SendInput 的 MOUSEEVENTF 常量 */
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
/** 绝对坐标空间：SendInput 的 dx/dy 要映射到 0..65535 */
const ABS_RANGE = 65535;

/** INPUT 结构体的类型标识 */
const INPUT_MOUSE = 0;

/**
 * 同步睡眠（不忙等）。
 * 用 SharedArrayBuffer + Atomics.wait 实现，主进程里可用；
 * 拿不到 SharedArrayBuffer 时退化为忙等。
 */
function sleepSync(ms) {
  const n = Math.max(0, ms | 0);
  if (n === 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, n);
    return;
  } catch (err) {
    const t = Date.now();
    while (Date.now() - t < n) { /* busy wait */ }
  }
}

/**
 * Windows 桌面输入注入。
 *
 * 用 `SendInput` 发送**绝对坐标**鼠标事件：
 *   dx = x / 屏幕宽 * 65535, dy = y / 屏幕高 * 65535
 * 这样不受虚拟桌面偏移影响，多显示器下也正确。
 *
 * ⚠️ 这是软件注入，比 ADB 更容易被反作弊识别。仅在没有 ADB 时使用。
 */
class WinInput {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this._api = null;
    this._lastError = '';
    this._screen = null;

    // 点击方式：
    //   'message'    —— PostMessage 投递鼠标消息，**完全不动物理光标**（默认）
    //   'sendinput'  —— SendInput 系统级注入，会移动光标（消息被拒时的回退）
    this.hwnd = opts.hwnd || null;
    this.mode = opts.mode === 'sendinput' ? 'sendinput' : 'message';
    // 记录每种方式成功/失败次数，便于日志说明当前实际在用哪种
    this.stats = { message: 0, messageFail: 0, sendinput: 0 };
  }

  /** 绑定 SendInput 及其所需结构体 */
  _ensureApi() {
    if (this._api) return this._api;

    const a = native.ensureApi();
    const koffi = a.koffi;
    if (!koffi) throw new Error('koffi 不可用，无法调用 SendInput');

    const lib = a.f; // 已在 native 里绑定过 user32，这里补 SendInput

    // 结构体只注册一次
    let MOUSEINPUT;
    let INPUT;
    try {
      MOUSEINPUT = koffi.struct('OMJ_MOUSEINPUT', {
        dx: 'int32',
        dy: 'int32',
        mouseData: 'uint32',
        dwFlags: 'uint32',
        time: 'uint32',
        dwExtraInfo: 'uintptr_t',
      });
      INPUT = koffi.struct('OMJ_INPUT', {
        type: 'uint32',
        mi: 'OMJ_MOUSEINPUT',
      });
    } catch (err) {
      // 可能已注册过（多实例），直接用名字
      MOUSEINPUT = 'OMJ_MOUSEINPUT';
      INPUT = 'OMJ_INPUT';
    }

    // native.js 里没绑 SendInput，这里单独加载 user32
    const user32 = koffi.load('user32.dll');
    const SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, _In_ OMJ_INPUT *inputs, int cbSize)');
    const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');

    // POINT 结构：两个 int32
    let POINT;
    try {
      POINT = koffi.struct('OMJ_POINT', { x: 'int32', y: 'int32' });
    } catch (err) {
      POINT = 'OMJ_POINT';
    }
    const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ OMJ_POINT *pt)');

    this._api = { koffi, SendInput, GetSystemMetrics, GetCursorPos, INPUT, lib };
    return this._api;
  }

  /** 当前鼠标位置（屏幕坐标） */
  cursorPos() {
    try {
      const { GetCursorPos } = this._ensureApi();
      const pt = { x: 0, y: 0 };
      if (GetCursorPos(pt) === 1) return { x: pt.x, y: pt.y };
    } catch (err) { /* ignore */ }
    return null;
  }

  isAvailable() {
    try {
      this._ensureApi();
      return true;
    } catch (err) {
      this._lastError = err.message;
      return false;
    }
  }

  status() {
    return {
      backend: 'win32',
      available: this.isAvailable(),
      lastError: this._lastError,
      note: '桌面软件输入（SendInput），比 ADB 更易被反作弊识别',
    };
  }

  /** 屏幕尺寸（虚拟桌面） */
  screenSize() {
    if (this._screen) return this._screen;
    const { GetSystemMetrics } = this._ensureApi();
    const w = GetSystemMetrics(78) || GetSystemMetrics(0);
    const h = GetSystemMetrics(79) || GetSystemMetrics(1);
    this._screen = { width: w, height: h };
    return this._screen;
  }

  /** 绝对坐标的鼠标移动 */
  _move(x, y) {
    const { koffi, SendInput, GetSystemMetrics, INPUT } = this._ensureApi();
    const W = GetSystemMetrics(78) || GetSystemMetrics(0) || 1;
    const H = GetSystemMetrics(79) || GetSystemMetrics(1) || 1;

    // 转成 0..65535 的归一化绝对坐标
    const nx = Math.round(Math.max(0, Math.min(1, x / W)) * ABS_RANGE);
    const ny = Math.round(Math.max(0, Math.min(1, y / H)) * ABS_RANGE);

    const inp = {
      type: INPUT_MOUSE,
      mi: {
        dx: nx, dy: ny, mouseData: 0,
        dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
        time: 0, dwExtraInfo: 0,
      },
    };
    const inpSize = koffi.sizeof(INPUT);
    const sent = SendInput(1, inp, inpSize);
    return sent === 1;
  }

  /**
   * 在屏幕坐标处点击。
   *
   * @param {number} x 屏幕绝对坐标
   * @param {number} y
   * @returns {{ok:boolean, sent:number, steps:number[]}}
   *
   * ★ 关键修正（实测踩过的坑）：
   *   原来把 MOUSEEVENTF_MOVE 和 LEFTDOWN/LEFTUP **合并发在同一次 SendInput 里**：
   *       MOVE | ABSOLUTE
   *       MOVE | ABSOLUTE | LEFTDOWN
   *       MOVE | ABSOLUTE | LEFTUP
   *   表现是「鼠标移到了目标位置，但游戏没有任何点击反应」。
   *   原因：带 MOVE 的按钮事件在不少窗口/游戏里会被合并成「移动」处理，
   *   按下/抬起状态根本没有产生。
   *
   *   正确做法是**分开送**：
   *       1) 纯 MOVE 定位
   *       2) 纯 LEFTDOWN（不带 MOVE）
   *       3) 按住几十毫秒（0ms 的按下-抬起会被部分程序忽略）
   *       4) 纯 LEFTUP（不带 MOVE）
   */
  tap(x, y) {
    // ---------- 优先：消息投递（不移动物理光标）----------
    //
    // 为什么默认用它：用户一边用鼠标一边挂机时，SendInput 会把光标抢走。
    // PostMessage 只是把鼠标消息塞进目标窗口的队列，光标纹丝不动。
    //
    // 什么情况下会失败：目标进程权限比我们高（UIPI）。
    // 实测：游戏以管理员运行（High），我们普通权限（Medium）时，
    // WM_MOUSEMOVE 能发出去，但 WM_LBUTTONDOWN/UP 直接返回 0 被拒。
    // 这时必须回退到 SendInput（但也同样会被系统拦，真正解法是让本程序以管理员运行）。
    if (this.mode === 'message' && this.hwnd) {
      try {
        const r = native.postClick(this.hwnd, x, y, { sync: false });
        if (r && r.ok) {
          this.stats.message++;
          this._lastError = '';
          return { ok: true, sent: r.steps.length, steps: r.steps, via: 'message' };
        }
        // 消息被拒：记一次失败，回退到 SendInput
        this.stats.messageFail++;
        this._lastError = `消息投递被拒（${r && r.error ? r.error : '未知'}）` +
          ' —— 通常是目标程序以管理员运行，而本程序不是';
        this.log('消息投递被拒，本回合改用 SendInput（会移动光标）');
      } catch (err) {
        this.stats.messageFail++;
        this._lastError = '消息投递异常: ' + err.message;
      }
    }

    // ---------- 回退：SendInput ----------
    const { koffi, SendInput, INPUT } = this._ensureApi();
    const inpSize = koffi.sizeof(INPUT);

    const W = this.screenSize().width || 1;
    const H = this.screenSize().height || 1;
    const nx = Math.round(Math.max(0, Math.min(1, x / W)) * ABS_RANGE);
    const ny = Math.round(Math.max(0, Math.min(1, y / H)) * ABS_RANGE);

    // 不带 MOVE 的纯按钮事件（dx/dy 会被系统忽略，但结构里必须填合法值）
    const mkButton = (flags) => ({
      type: INPUT_MOUSE,
      mi: { dx: nx, dy: ny, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
    });

    const sentFlags = [];
    let sentCount = 0;

    // 1) 定位
    if (this._move(x, y)) { sentCount++; sentFlags.push(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE); }
    sleepSync(2 + Math.random() * 4);

    // 2) 按下
    let downOk = false;
    try {
      downOk = SendInput(1, mkButton(MOUSEEVENTF_LEFTDOWN), inpSize) === 1;
    } catch (err) { downOk = false; }
    if (downOk) { sentCount++; sentFlags.push(MOUSEEVENTF_LEFTDOWN); }

    // 3) 按住一小段（模拟真人按压时长，20-60ms）
    sleepSync(20 + Math.random() * 40);

    // 4) 抬起（无论按下是否成功都要发，避免"卡住"的按下状态）
    let upOk = false;
    try {
      upOk = SendInput(1, mkButton(MOUSEEVENTF_LEFTUP), inpSize) === 1;
    } catch (err) { upOk = false; }
    if (upOk) { sentCount++; sentFlags.push(MOUSEEVENTF_LEFTUP); }

    if (downOk && upOk) this.stats.sendinput++;
    else this._lastError = this._lastError ||
      '按下/抬起事件未被系统接受（可能被拦截或权限不足）';

    return { ok: downOk && upOk, sent: sentCount, steps: sentFlags, via: 'sendinput' };
  }

  /**
   * 诊断用：返回最近一次点击是否成功、系统为何拒绝。
   */
  lastTapInfo() {
    return {
      ok: !this._lastError,
      error: this._lastError || '',
      mode: this.mode,
      stats: this.stats,
    };
  }

  /** SendInput 没有直接对应 ADB deviceSize 的概念，返回屏幕尺寸 */
  deviceSize() {
    const s = this.screenSize();
    return { width: s.width, height: s.height };
  }
}

// ================================================================ 后端选择

/** 在常见路径里找 adb.exe */
function findAdb() {
  for (const p of ADB_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (err) { /* ignore */ }
  }
  return findInPath('adb.exe');
}

function findInPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    try {
      const p = path.join(d, name);
      if (fs.existsSync(p)) return p;
    } catch (err) { /* ignore */ }
  }
  return null;
}

/**
 * 用 TCP 快测哪些端口是活的。
 *
 * 目的：adb connect 每次都要启动进程，6 个端口最坏要 10 秒。
 * 先用 200ms 超时的 TCP 探测筛一遍，只把真正在监听的端口交给 adb，
 * 能把 ADB 探测从 10 秒降到 1 秒以内。
 *
 * @param {number[]} ports
 * @param {number} [timeoutMs]
 * @returns {Promise<number[]>}
 */
function probeListeningPorts(ports, timeoutMs = 200) {
  const net = require('net');
  const checks = ports.map((p) => new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (alive) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      resolve(alive ? p : null);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(p, '127.0.0.1'); } catch (e) { finish(false); }
  }));
  return Promise.all(checks).then((r) => r.filter((x) => x !== null));
}

/**
 * 同步版 TCP 端口探测。
 *
 * 为什么需要同步版：Runner 的构造函数是同步的，而 createInput 在里面调用。
 * 用 spawnSync 起一个极小的子进程做探测，远快于 adb 盲试 6 个端口的 12 秒。
 *
 * ★ 两个关键修正（都踩过）：
 *
 * 1) 子进程必须带 ELECTRON_RUN_AS_NODE=1。
 *    打包后 process.execPath 是 OnmyojiAssistant.exe（Electron 主程序），
 *    不带这个环境变量的话子进程会当成**整个 GUI 应用**启动，
 *    一路挂到 timeout（3 秒）才被杀 —— 表现就是「点开始后卡几秒钟」。
 *    开发态 process.execPath 是 node.exe，所以本地完全看不出这个问题。
 *
 * 2) 结果缓存一段时间。
 *    每次 Runner 构造都重新探测是浪费；ADB 有没有起来不会在几秒内变化。
 *
 * @param {number[]} ports
 * @param {number} [timeoutMs] 总超时
 * @returns {number[]} 存活端口
 */

const PROBE_CACHE_MS = 30000;
let probeCache = null; // { key, at, ports }

function probePortsSync(ports, timeoutMs = 1500) {
  const list = Array.isArray(ports) && ports.length ? ports : PORT_CANDIDATES;
  const key = list.join(',');

  if (probeCache && probeCache.key === key && (Date.now() - probeCache.at) < PROBE_CACHE_MS) {
    return probeCache.ports.slice();
  }

  const code = `
const net = require('net');
const ports = ${JSON.stringify(list)};
const alive = [];
let pending = ports.length;
if (pending === 0) { process.stdout.write('[]'); process.exit(0); }
for (const p of ports) {
  const s = new net.Socket();
  let done = false;
  const fin = (ok) => {
    if (done) return; done = true;
    try { s.destroy(); } catch (e) {}
    if (ok) alive.push(p);
    if (--pending === 0) { process.stdout.write(JSON.stringify(alive)); process.exit(0); }
  };
  s.setTimeout(150);
  s.once('connect', () => fin(true));
  s.once('timeout', () => fin(false));
  s.once('error', () => fin(false));
  try { s.connect(p, '127.0.0.1'); } catch (e) { fin(false); }
}
`;

  let result = [];
  try {
    // 关键：让 Electron 子进程退化成纯 Node，否则会挂到超时
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    const res = spawnSync(process.execPath, ['-e', code], {
      timeout: timeoutMs, encoding: 'utf8', windowsHide: true, env,
    });
    const txt = (res.stdout || '').trim();
    if (txt) {
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) result = arr;
    }
  } catch (err) {
    result = [];
  }

  probeCache = { key, at: Date.now(), ports: result };
  return result.slice();
}

/** 清掉探测缓存（测试用，或用户手动重连 ADB 后调用） */
function clearProbeCache() {
  probeCache = null;
}

/**
 * 创建输入后端。
 *
 * 顺序：ADB（连得上才用） → Windows SendInput。
 * 两者都不可用时返回 null，调用方应退化为"只识别不点击"。
 *
 * @param {object} [opts]
 * @param {'auto'|'adb'|'win32'} [opts.prefer='auto']
 * @param {number[]} [opts.portsHint]
 *        预探测得到的存活端口。**传空数组表示"已确认没有存活端口"，
 *        会直接跳过 ADB**，避免 10 秒以上的盲试。
 * @param {boolean} [opts.autoProbe=true]
 *        未提供 portsHint 时是否自动做一次同步端口探测。
 * @returns {object|null}
 */
function createInput(opts = {}) {
  const prefer = opts.prefer || 'auto';
  const log = opts.log || (() => {});

  if (prefer === 'win32') {
    return buildWinInput(log, opts);
  }

  let hints = Array.isArray(opts.portsHint) ? opts.portsHint : null;

  // 没给提示就自己快测一次，避免 adb 盲试
  if (hints === null && opts.autoProbe !== false && (prefer === 'auto' || prefer === 'adb')) {
    hints = probePortsSync(PORT_CANDIDATES);
    if (hints.length === 0) {
      log('端口快测: 没有模拟器 ADB 端口在监听');
    } else {
      log(`端口快测: 存活端口 ${hints.join(',')}`);
    }
  }

  const skipAdb = (hints !== null && hints.length === 0);

  if ((prefer === 'adb' || prefer === 'auto') && !skipAdb) {
    try {
      const adb = new AdbInput({ log });
      if (adb.isAvailable()) {
        const connected = hints && hints.length ? adb.connect(hints) : adb.connect();
        if (connected) {
          log('输入后端: ADB（模拟器内部注入）');
          return adb;
        }
        if (prefer === 'adb') {
          log(`指定 ADB 但连接失败: ${adb.status().lastError}`);
          return null;
        }
        const why = adb.status().lastError;
        if (why) log(`ADB 不可用（${why}）`);
      } else {
        log('未找到 adb.exe');
      }
    } catch (err) {
      log(`ADB 初始化失败: ${err.message}`);
    }
  } else if (skipAdb) {
    log('无可用 ADB 端口，改用 Windows 输入');
  }

  return buildWinInput(log, opts);
}

/** 构造 Windows 输入后端，失败返回 null */
function buildWinInput(log, opts) {
  const o = opts || {};
  try {
    const win = new WinInput({ log, hwnd: o.hwnd, mode: o.mode });
    if (win.isAvailable()) {
      log(win.mode === 'message'
        ? '输入后端: 消息投递（不移动鼠标）' +
          (win.hwnd ? '' : ' —— 但没有窗口句柄，将回退 SendInput')
        : '输入后端: Windows SendInput（会移动鼠标）');
      return win;
    }
    log(`Windows 输入不可用: ${win.status().lastError}`);
  } catch (err) {
    log(`Windows 输入初始化失败: ${err.message}`);
  }
  return null;
}

/**
 * 点击测试：在指定坐标（默认当前鼠标位置）做一次真实的点击。
 *
 * 优先用消息投递（不动光标）。如果传了 hwnd 就投给那个窗口，
 * 否则退化为 SendInput（会移动光标）。
 *
 * @param {{x?:number, y?:number, hwnd?:number}} [opts]
 */
function testClick(opts) {
  const o = opts || {};
  let win;
  try {
    win = new WinInput({ log: () => {}, hwnd: o.hwnd || null, mode: o.mode });
    if (!win.isAvailable()) {
      return { ok: false, error: win.status().lastError || 'WinInput 不可用' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let x = o.x;
  let y = o.y;
  let fromCursor = false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const pos = win.cursorPos();
    if (!pos) return { ok: false, error: '取不到鼠标位置，请传入 x/y' };
    x = pos.x; y = pos.y;
    fromCursor = true;
  }

  let res;
  try {
    res = win.tap(Math.round(x), Math.round(y));
  } catch (err) {
    return { ok: false, error: err.message, x, y };
  }

  return {
    ok: !!(res && res.ok),
    x: Math.round(x),
    y: Math.round(y),
    fromCursor,
    sent: res ? res.sent : 0,
    steps: res ? res.steps : [],
    backend: 'win32',
    via: res ? res.via : undefined,
    error: res && res.ok ? '' : (win.lastTapInfo().error || '按下或抬起未被接受'),
  };
}

module.exports = {
  AdbInput,
  WinInput,
  createInput,
  testClick,
  probeListeningPorts,
  probePortsSync,
  clearProbeCache,
  findAdb,
  ADB_CANDIDATES,
  PORT_CANDIDATES,
};
