/**
 * Electron 主进程。
 *
 * 职责：
 *   - 创建无边框贴边面板窗口
 *   - 声明 DPI 感知（必须早于任何窗口坐标操作）
 *   - 提供 IPC：枚举游戏窗口、启停自动化、停靠控制、日志推送
 *   - 管理多实例：每个被选中的游戏窗口对应一个独立的自动化 runner
 */

'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');

const native = require('./lib/native');
const gameDetect = require('./lib/gamedetect');
const { RunnerManager } = require('./lib/runner');

// ---------------------------------------------------------------- 自检模式
//
// 用法: OnmyojiAssistant.exe --self-check
//
// 用途：验证打包后的运行环境是否健康。这一步很关键，因为
//   - koffi 是原生模块，打包后可能因为 asar 路径问题加载失败
//   - DPI 感知必须在建窗之前声明
//   - 游戏窗口检测依赖 Win32 枚举
// 任何一项失败都会写入退出码，方便脚本化排查。
// 必须在单实例锁之前处理，否则会干扰正在运行的实例。
if (process.argv.includes('--self-check')) {
  runSelfCheck();
  // 走到这里说明 runSelfCheck 已收尾（通常已 exit）。
  // 若在非 Electron 运行时下，runSelfCheck 会走 finishSelfCheck 的 process.exit 分支。
}

/**
 * 判断当前是否真的跑在 Electron 运行时里。
 *
 * ★ 为什么必须判断（实测踩到的坑）：
 *   如果环境变量 ELECTRON_RUN_AS_NODE 存在，electron.exe 会**退化成纯 Node**：
 *     - require('electron') 返回可执行文件路径字符串，不是 API 对象
 *     - app / BrowserWindow 全部 undefined
 *     - process.type 为 undefined（正常应为 'browser'）
 *   此时若继续往下执行 requestSingleInstanceLock()，会直接抛
 *   "Cannot read properties of undefined"，进程以 0x80000003 崩溃。
 *
 * 所以所有用到 app 的地方都必须先过这一关。
 */
function isElectronRuntime() {
  return typeof app !== 'undefined' && app !== null && typeof app.getVersion === 'function';
}

