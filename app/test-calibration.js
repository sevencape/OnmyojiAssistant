/**
 * 标定功能端到端测试
 *
 * 验证「界面里点标定 → 选素材 → 保存 → 能用于识别」这条完整链路：
 *   1. captureAndSuggest 返回结构化候选
 *   2. saveCalibration 把选中项写成 PNG + 更新 rules.json
 *   3. 写出的素材能被 TemplateLibrary 加载
 *   4. 用写出的 rules.json 构造 Runner，能识别到对应状态
 *   5. 名称校验、越界校验、重复规则替换等边界行为
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const native = require('./lib/native');
const capture = require('./lib/capture');
const vision = require('./lib/vision');
const gameDetect = require('./lib/gamedetect');
const calibration = require('./lib/calibration');
const { Runner } = require('./lib/runner');

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok === 'skip') { skipped++; console.log(`  [SKIP] ${name}${detail ? '  -> ' + detail : ''}`); return; }
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

async function main() {
  console.log('='.repeat(66));
  console.log('  标定功能端到端测试');
  console.log('='.repeat(66));

  // ---------- 纯逻辑测试（不需要游戏） ----------
  console.log('\n[1] 区域比例换算');
  {
    const r = calibration.zoneToRect({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, 1000, 800);
    check('比例→像素换算正确',
      r.x === 500 && r.y === 400 && r.w === 250 && r.h === 200,
      JSON.stringify(r));

    const edge = calibration.zoneToRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1000, 800);
    check('越界比例被裁剪（不超出画面）',
      edge.x + edge.w <= 1000 && edge.y + edge.h <= 800,
      JSON.stringify(edge));
  }

  console.log('\n[2] 变化图与稳定性计算');
  {
    // 造两帧：左半不变，右半大变
    const W = 160, H = 80;
    const mk = (fillRight) => {
      const b = Buffer.alloc(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          const v = x < W / 2 ? 100 : fillRight;
          b[o] = v; b[o + 1] = v; b[o + 2] = v; b[o + 3] = 255;
        }
      }
      return { width: W, height: H, bgra: b };
    };
    const f1 = mk(100);
    const f2 = mk(240); // 右半大幅变化

    const cm = calibration.buildChangeMap([f1, f2], 8);
    check('变化图生成', cm !== null, cm ? `${cm.width}x${cm.height}` : '');

    const leftChange = calibration.changeOfRegion(cm, { x: 8, y: 8, w: 56, h: 28 });
    const rightChange = calibration.changeOfRegion(cm, { x: 90, y: 8, w: 56, h: 28 });
    check('稳定区域变化≈0', leftChange < 0.5, `${leftChange.toFixed(3)}`);
    check('变化区域被识别', rightChange > 100, `${rightChange.toFixed(1)}`);
    check('稳定区 < 变化区', leftChange < rightChange, `${leftChange.toFixed(2)} vs ${rightChange.toFixed(1)}`);
  }

  console.log('\n[3] 名称校验');
  {
    // 用一个假 hwnd 让 saveCalibration 在参数校验阶段就返回（不实际抓帧）
    const bad = calibration.saveCalibration({ hwnd: 0, items: [] });
    check('空列表被拒绝', bad.ok === false, bad.error || '');

    const badName = calibration.saveCalibration({
      hwnd: 0,
      items: [{ name: '../evil', x: 0, y: 0, w: 50, h: 30 }],
    });
    check('路径穿越名称被拒绝', badName.ok === false,
      (badName.warnings || []).join(';') || badName.error || '');
  }

  // ---------- 真实游戏画面测试 ----------
  native.enableDpiAwareness();
  const games = gameDetect.pickGameWindows(native.listWindows(), process.pid)
    .filter((w) => (w.processName || '').toLowerCase().includes('onmyoji'));

  if (games.length === 0) {
    console.log('\n[4] 真实画面标定 —— 跳过（没有运行中的阴阳师）');
    return finish();
  }

  const hwnd = games[0].hwnd;
  const tmpDir = path.join(os.tmpdir(), 'omj-calib-test-' + Date.now());
  const assetsDir = path.join(tmpDir, 'assets');
  const rulesPath = path.join(tmpDir, 'rules.json');
  fs.mkdirSync(assetsDir, { recursive: true });

  console.log(`\n[4] 真实画面标定（hwnd=${hwnd}）`);
  const t0 = Date.now();
  const r = await calibration.captureAndSuggest(hwnd, { samples: 3, gapMs: 300 });
  const ms = Date.now() - t0;

  check('标定返回结果', !!r, `${ms}ms`);
  check('耗时合理（<10000ms）', ms < 10000, `${ms}ms`);
  check('截图非全黑', r.brightness >= 3, `亮度 ${r.brightness}`);
  check('采样到多帧', r.samples >= 2, `${r.samples} 帧`);
  check('有区域定义', r.zones.length === calibration.UI_ZONES.length,
    `${r.zones.length} 个区域`);
  check('整帧 PNG 可用于显示', typeof r.framePng === 'string' && r.framePng.length > 1000,
    `${Math.round(r.framePng.length / 1024)}KB base64`);

  // 收集所有候选
  const allCands = [];
  for (const z of r.zones) {
    for (const c of z.candidates) allCands.push({ zone: z.name, ...c });
  }
  // 这条依赖「游戏当前停在有按钮的界面」，属环境相关：
  // 战斗结算、胜利、加载画面本来就没有可点按钮。
  // 找不到就记为跳过，避免测试结果随游戏画面飘。
  check('至少找到一个候选', allCands.length > 0 ? true : 'skip',
    `${allCands.length} 个${allCands.length === 0 ? '（当前画面无按钮，跳过）' : ''}`);

  if (allCands.length === 0) {
    console.log('  当前画面没有可用候选（可能不是有按钮的界面），跳过保存测试');
    return finish();
  }

  // 每个候选都应带缩略图
  const withThumb = allCands.filter((c) => typeof c.pngBase64 === 'string' && c.pngBase64.length > 100);
  check('候选都带缩略图', withThumb.length === allCands.length,
    `${withThumb.length}/${allCands.length}`);

  // ---------- 保存 ----------
  console.log('\n[5] 保存素材与规则');
  const picked = allCands.slice(0, 3).map((c, i) => ({
    name: `test_btn_${i + 1}`,
    state: `测试状态${i + 1}`,
    x: c.x, y: c.y, w: c.w, h: c.h,
    threshold: 0.86,
    cooldownMs: 1000,
  }));

  const saveRes = calibration.saveCalibration({
    hwnd,
    items: picked,
    assetsDir,
    rulesPath,
    replaceRules: false,
  });

  check('保存成功', saveRes.ok === true, saveRes.error || '');
  check('保存了 3 个素材', saveRes.saved && saveRes.saved.length === 3,
    `${saveRes.saved ? saveRes.saved.length : 0} 个`);

  if (saveRes.ok) {
    // 校验文件真的存在且是有效 PNG
    let validPng = 0;
    for (const s of saveRes.saved) {
      const p = path.join(assetsDir, s.file);
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      // PNG 魔数
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) validPng++;
    }
    check('素材文件是有效 PNG', validPng === 3, `${validPng}/3`);

    // 校验 rules.json
    check('rules.json 已写出', fs.existsSync(rulesPath));
    if (fs.existsSync(rulesPath)) {
      const doc = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      check('规则数量正确', Array.isArray(doc.rules) && doc.rules.length === 3,
        `${doc.rules ? doc.rules.length : 0} 条`);
      check('规则含 template 字段',
        doc.rules.every((x) => typeof x.template === 'string'));
      check('规则含 threshold 字段',
        doc.rules.every((x) => typeof x.threshold === 'number'));
    }
  }

  // ---------- 用保存的素材做识别 ----------
  console.log('\n[6] 用保存的素材识别（验证素材可用）');
  if (saveRes.ok && saveRes.saved.length > 0) {
    const lib = new vision.TemplateLibrary(assetsDir);
    for (const s of saveRes.saved) {
      const tpl = lib.get(s.file);
      check(`素材可加载 ${s.file}`, tpl !== null,
        tpl ? `${tpl.width}x${tpl.height}` : (lib.loadErrors.get(s.file) || '未知'));
    }

    // 抓当前帧，用 Runner 识别
    const grab = capture.grabContent(hwnd);
    const logs = [];
    const runner = new Runner({
      hwnd,
      title: 'calib-test',
      params: {},
      log: (l, m) => logs.push(`[${l}] ${m}`),
      appRoot: tmpDir,
      assetsDir,
      inputBackend: 'none',
    });
    runner.origin = grab.windowOrigin;
    runner.roi = grab.roi;
    runner.stats.frames = 1;

    const setup = runner.describeSetup();
    check('Runner 加载到 3 条规则', setup.rulesCount === 3, `${setup.rulesCount} 条`);
    check('无缺失素材', setup.missingTemplates.length === 0,
      setup.missingTemplates.join(',') || '无');

    const decision = runner.evaluateFrame(grab.frame);
    check('识别到状态', decision !== null,
      decision ? `${decision.state} score=${decision.score.toFixed(4)}` : '未识别');

    if (decision) {
      check('识别分数够高', decision.score >= 0.86, decision.score.toFixed(4));
      // 坐标应落在某个已保存素材附近
      const near = saveRes.saved.find((s) =>
        Math.abs(decision.contentX - (s.x + Math.floor(s.width / 2))) <= 3 &&
        Math.abs(decision.contentY - (s.y + Math.floor(s.height / 2))) <= 3);
      check('命中位置对应某个已保存素材', !!near,
        near ? `匹配 ${near.file}` : `(${decision.contentX},${decision.contentY}) 无对应`);

      // 屏幕坐标换算
      const expX = grab.windowOrigin.left + grab.roi.x + decision.contentX;
      const expY = grab.windowOrigin.top + grab.roi.y + decision.contentY;
      check('屏幕坐标换算正确',
        decision.screenX === expX && decision.screenY === expY,
        `(${decision.screenX},${decision.screenY})`);
    }
  }

  // ---------- 覆盖模式 ----------
  console.log('\n[7] 覆盖模式与重复替换');
  if (saveRes.ok && saveRes.saved.length > 0) {
    // 用同名再存一次 → 应替换而非追加
    const again = calibration.saveCalibration({
      hwnd,
      items: [{ name: 'test_btn_1', state: '改名后', x: picked[0].x, y: picked[0].y, w: picked[0].w, h: picked[0].h }],
      assetsDir,
      rulesPath,
      replaceRules: false,
    });
    check('同名再次保存成功', again.ok === true, again.error || '');
    if (again.ok) {
      const doc = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      check('同名规则被替换而非追加', doc.rules.length === 3, `${doc.rules.length} 条`);
      const r1 = doc.rules.find((x) => x.template === 'test_btn_1.png');
      check('替换后 state 已更新', r1 && r1.state === '改名后', r1 ? r1.state : '未找到');
    }

    // 覆盖模式
    const overwrite = calibration.saveCalibration({
      hwnd,
      items: [{ name: 'only_one', state: '仅此一条', x: picked[0].x, y: picked[0].y, w: picked[0].w, h: picked[0].h }],
      assetsDir,
      rulesPath,
      replaceRules: true,
    });
    check('覆盖模式保存成功', overwrite.ok === true, overwrite.error || '');
    if (overwrite.ok) {
      const doc = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      check('覆盖后只剩 1 条规则', doc.rules.length === 1, `${doc.rules.length} 条`);
    }
  }

  // 清理
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  return finish();
}

function finish() {
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
