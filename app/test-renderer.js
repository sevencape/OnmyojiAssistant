/**
 * 渲染进程冒烟测试（在真实 Electron 里跑）
 *
 * 目的：验证界面的 JS 绑定真的生效，而不只是 DOM 元素存在。
 * 只做「HTML 里有这个 id」「app.js 语法正确」这类静态检查是不够的 ——
 * 运行期抛异常时事件监听会挂不上，界面看起来正常却点不动。
 *
 * 覆盖：
 *   1. 基础渲染（卡片、实例列表、参数控件）
 *   2. 自动选中第一个实例
 *   3. 开发者选项可折叠 / 展开后控件在
 *   4. 参数收集（runStart 的 payload 正确）
 *   5. 开始/停止按钮状态（含「结束后恢复」的真实 bug 回归）
 *   6. 打开数据目录 / 测试点击
 *   7. 页面无 JS 错误
 *
 * 用法: electron test-renderer.js
 */

'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

// 不拦截的话，销毁临时窗口会触发 Electron 默认退出，测试会在中途被杀
app.on('window-all-closed', () => {});

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? '  -> ' + detail : ''}`);
}

async function run() {
  console.log('='.repeat(66));
  console.log('  渲染进程冒烟测试');
  console.log('='.repeat(66));

  const win = new BrowserWindow({
    width: 400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'test-renderer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) pageErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    pageErrors.push('渲染进程崩溃: ' + JSON.stringify(d));
  });

  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // ---------- 1. 基础渲染 ----------
  console.log('\n[1] 基础渲染');
  const base = await win.webContents.executeJavaScript(`(() => {
    const sel = document.getElementById('dungeonType');
    return {
      cards: document.querySelectorAll('.card').length,
      instanceCount: document.querySelectorAll('.instance').length,
      hasDungeonType: !!sel,
      hasMaxBattles: !!document.getElementById('maxBattles'),
      hasMaxMinutes: !!document.getElementById('maxMinutes'),
      dungeonOptions: sel ? sel.options.length : 0,
      dungeonNames: sel ? Array.from(sel.options).map(o => o.textContent) : [],
      hasDevOpts: !!document.getElementById('devOpts'),
      devOptsOpen: document.getElementById('devOpts') ? document.getElementById('devOpts').open : null,
      hasCalib: !!document.getElementById('calibOverlay') || !!document.getElementById('btnCalibrate'),
      hasDock: !!document.getElementById('dockEnabled'),
    };
  })()`);
  record('卡片已渲染', base.cards >= 4, base.cards + ' 个 .card');
  record('实例列表已填充', base.instanceCount >= 1, base.instanceCount + ' 个实例');
  record('常用参数都在', base.hasDungeonType && base.hasMaxBattles && base.hasMaxMinutes);
  record('副本类型下拉栏由配置填充', base.dungeonOptions >= 4,
    base.dungeonOptions + ' 个: ' + (base.dungeonNames || []).join(' / '));
  record('开发者选项存在且默认折叠', base.hasDevOpts && base.devOptsOpen === false,
    base.hasDevOpts ? (base.devOptsOpen ? '默认展开' : '默认折叠') : '不存在');
  record('素材标定界面已移除', base.hasCalib === false);
  record('贴边停靠界面已移除', base.hasDock === false);

  // ---------- 2. 自动选中 ----------
  console.log('\n[2] 自动选中行为');
  const autoSel = await win.webContents.executeJavaScript(`(() => {
    const picked = document.querySelector('.instance.selected');
    return { hasSelected: !!picked, hwnd: picked ? picked.dataset.hwnd : null };
  })()`);
  record('init 后自动选中第一个实例',
    autoSel.hasSelected && autoSel.hwnd === '123456', autoSel.hwnd || '无选中');

  // ---------- 3. 开发者选项 ----------
  console.log('\n[3] 开发者选项');
  const dev = await win.webContents.executeJavaScript(`(() => {
    const d = document.getElementById('devOpts');
    d.open = true;
    return new Promise(r => setTimeout(() => r({
      open: d.open,
      hasInterval: !!document.getElementById('actionInterval'),
      hasIntervalMax: !!document.getElementById('actionIntervalMax'),
      hasChance: !!document.getElementById('triggerChance'),
      hasJitter: !!document.getElementById('clickJitter'),
      hasDryRun: !!document.getElementById('dryRun'),
      hasTestClick: !!document.getElementById('btnTestClick'),
      hasDiagnose: !!document.getElementById('btnDiagnose'),
      hasOpenData: !!document.getElementById('btnOpenData'),
      hasTeam: !!document.getElementById('teamIndex'),
      hasSoulLayer: !!document.getElementById('fieldSoulLayer'),
      // 展开后子控件应该有可见尺寸
      visible: (() => {
        const el = document.getElementById('actionInterval');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })(),
    }), 200));
  })()`);
  record('可以展开', dev.open === true);
  record('展开后控件可见（不是 display:none）', dev.visible === true);
  record('随机间隔控件在', dev.hasInterval && dev.hasIntervalMax);
  record('概率/抖动控件在', dev.hasChance && dev.hasJitter);
  record('仅识别不点击在', dev.hasDryRun);
  record('测试点击按钮在', dev.hasTestClick);
  record('素材诊断按钮在', dev.hasDiagnose);
  record('打开数据目录按钮在', dev.hasOpenData);
  record('阵容/层数也收进了开发者选项', dev.hasTeam && dev.hasSoulLayer);

  // ---------- 4. 参数收集 ----------
  console.log('\n[4] 参数收集');
  const pay = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('dungeonType').value = 'awaken';
    document.getElementById('maxBattles').value = '25';
    document.getElementById('maxMinutes').value = '60';
    document.getElementById('actionInterval').value = '0.4';
    document.getElementById('actionIntervalMax').value = '1.2';
    document.getElementById('triggerChance').value = '80';
    document.getElementById('clickJitter').value = '20';
    document.getElementById('dryRun').checked = true;
    document.getElementById('btnStart').click();
    return new Promise(r => setTimeout(() => {
      const call = window.__test.getCalls().filter(c => c.channel === 'runStart')[0];
      r(call ? call.payload : null);
    }, 400));
  })()`);
  record('点了开始并调用了 runStart', pay !== null);
  if (pay) {
    const p = pay.params || {};
    record('副本类型传递正确', p.dungeonId === 'awaken', String(p.dungeonId));
    record('最大场次传递正确', p.maxBattles === 25, String(p.maxBattles));
    record('最长时长传递正确', p.maxMinutes === 60, String(p.maxMinutes));
    record('最短间隔传递正确', p.actionInterval === 0.4, String(p.actionInterval));
    record('最长间隔传递正确', p.actionIntervalMax === 1.2, String(p.actionIntervalMax));
    record('触发概率换算成 0-1', Math.abs(p.triggerChance - 0.8) < 1e-6, String(p.triggerChance));
    record('点击抖动换算成 0-1', Math.abs(p.clickJitter - 0.2) < 1e-6, String(p.clickJitter));
    record('仅识别传递正确', p.dryRun === true, String(p.dryRun));
    record('hwnd 传递正确', pay.hwnd === 123456, String(pay.hwnd));
  }

  // ---------- 5. 按钮状态 ----------
  console.log('\n[5] 开始/停止按钮状态');
  const afterStart = await win.webContents.executeJavaScript(`(() => ({
    startDisabled: document.getElementById('btnStart').disabled,
    stopDisabled: document.getElementById('btnStop').disabled,
    badge: document.getElementById('engineBadge').textContent,
  }))()`);
  record('开始后「开始」置灰', afterStart.startDisabled === true);
  record('开始后「停止」可用', afterStart.stopDisabled === false);
  record('徽标显示运行中', afterStart.badge.indexOf('运行') >= 0, afterStart.badge);

  await win.webContents.executeJavaScript(`window.__test.setRunning(false)`);
  await new Promise((r) => setTimeout(r, 1800));
  const afterEnd = await win.webContents.executeJavaScript(`(() => ({
    startDisabled: document.getElementById('btnStart').disabled,
    stopDisabled: document.getElementById('btnStop').disabled,
    badge: document.getElementById('engineBadge').textContent,
  }))()`);
  record('运行自然结束后「开始」恢复可用（核心回归）',
    afterEnd.startDisabled === false, afterEnd.startDisabled ? '仍置灰 ← bug' : '已恢复');
  record('结束后「停止」置灰', afterEnd.stopDisabled === true);
  record('徽标显示已停止', afterEnd.badge.indexOf('停止') >= 0, afterEnd.badge);

  // 手动停止路径
  await win.webContents.executeJavaScript(`document.getElementById('btnStart').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await win.webContents.executeJavaScript(`document.getElementById('btnStop').click()`);
  await new Promise((r) => setTimeout(r, 1800));
  const afterStop = await win.webContents.executeJavaScript(`(() => ({
    startDisabled: document.getElementById('btnStart').disabled,
    stopCalls: window.__test.getCalls().filter(c => c.channel === 'runStopAll').length,
  }))()`);
  record('手动停止后「开始」恢复可用（核心回归）',
    afterStop.startDisabled === false, afterStop.startDisabled ? '仍置灰 ← bug' : '已恢复');
  record('手动停止调用了 runStopAll', afterStop.stopCalls >= 1, afterStop.stopCalls + ' 次');

  // ---------- 6. 数据目录与点击测试 ----------
  console.log('\n[6] 数据目录与点击测试');
  const dataUi = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('btnOpenData').click();
    document.getElementById('btnTestClick').click();
    document.getElementById('btnDiagnose').click();
    return new Promise(r => setTimeout(() => {
      const cs = window.__test.getCalls().map(c => c.channel);
      r({
        hint: document.getElementById('dataDirHint').textContent,
        calledOpen: cs.indexOf('openDataDir') >= 0,
        calledTest: cs.indexOf('testClick') >= 0,
      });
    }, 500));
  })()`);
  record('数据目录提示已显示', dataUi.hint.length > 0, dataUi.hint || '(空)');
  record('点击「打开数据目录」调用了 IPC', dataUi.calledOpen);
  record('点击「测试点击」调用了 IPC', dataUi.calledTest);

  // ---------- 7. 页面错误 ----------
  console.log('\n[7] 运行期错误');
  record('页面无 JS 错误', pageErrors.length === 0,
    pageErrors.length ? pageErrors.join(' | ').slice(0, 240) : '无');

  win.destroy();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(66));
  console.log('  通过 ' + (results.length - failed.length) + '  失败 ' + failed.length);
  if (failed.length) {
    console.log('\n  失败项：');
    failed.forEach((f) => console.log('    - ' + f.name + (f.detail ? '  ' + f.detail : '')));
  }
  console.log('='.repeat(66));
  return failed.length === 0 ? 0 : 1;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    console.error('测试异常:', err && err.stack ? err.stack : err);
    code = 1;
  }
  app.exit(code);
});