function runSelfCheck() {
  const lines = [];
  let failed = 0;

  const ok = (name, detail) => lines.push(`[ OK ] ${name}${detail ? '  -> ' + detail : ''}`);
  const bad = (name, detail) => {
    failed++;
    lines.push(`[FAIL] ${name}${detail ? '  -> ' + detail : ''}`);
  };

  lines.push('=========================================');
  lines.push('  阴阳师助手 自检');
  lines.push('=========================================');

  // 1. 运行时
  lines.push('');
  lines.push('[1] 运行时');
  ok('Electron', process.versions.electron);
  ok('Node', process.versions.node);
  ok('Chrome', process.versions.chrome);

  // 运行模式才是关键判据，环境变量只是线索
  const inElectron = isElectronRuntime();
  if (inElectron) {
    ok('运行模式', 'Electron 主进程 (app 可用)');
  } else {
    bad('运行模式',
      `实际跑成了纯 Node（process.type=${String(process.type)}, app=${typeof app}）。` +
      '原因通常是环境变量 ELECTRON_RUN_AS_NODE 存在');
  }
  if (process.env.ELECTRON_RUN_AS_NODE) {
    lines.push(`         环境变量 ELECTRON_RUN_AS_NODE=${JSON.stringify(process.env.ELECTRON_RUN_AS_NODE)}`);
  }

  // 不是 Electron 运行时，后续 app 相关检查全部没意义，直接收尾
  if (!inElectron) {
    lines.push('');
    lines.push('  提示：请清除 ELECTRON_RUN_AS_NODE 后重新启动。');
    lines.push('        在 cmd 里用 setlocal + set "ELECTRON_RUN_AS_NODE=" 通常无效，');
    lines.push('        因为该变量可能在进程创建时被父环境重新注入。');
    lines.push('        直接双击 exe 运行不受此问题影响。');
    finishSelfCheck(lines, failed);
    return;
  }

  // 2. DPI
  lines.push('');
  lines.push('[2] DPI 感知');
  try {
    const mode = native.enableDpiAwareness();
    ok('声明 DPI 感知', mode);
  } catch (err) {
    bad('声明 DPI 感知', err.message);
  }

  // 3. koffi / Win32
  lines.push('');
  lines.push('[3] koffi / Win32 绑定');
  try {
    native.ensureApi();
    ok('加载 Win32 动态库', 'user32 / gdi32 / kernel32');
  } catch (err) {
    bad('加载 Win32 动态库', err.message);
  }

  // 4. 窗口枚举
  lines.push('');
  lines.push('[4] 窗口枚举');
  let windows = [];
  if (failed === 0) {
    try {
      const t0 = Date.now();
      windows = native.listWindows();
      ok('枚举顶层窗口', `${windows.length} 个, ${Date.now() - t0}ms`);
    } catch (err) {
      bad('枚举顶层窗口', err.message);
    }

    const games = gameDetect.pickGameWindows(windows, process.pid);

    if (games.length > 0) {
      ok('检测到游戏窗口', `${games.length} 个`);
      for (const g of games) {
        lines.push(`         hwnd=${g.hwnd} "${g.title}" ` +
          `${g.bounds.width}x${g.bounds.height} @(${g.bounds.left},${g.bounds.top}) ` +
          `proc=${g.processName || '?'} (${g._reason})`);
      }
    } else {
      lines.push('         (未运行阴阳师，跳过游戏窗口检测)');
    }

    // 5. 截图
    lines.push('');
    lines.push('[5] 截图链路');
    const target = games.find((g) => !g.minimized);
    if (target) {
      try {
        const capture = require('./lib/capture');
        const t0 = Date.now();
        const r = capture.grabContent(target.hwnd);
        const ms = Date.now() - t0;
        const brightness = capture.meanBrightness(r.frame);
        const frameOk = brightness >= 3;
        const methodNote = r.method === 'bitblt'
          ? '窗口DC'
          : r.method === 'screen'
            ? '屏幕DC(已降级)'
            : r.method;
        (frameOk ? ok : bad)('截图 + 内容区探测',
          `${methodNote} | 窗口 ${r.fullSize.width}x${r.fullSize.height} → ` +
          `内容区 ${r.roi.width}x${r.roi.height}@(${r.roi.x},${r.roi.y}) ` +
          `亮度 ${brightness.toFixed(1)}/255, ${ms}ms`);
        if (r.warning) bad('截图降级告警', r.warning);
      } catch (err) {
        bad('截图 + 内容区探测', err.message);
      }
    } else {
      lines.push('         (无可用游戏窗口，跳过)');
    }
  } else {
    lines.push('         (前置检查失败，跳过)');
  }

  // 6. 识别与输入模块（验证打包后这些模块能被正确加载）
  lines.push('');
  lines.push('[6] 识别与输入模块');
  try {
    const vision = require('./lib/vision');
    ok('视觉模块', `模板引擎就绪 (coarse factor ${vision.COAST_FACTOR || vision.COARSE_FACTOR || '?'})`);
    const { normalizeRegion } = require('./lib/runner');
    ok('规则模块', `region 归一化就绪`);
  } catch (err) {
    bad('视觉/规则模块', err.message);
  }
  try {
    const input = require('./lib/input');
    ok('输入模块', `ADB ${input.findAdb() ? '已找到' : '未找到'} / Win32 SendInput 可用`);
  } catch (err) {
    bad('输入模块', err.message);
  }

  // 检查界面资源是否齐全（打包漏文件时最容易出问题）
  try {
    const fs = require('fs');
    const rendererDir = path.join(__dirname, 'renderer');
    const need = ['index.html', 'styles.css', 'app.js'];
    const missing = need.filter((f) => !fs.existsSync(path.join(rendererDir, f)));
    if (missing.length === 0) ok('界面资源', need.join(' / '));
    else bad('界面资源', '缺少 ' + missing.join(', '));
  } catch (err) {
    bad('界面资源', err.message);
  }

  // 6.5 权限（UIPI）
  lines.push('');
  lines.push('[6.5] 权限');
  try {
    const elevated = native.isElevated();
    if (elevated === true) {
      ok('运行权限', '管理员（可以给管理员权限的游戏窗口发送点击）');
    } else if (elevated === false) {
      ok('运行权限', '普通用户 —— 若游戏以管理员运行，点击会被系统拦截，建议以管理员身份运行本程序');
    } else {
      ok('运行权限', '无法检测');
    }
  } catch (err) {
    bad('运行权限', err.message);
  }

  // 7. 配置目录与副本流程
  // 出过一次事故：规则和素材不在同一个地方，程序报「素材全部缺失」但用户不知道去哪看。
  // 现在配置目录是唯一的来源，自检里把「读的是哪个目录、有哪些副本、缺哪些素材」全列出来。
  lines.push('');
  lines.push('[7] 配置目录与副本流程');
  try {
    const paths = require('./lib/paths');
    const dungeonsLib = require('./lib/dungeons');
    const fs = require('fs');

    const configDir = paths.resolveConfigDir();
    const dungeonsDir = paths.dungeonsDirFor(configDir);
    const assetsDir = paths.assetsDirFor(configDir);

    ok('配置目录', configDir + (paths.isPackaged() ? ' (打包模式)' : ' (开发模式)'));

    const pngs = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => /\.png$/i.test(f))
      : [];
    ok('素材目录', `${assetsDir} (${pngs.length} 个 PNG)`);

    const list = dungeonsLib.listDungeons(dungeonsDir, assetsDir);
    if (list.length === 0) {
      bad('副本配置', `${dungeonsDir} 里没有 json（加一个即可新增副本类型）`);
    } else {
      ok('副本配置', `${list.length} 种: ` +
        list.map((d) => `${d.name}(${d.rules.length}条)`).join(', '));
      for (const d of list) {
        if (d.error) {
          bad(`副本「${d.name}」`, d.error);
        } else if (d.missingAssets.length) {
          ok(`副本「${d.name}」`, `缺 ${d.missingAssets.length} 张素材: ${d.missingAssets.join(', ')}`);
        } else {
          ok(`副本「${d.name}」`, `素材齐全 ${d.rules.length}/${d.rules.length}`);
        }
      }
    }
  } catch (err) {
    bad('配置目录', err.message);
  }

  finishSelfCheck(lines, failed);
}

