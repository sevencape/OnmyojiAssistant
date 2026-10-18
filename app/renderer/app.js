/**
 * 渲染进程逻辑：窗口检测、实例选择、参数收集、启停控制、日志显示。
 *
 * 通过 preload 暴露的 window.api 与主进程通信，不直接接触 Node。
 * 本文件是纯前端，没有构建步骤，直接由 index.html 加载。
 */

'use strict';

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);

const el = {
  engineBadge: $('engineBadge'),
  btnPin: $('btnPin'),
  btnMin: $('btnMin'),
  btnClose: $('btnClose'),

  instanceList: $('instanceList'),
  detectHint: $('detectHint'),
  autoRefresh: $('autoRefresh'),
  btnRefresh: $('btnRefresh'),

  dungeonType: $('dungeonType'),
  dungeonHint: $('dungeonHint'),
  fieldSoulLayer: $('fieldSoulLayer'),
  soulLayer: $('soulLayer'),
  teamIndex: $('teamIndex'),
  maxBattles: $('maxBattles'),
  maxMinutes: $('maxMinutes'),
  actionInterval: $('actionInterval'),
  actionIntervalMax: $('actionIntervalMax'),
  actionIntervalValue: $('actionIntervalValue'),
  triggerChance: $('triggerChance'),
  clickJitter: $('clickJitter'),
  btnTestClick: $('btnTestClick'),
  btnDiagnose: $('btnDiagnose'),
  dryRun: $('dryRun'),

  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  statRunning: $('statRunning'),
  statActions: $('statActions'),
  statBattles: $('statBattles'),

  log: $('log'),
  btnClearLog: $('btnClearLog'),

  btnOpenData: $('btnOpenData'),
  dataDirHint: $('dataDirHint'),
};

// ---------------------------------------------------------------- 状态

const state = {
  games: [],
  selectedHwnd: null,
  alwaysOnTop: true,
  statusTimer: null,
  // uiRunning 表示「界面上认为自己正在跑」。
  // 一定要有独立标志位，不能用 btnStop.disabled 代替 ——
  // 点「停止」时就会把它置 true，拿它当判断条件会导致开始按钮永远恢复不了（真实 bug）。
  uiRunning: false,
  dataDir: null,
  configDir: null,
  // 副本类型列表来自 config/dungeons/*.json
  dungeons: [],
};

// ---------------------------------------------------------------- 日志

const MAX_LOG_LINES = 400;

function addLog(level, message, instanceId) {
  const line = document.createElement('div');
  line.className = 'log-line ' + (level || 'info');

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  // 用 textContent 而不是 innerHTML，避免窗口标题里的特殊字符破坏结构
  msg.textContent = (instanceId ? `[${instanceId}] ` : '') + message;

  line.appendChild(time);
  line.appendChild(msg);
  el.log.appendChild(line);

  while (el.log.childElementCount > MAX_LOG_LINES) {
    el.log.removeChild(el.log.firstChild);
  }
  el.log.scrollTop = el.log.scrollHeight;
}

el.btnClearLog.addEventListener('click', () => {
  el.log.innerHTML = '';
});

// ---------------------------------------------------------------- 窗口检测

function renderInstances() {
  el.instanceList.innerHTML = '';

  if (state.games.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '未检测到阴阳师窗口';
    el.instanceList.appendChild(empty);
    el.detectHint.textContent =
      '请先启动阴阳师 PC 客户端。若已启动仍未检测到，点「刷新」查看全部窗口日志。';
    return;
  }

  el.detectHint.textContent = `检测到 ${state.games.length} 个游戏窗口，点击选择要操作的目标。`;

  for (const g of state.games) {
    const item = document.createElement('div');
    item.className = 'instance' + (g.hwnd === state.selectedHwnd ? ' selected' : '');
    item.dataset.hwnd = String(g.hwnd);

    const dot = document.createElement('div');
    dot.className = 'dot';

    const info = document.createElement('div');
    info.className = 'info';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = g.title || `窗口 ${g.hwnd}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${g.bounds.width}×${g.bounds.height} @ (${g.bounds.left},${g.bounds.top})` +
      (g.processName ? ` · ${g.processName}` : '') +
      (g.minimized ? ' · 已最小化' : '');

    info.appendChild(name);
    info.appendChild(meta);

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'hwnd ' + g.hwnd;

    item.appendChild(dot);
    item.appendChild(info);
    item.appendChild(tag);

    item.addEventListener('click', () => selectInstance(g));
    el.instanceList.appendChild(item);
  }
}

async function selectInstance(game) {
  state.selectedHwnd = game.hwnd;
  renderInstances();
  addLog('info', `已选择目标: "${game.title}" (hwnd ${game.hwnd}, pid ${game.pid})`);
}

