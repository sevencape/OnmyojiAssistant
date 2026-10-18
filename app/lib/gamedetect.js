/**
 * 游戏窗口识别。
 *
 * 抽成独立模块的原因：主程序（main.js）、自检（--self-check）、探针（probe.js）
 * 三处都需要同一套判定逻辑。分开写必然出现不一致——实测就踩过：
 * 自检里只按标题匹配，结果选中了标题含「阴阳师」的 DeepSeek Harness 窗口去截图，
 * 得到全黑，误判为截图链路故障。
 *
 * ★ 判定优先级（顺序不能改）：
 *   1. 进程名精确匹配 onmyoji.exe —— 最可靠，不受窗口标题影响
 *   2. 进程名包含 onmyoji
 *   3. 标题含游戏/模拟器关键字，且排除其他 Electron 应用与自身进程
 *   4. 最后按面积排序，取最大的那个
 *
 * ★ 必须过滤的干扰项（实测存在）：
 *   - MuMu 会额外创建多个标题完全相同的隐藏辅助窗口，坐标在 (-48000,-48000)
 *   - 其他窗口标题里可能碰巧含「阴阳师」（比如浏览器、编辑器窗口）
 */

'use strict';

/** 已知的游戏进程名（小写） */
const GAME_PROCESSES = ['onmyoji.exe'];

/** 标题关键字（小写），用于进程名匹配失败时的兜底 */
const GAME_TITLE_KEYWORDS = ['阴阳师', 'onmyoji', 'mumu', 'nemu', '模拟器专版'];

/** 坐标小于此值视为屏幕外的隐藏窗口 */
const OFFSCREEN_THRESHOLD = -30000;

/** 游戏窗口的最小尺寸，用于过滤浮层和辅助窗口 */
const MIN_GAME_WIDTH = 640;
const MIN_GAME_HEIGHT = 400;

/**
 * 判断单个窗口是否可能是游戏窗口。
 * @param {object} w listWindows() 的返回项
 * @param {number} [selfPid] 调用方进程 id，用于排除自己
 * @returns {{match: boolean, score: number, reason: string}}
 *   score 越大越可信，用于排序
 */
function scoreGameWindow(w, selfPid) {
  if (selfPid && w.pid === selfPid) {
    return { match: false, score: 0, reason: '自身进程' };
  }

  const proc = (w.processName || '').toLowerCase();
  const title = (w.title || '').toLowerCase();

  // 屏幕外的隐藏辅助窗口直接排除（MuMu 会造一堆）
  if (w.bounds.left <= OFFSCREEN_THRESHOLD || w.bounds.top <= OFFSCREEN_THRESHOLD) {
    return { match: false, score: 0, reason: '屏幕外隐藏窗口' };
  }

  // 太小的一律排除（标题栏残留、浮层等）
  if (w.bounds.width < MIN_GAME_WIDTH || w.bounds.height < MIN_GAME_HEIGHT) {
    return { match: false, score: 0, reason: `尺寸过小 ${w.bounds.width}x${w.bounds.height}` };
  }

  if (GAME_PROCESSES.includes(proc)) {
    return { match: true, score: 1000, reason: '进程名精确匹配' };
  }
  if (proc.includes('onmyoji')) {
    return { match: true, score: 900, reason: '进程名包含 onmyoji' };
  }
  if (GAME_TITLE_KEYWORDS.some((k) => title.includes(k))) {
    // 标题匹配可信度较低：其他应用标题里也可能出现这些词
    return { match: true, score: 500, reason: '标题关键字匹配' };
  }

  return { match: false, score: 0, reason: '无匹配特征' };
}

/**
 * 从窗口列表里挑出游戏窗口，按可信度 + 面积排序。
 * @param {Array<object>} windows
 * @param {number} [selfPid]
 * @returns {Array<object>} 每项额外带 _score / _reason
 */
function pickGameWindows(windows, selfPid) {
  const scored = [];
  for (const w of windows) {
    const s = scoreGameWindow(w, selfPid);
    if (s.match) {
      scored.push(Object.assign({}, w, { _score: s.score, _reason: s.reason }));
    }
  }
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height);
  });
  return scored;
}

/**
 * 取最可信的一个游戏窗口。
 * @returns {object|null}
 */
function pickPrimaryGameWindow(windows, selfPid) {
  const list = pickGameWindows(windows, selfPid);
  return list.length > 0 ? list[0] : null;
}

module.exports = {
  GAME_PROCESSES,
  GAME_TITLE_KEYWORDS,
  scoreGameWindow,
  pickGameWindows,
  pickPrimaryGameWindow,
};
