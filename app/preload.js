/**
 * preload：在隔离上下文里暴露一组最小 API 给渲染进程。
 *
 * 安全约定：
 *   - contextIsolation: true
 *   - nodeIntegration: false
 *   - 只暴露明确列出的方法，不暴露 ipcRenderer 本身
 *     这样渲染进程即使被注入脚本也无法调用任意 IPC 通道
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---------- 窗口检测 ----------
  listWindows: () => ipcRenderer.invoke('windows:list'),

  // ---------- 面板 ----------
  panelInfo: () => ipcRenderer.invoke('panel:info'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('panel:setAlwaysOnTop', value),
  minimizePanel: () => ipcRenderer.invoke('panel:minimize'),
  closePanel: () => ipcRenderer.invoke('panel:close'),

  // ---------- 自动化 ----------
  runStart: (payload) => ipcRenderer.invoke('run:start', payload),
  runStop: (instanceId) => ipcRenderer.invoke('run:stop', instanceId),
  runStopAll: () => ipcRenderer.invoke('run:stopAll'),
  runStatus: () => ipcRenderer.invoke('run:status'),

  // ---------- 窗口操作 ----------
  focusWindow: (hwnd) => ipcRenderer.invoke('window:focus', hwnd),

  // ---------- 数据目录 ----------
  // 返回数据目录路径（assets/ 与 rules.json 所在位置）
  dataDir: () => ipcRenderer.invoke('data:info'),
  // 在资源管理器里打开数据目录
  openDataDir: () => ipcRenderer.invoke('data:open'),
  // 列出 config/dungeons/ 里的所有副本类型（用于填充下拉栏）
  dungeonsList: () => ipcRenderer.invoke('dungeons:list'),
  // 素材诊断：把当前画面和各素材匹配一遍，返回每个素材的最高分
  diagnose: (hwnd) => ipcRenderer.invoke('vision:diagnose', hwnd),

  // ---------- 输入测试 ----------
  // 在指定坐标（默认当前鼠标位置）发一次真实点击，验证输入链路是否生效
  testClick: (opts) => ipcRenderer.invoke('input:testClick', opts),

  // ---------- 日志订阅 ----------
  onLog: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('log', wrapped);
    return () => ipcRenderer.removeListener('log', wrapped);
  },
});
