/**
 * 环境探针 —— 验证运行链路，不依赖游戏是否在运行。
 *
 * 用法:
 *   npm run probe
 *   （或 electron probe.js）
 *
 * 检查项:
 *   1. Electron / Node 版本
 *   2. koffi 能否加载 Win32 动态库
 *   3. DPI 感知是否声明成功
 *   4. 能否枚举窗口，并识别出候选游戏窗口
 *   5. 能否对目标窗口截图
 *   6. 截图像素是否为全黑（独占全屏 / 最小化的典型症状）
 *   7. PNG 编码是否正确
 *   8. 贴边停靠用的 SetWindowPos 是否可用
 *
 * 退出码 0 = 全部通过；非 0 = 有失败项，见输出。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const native = require('./lib/native');
const capture = require('./lib/capture');
const gameDetect = require('./lib/gamedetect');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  const mark = ok === true ? '[ OK ]' : ok === 'skip' ? '[SKIP]' : '[FAIL]';
  console.log(`  ${mark} ${name}${detail ? '  -> ' + detail : ''}`);
}

async function run() {
  console.log('');
  console.log('=========================================================');
  console.log('  阴阳师助手 - 环境探针');
  console.log('=========================================================');
  console.log('');

  // ---------- 1. 版本 ----------
  console.log('[1] 运行时版本');
  record('Electron 已就绪', true, `electron ${process.versions.electron}`);
  record('Node 已就绪', true, `node ${process.versions.node}, chrome ${process.versions.chrome}`);

  // ---------- 2. koffi ----------
  console.log('\n[2] koffi / Win32 绑定');
  let apiOk = false;
  try {
    native.ensureApi();
    apiOk = true;
    record('koffi 加载 Win32 动态库', true, 'user32 / gdi32 / kernel32');
  } catch (err) {
    record('koffi 加载 Win32 动态库', false, err.message);
  }

  // ---------- 3. DPI ----------
  console.log('\n[3] DPI 感知');
  let dpiMode = '未执行';
  if (apiOk) {
    try {
      dpiMode = native.enableDpiAwareness();
      record('声明进程 DPI 感知', true, dpiMode);
    } catch (err) {
      record('声明进程 DPI 感知', false, err.message);
    }
  } else {
    record('声明进程 DPI 感知', 'skip', 'koffi 不可用');
  }

  // ---------- 4. 窗口枚举 ----------
  console.log('\n[4] 窗口枚举');
  let windows = [];
  if (apiOk) {
    try {
      const t0 = Date.now();
      windows = native.listWindows();
      record('枚举顶层窗口', true, `找到 ${windows.length} 个, 耗时 ${Date.now() - t0}ms`);

      // 候选游戏窗口：走共享识别逻辑（进程名优先，过滤隐藏窗口与自身）
      const candidates = gameDetect.pickGameWindows(windows, process.pid);

      if (candidates.length > 0) {
        record('检测到候选游戏窗口', true, `${candidates.length} 个`);
        for (const w of candidates) {
          console.log(`         hwnd=${w.hwnd} "${w.title}" ${w.bounds.width}x${w.bounds.height}` +
            ` @(${w.bounds.left},${w.bounds.top}) proc=${w.processName || '?'}` +
            ` (${w._reason})` + (w.minimized ? ' [最小化]' : ''));
        }
      } else {
        record('检测到候选游戏窗口', 'skip', '当前没有运行阴阳师（不影响环境验证）');
        console.log('         当前窗口列表前 10 个（用于确认检测关键字）:');
        for (const w of windows.slice(0, 10)) {
          console.log(`         hwnd=${w.hwnd} "${w.title}" ${w.bounds.width}x${w.bounds.height}` +
            ` proc=${w.processName || '?'}`);
        }
      }
    } catch (err) {
      record('枚举顶层窗口', false, err.message);
    }
  } else {
    record('枚举顶层窗口', 'skip', 'koffi 不可用');
  }

  // ---------- 5-7. 截图 / 像素 / PNG ----------
  console.log('\n[5] 截图链路');

  /**
   * 对一个窗口做完整截图验证。
   *
   * 现在 grabContent 内部是**降级链**，所以这里不再逐个方式对比，而是：
   *   1. 正常调用一次（走降级链），报告实际生效的方式和内容区
   *   2. 单独试各级方式，报告每一级在该窗口上的可用性（诊断用）
   *
   * @param {object} win
   * @param {boolean} strictBlank 全黑是否算失败（真实游戏窗口 = true）
   */
  async function testCapture(win, strictBlank) {
    console.log(`         目标: "${win.title}" hwnd=${win.hwnd} ` +
      `${win.bounds.width}x${win.bounds.height} proc=${win.processName || '?'}`);

    // ---- 1. 正常调用（降级链自动选路）----
    let outcome;
    const t0 = Date.now();
    try {
      outcome = capture.grabContent(win.hwnd);
    } catch (err) {
      record('截图链路', false, err.message);
      return false;
    }
    const ms = Date.now() - t0;
    const brightness = capture.meanBrightness(outcome.frame);
    const { roi } = outcome;
    const usable = brightness >= 3;

    const how = outcome.method === 'bitblt' ? '窗口DC'
      : outcome.method === 'screen' ? '屏幕DC(降级)'
        : outcome.method;

    record('截图链路', usable ? true : (strictBlank ? false : 'skip'),
      `生效方式 ${how} | 窗口 ${outcome.fullSize.width}x${outcome.fullSize.height} → ` +
      `内容区 ${roi.width}x${roi.height}@(${roi.x},${roi.y}) ` +
      `亮度 ${brightness.toFixed(1)}/255, ${ms}ms`);

    if (usable) {
      console.log(`         坐标换算基准: 屏幕坐标 = (${outcome.windowOrigin.left},${outcome.windowOrigin.top})` +
        ` + (${roi.x},${roi.y}) + 内容区坐标`);
    }

    // ---- 2. 存图供人工确认 ----
    const outDir = path.join(__dirname, 'debug');
    const outFile = path.join(outDir, `probe_${win.hwnd}.png`);
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outFile, capture.encodePng(outcome.frame));
      record('写出截图文件', true, outFile);
    } catch (err) {
      // debug/ 可能因沙箱权限不可写；换成工作区外的可写位置再试
      try {
        const alt = path.join(require('electron').app.getPath('userData'), `probe_${win.hwnd}.png`);
        fs.writeFileSync(alt, capture.encodePng(outcome.frame));
        record('写出截图文件', true, alt);
      } catch (err2) {
        record('写出截图文件', 'skip', `debug/ 不可写 (${err.code || err.message})`);
      }
    }

    if (outcome.warning) {
      console.log('         ⚠ ' + String(outcome.warning).split(/\r?\n/)[0]);
    }

    // ---- 3. 各级方式可用性诊断 ----
    console.log('         各级抓取方式在该窗口上的表现:');
    for (const m of ['bitblt', 'printwindow_full', 'printwindow']) {
      try {
        const f = capture.grab(win.hwnd, undefined, m);
        const b = capture.meanBrightness(f);
        console.log(`           ${m.padEnd(17)} 亮度 ${b.toFixed(1)}/255 ${b >= 3 ? '可用' : '全黑不可用'}`);
      } catch (err) {
        console.log(`           ${m.padEnd(17)} 失败: ${err.message}`);
      }
    }
    try {
      const f = capture.grabScreen(native.getWindowBounds(win.hwnd));
      const b = capture.meanBrightness(f);
      console.log(`           ${'screen'.padEnd(17)} 亮度 ${b.toFixed(1)}/255 ${b >= 3 ? '可用' : '全黑不可用'}`);
    } catch (err) {
      console.log(`           ${'screen'.padEnd(17)} 失败: ${err.message}`);
    }

    // ---- 4. 性能 ----
    try {
      const p0 = Date.now();
      const N = 10;
      for (let i = 0; i < N; i++) capture.grabContent(win.hwnd, { roi });
      const avg = (Date.now() - p0) / N;
      record('截图性能', avg < 300,
        `含内容区裁剪 平均 ${avg.toFixed(1)}ms/帧 (约 ${(1000 / Math.max(avg, 1)).toFixed(0)} fps)`);
    } catch (err) {
      record('截图性能', false, err.message);
    }

    return usable;
  }

  // 目标挑选：直接复用共享识别逻辑的结果（已按可信度 + 面积排序）
  const realTarget = candidates.find((w) => !w.minimized) || null;

  if (realTarget) {
    console.log('         使用真实游戏窗口验证（有效验证）');
    await testCapture(realTarget, true);
  } else {
    console.log('         未找到游戏窗口，退回自建测试窗口（仅验证引擎可用性）');
  }

  // 自建窗口：验证 GDI → PNG 引擎链路本身没问题
  let testWindow = null;
  if (!realTarget) {
    try {
      testWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: true,
        backgroundColor: '#4a6fa5',
        webPreferences: { offscreen: false },
      });
      await testWindow.loadURL('data:text/html,' + encodeURIComponent(
        '<body style="margin:0;background:#4a6fa5">' +
        '<h1 style="color:#fff;font-family:sans-serif;padding:40px">截图测试目标</h1></body>'
      ));
      testWindow.show();
      testWindow.focus();
      // 给合成器足够时间完成首次绘制
      await new Promise((r) => setTimeout(r, 1200));

      const hwndBuf = testWindow.getNativeWindowHandle();
      const hwnd = hwndBuf.readBigInt64LE
        ? Number(hwndBuf.readBigInt64LE(0))
        : hwndBuf.readUInt32LE(0);

      record('创建截图测试窗口', true, `hwnd=${hwnd}`);
      await testCapture({ hwnd, title: '测试窗口', bounds: testWindow.getBounds() }, false);
    } catch (err) {
      record('创建截图测试窗口', false, err.message);
    }
  }

  // ---------- 6. 贴边停靠能力 ----------
  // 用一个专门建的可移动窗口做测试，**绝不能拿真实的游戏/模拟器窗口当试验品**
  console.log('\n[6] 贴边停靠能力');
  let moveTarget = null;
  if (testWindow && !testWindow.isDestroyed()) {
    const b = testWindow.getNativeWindowHandle();
    moveTarget = {
      hwnd: b.readBigInt64LE ? Number(b.readBigInt64LE(0)) : b.readUInt32LE(0),
      label: '测试窗口',
    };
  }

  if (!apiOk) {
    record('SetWindowPos 移动窗口', 'skip', 'koffi 不可用');
  } else if (!moveTarget) {
    // 没有测试窗口时，创建一个最小的可移动窗口专门用于本项测试
    try {
      const w = new BrowserWindow({ width: 300, height: 200, show: true, frame: false });
      const b = w.getNativeWindowHandle();
      moveTarget = {
        hwnd: b.readBigInt64LE ? Number(b.readBigInt64LE(0)) : b.readUInt32LE(0),
        label: '临时测试窗口',
      };
      moveTarget.window = w;
      record('创建可移动测试窗口', true, `hwnd=${moveTarget.hwnd}`);
    } catch (err) {
      record('创建可移动测试窗口', false, err.message);
    }
  }

  if (moveTarget) {
    try {
      const before = native.getWindowBounds(moveTarget.hwnd);
      const okMove = native.setWindowPos(
        moveTarget.hwnd,
        before.left + 20,
        before.top + 20,
        before.width,
        before.height
      );
      const after = native.getWindowBounds(moveTarget.hwnd);
      const moved = after.left !== before.left || after.top !== before.top;
      record('SetWindowPos 移动窗口', okMove && moved,
        `${moveTarget.label} (${before.left},${before.top}) -> (${after.left},${after.top})`);
      // 挪回原位
      native.setWindowPos(moveTarget.hwnd, before.left, before.top, before.width, before.height);
    } catch (err) {
      record('SetWindowPos 移动窗口', false, err.message);
    }
  }

  if (moveTarget && moveTarget.window && !moveTarget.window.isDestroyed()) {
    moveTarget.window.destroy();
  }

  if (testWindow && !testWindow.isDestroyed()) testWindow.destroy();

  // ---------- 汇总 ----------
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === 'skip');
  const passed = results.filter((r) => r.ok === true);

  console.log('');
  console.log('=========================================================');
  console.log(`  通过 ${passed.length}  失败 ${failed.length}  跳过 ${skipped.length}`);
  if (failed.length) {
    console.log('');
    console.log('  失败项：');
    for (const f of failed) console.log(`    - ${f.name}: ${f.detail}`);
  }
  console.log('=========================================================');
  console.log('');

  return failed.length === 0 ? 0 : 1;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    console.error('\n探针异常终止:', err && err.stack ? err.stack : err);
    code = 1;
  }
  app.exit(code);
});

// 探针不需要窗口，避免残留
app.on('window-all-closed', () => {});