async function refreshWindows(verbose = false) {
  const res = await window.api.listWindows();
  if (!res.ok) {
    addLog('error', '窗口枚举失败: ' + res.error);
    return;
  }
  state.games = res.games;

  // 选中的窗口消失了就清空选择
  if (state.selectedHwnd && !state.games.some((g) => g.hwnd === state.selectedHwnd)) {
    state.selectedHwnd = null;
  }
  // 没有选中项时自动选第一个，省一次点击
  if (!state.selectedHwnd && state.games.length > 0) {
    state.selectedHwnd = state.games[0].hwnd;
  }

  renderInstances();

  if (verbose) {
    addLog('info', `窗口枚举完成：共 ${res.allCount} 个顶层窗口，其中游戏窗口 ${res.games.length} 个`);
  }
}

el.btnRefresh.addEventListener('click', () => {
  addLog('info', '刷新窗口列表…');
  refreshWindows(true);
});

el.autoRefresh.addEventListener('change', () => {
  if (el.autoRefresh.checked) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
});

let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => refreshWindows(false), 2000);
}
function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ---------------------------------------------------------------- 副本类型

// 副本类型完全由 config/dungeons/*.json 决定。
// 加一套流程 = 丢一个 json + 对应 png 进 config，重启程序即可在这里选到。
state.dungeons = [];

async function loadDungeons() {
  try {
    const res = await window.api.dungeonsList();
    if (!res || !res.ok) {
      addLog('error', '读取副本配置失败: ' + ((res && res.error) || '未知'));
      return;
    }
    state.dungeons = res.dungeons || [];
    state.configDir = res.configDir;

    const sel = el.dungeonType;
    const prev = sel.value;
    sel.innerHTML = '';

    if (state.dungeons.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（没有副本配置）';
      sel.appendChild(o);
      addLog('error', 'config/dungeons/ 里没有找到任何 json 配置');
      return;
    }

    for (const d of state.dungeons) {
      const o = document.createElement('option');
      o.value = d.id;
      // 有问题/缺素材的，直接在名字上标出来，不用点开才知道
      const bad = d.error || (d.missingAssets && d.missingAssets.length);
      o.textContent = d.name + (bad ? ' ⚠' : '');
      o.title = (d.description || '') +
        (d.missingAssets && d.missingAssets.length ? `\n缺素材: ${d.missingAssets.join(', ')}` : '') +
        (d.error ? `\n配置错误: ${d.error}` : '');
      sel.appendChild(o);
    }

    if (prev && state.dungeons.some((d) => d.id === prev)) sel.value = prev;
    updateDungeonHint();
    addLog('info', `已加载 ${state.dungeons.length} 种副本类型: ` +
      state.dungeons.map((d) => `${d.name}(${d.ruleCount}条)`).join(', '));

    const incomplete = state.dungeons.filter((d) => d.missingAssets && d.missingAssets.length);
    for (const d of incomplete) {
      addLog('warn', `副本「${d.name}」缺少素材: ${d.missingAssets.join(', ')}` +
        `（放到 config/assets/ 即可，缺素材的规则会被自动跳过）`);
    }
  } catch (err) {
    addLog('error', '读取副本配置异常: ' + (err && err.message ? err.message : err));
  }
}

function currentDungeon() {
  const id = el.dungeonType.value;
  return state.dungeons.find((d) => d.id === id) || null;
}

function updateDungeonHint() {
  const d = currentDungeon();
  el.fieldSoulLayer.classList.toggle('hidden', !d || d.id !== 'soul');
  if (!el.dungeonHint) return;
  if (!d) { el.dungeonHint.textContent = ''; return; }
  const bits = [];
  if (d.description) bits.push(d.description);
  bits.push(`${d.ruleCount} 条规则`);
  if (d.missingAssets && d.missingAssets.length) bits.push(`缺 ${d.missingAssets.length} 张素材`);
  el.dungeonHint.textContent = bits.join(' · ');
}

el.dungeonType.addEventListener('change', updateDungeonHint);

el.actionInterval.addEventListener('input', updateIntervalHint);
el.actionIntervalMax.addEventListener('input', updateIntervalHint);

function updateIntervalHint() {
  const a = Number(el.actionInterval.value) || 0.6;
  const b = Number(el.actionIntervalMax.value) || 0;
  if (b > a) {
    el.actionIntervalValue.textContent = `每轮在 ${a.toFixed(1)}–${b.toFixed(1)} 秒之间随机`;
  } else {
    el.actionIntervalValue.textContent = `固定 ${a.toFixed(1)} 秒（最长间隔 ≤ 最短间隔）`;
  }
}