/**
 * 输出自检结果并退出。
 * 抽出来是为了让「非 Electron 运行时」的提前返回路径也能复用同一套收尾逻辑。
 */
function finishSelfCheck(lines, failed) {
  lines.push('');
  lines.push('=========================================');
  lines.push(failed === 0 ? '  自检通过' : `  自检失败：${failed} 项`);
  lines.push('=========================================');

  const text = lines.join('\n');
  try {
    process.stdout.write(text + '\n');
  } catch (err) { /* 打包后可能无 stdout */ }

  // 落盘一份，方便无控制台时（打包后双击运行）查看结果。
  // 写日志本身绝不能成为失败原因，所以全程 try 包裹、并且在 app 不可用时跳过。
  try {
    const fs = require('fs');
    const os = require('os');

    let target = null;
    if (isElectronRuntime()) {
      try {
        const ud = app.getPath('userData');
        if (ud) target = path.join(ud, 'self-check.log');
      } catch (err) { /* userData 不可用时忽略 */ }
    }

    if (target) {
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, text + '\n', 'utf8');
    }
  } catch (err) {
    // 退到临时目录再试一次
    try {
      const fs = require('fs');
      const os = require('os');
      fs.writeFileSync(path.join(os.tmpdir(), 'onmyoji-assistant-self-check.log'),
        text + '\n', 'utf8');
    } catch (err2) { /* 彻底放弃写日志 */ }
  }

  const code = failed === 0 ? 0 : 1;
  if (isElectronRuntime()) {
    setTimeout(() => app.exit(code), 60);
  } else {
    process.exit(code);
  }
}

// 单实例：多开会互相抢停靠位置，而且没必要。
// 但必须先确认真的在 Electron 运行时里，否则 app undefined 会直接崩。
if (!isElectronRuntime()) {
  // 正常启动路径走到这里说明环境不对，给出明确提示而不是抛 TypeError
  const msg = [
    '阴阳师助手启动失败：当前不是 Electron 运行时。',
    '',
    '原因：环境变量 ELECTRON_RUN_AS_NODE 存在，electron.exe 退化成纯 Node，',
    '      app / BrowserWindow 都不可用。',
    '',
    '处理：',
    '  1. 直接双击 OnmyojiAssistant.exe 运行（不受该变量影响）',
    '  2. 或在启动前清除 ELECTRON_RUN_AS_NODE，再运行 --self-check 排查',
  ].join('\n');
  try { process.stdout.write(msg + '\n'); } catch (err) { /* ignore */ }
  try {
    const fs = require('fs');
    const os = require('os');
    fs.writeFileSync(path.join(os.tmpdir(), 'onmyoji-assistant-boot-error.log'),
      msg + '\n', 'utf8');
  } catch (err) { /* ignore */ }
  process.exit(3);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow|null} */
let panel = null;
/** @type {RunnerManager|null} */
let runners = null;

const PANEL_WIDTH = 380;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 560;

