/**
 * 贴边停靠：让助手面板吸附在游戏窗口边缘并跟随移动。
 *
 * 实现方式说明（为什么不注入游戏进程）：
 *   游戏客户端带反作弊，任何 SetParent 嵌入、DLL 注入、覆盖层挂钩都可能被判定为异常。
 *   这里只用 SetWindowPos 在**外部**移动我们自己的窗口，完全不接触游戏进程内存，
 *   是风险最低的"挂载"方式。
 *
 * 跟随采用轮询（默认 250ms）而非 WinEvent 钩子：
 *   钩子需要在消息循环里挂回调，在 Electron 主进程里实现复杂且容易泄漏；
 *   轮询 250ms 的 CPU 开销可忽略，且足够跟手。
 */

'use strict';

const native = require('./native');

const SIDES = ['right', 'left'];

class DockManager {
  /**
   * @param {object} opts
   * @param {() => import('electron').BrowserWindow|null} opts.getPanel 取面板窗口句柄
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.getPanel = opts.getPanel;
    this.log = opts.log || (() => {});
    this.targetHwnd = null;
    this.side = 'right';
    this.enabled = false;
    this.gap = 0;          // 面板与游戏之间的间隙
    this.pollMs = 250;
    this._timer = null;
    this._lastApplied = null;
    this._missCount = 0;
  }

  /** 开始跟随指定游戏窗口 */
  start(hwnd, side = 'right') {
    if (!native.isWindow(hwnd)) {
      return { ok: false, error: '目标窗口不存在' };
    }
    this.targetHwnd = hwnd;
    this.side = SIDES.includes(side) ? side : 'right';
    this.enabled = true;
    this._missCount = 0;
    this._lastApplied = null;

    this.applyOnce(); // 立即贴一次，不要等第一个轮询周期
    if (!this._timer) {
      this._timer = setInterval(() => this.tick(), this.pollMs);
      if (this._timer.unref) this._timer.unref();
    }
    this.log(`已停靠到窗口 ${hwnd} 的${this.side === 'right' ? '右' : '左'}侧`);
    return { ok: true, side: this.side };
  }

  /** 停止跟随（面板留在原地） */
  stop() {
    this.enabled = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.targetHwnd = null;
    this.log('已解除停靠');
    return { ok: true };
  }

  /** 切换停靠边 */
  setSide(side) {
    if (!SIDES.includes(side)) return { ok: false, error: '无效的边: ' + side };
    this.side = side;
    this.applyOnce(true);
    return { ok: true, side };
  }

  /** 当前状态，供界面显示 */
  status() {
    return {
      enabled: this.enabled,
      side: this.side,
      targetHwnd: this.targetHwnd,
      targetAlive: this.targetHwnd ? native.isWindow(this.targetHwnd) : false,
    };
  }

  // ------------------------------------------------------------ 内部

  tick() {
    if (!this.enabled || !this.targetHwnd) return;

    if (!native.isWindow(this.targetHwnd)) {
      this._missCount++;
      // 允许偶发的瞬时失败（窗口重建），连续多次才判定为关闭
      if (this._missCount > 8) {
        this.log('目标游戏窗口已关闭，自动解除停靠');
        this.stop();
      }
      return;
    }
    this._missCount = 0;
    this.applyOnce();
  }

  /** 计算并应用面板位置 */
  applyOnce(force = false) {
    if (!this.targetHwnd) return;
    const panel = this.getPanel();
    if (!panel || panel.isDestroyed()) return;

    const game = native.getWindowBounds(this.targetHwnd);
    if (!game) return;

    const [pw, ph] = panel.getSize();
    let x;
    if (this.side === 'right') {
      x = game.left + game.width + this.gap;
    } else {
      x = game.left - pw - this.gap;
    }
    // 垂直方向与游戏顶部对齐
    const y = game.top;

    // 避免频繁重复设置同一个位置（每次调用都会触发一次窗口重绘）
    const key = `${x},${y},${pw},${ph}`;
    if (!force && key === this._lastApplied) return;
    this._lastApplied = key;

    panel.setBounds({ x: Math.round(x), y: Math.round(y), width: pw, height: ph });
  }
}

module.exports = { DockManager };
