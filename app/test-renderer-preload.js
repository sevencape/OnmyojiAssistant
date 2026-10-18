/**
 * 渲染进程测试专用的 preload：mock 掉 window.api
 *
 * 在真实 Electron 渲染进程里跑界面逻辑，但把所有 IPC 换成假实现，
 * 这样能验证「点击 → 调用 API → 渲染结果」的完整前端链路，
 * 不需要真的游戏窗口，也不会产生副作用（不写文件、不点击）。
 *
 * 所有调用都记录到 calls，通过 window.__test.getCalls() 取。
 * 不能直接把数组 expose 出去：contextBridge 会在 expose 时快照一次，
 * 之后 push 的内容测试侧看不到（实测踩过）。
 */

'use strict';

const { contextBridge } = require('electron');

const calls = [];

/** 模拟主进程侧的运行状态（由 runStart / runStopAll 改变，测试也能直接改） */
let running = false;

function rec(channel, payload) {
  calls.push({ channel, payload });
}

const FAKE_WINDOWS = [
  {
    hwnd: 123456,
    title: '阴阳师-MuMu模拟器专版',
    pid: 999,
    processName: 'onmyoji.exe',
    bounds: { left: 100, top: 50, width: 1728, height: 1019 },
    minimized: false,
    maximized: false,
    _score: 1000,
    _reason: '进程名精确匹配',
  },
];

contextBridge.exposeInMainWorld('__test', {
  getCalls: () => JSON.parse(JSON.stringify(calls)),
  setRunning: (v) => { running = !!v; },
  isRunning: () => running,
});

contextBridge.exposeInMainWorld('api', {
  listWindows: () => {
    rec('listWindows');
    return Promise.resolve({ ok: true, games: FAKE_WINDOWS, allCount: 10 });
  },

  panelInfo: () => {
    rec('panelInfo');
    return Promise.resolve({
      ok: true,
      bounds: { x: 0, y: 0, width: 400, height: 900 },
      alwaysOnTop: true,
      dpi: 'mock (test)',
    });
  },
  setAlwaysOnTop: (v) => { rec('setAlwaysOnTop', v); return Promise.resolve({ ok: true }); },
  minimizePanel: () => { rec('minimizePanel'); return Promise.resolve({ ok: true }); },
  closePanel: () => { rec('closePanel'); return Promise.resolve({ ok: true }); },

  runStart: (p) => {
    rec('runStart', p);
    running = true;
    return Promise.resolve({ ok: true, instanceId: 'r123456' });
  },
  runStop: (id) => {
    rec('runStop', id);
    running = false;
    return Promise.resolve({ ok: true });
  },
  runStopAll: () => {
    rec('runStopAll');
    running = false;
    return Promise.resolve({ ok: true });
  },
  runStatus: () => {
    rec('runStatus');
    const instances = running
      ? [{ hwnd: 123456, running: true, actions: 3, battles: 0, frames: 9, state: '挑战' }]
      : [];
    return Promise.resolve({ ok: true, instances });
  },

  focusWindow: (h) => { rec('focusWindow', h); return Promise.resolve({ ok: true }); },

  dataDir: () => {
    rec('dataDir');
    return Promise.resolve({
      ok: true,
      root: 'F:\\fake\\OnmyojiAssistant\\data',
      assetsDir: 'F:\\fake\\OnmyojiAssistant\\data\\assets',
      rulesPath: 'F:\\fake\\OnmyojiAssistant\\data\\rules.json',
      packaged: true,
    });
  },
  openDataDir: () => {
    rec('openDataDir');
    return Promise.resolve({ ok: true, root: 'F:\\fake\\OnmyojiAssistant\\config' });
  },

  // 素材诊断\n  diagnose: (hwnd) => {\n    rec('diagnose', hwnd);\n    return Promise.resolve({ ok: true, scale: 1, contentWidth: 1718, contentHeight: 1019, results: [] });\n  },\n\n  // 副本类型（来自 config/dungeons/*.json）
  dungeonsList: () => {
    rec('dungeonsList');
    return Promise.resolve({
      ok: true,
      configDir: 'F:\\fake\\OnmyojiAssistant\\config',
      dungeons: [
        { id: 'soul', name: '御魂', description: '探索 → 御魂 → 八岐大蛇 → 挑战 → 准备', order: 10, ruleCount: 9, missingAssets: [], error: null },
        { id: 'awaken', name: '觉醒材料', description: '探索 → 觉醒材料 → 火麒麟 → 挑战 → 准备', order: 20, ruleCount: 9, missingAssets: [], error: null },
        { id: 'evolve', name: '御灵', description: '探索 → 御魂 → 暗神龙 → 挑战 → 准备', order: 30, ruleCount: 10, missingAssets: [], error: null },
        { id: 'common', name: '通用副本', description: '挑战 → 准备 → 结算', order: 90, ruleCount: 5, missingAssets: [], error: null },
      ],
    });
  },

  testClick: (opts) => {
    rec('testClick', opts);
    return Promise.resolve({
      ok: true, x: 1280, y: 720, fromCursor: true,
      sent: 3, steps: [32769, 2, 4], backend: 'win32', error: '',
    });
  },

  onLog: () => () => {},
});