function collectParams() {
  const minInterval = Number(el.actionInterval.value) || 0.6;
  const maxInterval = Number(el.actionIntervalMax.value) || 0;
  const chancePercent = Number(el.triggerChance.value);
  const jitterPercent = Number(el.clickJitter.value);

  return {
    // 副本类型现在是配置文件的 id（config/dungeons/*.json）
    dungeonId: el.dungeonType.value,
    soulLayer: Number(el.soulLayer.value),
    teamIndex: Number(el.teamIndex.value),
    maxBattles: Number(el.maxBattles.value) || 0,
    maxMinutes: Number(el.maxMinutes.value) || 0,
    actionInterval: minInterval,
    // 0 或 <= 最短间隔 表示固定间隔
    actionIntervalMax: maxInterval > minInterval ? maxInterval : 0,
    // 1 = 每次命中都点；0.6 = 六成概率点
    triggerChance: Number.isFinite(chancePercent)
      ? Math.max(0.01, Math.min(1, chancePercent / 100))
      : 1,
    // 0 = 永远点正中；0.35 = 在按钮内部随机取点
    clickJitter: Number.isFinite(jitterPercent)
      ? Math.max(0, Math.min(0.9, jitterPercent / 100))
      : 0.35,
    dryRun: el.dryRun.checked,
    errorStreakLimit: 12,
  };
}

// ---------------------------------------------------------------- 启停

el.btnStart.addEventListener('click', async () => {
  if (!state.selectedHwnd) {
    addLog('warn', '请先选择一个游戏实例');
    return;
  }
  const game = state.games.find((g) => g.hwnd === state.selectedHwnd);
  if (!game) {
    addLog('warn', '目标窗口已失效，请刷新');
    return;
  }
  if (game.minimized) {
    addLog('warn', '目标窗口处于最小化状态，截图会得到黑屏，请先恢复游戏窗口');
  }

  const params = collectParams();
  const res = await window.api.runStart({
    hwnd: game.hwnd,
    title: game.title,
    params,
  });

  if (!res.ok) {
    addLog('error', '启动失败: ' + res.error);
    // 启动失败也要把按钮恢复到可用，否则用户点一次失败就再也点不了了
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
    setBadge('就绪', '');
    return;
  }

  state.uiRunning = true;
  el.btnStart.disabled = true;
  el.btnStop.disabled = false;
  setBadge('运行中', 'running');
  startStatusPolling();
});

el.btnStop.addEventListener('click', async () => {
  // 只置灰停止按钮防重复点击；开始按钮的恢复交给 pollStatus 统一处理，
  // 不能用「btnStop 是否可用」去推断运行状态。
  el.btnStop.disabled = true;
  setBadge('停止中…', '');
  try {
    await window.api.runStopAll();
  } catch (err) {
    addLog('error', '停止请求失败: ' + (err && err.message ? err.message : err));
    state.uiRunning = false;
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
    setBadge('已停止', '');
    stopStatusPolling();
  }
});

// ---------------------------------------------------------------- 状态轮询

function startStatusPolling() {
  if (state.statusTimer) return;
  state.statusTimer = setInterval(pollStatus, 1000);
  pollStatus();
}

function stopStatusPolling() {
  if (state.statusTimer) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
}

async function pollStatus() {
  let res;
  try {
    res = await window.api.runStatus();
  } catch (err) {
    // 状态查询失败不能把界面卡在「运行中，按钮全灰」的状态里
    addLog('warn', '查询运行状态失败: ' + (err && err.message ? err.message : err));
    return;
  }
  if (!res || !res.ok) return;

  const list = res.instances || [];
  const running = list.filter((i) => i.running);

  el.statRunning.textContent = String(running.length);

  let actions = 0;
  let battles = 0;
  for (const i of list) {
    actions += i.actions || 0;
    battles += i.battles || 0;
  }
  el.statActions.textContent = String(actions);
  el.statBattles.textContent = String(battles);

  // 标记运行中的实例
  const runningHwnds = new Set(running.map((i) => i.hwnd));
  for (const node of el.instanceList.querySelectorAll('.instance')) {
    const hwnd = Number(node.dataset.hwnd);
    node.classList.toggle('running', runningHwnds.has(hwnd));
  }

  // 用 uiRunning 判断「之前在跑，现在没在跑」→ 恢复按钮
  // （之前用 !el.btnStop.disabled 判断，点停止时它已经是 true，导致按钮永久置灰）
  if (state.uiRunning && running.length === 0) {
    state.uiRunning = false;
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
    setBadge('已停止', '');
    stopStatusPolling();
  }
}

