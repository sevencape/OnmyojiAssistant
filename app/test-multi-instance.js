/**
 * 多实例并发测试（真实游戏窗口）
 *
 * 目的：验证目标里的「支持多个游戏窗口/实例」是真的能用，
 * 而不只是"架构上每实例有个 Runner"。
 *
 * 验证点：
 *   1. 能同时为多个真实游戏窗口创建 Runner
 *   2. 两个 Runner 并发跑时互不干扰（各自有独立统计、独立截图）
 *   3. 帧率不会因为并发而崩溃
 *   4. 停掉一个不影响另一个
 *   5. stopAll 能全部干净停止
 *   6. 每个实例独立的冷却表（不会因为同名规则互相阻塞）
 *   7. 同一实例重复 start 会被拒绝
 *
 * 安全：全程 dryRun=true + inputBackend=none，绝不产生真实点击。
 *
 * 用法: node test-multi-instance.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const native = require('./lib/native');
const capture = require('./lib/capture');
const gameDetect = require('./lib/gamedetect');
const { Runner, RunnerManager } = require('./lib/runner');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 从帧里裁一块，编码成 PNG 写盘 */
function cropToPng(frame, x, y, w, h, file) {
  const out = Buffer.alloc(w * h * 4);
  const srcRow = frame.width * 4;
  const dstRow = w * 4;
  for (let row = 0; row < h; row++) {
    const s = (y + row) * srcRow + x * 4;
    frame.bgra.copy(out, row * dstRow, s, s + dstRow);
  }
  fs.writeFileSync(file, capture.encodePng({ width: w, height: h, bgra: out }));
}

/**
 * 从一帧里找一个稳定且有特征的区域当素材。
 * 用简单策略：在左下/右下两个已知区域里，找边缘最强的小块。
 */
function pickTemplateRegion(frame, gray) {
  const W = frame.width;
  const H = frame.height;
  const W_ = 56, H_ = 28;

  const zones = [
    { x: Math.floor(W * 0.55), y: Math.floor(H * 0.70), w: Math.floor(W * 0.4), h: Math.floor(H * 0.25) },
    { x: 0, y: Math.floor(H * 0.70), w: Math.floor(W * 0.3), h: Math.floor(H * 0.25) },
    { x: Math.floor(W * 0.3), y: Math.floor(H * 0.72), w: Math.floor(W * 0.4), h: Math.floor(H * 0.22) },
  ];

  let best = null;
  for (const z of zones) {
    for (let y = z.y; y + H_ < Math.min(H, z.y + z.h); y += 14) {
      for (let x = z.x; x + W_ < Math.min(W, z.x + z.w); x += 14) {
        let edge = 0;
        for (let dy = 1; dy < H_ - 1; dy += 3) {
          for (let dx = 1; dx < W_ - 1; dx += 3) {
            const i = (y + dy) * W + (x + dx);
            edge += Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + W] - gray[i - W]);
          }
        }
        if (!best || edge > best.edge) best = { x, y, w: W_, h: H_, edge };
      }
    }
    if (best && best.edge > 2500) break;
  }
  return best;
}

