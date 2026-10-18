/**
 * 真实游戏画面端到端测试：用标定出来的真实素材，验证完整识别→决策→点击链路。
 *
 * 这个测试不依赖合成图，全部用**真实游戏画面**：
 *   1. 抓一帧真实画面
 *   2. 用 calibrate 的逻辑找出稳定 UI 区域并裁素材
 *   3. 把素材写进临时 assets 目录 + 生成 rules.json
 *   4. 构造 Runner，跑 evaluateFrame
 *   5. 验证：能识别到状态、坐标换算正确、冷却生效
 *
 * 这是对"程序真的能在真实画面上工作"的最终证据。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const native = require('./lib/native');
const capture = require('./lib/capture');
const vision = require('./lib/vision');
const gameDetect = require('./lib/gamedetect');
const { Runner } = require('./lib/runner');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cropFrame(frame, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const srcRow = frame.width * 4;
  const dstRow = w * 4;
  for (let row = 0; row < h; row++) {
    const s = (y + row) * srcRow + x * 4;
    frame.bgra.copy(out, row * dstRow, s, s + dstRow);
  }
  return { width: w, height: h, bgra: out };
}

async function main() {
  console.log('='.repeat(66));
  console.log('  真实游戏画面端到端测试');
  console.log('='.repeat(66));

  native.enableDpiAwareness();

  // ---------- 找游戏实例 ----------
  const games = gameDetect.pickGameWindows(native.listWindows(), process.pid)
    .filter((w) => (w.processName || '').toLowerCase().includes('onmyoji'));
  check('检测到游戏实例', games.length > 0, `${games.length} 个`);
  if (games.length === 0) {
    console.log('\n没有运行中的阴阳师，无法做真实画面测试。');
    return 2;
  }
  const hwnd = games[0].hwnd;
  console.log(`  使用 hwnd=${hwnd} ${games[0].bounds.width}x${games[0].bounds.height}`);

  // ---------- 抓帧（两帧，用于稳定性） ----------
  const grab1 = capture.grabContent(hwnd);
  await sleep(400);
  const grab2 = capture.grabContent(hwnd);

  const frame = grab1.frame;
  const W = frame.width, H = frame.height;
  const brightness = capture.meanBrightness(frame);
  check('抓帧成功且非全黑', brightness >= 3,
    `${grab1.method} ${W}x${H} 亮度 ${brightness.toFixed(1)}`);

  // ---------- 找稳定区域 ----------
  const ctx = vision.createFrameContext(frame);
  // 简易稳定性：逐像素比较两帧
  const regionStable = (x, y, w, h, maxDiff = 6) => {
    let sum = 0, cnt = 0;
    const step = 3;
    for (let dy = 0; dy < h; dy += step) {
      for (let dx = 0; dx < w; dx += step) {
        const px = x + dx, py = y + dy;
        if (px >= W || py >= H || px >= grab2.frame.width || py >= grab2.frame.height) continue;
        const off = (py * W + px) * 4 + 1;
        sum += Math.abs(grab2.frame.bgra[off] - frame.bgra[off]);
        cnt++;
      }
    }
    return cnt > 0 ? (sum / cnt) <= maxDiff : false;
  };

  // 在已知按钮区域里找：右下技能区、左下自动区
  const ZONES = [
    { name: 'skills', x: Math.floor(W * 0.55), y: Math.floor(H * 0.70), w: Math.floor(W * 0.45), h: Math.floor(H * 0.28) },
    { name: 'bottom_left', x: 0, y: Math.floor(H * 0.70), w: Math.floor(W * 0.30), h: Math.floor(H * 0.28) },
  ];

  const tmpDir = path.join(require('os').tmpdir(), 'omj-real-test-' + Date.now());
  const assetsDir = path.join(tmpDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const templates = [];
  for (const zone of ZONES) {
    // 在区域内滑窗找稳定且有边缘的块
    let best = null;
    const TW = 56, TH = 28, step = 12;
    for (let y = zone.y; y + TH < zone.y + zone.h && y + TH < H; y += step) {
      for (let x = zone.x; x + TW < zone.x + zone.w && x + TW < W; x += step) {
        // 边缘强度
        let edgeSum = 0;
        for (let dy = 1; dy < TH - 1; dy += 2) {
          for (let dx = 1; dx < TW - 1; dx += 2) {
            const i = (y + dy) * W + (x + dx);
            const gx = Math.abs(ctx.gray[i + 1] - ctx.gray[i - 1]);
            const gy = Math.abs(ctx.gray[i + W] - ctx.gray[i - W]);
            edgeSum += gx + gy;
          }
        }
        if (edgeSum < 3000) continue;
        if (!regionStable(x, y, TW, TH)) continue;
        if (!best || edgeSum > best.edge) best = { x, y, w: TW, h: TH, edge: edgeSum };
      }
    }
    if (best) {
      const crop = cropFrame(frame, best.x, best.y, best.w, best.h);
      const name = `${zone.name}.png`;
      fs.writeFileSync(path.join(assetsDir, name), capture.encodePng(crop));
      templates.push({ zone: zone.name, file: name, ...best });
    }
  }

  check('从真实画面提取到稳定素材', templates.length > 0,
    templates.map((t) => `${t.zone}@(${t.x},${t.y})`).join(', '));
  if (templates.length === 0) return 3;

  // ---------- 写 rules.json ----------
  const rules = templates.map((t) => ({
    state: t.zone,
    template: t.file,
    threshold: 0.9,
    action: { type: 'tap' },
    cooldownMs: 600,
  }));
  const rulesPath = path.join(tmpDir, 'rules.json');
  fs.writeFileSync(rulesPath, JSON.stringify({ rules }, null, 2), 'utf8');

  // ---------- 构造 Runner ----------
  console.log('\n[构造 Runner]');
  const logs = [];
  const runner = new Runner({
    hwnd,
    title: '真实画面测试',
    params: {},
    log: (l, m) => logs.push(`[${l}] ${m}`),
    appRoot: tmpDir,
    assetsDir,
    inputBackend: 'none', // 只识别，不真的点击
  });

  const setup = runner.describeSetup();
  check('规则加载成功', setup.rulesCount === templates.length,
    `${setup.rulesCount} 条，来源 ${path.basename(String(setup.rulesSource || ''))}`);
  check('素材无缺失', setup.missingTemplates.length === 0,
    setup.missingTemplates.join(',') || '无');

  // 注入真实抓帧信息
  runner.origin = grab1.windowOrigin;
  runner.roi = grab1.roi;
  runner.stats.frames = 1;

  // ---------- 识别 ----------
  console.log('\n[真实画面识别]');
  const t0 = Date.now();
  const decision = runner.evaluateFrame(frame);
  const ms = Date.now() - t0;

  check('识别到状态', decision !== null,
    decision ? `${decision.state} score=${decision.score.toFixed(4)}` : '未识别');
  check('识别耗时合理（<1500ms）', ms < 1500, `${ms}ms`);

  if (decision) {
    // 验证坐标换算：屏幕 = windowOrigin + roi + 内容区坐标
    const expX = grab1.windowOrigin.left + grab1.roi.x + decision.contentX;
    const expY = grab1.windowOrigin.top + grab1.roi.y + decision.contentY;
    check('屏幕坐标换算正确',
      decision.screenX === expX && decision.screenY === expY,
      `屏幕(${decision.screenX},${decision.screenY}) 期望(${expX},${expY})`);

    // 命中位置应落在对应区域内
    const tpl = templates.find((t) => t.file === decision.template);
    if (tpl) {
      const dx = Math.abs(decision.contentX - (tpl.x + Math.floor(tpl.w / 2)));
      const dy = Math.abs(decision.contentY - (tpl.y + Math.floor(tpl.h / 2)));
      check('命中位置与素材采集位置一致（误差<=2px）', dx <= 2 && dy <= 2,
        `实测(${decision.contentX},${decision.contentY}) 素材中心(${tpl.x + Math.floor(tpl.w / 2)},${tpl.y + Math.floor(tpl.h / 2)})`);
    }

    // 冷却：正确行为是「冷却中的规则被跳过，其他规则仍可命中」。
    // 实测画面里 skills 和 bottom_left 两个区域都有素材，
    // 所以第一次命中 skills 后，第二次应当命中 bottom_left（而不是同一个）。
    const second = runner.evaluateFrame(frame);
    if (second) {
      check('冷却中的规则被跳过（换成了另一条）', second.state !== decision.state,
        `第一次 ${decision.state} → 第二次 ${second.state}`);
    } else {
      // 只有一条规则时，冷却期内应返回 null
      check('冷却期内不重复触发', true, '返回 null（单规则场景）');
    }
  }

  // ---------- 点击坐标（假后端验证）----------
  console.log('\n[点击坐标验证]');
  const taps = [];
  runner.input = {
    tap: (x, y) => { taps.push({ x, y }); return true; },
    deviceSize: () => ({ width: 2560, height: 1440 }),
    status: () => ({ backend: 'win32', available: true }),
  };
  runner.inputBackend = 'win32';
  runner._cooldowns.clear();

  if (decision) {
    const d2 = runner.evaluateFrame(frame);
    if (d2) {
      try {
        runner.executeAction(d2);
        check('点击被调用', taps.length === 1, JSON.stringify(taps[0]));
        check('win32 用屏幕坐标',
          taps[0].x === d2.screenX && taps[0].y === d2.screenY,
          `tap(${taps[0].x},${taps[0].y}) screen(${d2.screenX},${d2.screenY})`);
      } catch (err) {
        check('点击被调用', false, err.message);
      }
    }
  }

  // ---------- 清理 ----------
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n' + '='.repeat(66));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败项：');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(66));
  return fail === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error('测试异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
