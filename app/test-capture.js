/**
 * 截图降级链测试
 *
 * ── 这个测试是为了防一次「程序无响应被 Windows 关掉」的事故 ──
 *
 * 事故现象：点开始后过一会儿整个程序卡死，事件日志 Application Hang (AppHangB1)。
 *
 * 根本原因：
 *   截图降级链的顺序是 bitblt → printwindow_full → printwindow → screen。
 *   协同合成的游戏窗口用 bitblt 每帧都拿到全黑，于是**每一帧**都在调 PrintWindow。
 *   而 PrintWindow 会向目标窗口发**同步消息**（WM_PRINT），调用方要等对端处理完
 *   才返回 —— 目标程序一忙（进战斗读条、加载资源）就无限阻塞，
 *   把我们 Electron 主进程的主线程卡住，窗口不再响应消息，Windows 就把程序关了。
 *
 * 修复：
 *   1. 顺序改成 bitblt → screen → printwindow，安全便宜的排前面
 *   2. Runner 记住可用的方式，之后不再逐帧重试整条链
 *   3. 默认禁用 PrintWindow（params.allowPrintWindow 显式开启才用）
 *   4. 支持 OMJ_NO_PRINTWINDOW=1 环境变量彻底关闭
 *
 * 本测试锁死以上行为。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const native = require('./lib/native');
const capture = require('./lib/capture');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

const W = 200, H = 100;

function solidFrame(brightness) {
  const bgra = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    bgra[o] = brightness;
    bgra[o + 1] = brightness;
    bgra[o + 2] = brightness;
    bgra[o + 3] = 255;
  }
  return { width: W, height: H, bgra };
}

// 保存原始实现，测试结束后还原
const orig = {
  getWindowBounds: native.getWindowBounds,
  captureWindow: native.captureWindow,
  captureScreen: native.captureScreen,
};

function stubNative(behavior) {
  native.getWindowBounds = () => ({ left: 0, top: 0, width: W, height: H });
  native.captureWindow = (hwnd, rect, method) => {
    const b = behavior[method];
    if (b === 'throw') throw new Error('模拟失败');
    return solidFrame(b == null ? 0 : b);
  };
  native.captureScreen = () => {
    const b = behavior.screen;
    if (b === 'throw') throw new Error('模拟失败');
    return solidFrame(b == null ? 0 : b);
  };
}

function restoreNative() {
  native.getWindowBounds = orig.getWindowBounds;
  native.captureWindow = orig.captureWindow;
  native.captureScreen = orig.captureScreen;
}

function main() {
  console.log('='.repeat(66));
  console.log('  截图降级链测试');
  console.log('='.repeat(66));

  // ===== 1. 默认顺序：PrintWindow 默认不参与 =====
  console.log('\n[1] 默认顺序（PrintWindow 关闭）');
  {
    stubNative({ bitblt: 0, screen: 120, printwindow_full: 200, printwindow: 200 });
    const r = capture.captureWithFallback(1, {});
    check('bitblt 全黑时退回 screen', r.method === 'screen', r.method);
    check('完全没有尝试 printwindow',
      r.attempted.indexOf('printwindow') < 0 && r.attempted.indexOf('printwindow_full') < 0,
      `试过 [${r.attempted.join(',')}]`);
    check('记录了 bitblt 全黑', r.failed.some((f) => f.method === 'bitblt' && f.black === true),
      r.failed.map((f) => f.method).join(','));
    restoreNative();
  }

  // ===== 2. 即使允许 PrintWindow，screen 也排在它前面 =====
  console.log('\n[2] 允许 PrintWindow 时仍优先 screen');
  {
    stubNative({ bitblt: 0, screen: 120, printwindow_full: 200, printwindow: 200 });
    const r = capture.captureWithFallback(1, { allowPrintWindow: true });
    check('选中 screen（不是 printwindow）', r.method === 'screen', r.method);
    check('没有走到 printwindow',
      r.attempted.indexOf('printwindow_full') < 0,
      `试过 [${r.attempted.join(',')}]  ← 关键：PrintWindow 必须排在 screen 后面`);
    restoreNative();
  }

  // ===== 3. screen 也不可用时才用 PrintWindow =====
  console.log('\n[3] screen 也失败时才用 PrintWindow');
  {
    stubNative({ bitblt: 0, screen: 0, printwindow_full: 200, printwindow: 200 });
    const r = capture.captureWithFallback(1, { allowPrintWindow: true });
    check('降级到 printwindow_full', r.method === 'printwindow_full', r.method);
    check('按顺序试过 bitblt,screen 后才是 printwindow',
      r.attempted.join(',') === 'bitblt,screen,printwindow_full',
      `[${r.attempted.join(',')}]`);
    restoreNative();
  }

  // ===== 4. OMJ_NO_PRINTWINDOW=1 彻底禁用 =====
  console.log('\n[4] 环境变量彻底禁用 PrintWindow');
  {
    stubNative({ bitblt: 0, screen: 0, printwindow_full: 200, printwindow: 200 });
    process.env.OMJ_NO_PRINTWINDOW = '1';
    const r = capture.captureWithFallback(1, { allowPrintWindow: true });
    delete process.env.OMJ_NO_PRINTWINDOW;
    check('即使 allowPrintWindow=true 也不试 printwindow',
      r.attempted.indexOf('printwindow_full') < 0 && r.attempted.indexOf('printwindow') < 0,
      `试过 [${r.attempted.join(',')}]，结果 ${r.method}`);
    check('返回 none-usable 并带告警', r.method === 'none-usable' && !!r.warning);
    restoreNative();
  }

  // ===== 5. prefer：学会的方式只试一次 =====
  console.log('\n[5] prefer 学习');
  {
    stubNative({ bitblt: 0, screen: 120, printwindow_full: 200, printwindow: 200 });
    const r = capture.captureWithFallback(1, { prefer: 'screen' });
    check('首选方式命中后不再试其他', r.attempted.length === 1 && r.attempted[0] === 'screen',
      `试过 [${r.attempted.join(',')}]`);
    check('方法正确', r.method === 'screen', r.method);
    restoreNative();
  }

  // ===== 6. skip：已验证无效的方式直接跳过 =====
  console.log('\n[6] skip 跳过已知无效方式');
  {
    stubNative({ bitblt: 0, screen: 120, printwindow_full: 200, printwindow: 200 });
    const r = capture.captureWithFallback(1, { skip: ['bitblt'] });
    check('跳过 bitblt', r.attempted.indexOf('bitblt') < 0, `试过 [${r.attempted.join(',')}]`);
    check('仍然拿到 screen', r.method === 'screen', r.method);
    check('skip 的方式记录在 failed 里',
      r.failed.some((f) => f.method === 'bitblt'), r.failed.map((f) => f.method).join(','));
    restoreNative();
  }

  // ===== 7. 抛异常也要继续降级 =====
  console.log('\n[7] 某方式抛异常时继续降级');
  {
    stubNative({ bitblt: 'throw', screen: 120, printwindow_full: 200, printwindow: 200 });
    const r = capture.captureWithFallback(1, {});
    check('bitblt 抛异常后仍能拿到 screen', r.method === 'screen', r.method);
    check('异常被记录', r.failed.some((f) => f.method === 'bitblt' && /模拟失败/.test(f.reason)),
      (r.failed.find((f) => f.method === 'bitblt') || {}).reason || '');
    restoreNative();
  }

  // ===== 8. grabContent 把 failed/attempted 透传给调用方 =====
  console.log('\n[8] grabContent 透传学习信息');
  {
    stubNative({ bitblt: 0, screen: 120, printwindow_full: 200, printwindow: 200 });
    const g = capture.grabContent(1, { roi: { x: 0, y: 0, width: W, height: H } });
    check('返回 method', g.method === 'screen', g.method);
    check('返回 attempted 数组', Array.isArray(g.attempted), `[${(g.attempted || []).join(',')}]`);
    check('返回 failed 数组', Array.isArray(g.failed) && g.failed.length > 0,
      (g.failed || []).map((f) => f.method).join(','));
    check('帧尺寸正确', g.frame.width === W && g.frame.height === H,
      `${g.frame.width}x${g.frame.height}`);
    restoreNative();
  }

  console.log('\n' + '='.repeat(66));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败项：');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(66));
  return fail === 0 ? 0 : 1;
}

process.exit(main());
