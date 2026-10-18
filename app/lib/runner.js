/**
 * 自动化运行管理：为每个游戏实例维护独立的运行循环。
 *
 * 实现程度：
 *   ✅ 多实例独立循环、截图（含降级链）、状态监控、启停控制、
 *      场次/时长/动作上限、统计上报、异常隔离
 *   ✅ 模板匹配识别（lib/vision.js，FFT+NCC，由粗到精）
 *   ✅ 点击注入（lib/input.js，优先 ADB）
 *
 * 识别规则来自 rules.json。没有 rules.json 或素材缺失时，
 * 循环照常截图但不会点击 —— 保证在任何阶段都能运行、可观察。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const native = require('./native');
const capture = require('./capture');
const vision = require('./vision');
const paths = require('./paths');
const { createInput } = require('./input');
const { loadScreenConfig } = require('./dungeons');

/** 全局动作计数器（跨实例），用于界面显示 */
let globalActions = 0;

/**
 * 同步小睡（毫秒）。
 *
 * 为什么不用 await：连点两次之间只需要等一两百毫秒，
 * 而 executeAction 是同步调用的（调用方没有 await）。
 * 这里用一个短忙等 + Atomics.wait 的混合实现，精度比纯忙等好、也不会卡太久。
 */
function sleepSync(ms) {
  const end = Date.now() + Math.max(0, ms);
  const buf = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    const left = end - Date.now();
    if (left > 4) Atomics.wait(buf, 0, 0, Math.min(left - 2, 20));
  }
}

/**
 * 读取 rules.json。
 * 位置优先级：环境变量 → 数据根目录 → 数据根目录的上一级
 *
 * ★ 曾经这里还硬编码了 'F:\\WorkSpace\\onmyoji-bot\\rules.json' 作为兜底，
 *   结果在开发机上永远命中它，打包后的程序读的是**开发用的示例规则**，
 *   而不是用户标定后写出的规则 —— 表现为「素材全缺失」。
 *   已删除该硬编码，路径统一由 lib/paths.js 决定。
 *
 * @returns {{rules:Array, templates:Object, source:string|null}}
 */
function loadRules(appRoot) {
  const candidates = [
    process.env.OMJ_RULES,
    path.join(appRoot, 'rules.json'),
    path.join(appRoot, '..', 'rules.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const rules = Array.isArray(raw) ? raw : (raw.rules || []);
      return { rules, raw, source: p };
    } catch (err) {
      // 配置坏了不应该让程序起不来
      return { rules: [], raw: null, source: null, error: `${p}: ${err.message}` };
    }
  }
  return { rules: [], raw: null, source: null };
}