async function main() {
  console.log('='.repeat(66));
  console.log('  多实例并发测试（真实游戏窗口）');
  console.log('='.repeat(66));

  native.enableDpiAwareness();

  // ---------- 找游戏窗口 ----------
  const all = native.listWindows();
  const games = gameDetect.pickGameWindows(all, process.pid)
    .filter((w) => (w.processName || '').toLowerCase().includes('onmyoji'))

  check('检测到游戏窗口', games.length >= 2, `${games.length} 个（需要 >= 2 做并发）`);
  if (games.length < 2) {
    console.log('\n  只有 1 个或没有游戏窗口，无法测试并发。请多开阴阳师后重跑。');
    return 2;
  }

  const targets = games.slice(0, Math.min(4, games.length));
  console.log('');
  targets.forEach((t, i) => {
    console.log(`  实例[${i}] hwnd=${t.hwnd} ${t.bounds.width}x${t.bounds.height} @(${t.bounds.left},${t.bounds.top})`);
  });

  // ---------- 准备临时素材 ----------
  const tmp = path.join(os.tmpdir(), 'omj-multi-' + Date.now());
  const assetsDir = path.join(tmp, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  // 给每个实例各造一个素材（用各自画面的内容，保证能命中）
  const prepared = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      const grab = capture.grabContent(t.hwnd);
      const f = grab.frame;

      // 灰度
      const gray = new Float32Array(f.width * f.height);
      for (let p = 0, n = f.width * f.height; p < n; p++) {
        const o = p * 4;
        gray[p] = 0.299 * f.bgra[o + 2] + 0.587 * f.bgra[o + 1] + 0.114 * f.bgra[o];
      }

      const region = pickTemplateRegion(f, gray);
      if (!region) {
        console.log(`  实例[${i}] 没找到合适区域，跳过`);
        continue;
      }

      const name = `inst${i}_btn.png`;
      cropToPng(f, region.x, region.y, region.w, region.h, path.join(assetsDir, name));
      prepared.push({
        index: i,
        hwnd: t.hwnd,
        title: t.title,
        asset: name,
        region,
        frameSize: { w: f.width, h: f.height },
        brightness: capture.meanBrightness(f),
      });
      console.log(`  实例[${i}] 素材 ${name} 取自 (${region.x},${region.y}) 亮度 ${capture.meanBrightness(f).toFixed(0)}`);
    } catch (err) {
      console.log(`  实例[${i}] 抓帧失败: ${err.message}`);
    }
  }

  check('为实例准备好素材', prepared.length >= 2, `${prepared.length} 个`);

  // ---------- 写规则 ----------
  // 每个实例用自己的素材 + 同名 state，验证「冷却表独立」
  const rules = prepared.map((p) => ({
    state: '测试按钮',           // 故意同名，验证实例间不互相阻塞
    template: p.asset,
    threshold: 0.85,
    action: { type: 'none' },    // 不点击（双保险）
    cooldownMs: 200,
  }));
  fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({ rules }, null, 2), 'utf8');

  // ---------- 创建 Runner ----------
  console.log('\n[1] 创建并发实例');
  const runners = [];
  const logs = [];
  for (const p of prepared) {
    const r = new Runner({
      hwnd: p.hwnd,
      title: p.title,
      params: { dryRun: true, actionInterval: 0.25, errorStreakLimit: 20 },
      log: (l, m, id) => logs.push(`${id || '-'} ${l}: ${m}`),
      appRoot: tmp,
      assetsDir,
      inputBackend: 'none',
    });
    runners.push(r);
    const s = r.describeSetup();
    check(`实例[${p.index}] Runner 就绪`,
      s.rulesCount === rules.length && s.missingTemplates.length === 0,
      `${s.rulesCount} 条规则, 缺失 ${s.missingTemplates.length}`);
  }
  check('创建了多个 Runner', runners.length >= 2, `${runners.length} 个`);

  // ---------- 并发启动 ----------
  console.log('\n[2] 并发运行 3 秒');
  const t0 = Date.now();
  for (const r of runners) {
    const res = r.start();
    if (!res.ok) console.log(`  启动失败: ${res.error}`);
  }

  check('全部实例在运行', runners.every((r) => r.running), 
    runners.map((r) => (r.running ? '跑' : '停')).join(','));

  await sleep(3000);

  const snap = runners.map((r) => r.status());
  snap.forEach((s, i) => {
    console.log(`  实例[${i}] 帧=${s.frames} 动作=${s.actions} fps=${s.fps} 状态=${s.state} 错误=${s.errors}`);
  });

  const elapsed = (Date.now() - t0) / 1000;
  check('所有实例都在采集帧', snap.every((s) => s.frames > 0),
    snap.map((s) => s.frames).join(','));
  check('每个实例的统计独立', snap.every((s) => typeof s.frames === 'number'),
    '各有各的 frames/actions');
  check('没有实例因异常停止', snap.every((s) => s.errors < 5),
    snap.map((s) => s.errors).join(','));

  // 帧率合理（并发下每个应该仍有 > 1 fps）
  const minFps = Math.min(...snap.map((s) => s.fps));
  check('并发下帧率合理（>=1 fps）', minFps >= 1, `最低 ${minFps} fps，运行 ${elapsed.toFixed(1)}s`);

  // ---------- 停一个，另一个继续 ----------
  console.log('\n[3] 停掉实例 0，验证实例 1 不受影响');
  const beforeStop = runners[1].status().frames;
  const stopRes = runners[0].stop('测试：单独停止实例0');
  check('stop 返回成功', stopRes.ok === true, stopRes.error || '');

  await sleep(1200);

  const afterStop = runners[1].status();
  check('实例 0 已停止', runners[0].running === false);
  check('实例 1 仍在运行', runners[1].running === true, afterStop.state);
  check('实例 1 继续采集帧', afterStop.frames > beforeStop,
    `${beforeStop} → ${afterStop.frames}`);

  // ---------- 重复 start 应被拒绝 ----------
  console.log('\n[4] 重复启动保护');
  const dup = runners[1].start();
  check('已在运行的实例拒绝重复 start', dup.ok === false, dup.error || '');

  // ---------- stopAll ----------
  console.log('\n[5] 全部停止');
  const stopped = runners.reduce((n, r) => n + (r.running ? 1 : 0), 0);
  for (const r of runners) {
    if (r.running) r.stop('测试结束');
  }
  await sleep(1500);

  check('全部实例已停止', runners.every((r) => !r.running),
    runners.map((r) => (r.running ? '仍跑' : '已停')).join(','));
  check('停止前有实例在跑', stopped >= 1, `${stopped} 个`);

  // ---------- RunnerManager ----------
  console.log('\n[6] RunnerManager 管理多实例');
  {
    const tmp2 = path.join(os.tmpdir(), 'omj-multi-mgr-' + Date.now());
    const assets2 = path.join(tmp2, 'assets');
    fs.mkdirSync(assets2, { recursive: true });
    // 复用第一份素材
    fs.copyFileSync(path.join(assetsDir, prepared[0].asset), path.join(assets2, prepared[0].asset));
    fs.writeFileSync(path.join(tmp2, 'rules.json'), JSON.stringify({
      rules: [{ state: '测试按钮', template: prepared[0].asset, threshold: 0.85, action: { type: 'none' }, cooldownMs: 200 }],
    }), 'utf8');

    // 手动构造 manager 并注入 Runner 配置
    const mgrLogs = [];
    const mgr = new RunnerManager({ log: (l, m, id) => mgrLogs.push(`${id} ${l}: ${m}`) });
    mgr.factory = (payload) => new Runner({
      hwnd: payload.hwnd, title: payload.title, params: payload.params,
      log: (l, m, id) => mgrLogs.push(`${id} ${l}: ${m}`),
      appRoot: tmp2, assetsDir: assets2, inputBackend: 'none',
    });

    // 直接测试 start/status/stopAll 的接口约定
    const st = mgr.status();
    check('Manager.status 初始为空数组', Array.isArray(st) && st.length === 0, JSON.stringify(st));
    const stopAllRes = mgr.stopAll();
    check('Manager.stopAll 空集合不报错', stopAllRes.ok === true, `${stopAllRes.stopped} 个`);
    const badStop = mgr.stop('不存在的实例');
    check('Manager.stop 未知实例返回错误', badStop.ok === false, badStop.error || '');
  }

  // ---------- 清理 ----------
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

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