function setBadge(text, cls) {
  el.engineBadge.textContent = text;
  el.engineBadge.className = 'badge' + (cls ? ' ' + cls : '');
}

// ---------------------------------------------------------------- 标题栏

el.btnPin.addEventListener('click', async () => {
  state.alwaysOnTop = !state.alwaysOnTop;
  await window.api.setAlwaysOnTop(state.alwaysOnTop);
  el.btnPin.classList.toggle('active', state.alwaysOnTop);
  addLog('info', state.alwaysOnTop ? '面板已置顶' : '面板已取消置顶');
});

el.btnMin.addEventListener('click', () => window.api.minimizePanel());
el.btnClose.addEventListener('click', () => window.api.closePanel());

// ---------------------------------------------------------------- 初始化

async function init() {
  // 主进程推来的日志
  window.api.onLog((payload) => {
    addLog(payload.level, payload.message, payload.instanceId);
  });

  // 同步面板初始状态
  const info = await window.api.panelInfo();
  if (info && info.ok) {
    state.alwaysOnTop = !!info.alwaysOnTop;
    el.btnPin.classList.toggle('active', state.alwaysOnTop);
    addLog('info', `面板就绪 | DPI: ${info.dpi}`);
  }

  await loadDungeons();      // 先加载副本配置，下拉栏才有东西可选
  await refreshWindows(true);
  startAutoRefresh();
  pollStatus();
  refreshDataDir();

  addLog('info', '提示：先在「游戏实例」里选中目标，再设置参数，最后点「开始」。');
}

/** 显示数据目录（素材和规则文件所在位置） */
async function refreshDataDir() {
  try {
    const res = await window.api.dataDir();
    if (!res || !res.ok) return;
    state.dataDir = res.root;
    // 面板很窄，只显示最后两段路径
    const parts = String(res.root).split(/[\\/]/).filter(Boolean);
    const short = parts.slice(-2).join('\\');
    if (el.dataDirHint) el.dataDirHint.textContent = short;
    if (el.btnOpenData) el.btnOpenData.title = res.root;
  } catch (err) { /* 拿不到就不显示 */ }
}

el.btnOpenData.addEventListener('click', async () => {
  const res = await window.api.openDataDir();
  if (res && res.ok) addLog('info', `已打开数据目录: ${res.root}`);
  else addLog('warn', '打开数据目录失败: ' + ((res && res.error) || '未知错误'));
});

// ---------------------------------------------------------------- 点击测试

// 把鼠标移到游戏里任意位置，然后点这个按钮，看看程序发出的点击是否真的生效。
// 这是排查「鼠标动了但点不动」最快的手段。
el.btnTestClick.addEventListener('click', async () => {
  el.btnTestClick.disabled = true;
  try {
    const res = await window.api.testClick();
    if (res && res.ok) {
      addLog('ok', `点击测试成功：屏幕(${res.x},${res.y})，已发送 ${res.sent}/3 步` +
        (res.fromCursor ? '（用的是当前鼠标位置）' : ''));
    } else {
      addLog('error', '点击测试失败: ' + ((res && res.error) || '未知原因') +
        (res ? ` 屏幕(${res.x || '?'},${res.y || '?'}) 已发送 ${res.sent || 0}/3 步` : ''));
    }
  } catch (err) {
    addLog('error', '点击测试异常: ' + (err && err.message ? err.message : err));
  } finally {
    el.btnTestClick.disabled = false;
  }
});

// 素材诊断：把当前画面和所有素材匹配一遍，报每个素材的最高分。
// 排查「识别不到素材」时先点这个 —— 能立刻看出是差一点（调阈值）还是完全不像（重裁）。
el.btnDiagnose.addEventListener('click', async () => {
  el.btnDiagnose.disabled = true;
  addLog('info', '正在诊断素材匹配情况…');
  try {
    const res = await window.api.diagnose(state.selectedHwnd);
    if (!res || !res.ok) {
      addLog('error', '素材诊断失败: ' + ((res && res.error) || '未知原因'));
      return;
    }
    const hit = res.results.filter((r) => r.score >= 0.86).length;
    addLog(hit > 0 ? 'ok' : 'warn',
      `诊断完成：内容区 ${res.contentWidth}x${res.contentHeight}，` +
      `素材缩放 ${res.scale.toFixed(3)} 倍，${hit}/${res.results.length} 个达到阈值 0.86`);
    // 详细的每素材分数由主进程直接推到运行日志里了
  } catch (err) {
    addLog('error', '素材诊断异常: ' + (err && err.message ? err.message : err));
  } finally {
    el.btnDiagnose.disabled = false;
  }
});

init().catch((err) => {
  addLog('error', '初始化失败: ' + (err && err.message ? err.message : err));
});