/**
 * 把 rules.json 里的 region 归一化成 matchTemplate 需要的对象格式。
 *
 * ★ 这个转换是必须的（实测踩过）：
 *   rules.json 里写的是数组 [x, y, w, h]（JSON 里更简洁），
 *   但 vision.matchTemplate 期望 { x, y, width, height }。
 *   直接丢数组进去，region.x 是 undefined → 内部算出 NaN → 永远不命中。
 *
 * 更坑的是「区域外不命中」这类测试**会因为 bug 而通过**（什么都不命中），
 * 属于假阳性，只有「区域内应命中」的测试才能暴露它。
 *
 * @param {Array|object|null} region
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function normalizeRegion(region) {
  if (!region) return null;

  // 数组形式 [x, y, w, h]
  if (Array.isArray(region)) {
    if (region.length !== 4) return null;
    const [x, y, w, h] = region.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (w <= 0 || h <= 0) return null;
    return { x, y, width: w, height: h };
  }

  // 对象形式：兼容 width/height 与 w/h 两种写法
  if (typeof region === 'object') {
    const x = Number(region.x);
    const y = Number(region.y);
    const w = Number(region.width != null ? region.width : region.w);
    const h = Number(region.height != null ? region.height : region.h);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (w <= 0 || h <= 0) return null;
    return { x, y, width: w, height: h };
  }

  return null;
}

class Runner {
  /**
   * @param {object} opts
   * @param {number} opts.hwnd        目标游戏窗口
   * @param {string} opts.title       窗口标题（显示用）
   * @param {object} opts.params      运行参数
   * @param {(level:string,msg:string,id:string|null)=>void} opts.log
   */
  constructor(opts) {
    this.id = 'r' + opts.hwnd;
    this.hwnd = opts.hwnd;
    this.title = opts.title;
    this.params = opts.params || {};
    this.log = opts.log;

    this.running = false;
    this.stopping = false;
    this.startedAt = 0;
    this.stats = {
      actions: 0,
      battles: 0,
      frames: 0,
      errors: 0,
      skipped: 0,
      lastError: '',
      fps: 0,
      state: '空闲',
      // waiting=true 表示当前帧没匹配到任何规则（界面上可以显示成「等待中」）
      waiting: false,
      missStreak: 0,
    };

    // 日志节流/状态跟踪（避免重复刷屏，又能看清走到哪一步）
    this._lastState = null;       // 上一次命中的状态名
    this._lastMatchAt = 0;        // 上一次命中的时间
    this._missStreak = 0;         // 连续未命中帧数
    this._stallLogged = false;    // 「等待中」是否已提示过
    this._stallLoggedAt = 0;      // 上次提示「等待中」的时间

    this._loopPromise = null;

    // ---- 识别与输入 ----
    // 两种规则来源：
    //   1) 传了 opts.dungeon（新架构）：直接用配置里的规则 + config/assets
    //   2) 没传（老路径/测试）：从数据目录读 rules.json
    this.appRoot = opts.appRoot || paths.resolveDataRoot(opts);

    let assetsDir;
    let loaded;
    const configDir = opts.configDir || paths.resolveConfigDir(opts);

    // 屏幕/缩放配置：素材基准宽度 + 是否自动缩放
    try {
      this.screenCfg = loadScreenConfig(configDir);
    } catch (err) {
      this.screenCfg = { referenceWidth: 1718, autoScale: true, warnDeviation: 0.02 };
    }
    this.appliedScale = 1;

    if (opts.dungeon && Array.isArray(opts.dungeon.rules)) {
      this.dungeon = opts.dungeon;
      assetsDir = opts.assetsDir || paths.assetsDirFor(configDir);
      loaded = {
        rules: opts.dungeon.rules,
        source: opts.dungeon.file || `副本配置:${opts.dungeon.id}`,
        error: opts.dungeon.error || null,
      };
    } else {
      this.dungeon = null;
      assetsDir = opts.assetsDir || paths.assetsDirFor(this.appRoot);
      loaded = loadRules(this.appRoot);
    }

    this.rules = loaded.rules;
    this.rulesSource = loaded.source;
    this.rulesError = loaded.error || null;

    // 启动前先算清楚「有多少条规则的素材缺失」，
    // 用于 start() 时给一条**可执行**的汇总提示，
    // 而不是逐条刷「素材缺失或无法解码」让人不知道该做什么。
    //
    // 顺带做一次**自动纠正**：用户手工编辑 rules.json 时很容易写成
    //   - template: "btn_x"           （漏了 .png）
    //   - template: "btn_x.png.png"   （多了一层 .png）
    // 这两种在磁盘上其实都有对应文件（或者文件名就是双重后缀）。
    // 这里把 rule.template 修正成磁盘上**真实存在的文件名**，
    // 避免「明明有文件却报缺失」这种让用户完全摸不着头脑的情况。
    this.missingTemplates = [];
    this.healedTemplates = [];
    for (const r of this.rules) {
      if (!this._ruleApplies(r)) continue;
      const tpl = r && r.template;
      if (!tpl) continue;

      if (this.missingTemplates.indexOf(tpl) >= 0) continue;

      const actual = paths.resolveActualTemplate(assetsDir, tpl);
      if (actual) {
        if (actual !== tpl) {
          this.healedTemplates.push({ from: tpl, to: actual });
          r.template = actual;
        }
      } else if (this.missingTemplates.indexOf(tpl) < 0) {
        this.missingTemplates.push(tpl);
      }
    }

    this.library = new vision.TemplateLibrary(assetsDir);
    this._cooldowns = new Map();
    this._missingWarned = new Set();
    // 记住实际可用的截图方式，避免每帧重试整条降级链
    this._captureMethod = null;
    this._ctx = null;
    this._ctxFrameId = -1;
    this.roi = null;
    this.origin = null;

    // 输入后端：自动探测。
    //   优先 ADB（模拟器内部注入，隐蔽性好）；
    //   连不上再退到 Windows SendInput（桌面注入，风险更高，会明确告警）。
    //   两者都不可用时退化为"只识别不点击"。
    this.input = null;
    this.inputBackend = 'none';
    this.deviceSize = null;
    try {
      const backend = createInput({
        prefer: opts.inputBackend || 'auto',
        // 不传 portsHint：createInput 内部会先做一次同步端口快测，
        // 没有存活端口就直接跳过 ADB（避免 adb 盲试 6 个端口耗 12 秒）
        log: (m) => this.say('info', m),
        // 把窗口句柄传下去：消息投递模式需要它才能不借助物理光标点击
        hwnd: this.hwnd,
        // 'message'（默认，不动鼠标）/ 'sendinput'（会移动光标）
        mode: this.params.inputMode === 'sendinput' ? 'sendinput' : 'message',
      });
      if (backend) {
        this.input = backend;
        // 后端类型从 status() 里取；WinInput/AdbInput 实例本身没有 backend 字段
        let kind = 'unknown';
        try {
          const st = backend.status();
          if (st && st.backend) kind = st.backend;
        } catch (err) { /* ignore */ }
        this.inputBackend = kind;
      } else {
        this.say('warn', '没有可用的输入后端，将只识别不点击');
      }
    } catch (err) {
      this.say('warn', `输入后端初始化失败: ${err.message}`);
    }

    // 兼容旧字段名（外部/测试代码里用到 this.adb）
    this.adb = this.input;
  }

  /** 资源与规则的就绪情况，供界面/自检展示 */
  describeSetup() {
    const missing = this.library.missing(
      Array.from(new Set(this.rules.map((r) => r.template).filter(Boolean)))
    );
    return {
      rulesCount: this.rules.length,
      rulesSource: this.rulesSource,
      rulesError: this.rulesError,
      assetsDir: this.library.dir,
      missingTemplates: missing,
      inputBackend: this.inputBackend,
      input: this.input ? this.input.status() : null,
      adb: this.inputBackend === 'adb' && this.input ? this.input.status() : null,
    };
  }

  /** 向界面推一条属于本实例的日志 */
  say(level, msg) {
    this.log(level, msg, this.id);
  }

  start() {
    if (this.running) return { ok: false, error: '已在运行中' };
    if (!native.isWindow(this.hwnd)) {
      return { ok: false, error: `窗口 ${this.hwnd} 不存在，可能游戏已关闭` };
    }

    this.running = true;
    this.stopping = false;
    this.startedAt = Date.now();
    this.stats = {
      actions: 0, battles: 0, frames: 0, errors: 0, skipped: 0,
      lastError: '', fps: 0, state: '启动中', waiting: false, missStreak: 0,
    };
    // 重置日志跟踪状态
    this._lastState = null;
    this._lastMatchAt = Date.now();
    this._missStreak = 0;
    this._stallLogged = false;
    this._stallLoggedAt = 0;

    const p = this.params || {};
    const limitDesc = [];
    if (p.maxBattles > 0) limitDesc.push(`最大 ${p.maxBattles} 场`);
    if (p.maxMinutes > 0) limitDesc.push(`最长 ${p.maxMinutes} 分钟`);
    if (p.dryRun) limitDesc.push('仅识别模式');

    this.say('ok', `开始运行 | 副本=${p.dungeonType || 'soul'}` +
      (p.dungeonType === 'soul' ? ` 第${p.soulLayer || 10}层` : '') +
      (limitDesc.length ? ` | ${limitDesc.join(' | ')}` : ''));

    // 配置来源：让用户一眼看到程序到底在读哪里
    if (this.dungeon) {
      this.say('info', `副本配置: ${this.dungeon.name}（${this.dungeon.id}）` +
        ` | 素材 ${this.library.dir}` +
        ` | 规则 ${this.rulesSource || '未找到'}`);
    } else {
      this.say('info', `配置目录: ${this.appRoot}` +
        `（素材 ${this.library.dir}，规则 ${this.rulesSource || '未找到'}）`);
    }

    // ---- 法规/配置预检：给一条可执行的提示，而不是逐条刷警告 ----
    if (this.healedTemplates && this.healedTemplates.length > 0) {
      this.say('warn', `已自动修正 ${this.healedTemplates.length} 处素材名不一致: ` +
        this.healedTemplates.map((h) => `${h.from} → ${h.to}`).join(', '));
    }

    if (this.rules.length === 0) {
      this.say('warn', '规则为空，无法识别任何画面。请先在「素材标定」里标定按钮并保存。');
    } else if (this.missingTemplates.length >= this.rules.length) {
      // 所有规则的素材都缺 —— 说明用户还没标定，或者标定存到了别的地方
      this.say('warn', `规则有 ${this.rules.length} 条，但素材全部缺失（${this.missingTemplates.length} 个 PNG 找不到）。`);
      this.say('warn', `请到「素材标定」标定按钮并保存；素材应出现在 ${this.library.dir}`);
      // 把目录里实际有哪些 PNG 列出来 —— 这条信息能立刻定位「名字对不上」的问题
      try {
        const present = fs.readdirSync(this.library.dir).filter((f) => /\.png$/i.test(f));
        if (present.length > 0) {
          this.say('warn', `该目录里实际有: ${present.join(', ')}`);
          this.say('warn', `规则里要的是: ${this.missingTemplates.join(', ')}`);
        } else {
          this.say('warn', '该目录里没有任何 PNG 文件');
        }
      } catch (err) { /* 目录不存在就算了 */ }
    } else if (this.missingTemplates.length > 0) {
      this.say('warn', `有 ${this.missingTemplates.length} 条规则的素材缺失，将被跳过: ` +
        this.missingTemplates.join(', '));
    } else {
      this.say('info', `规则 ${this.rules.length} 条，素材齐全`);
    }

    this._loopPromise = this._loop().catch((err) => {
      this.say('error', `运行循环异常终止: ${err && err.message ? err.message : err}`);
      this.stats.state = '异常';
      this.running = false;
    });

    return { ok: true, instanceId: this.id };
  }

  stop(reason = '手动结束') {
    if (!this.running) return { ok: false, error: '未在运行' };
    this.stopping = true;
    this.say('warn', `正在停止… (${reason})`);
    return { ok: true };
  }

  status() {
    return {
      instanceId: this.id,
      hwnd: this.hwnd,
      title: this.title,
      running: this.running,
      elapsedMs: this.running ? Date.now() - this.startedAt : 0,
      ...this.stats,
    };
  }

  // ------------------------------------------------------------ 主循环

  async _loop() {
    // 间隔：在 [actionInterval, actionIntervalMax] 之间每轮随机。
    // 固定节奏（比如永远 0.6 秒）是很强的机器特征，随机化更自然。
    const minMs = Math.max(200, Math.round((this.params.actionInterval || 0.6) * 1000));
    const rawMax = this.params.actionIntervalMax != null
      ? Number(this.params.actionIntervalMax) : 0;
    const maxMs = rawMax > 0 ? Math.max(minMs, Math.round(rawMax * 1000)) : minMs;

    // 触发概率：命中规则后按概率决定是否真的执行，模拟"人有时会慢一拍"
    const rawChance = this.params.triggerChance != null ? Number(this.params.triggerChance) : 1;
    const triggerChance = Math.max(0, Math.min(1, Number.isFinite(rawChance) ? rawChance : 1));

    const deadline = this.params.maxMinutes > 0
      ? this.startedAt + this.params.maxMinutes * 60 * 1000
      : null;

    let fpsWindowStart = Date.now();
    let fpsWindowFrames = 0;

    this.stats.state = '运行中';

    try {
      while (this.running && !this.stopping) {
        // ---- 终止条件 ----
        if (deadline && Date.now() >= deadline) {
          this.say('ok', `达到最长时长 ${this.params.maxMinutes} 分钟，正常结束`);
          break;
        }
        if (this.params.maxBattles > 0 && this.stats.battles >= this.params.maxBattles) {
          this.say('ok', `达到最大场次 ${this.params.maxBattles}，正常结束`);
          break;
        }
        if (this.stats.errors >= (this.params.errorStreakLimit || 12)) {
          this.stats.state = '异常停止';
          this.say('error', `连续异常达到上限，已停止: ${this.stats.lastError}`);
          break;
        }
        if (!native.isWindow(this.hwnd)) {
          this.stats.state = '窗口消失';
          this.say('error', '游戏窗口已关闭，停止运行');
          break;
        }

        const tickStart = Date.now();

        try {
          // ---- 1. 截图（自动定位内容区，去掉模拟器填充的黑边）----
          //
          // 截图方式会「学习」：第一次成功后记住它并优先复用，
          // 不再每帧都从头走一遍降级链（每帧重试 = 每帧都冒一次卡死风险）。
          //
          // ★ allowPrintWindow 默认 **false**：
          //   PrintWindow 是跨进程同步消息（WM_PRINT），目标窗口一忙就无限阻塞，
          //   而我们是在主进程里同步调用 —— 主线程卡住 → Windows 判「未响应」→ 程序被关
          //   （事件日志 AppHangB1）。对协同合成的游戏窗口它也从没抓到过画面，纯风险。
          //   确实需要（例如窗口被别的窗口遮住）时，可在 params 里传 allowPrintWindow: true。
          const grab = capture.grabContent(this.hwnd, {
            roi: this.roi || undefined, // 首次探测后缓存复用，避免每帧都扫一遍
            prefer: this._captureMethod || undefined,
            allowPrintWindow: this.params.allowPrintWindow === true,
          });
          if (grab.method && grab.method !== 'none-usable') {
            this._captureMethod = grab.method;
          }
          if (!this.roi) {
            this.roi = grab.roi;
            const how = grab.method === 'bitblt' ? '窗口DC'
              : grab.method === 'screen' ? '屏幕DC(已降级)' : grab.method;
            this.say('info', `已锁定内容区 ${grab.roi.width}x${grab.roi.height} ` +
              `@ ROI(${grab.roi.x},${grab.roi.y}) [${how}]，窗口 ${grab.fullSize.width}x${grab.fullSize.height}`);
            // 内容区尺寸确定后立刻校正素材缩放（窗口改过大小就靠这一步救命）
            this._applyAutoScale(grab.frame.width, grab.frame.height);
          }
          // 截图方式异常（全黑降级等）只提示一次，避免刷屏
          if (grab.warning && !this._warnedCapture) {
            this._warnedCapture = true;
            this.say('warn', String(grab.warning).split('\n')[0]);
          }
          this.origin = grab.windowOrigin;
          const frame = grab.frame;

          this.stats.frames++;
          fpsWindowFrames++;

          // fps 统计（每秒刷新一次，避免界面数字乱跳）
          if (Date.now() - fpsWindowStart >= 1000) {
            this.stats.fps = Math.round(fpsWindowFrames * 1000 / (Date.now() - fpsWindowStart));
            fpsWindowStart = Date.now();
            fpsWindowFrames = 0;
          }

          // ---- 2. 识别 ----
          const decision = this.evaluateFrame(frame);

          // ---- 3. 执行 ----
          if (decision) {
            this.stats.state = decision.state;

            // 步骤变化时打一条日志：让用户看得出「现在走到哪一步了」。
            // 之前只在点击时打日志，命中同一个按钮时会刷重复行、切换步骤反而看不出来。
            if (this._lastState !== decision.state) {
              this._lastState = decision.state;
              this.say('info', `步骤: ${decision.state}（分数 ${decision.score.toFixed(3)}）`);
            }
            this._missStreak = 0;
            this._stallLogged = false;
            this.stats.waiting = false;
            this.stats.missStreak = 0;

            // 概率触发：命中后不一定立刻点。
            // 目的不是"偷懒"，而是避免每次画面一出现就精确在同一延迟内点击 ——
            // 那种毫秒级规律性非常容易被判定成脚本。
            const roll = Math.random();
            const willAct = triggerChance >= 1 || roll < triggerChance;

            if (!this.params.dryRun && willAct) {
              this.executeAction(decision);
              this.stats.actions++;
              globalActions++;
            } else if (!this.params.dryRun) {
              // 这一轮"放过"，下轮再看（画面通常仍在，会再次命中）
              this.stats.skipped = (this.stats.skipped || 0) + 1;
            } else {
              // 仅识别模式：不点击，但也要计数，方便看识别率
              this.stats.actions++;
              globalActions++;
            }

            if (decision.isBattleEnd) {
              this.stats.battles++;
              this.say('ok', `完成第 ${this.stats.battles} 场 (${decision.state})`);
            }
            this.stats.errors = 0; // 成功一轮就清零
          } else {
            // ---- 没匹配到任何规则 ----
            //
            // 这种情况以前**完全静默**，日志看起来像卡死了。
            // 实际上大概率是正常的（在战斗中 / 加载中 / 翻页动画），
            // 但也可能是素材对不上。所以这里要主动说明「在等什么」。
            this.stats.state = '等待画面变化';
            this.stats.waiting = true;
            this._missStreak = (this._missStreak || 0) + 1;
            this.stats.missStreak = this._missStreak;

            const stallMs = Date.now() - (this._lastMatchAt || this.startedAt);
            // 连续 5 帧（约 3-5 秒）才开始提示，避免正常切画面时刷屏
            if (this._missStreak >= 5 && !this._stallLogged) {
              this._stallLogged = true;
              this._stallLoggedAt = Date.now();
              this._lastState = null;   // 下次命中时重新播报步骤
              this.say('info', `等待中: 当前画面没有匹配到任何规则` +
                `（连续 ${this._missStreak} 帧 / ${(stallMs / 1000).toFixed(1)}s）`);
              this.say('info', `正在等这些画面: ${this._waitingForText()}`);
              this.say('info', '如果一直停在这里：战斗中/加载中属正常；' +
                '若明显卡住，多半是素材和当前界面不一致，可看下方「素材匹配」或调阈值');
            } else if (this._stallLogged && this._stallLoggedAt &&
              Date.now() - this._stallLoggedAt >= 20000) {
              // 长时间没动静：每 20 秒再提醒一次，带上已等待时长
              this._stallLoggedAt = Date.now();
              this.say('warn', `仍在等待（已 ${(stallMs / 1000).toFixed(0)}s 无匹配）: ` +
                `正在等 ${this._waitingForText(true)}`);
            }
          }
          if (decision) this._lastMatchAt = Date.now();
        } catch (err) {
          this.stats.errors++;
          this.stats.lastError = err && err.message ? err.message : String(err);
          // 不刷屏：只在错误计数为 1 或每 10 次时记录
          if (this.stats.errors === 1 || this.stats.errors % 10 === 0) {
            this.say('error', `截图/识别失败 (${this.stats.errors}): ${this.stats.lastError}`);
          }
        }

        // ---- 节奏控制（每轮重新随机）----
        const elapsed = Date.now() - tickStart;
        const targetMs = maxMs > minMs
          ? minMs + Math.random() * (maxMs - minMs)
          : minMs;
        const wait = Math.max(0, Math.round(targetMs) - elapsed);
        if (wait > 0) await sleep(wait);
      }
    } finally {
      this.running = false;
      this.stopping = false;
      const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
      this.stats.state = '已停止';
      this.say('info', `已结束 | 运行 ${secs}s | 截图 ${this.stats.frames} 帧 | ` +
        `动作 ${this.stats.actions} 次 | 场次 ${this.stats.battles}`);
    }
  }

  // ------------------------------------------------------------ 识别与点击

  /**
   * 识别当前帧，返回一个决策。
   *
   * 规则来自 rules.json（见 assets 同级的配置）。每条规则：
   *   { state, template, threshold?, region?, action, isBattleEnd?, cooldownMs? }
   *
   * 按数组顺序**优先级**匹配，命中第一条就返回 —— 这就是状态机的核心：
   * 每轮都从最高优先级往下问一遍，谁先命中执行谁，
   * 而不是写死"先点A再等2秒点B"（游戏弹窗和动画时长都不固定，线性流程必然错位）。
   *
   * @param {object} frame 内容区像素
   * @returns {{state:string, action:object, score:number, isBattleEnd:boolean,
   *            screenX:number, screenY:number}|null}
   */
  /**
   * 判断某条规则在当前参数下是否适用。
   *
   * rules.json 里可以写 `onlyForDungeon: "soul"`（或数组），
   * 表示这条规则只在「副本类型=御魂」时参与匹配。
   * 这样同一份规则文件能同时描述御魂/觉醒/御灵/探索四套入口，
   * 由界面上的「副本类型」决定走哪一套。
   */
  _ruleApplies(rule) {
    if (!rule || !rule.onlyForDungeon) return true;
    const want = (this.params && this.params.dungeonType) || 'soul';
    const list = Array.isArray(rule.onlyForDungeon) ? rule.onlyForDungeon : [rule.onlyForDungeon];
    return list.indexOf(want) >= 0;
  }

  /**
   * 按当前内容区尺寸校正素材缩放。
   *
   * 为什么必须有这一步（实测踩过的坑）：
   *   模板匹配对平移不敏感，但对**缩放极其敏感**。合成实验数据：
   *     画面缩放 0.95 → 原始素材分数 0.58~0.89（一半失效）
   *     画面缩放 0.90 → 0.27~0.68
   *     画面缩放 0.874（用户把窗口调小的实际值）→ 0.00~0.61，全部失效
   *   而把素材按同样比例缩放后，分数全部回到 1.000。
   *
   *   症状表现是「改了窗口大小就识别不到素材」，很容易误判成素材裁坏了。
   *
   * @param {number} frameW 当前内容区宽度
   * @param {number} frameH 当前内容区高度
   */
  _applyAutoScale(frameW, frameH) {
    if (!this.library || !frameW) return;
    const cfg = this.screenCfg || {};

    if (cfg.autoScale === false) {
      this.library.setScale(1);
      this.appliedScale = 1;
      return;
    }

    const refW = cfg.referenceWidth || 1718;
    const scale = frameW / refW;
    if (!Number.isFinite(scale) || scale <= 0) return;

    this.library.setScale(scale);
    this.appliedScale = this.library.scale;

    const dev = Math.abs(scale - 1);
    const warnAt = cfg.warnDeviation != null ? cfg.warnDeviation : 0.02;

    if (dev >= warnAt) {
      this.say('info', `窗口内容区 ${frameW}x${frameH}，与素材基准宽 ${refW} 相差 ` +
        `${((scale - 1) * 100).toFixed(1)}%，已把素材按 ${scale.toFixed(3)} 倍缩放后匹配`);
    }
    if (dev > 0.15) {
      this.say('warn', `缩放偏差较大 (${(dev * 100).toFixed(0)}%)，识别率可能下降。` +
        `建议把游戏窗口调回素材采集时的尺寸，或重裁素材并更新 config/screen.json 的 referenceWidth`);
    }
  }

  /**
   * 「正在等哪些画面」的可读文字。
   *
   * 没匹配到任何规则时，日志里以前是一片空白，用户以为程序卡死了。
   * 这个方法把当前生效的规则状态列出来，让人知道程序在找什么。
   *
   * @param {boolean} [compact] 精简模式（用于长时间等待的重复提醒）
   */
  _waitingForText(compact) {
    const states = [];
    for (const r of (this.rules || [])) {
      if (!this._ruleApplies(r)) continue;
      const s = r.state || r.template || '未命名';
      if (states.indexOf(s) < 0) states.push(s);
    }
    if (states.length === 0) return '（当前没有可用规则）';

    const limit = compact ? 3 : 5;
    const shown = states.slice(0, limit).join(' / ');
    return states.length > limit ? `${shown} … 等 ${states.length} 项` : shown;
  }

  evaluateFrame(frame) {
    if (!this.rules || this.rules.length === 0) return null;
    if (!this.library) return null;

    const now = Date.now();

    // 整帧建一次 FrameContext，多个模板可复用 FFT
    if (!this._ctx || this._ctxFrameId !== this.stats.frames) {
      this._ctx = vision.createFrameContext(frame);
      this._ctxFrameId = this.stats.frames;
    }
    const ctx = this._ctx;

    for (const rule of this.rules) {
      // 副本类型过滤：规则可以声明只在某些副本下生效。
      // 例如「御魂」这个入口按钮只在副本类型=御魂时才有意义。
      if (!this._ruleApplies(rule)) continue;

      // 冷却：避免对同一个按钮连点
      const cdKey = rule.state;
      const until = this._cooldowns.get(cdKey) || 0;
      if (now < until) continue;

      const tpl = this.library.get(rule.template);
      if (!tpl) {
        // 素材缺失这里**不再逐条打日志**：
        // 12 条规则都缺素材时会刷出 12 行同样的警告，用户完全不知道该干什么。
        // 启动时的预检（start()）已经给出了一条可执行的汇总提示。
        // 这里只记录，供诊断用。
        if (!this._missingWarned.has(rule.template)) {
          this._missingWarned.add(rule.template);
        }
        continue;
      }

      let hit = null;
      try {
        hit = vision.matchTemplate(ctx, tpl, normalizeRegion(rule.region),
          rule.threshold != null ? rule.threshold : 0.85);
      } catch (err) {
        this.say('error', `匹配 ${rule.template} 失败: ${err.message}`);
        continue;
      }
      if (!hit) continue;

      // 命中：换算成屏幕坐标
      //   屏幕坐标 = windowOrigin + (roi.x + 匹配坐标, roi.y + 匹配坐标)
      const origin = this.origin || { left: 0, top: 0 };
      const roi = this.roi || { x: 0, y: 0 };
      const screenX = origin.left + roi.x + hit.cx;
      const screenY = origin.top + roi.y + hit.cy;

      // ★ 注意用 != null 判断，不能用 ||：
      //   cooldownMs 配成 0 表示「不要冷却」，但 0 是假值，
      //   写成 `rule.cooldownMs || 800` 会让 0 变成 800ms —— 用户配了 0 却没生效。
      const cooldown = rule.cooldownMs != null && Number.isFinite(Number(rule.cooldownMs))
        ? Math.max(0, Number(rule.cooldownMs))
        : 800;
      this._cooldowns.set(cdKey, now + cooldown);

      return {
        state: rule.state,
        action: rule.action || { type: 'tap' },
        score: hit.score,
        isBattleEnd: !!rule.isBattleEnd,
        screenX,
        screenY,
        contentX: hit.cx,
        contentY: hit.cy,
        // 命中的**矩形范围**（屏幕坐标），用于在按钮内部随机取点，
        // 避免每次都点在同一个像素上（那是很明显的机器特征）。
        boxScreenX: origin.left + roi.x + hit.x,
        boxScreenY: origin.top + roi.y + hit.y,
        boxW: hit.width,
        boxH: hit.height,
        template: rule.template,
      };
    }

    return null;
  }

  /**
   * 执行决策。
   *
   * 当前实现：ADB `input tap`（从模拟器内部注入，比桌面 SendInput 更隐蔽）。
   * ADB 不可用时只记录日志不点击，避免误用风险更高的方式。
   */
  executeAction(decision) {
    if (!decision) return;

    const { action, screenX, screenY, contentX, contentY, state } = decision;

    if (action.type === 'none') {
      this.say('info', `状态 ${state} 命中但不执行动作`);
      return;
    }

    // stop：命中即正常停止本轮运行。
    // 典型用法：体力不足、活动结束、需要人工处理的异常界面。
    // 这是「保命」动作 —— 比继续乱点安全得多。
    if (action.type === 'stop') {
      const reason = action.reason || `命中状态「${state}」，按规则停止`;
      this.say('ok', `停止: ${reason}`);
      this.stop(reason);
      return;
    }

    if (action.type !== 'tap') {
      this.say('warn', `未知动作类型 ${action.type}，跳过`);
      return;
    }

    const backend = this.input;
    if (!backend) {
      this.say('warn', `命中 ${state}，但没有可用输入后端，未点击`);
      return;
    }

    // action.repeat：连点次数（默认 1）。
    // 「点击屏幕继续」这类提示需要连点两下才推进，所以支持按规则配置次数。
    // 每次点击都重新随机取点（_pickClickPoint），两次不会落在同一像素。
    const repeat = Math.max(1, Math.min(5, Number(action.repeat) || 1));

    for (let i = 0; i < repeat; i++) {
      // 第一次无条件执行；后续几次如果已经被停止就不再继续
      if (i > 0) {
        if (!this.running) return;
        // 连点时第二次稍微等一等：两下同毫秒的点击不像人
        sleepSync(120 + Math.random() * 180);
      }
      this._tapOnce(decision, backend, i, repeat);
    }
  }

  /** 执行单次点击（含坐标换算与错误上报） */
  _tapOnce(decision, backend, index, repeat) {
    const { state } = decision;
    const suffix = repeat > 1 ? ` (${index + 1}/${repeat})` : '';

    // 在命中矩形内随机取点，而不是每次点正中。
    // 固定坐标点几百次是非常明显的机器特征，容易被判定脚本。
    const pt = this._pickClickPoint(decision);

    try {
      if (this.inputBackend === 'adb') {
        // ADB 用**设备坐标**：按内容区分辨率 → 设备分辨率 的比例换算
        const dev = this.deviceSize || (this.deviceSize = backend.deviceSize());

        // 注意：this.roi 只含 {x,y} 偏移，没有宽高；宽高要从帧上下文拿。
        const contentW = this._ctx ? this._ctx.width : 0;
        const contentH = this._ctx ? this._ctx.height : 0;

        let tapX = pt.screenX;
        let tapY = pt.screenY;

        if (dev && dev.width > 0 && dev.height > 0 && contentW > 0 && contentH > 0) {
          tapX = Math.round(pt.contentX * (dev.width / contentW));
          tapY = Math.round(pt.contentY * (dev.height / contentH));
        } else if (!dev || dev.width <= 0 || dev.height <= 0) {
          this.say('warn', '设备分辨率无效，改用屏幕坐标');
        }

        backend.tap(tapX, tapY);
        this.say('info', `点击 [${state}]${suffix} 设备坐标(${tapX},${tapY}) ` +
          `屏幕(${pt.screenX},${pt.screenY}) 分数 ${decision.score.toFixed(3)}`);
      } else {
        // WinInput 直接用**屏幕坐标**，不需要分辨率换算
        const res = backend.tap(pt.screenX, pt.screenY);
        if (res && res.ok === false) {
          // 点击事件没被系统接受：必须让用户看到，否则会以为是"游戏没反应"
          this.say('error', `点击事件未被系统接受 [${state}]${suffix} ` +
            `屏幕(${pt.screenX},${pt.screenY}) 已发送 ${res.sent || 0}/3 步 ` +
            `(${backend.lastTapInfo ? (backend.lastTapInfo().error || '') : ''})`);
        } else {
          this.say('info', `点击 [${state}]${suffix} 屏幕坐标(${pt.screenX},${pt.screenY}) ` +
            `分数 ${decision.score.toFixed(3)}`);
        }
      }
    } catch (err) {
      this.say('error', `点击失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 在命中的矩形范围内随机取一个点击点。
   *
   * 参数 clickJitter（0-0.9）表示「随机范围占按钮尺寸的比例」：
   *   0    → 永远点正中（旧行为，最容易被识别）
   *   0.35 → 在按钮内以中心为准的 35% 范围内随机
   *   0.9  → 几乎可以在整个按钮内任意位置
   *
   * 点始终落在模板矩形**内部**，不会点到按钮外面去。
   */
  _pickClickPoint(decision) {
    const jitter = Math.max(0, Math.min(1,
      this.params.clickJitter != null ? Number(this.params.clickJitter) : 0.35));

    const bx = decision.boxScreenX;
    const by = decision.boxScreenY;
    const bw = decision.boxW;
    const bh = decision.boxH;

    // 没有矩形信息（旧数据结构）就退回中心点
    if (!(bw > 0 && bh > 0) || !Number.isFinite(bx) || !Number.isFinite(by)) {
      return {
        screenX: decision.screenX,
        screenY: decision.screenY,
        contentX: decision.contentX,
        contentY: decision.contentY,
      };
    }

    // 抖动为 0：精确命中中心
    if (jitter <= 0) {
      return {
        screenX: Math.round(bx + bw / 2),
        screenY: Math.round(by + bh / 2),
        contentX: decision.contentX,
        contentY: decision.contentY,
      };
    }

    // 可用范围 = 按钮尺寸 × 抖动比例，居中放置
    const usableW = bw * jitter;
    const usableH = bh * jitter;
    const ox = bx + (bw - usableW) / 2 + Math.random() * usableW;
    const oy = by + (bh - usableH) / 2 + Math.random() * usableH;

    const screenX = Math.round(ox);
    const screenY = Math.round(oy);
    // 内容区坐标按同样的偏移换算（ADB 用）
    const contentX = decision.contentX + (screenX - decision.screenX);
    const contentY = decision.contentY + (screenY - decision.screenY);

    return { screenX, screenY, contentX, contentY };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 管理器

class RunnerManager {
  constructor(opts) {
    this.log = opts.log || (() => {});
    /** @type {Map<string, Runner>} */
    this.instances = new Map();
  }

  /**
   * 启动一个实例。
   * payload: { hwnd, title, params, dungeon? }
   *   dungeon 由调用方（main.js）从 config/dungeons/*.json 解析好传进来。
   */
  start(payload) {
    const { hwnd, title, params, dungeon } = payload || {};
    if (!hwnd) return { ok: false, error: '缺少目标窗口' };

    const id = 'r' + hwnd;
    const existing = this.instances.get(id);
    if (existing && existing.running) {
      return { ok: false, error: '该实例已在运行中' };
    }

    const runner = new Runner({
      hwnd,
      title: title || `窗口 ${hwnd}`,
      params: params || {},
      log: this.log,
      dungeon: dungeon || null,
    });
    this.instances.set(id, runner);

    const res = runner.start();
    if (!res.ok) {
      this.instances.delete(id);
      return res;
    }
    return { ok: true, instanceId: id };
  }

  stop(instanceId) {
    const runner = this.instances.get(instanceId);
    if (!runner) return { ok: false, error: '实例不存在' };
    return runner.stop();
  }

  stopAll() {
    let count = 0;
    for (const runner of this.instances.values()) {
      if (runner.running) {
        runner.stop('程序退出');
        count++;
      }
    }
    return { ok: true, stopped: count };
  }

  status() {
    const list = [];
    for (const runner of this.instances.values()) {
      list.push(runner.status());
    }
    return list;
  }

  get globalActions() {
    return globalActions;
  }
}

module.exports = { Runner, RunnerManager, normalizeRegion, loadRules };