// ---------------------------------------------------------------- 面板窗口

function computeDefaultPosition() {
  // 默认放主屏工作区右侧
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const height = Math.min(900, wa.height);
  return {
    x: Math.round(wa.x + wa.width - PANEL_WIDTH),
    y: Math.round(wa.y + Math.max(0, (wa.height - height) / 2)),
    width: PANEL_WIDTH,
    height,
  };
}

function createPanel() {
  const pos = computeDefaultPosition();

  panel = new BrowserWindow({
    ...pos,
    minWidth: PANEL_MIN_WIDTH,
    maxWidth: PANEL_MAX_WIDTH,
    minHeight: 420,
    frame: false,            // 无边框，贴边时才不会露出标题栏
    resizable: true,
    movable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,      // 保留任务栏项，方便切回来
    alwaysOnTop: true,       // 默认置顶，方便边看边操作
    backgroundColor: '#12161c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,        // preload 需要 require
    },
  });

  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  panel.once('ready-to-show', () => panel.show());

  // 外部链接用系统浏览器打开，不要在面板里导航
  panel.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  panel.on('closed', () => {
    panel = null;
  });

  return panel;
}

/** 把日志推给渲染进程 */
function pushLog(level, message, instanceId = null) {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('log', {
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      message,
      instanceId,
    });
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  // --- 窗口枚举：返回所有窗口 + 自动识别出的游戏窗口 ---
  ipcMain.handle('windows:list', () => {
    try {
      const all = native.listWindows();
      // 用共享的识别逻辑，保证界面显示的和自检判定的一致
      const games = gameDetect.pickGameWindows(all, process.pid);
      return { ok: true, games, allCount: all.length };
    } catch (err) {
      return { ok: false, error: err.message, games: [], allCount: 0 };
    }
  });

  // --- 面板自身信息 ---
  ipcMain.handle('panel:info', () => {
    if (!panel) return { ok: false };
    const b = panel.getBounds();
    return {
      ok: true,
      bounds: b,
      alwaysOnTop: panel.isAlwaysOnTop(),
      dpi: native.enableDpiAwareness(),
    };
  });

  ipcMain.handle('panel:setAlwaysOnTop', (_e, value) => {
    if (!panel) return { ok: false };
    panel.setAlwaysOnTop(!!value);
    return { ok: true, alwaysOnTop: panel.isAlwaysOnTop() };
  });

  ipcMain.handle('panel:close', () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('panel:minimize', () => {
    if (panel) panel.minimize();
    return { ok: true };
  });

  // --- 自动化 ---
  ipcMain.handle('run:start', (_e, payload) => {
    if (!runners) return { ok: false, error: '运行管理器未初始化' };
    // 把选中的副本配置解析出来，交给 Runner
    let dungeon = null;
    try {
      const paths = require('./lib/paths');
      const dungeons = require('./lib/dungeons');
      const configDir = paths.resolveConfigDir();
      const id = (payload && payload.params && payload.params.dungeonId) || 'soul';
      dungeon = dungeons.loadDungeon(
        paths.dungeonsDirFor(configDir), id, paths.assetsDirFor(configDir));
      if (!dungeon) {
        return { ok: false, error: `找不到副本配置: ${id}（检查 config/dungeons/${id}.json）` };
      }
      if (dungeon.error) {
        return { ok: false, error: `副本配置有误: ${dungeon.error}` };
      }
      if (!dungeon.rules.length) {
        return { ok: false, error: `副本「${dungeon.name}」没有任何规则` };
      }
    } catch (err) {
      return { ok: false, error: '读取副本配置失败: ' + err.message };
    }
    return runners.start({ ...payload, dungeon });
  });

  ipcMain.handle('run:stop', (_e, instanceId) => {
    if (!runners) return { ok: false, error: '运行管理器未初始化' };
    return runners.stop(instanceId);
  });

  ipcMain.handle('run:stopAll', () => {
    if (!runners) return { ok: false, error: '运行管理器未初始化' };
    return runners.stopAll();
  });

  ipcMain.handle('run:status', () => {
    if (!runners) return { ok: false, instances: [] };
    return { ok: true, instances: runners.status() };
  });

  // --- 数据目录 ---
  ipcMain.handle('data:info', () => {
    try {
      const paths = require('./lib/paths');
      const root = paths.resolveDataRoot();
      const configDir = paths.resolveConfigDir();
      return {
        ok: true,
        root,
        configDir,
        dungeonsDir: paths.dungeonsDirFor(configDir),
        assetsDir: paths.assetsDirFor(configDir),
        packaged: paths.isPackaged(),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- 素材诊断 ---
  // 对当前画面把每条规则用到的素材都匹配一遍，报最高分。
  // 用途：排查「识别不到素材」到底差多少分、要不要调阈值、要不要重裁。
  ipcMain.handle('vision:diagnose', (_e, hwnd) => {
    try {
      const paths = require('./lib/paths');
      const dungeonsLib = require('./lib/dungeons');
      const capture = require('./lib/capture');
      const vision = require('./lib/vision');

      let target = hwnd;
      if (!target) {
        const games = require('./lib/gamedetect')
          .pickGameWindows(require('./lib/native').listWindows(), process.pid)
          .filter((w) => (w.processName || '').toLowerCase().includes('onmyoji'));
        if (!games.length) return { ok: false, error: '没有找到游戏窗口' };
        target = games[0].hwnd;
      }

      const configDir = paths.resolveConfigDir();
      const assetsDir = paths.assetsDirFor(configDir);
      const screenCfg = dungeonsLib.loadScreenConfig(configDir);

      const grab = capture.grabContent(target, { allowPrintWindow: false });
      const frame = grab.frame;

      // 与 Runner 一致：按内容区宽度缩放素材
      const scale = screenCfg.autoScale === false
        ? 1
        : frame.width / (screenCfg.referenceWidth || 1718);

      const lib = new vision.TemplateLibrary(assetsDir);
      lib.setScale(scale);
      const ctx = vision.createFrameContext(frame);

      // 收集所有副本用到的素材（去重），逐条报分数
      const list = dungeonsLib.listDungeons(
        paths.dungeonsDirFor(configDir), assetsDir);
      const names = [];
      for (const d of list) {
        for (const r of d.rules) {
          if (r.template && names.indexOf(r.template) < 0) names.push(r.template);
        }
      }

      const results = [];
      for (const name of names) {
        const tpl = lib.get(name);
        if (!tpl) { results.push({ name, score: 0, error: '素材读取失败' }); continue; }
        const hit = vision.matchTemplate(ctx, tpl, null, 0);
        results.push({
          name,
          score: hit ? hit.score : 0,
          width: tpl.width,
          height: tpl.height,
          at: hit ? { x: hit.cx, y: hit.cy } : null,
        });
      }
      results.sort((a, b) => b.score - a.score);

      pushLog('info', `素材诊断: 内容区 ${frame.width}x${frame.height}，` +
        `素材按 ${scale.toFixed(3)} 倍缩放，共 ${results.length} 个素材`);
      for (const r of results) {
        const mark = r.score >= 0.86 ? '命中' : (r.score >= 0.7 ? '接近' : '不足');
        pushLog(r.score >= 0.86 ? 'ok' : 'info',
          `  ${r.name.padEnd(18)} ${String(r.width).padStart(3)}x${String(r.height).padEnd(3)} 最高分 ${r.score.toFixed(3)} ${mark}`);
      }
      const best = results[0];
      if (best && best.score < 0.86) {
        pushLog('warn', `当前画面没有任何素材达到阈值 0.86（最高 ${best.name} ${best.score.toFixed(3)}）。` +
          `若这个画面本该有按钮：先确认素材是按 config/screen.json 的基准宽度裁的，再考虑重裁或调阈值`);
      }

      return { ok: true, scale, contentWidth: frame.width, contentHeight: frame.height, results };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- 副本配置 ---
  // 界面启动时拉一次，用来填充「副本类型」下拉栏。
  // 这样往 config/dungeons/ 里加一个 json，重启程序就能看到新类型。
  ipcMain.handle('dungeons:list', () => {
    try {
      const paths = require('./lib/paths');
      const dungeons = require('./lib/dungeons');
      const configDir = paths.resolveConfigDir();
      const list = dungeons.listDungeons(
        paths.dungeonsDirFor(configDir), paths.assetsDirFor(configDir));
      return {
        ok: true,
        configDir,
        dungeons: list.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          order: d.order,
          ruleCount: d.ruleCount,
          missingAssets: d.missingAssets,
          error: d.error || null,
        })),
      };
    } catch (err) {
      return { ok: false, error: err.message, dungeons: [] };
    }
  });

  // 打开配置目录（用户要改的是 config/dungeons 和 config/assets）
  ipcMain.handle('data:open', async () => {
    try {
      const paths = require('./lib/paths');
      const fs = require('fs');
      const configDir = paths.resolveConfigDir();
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      const err = await shell.openPath(configDir);
      return err ? { ok: false, error: err } : { ok: true, root: configDir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- 输入测试 ---
  // 在当前鼠标位置做一次真实点击，验证输入链路。
  // 传了 hwnd 就用消息投递（不动光标）；没传就退化为 SendInput（会移动光标）。
  ipcMain.handle('input:testClick', (_e, opts) => {
    try {
      const input = require('./lib/input');
      const o = opts || {};

      // 没指定窗口就用第一个游戏窗口，这样能走「不移动鼠标」的消息投递
      let hwnd = o.hwnd;
      if (!hwnd) {
        try {
          const native = require('./lib/native');
          const games = require('./lib/gamedetect')
            .pickGameWindows(native.listWindows(), process.pid)
            .filter((w) => (w.processName || '').toLowerCase().includes('onmyoji'));
          if (games.length) hwnd = games[0].hwnd;
        } catch (err) { /* 取不到就算了，走 SendInput */ }
      }

      const res = input.testClick({ hwnd, x: o.x, y: o.y });
      if (res.ok) {
        pushLog('ok', `测试点击成功：屏幕(${res.x},${res.y}) 方式=${res.via === 'message' ? '消息投递（未移动鼠标）' : 'SendInput（移动了鼠标）'}`);
      } else {
        pushLog('error', `测试点击失败：${res.error || '未知原因'} 屏幕(${res.x},${res.y})`);
      }
      return res;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- 窗口操作 ---
  ipcMain.handle('window:focus', (_e, hwnd) => {
    return { ok: native.bringToFront(hwnd) };
  });
}

// ---------------------------------------------------------------- 生命周期

app.on('second-instance', () => {
  if (panel) {
    if (panel.isMinimized()) panel.restore();
    panel.show();
    panel.focus();
  }
});

app.whenReady().then(() => {
  // DPI 感知必须在建窗之前
  const dpi = native.enableDpiAwareness();

  panel = createPanel();


  runners = new RunnerManager({
    log: (level, message, instanceId) => pushLog(level, message, instanceId),
  });

  registerIpc();

  pushLog('info', `助手已启动 | DPI: ${dpi}`);

  // UIPI 提示：如果游戏以管理员运行而本程序不是，点击会被系统丢弃
  // （鼠标会动，但游戏收不到按键）——这是实测踩过的坑，必须在启动就说清楚。
  const elevated = native.isElevated();
  if (elevated === false) {
    pushLog('warn', '本程序未以管理员身份运行。如果游戏是以管理员启动的，' +
      'Windows 会拦截点击（鼠标会动但游戏无反应）。建议右键 exe → 以管理员身份运行。');
  } else if (elevated === true) {
    pushLog('info', '已以管理员身份运行，可以给管理员权限的游戏窗口发送输入');
  }

  startMainThreadWatchdog();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) panel = createPanel();
  });
});

// ---------------------------------------------------------------- 主线程看门狗
//
// 出过一次「点开始后程序无响应被 Windows 关掉」的事故（事件日志 AppHangB1），
// 但事后没有任何日志能说明卡在哪里 —— 因为卡住的时候日志也写不出去。
//
// 这个看门狗每 300ms 检查一次事件循环的「实际间隔」：
// 如果主线程被同步调用阻塞，定时器就会被推迟，等它恢复后我们能算出被卡了多久。
// 卡超过 1.5 秒就立刻记一条错误（带持续时间），下次再出问题就有据可查。
let watchdogTimer = null;
function startMainThreadWatchdog() {
  if (watchdogTimer) return;
  let last = Date.now();
  let worstMs = 0;

  watchdogTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;

    // 正常应该在 300ms 左右；明显超出说明主线程被阻塞过
    if (gap > 1500) {
      worstMs = Math.max(worstMs, gap);
      pushLog('error',
        `主线程被阻塞 ${gap}ms（可能是截图/输入/模板匹配的同步调用），` +
        `如果持续出现请把这条日志发出来`);
    }
  }, 300);

  // 未捕获异常也要落日志，否则崩了什么都不剩
  process.on('uncaughtException', (err) => {
    pushLog('error', `未捕获异常: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
  });
  process.on('unhandledRejection', (err) => {
    pushLog('error', `未处理的 Promise 拒绝: ${err && err.message ? err.message : err}`);
  });
}

app.on('window-all-closed', () => {
  if (runners) runners.stopAll();
  app.quit();
});

app.on('before-quit', () => {
  if (runners) runners.stopAll();
});
