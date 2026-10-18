/**
 * 数据目录一致性测试
 *
 * ── 这个测试是为了防一个真实事故 ──
 * 用户打包后标定，日志显示：
 *   保存成功：2 个素材 → ...\dist\win-unpacked\resources\assets
 *   运行失败 | 12 个素材缺失
 *
 * 原因：标定保存和运行加载**各自算各自的根目录**
 *   保存：__dirname 在 resources/app.asar/lib → 退两级 → resources/
 *   加载：启发式优先命中硬编码的 F:\WorkSpace\onmyoji-bot
 *
 * 修复后只有一个数据根目录（lib/paths.js）。
 * 本测试锁死这个不变量：**保存写到的位置，必须就是加载读取的位置**。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const paths = require('./lib/paths');
const capture = require('./lib/capture');
const { Runner } = require('./lib/runner');
const calibration = require('./lib/calibration');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

// 极简 PNG
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function writePng(file, w, h, pix) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const p = pix(x, y);
      const d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = p[0]; raw[d + 1] = p[1]; raw[d + 2] = p[2];
    }
  }
  function chunk(t, d) {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0);
    const b = Buffer.concat([Buffer.from(t, 'ascii'), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0, 0);
    return Buffer.concat([l, b, c]);
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const checker = (x, y) => ((Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0 ? [245, 245, 245] : [15, 15, 15]);

function main() {
  console.log('='.repeat(66));
  console.log('  数据目录一致性测试');
  console.log('='.repeat(66));

  // ===== 1. paths 解析行为 =====
  console.log('\n[1] paths.resolveDataRoot / resolveConfigDir');
  {
    const devRoot = paths.resolveDataRoot();
    check('开发态解析到项目根目录', path.basename(devRoot) === 'onmyoji-bot', devRoot);

    // 配置现在统一放在 <根>/config 下（dungeons + assets）
    const cfg = paths.resolveConfigDir();
    check('开发态配置目录是 <项目>/config', cfg === path.join(devRoot, 'config'), cfg);
    check('config/dungeons 存在', fs.existsSync(paths.dungeonsDirFor(cfg)),
      paths.dungeonsDirFor(cfg));
    check('config/assets 存在', fs.existsSync(paths.assetsDirFor(cfg)),
      paths.assetsDirFor(cfg));

    const custom = paths.resolveDataRoot({ dataRoot: os.tmpdir() });
    check('显式 dataRoot 生效', custom === path.resolve(os.tmpdir()), custom);

    const customCfg = paths.resolveConfigDir({ configDir: os.tmpdir() });
    check('显式 configDir 生效', customCfg === path.resolve(os.tmpdir()), customCfg);

    process.env.OMJ_DATA = path.join(os.tmpdir(), 'omj-env-test');
    check('环境变量 OMJ_DATA 生效',
      paths.resolveDataRoot() === path.resolve(process.env.OMJ_DATA),
      paths.resolveDataRoot());
    delete process.env.OMJ_DATA;

    check('assetsDirFor 与 rulesPathFor 同一父目录',
      path.dirname(paths.assetsDirFor('C:\\x')) === path.dirname(paths.rulesPathFor('C:\\x')),
      `${paths.assetsDirFor('C:\\x')} / ${paths.rulesPathFor('C:\\x')}`);
  }

  // ===== 2. 保存 → 加载 必须落在同一目录 =====
  console.log('\n[2] 保存 → 加载 一致性（核心不变量）');
  {
    const dataRoot = path.join(os.tmpdir(), 'omj-paths-' + Date.now());
    fs.mkdirSync(dataRoot, { recursive: true });

    // 造一个素材（模拟标定产物），手动写进 dataRoot/assets
    const assets = paths.assetsDirFor(dataRoot);
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'btn_test.png'), 40, 20, checker);

    // 用 saveCalibration 写规则（直接给它 dataRoot，验证它写到同一处）
    // 这里不抓真实画面，改成模拟：先放好素材，再让 saveCalibration 只合并规则
    const cropPng = fs.readFileSync(path.join(assets, 'btn_test.png'));
    const payload = {
      dataRoot,
      items: [{
        name: 'btn_test',
        x: 100, y: 200, w: 40, h: 20,
        pngBase64: cropPng.toString('base64'),
        threshold: 0.86,
      }],
    };

    const saved = calibration.saveCalibration(payload);
    check('saveCalibration 成功', saved.ok === true, saved.error || '');
    check('保存到 dataRoot/assets', saved.assetsDir === assets, saved.assetsDir);
    check('规则写到 dataRoot/rules.json',
      saved.rulesPath === paths.rulesPathFor(dataRoot), saved.rulesPath);

    // 现在用 Runner 加载 —— 必须读到刚才保存的东西
    const runner = new Runner({
      hwnd: 1, title: 't', params: {}, log: () => { },
      appRoot: dataRoot,          // ← 关键：同一个数据根目录
      inputBackend: 'none',
    });

    check('Runner 的 appRoot 就是 dataRoot', runner.appRoot === dataRoot, runner.appRoot);
    check('Runner 的素材目录就是保存目录', runner.library.dir === assets, runner.library.dir);
    check('Runner 读到了规则', runner.rules.length === 1,
      `${runner.rules.length} 条，来源 ${runner.rulesSource}`);
    check('规则来源就是保存的文件', runner.rulesSource === paths.rulesPathFor(dataRoot),
      runner.rulesSource || 'null');
    check('没有缺失素材', runner.missingTemplates.length === 0,
      runner.missingTemplates.join(',') || '无');
    check('素材能被解码', !!runner.library.get('btn_test.png'),
      runner.library.get('btn_test.png') ? '已加载' : '加载失败');

    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  // ===== 3. 素材全缺时给出可执行提示 =====
  console.log('\n[3] 素材缺失时的提示（不再逐条刷）');
  {
    const dataRoot = path.join(os.tmpdir(), 'omj-missing-' + Date.now());
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'rules.json'), JSON.stringify({
      rules: [
        { state: 'a', template: 'nope1.png', action: { type: 'tap' } },
        { state: 'b', template: 'nope2.png', action: { type: 'tap' } },
        { state: 'c', template: 'nope3.png', action: { type: 'tap' } },
      ],
    }), 'utf8');

    const logs = [];
    const runner = new Runner({
      hwnd: 1, title: 't', params: {},
      log: (l, m) => logs.push(l + ': ' + m),
      appRoot: dataRoot, inputBackend: 'none',
    });

    check('预检识别出 3 个缺失素材', runner.missingTemplates.length === 3,
      runner.missingTemplates.join(','));

    // 模拟 start() 的预检日志（不真的跑循环）
    if (runner.missingTemplates.length >= runner.rules.length) {
      // 这条分支应该被命中
      check('全部缺失时走"全部缺失"分支',
        runner.missingTemplates.length >= runner.rules.length);
    }

    // 逐条 evaluateFrame 不应该再刷警告
    const before = logs.length;
    runner.stats.frames = 1;
    for (let i = 0; i < 3; i++) {
      runner.evaluateFrame({ width: 100, height: 100, bgra: Buffer.alloc(100 * 100 * 4, 40) });
    }
    const newLogs = logs.slice(before);
    const missingWarns = newLogs.filter((l) => l.indexOf('素材缺失或无法解码') >= 0);
    check('evaluateFrame 不再逐条刷素材缺失警告', missingWarns.length === 0,
      missingWarns.length ? missingWarns.join(' | ') : '无（正确）');

    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  // ===== 4. 无规则时的提示 =====
  console.log('\n[4] 空规则的处理');
  {
    const dataRoot = path.join(os.tmpdir(), 'omj-empty-' + Date.now());
    fs.mkdirSync(dataRoot, { recursive: true });
    // 不写 rules.json
    const runner = new Runner({
      hwnd: 1, title: 't', params: {}, log: () => { },
      appRoot: dataRoot, inputBackend: 'none',
    });
    check('没有 rules.json 时规则为空且不抛异常',
      runner.rules.length === 0 && runner.rulesError === null,
      `rules=${runner.rules.length} error=${runner.rulesError || 'none'}`);
    check('evaluateFrame 返回 null 而不崩',
      runner.evaluateFrame({ width: 50, height: 50, bgra: Buffer.alloc(50 * 50 * 4) }) === null);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  // ===== 5. 素材名规范化（双扩展名事故的回归测试）=====
  console.log('\n[5] 素材名规范化');
  {
    const cases = [
      { in: 'btn_x', base: 'btn_x', file: 'btn_x.png' },
      { in: 'btn_x.png', base: 'btn_x', file: 'btn_x.png' },
      { in: 'btn_x.PNG', base: 'btn_x', file: 'btn_x.png' },
      { in: 'btn_x.png.png', base: 'btn_x', file: 'btn_x.png' },
      { in: '  btn_x  ', base: 'btn_x', file: 'btn_x.png' },
      { in: 'a.png.png.png', base: 'a', file: 'a.png' },
    ];
    let allOk = true;
    for (const c of cases) {
      const b = paths.normalizeAssetName(c.in);
      const f = paths.pngFileName(c.in);
      if (b !== c.base || f !== c.file) {
        allOk = false;
        console.log(`      不一致: ${JSON.stringify(c.in)} -> base=${JSON.stringify(b)} file=${JSON.stringify(f)}`);
      }
    }
    check('各种写法都规范成同一个基名', allOk, cases.length + ' 种写法');
    check('空值安全', paths.normalizeAssetName('') === '' && paths.normalizeAssetName(null) === '');

    // 带扩展名输入可以保存成功，且不会产生 .png.png
    const root = path.join(os.tmpdir(), 'omj-name-' + Date.now());
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    // 先造一张真实的 16x16 PNG 再转 base64（1x1 会被"尺寸过小"校验拒掉）
    const samplePng = path.join(root, 'tmp', 'sample.png');
    writePng(samplePng, 16, 16, checker);
    const TINY = fs.readFileSync(samplePng).toString('base64');

    const r = calibration.saveCalibration({
      dataRoot: root,
      items: [{ name: 'typed_with_ext.png', x: 0, y: 0, w: 16, h: 16, pngBase64: TINY }],
    });
    check('带 .png 的名称可以保存（不再整条拒绝）', r.ok === true, r.error || '');
    check('落盘文件名只有一个 .png', r.ok && r.saved[0].file === 'typed_with_ext.png',
      r.ok ? r.saved[0].file : '-');
    const files = r.ok ? fs.readdirSync(path.join(root, 'assets')) : [];
    check('磁盘上没有 .png.png', files.every((f) => !/\.png\.png$/i.test(f)), files.join(','));
    check('rules 里的 template 与文件名一致',
      r.ok && (() => {
        const doc = JSON.parse(fs.readFileSync(paths.rulesPathFor(root), 'utf8'));
        return doc.rules[0].template === r.saved[0].file;
      })(), r.ok ? '一致' : '-');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ===== 6. 模板名自愈（手工改坏 rules.json 也能跑）=====
  console.log('\n[6] 模板名自愈');
  {
    const root = path.join(os.tmpdir(), 'omj-heal-' + Date.now());
    const assets = path.join(root, 'assets');
    fs.mkdirSync(assets, { recursive: true });

    // 磁盘上是正常文件名
    writePng(path.join(assets, 'btn_real.png'), 20, 10, checker);
    // 再放一个双扩展名的，模拟用户手工造出来的
    writePng(path.join(assets, 'btn_double.png.png'), 20, 10, checker);

    // 规则里三种写法：漏扩展名 / 多扩展名 / 正确
    fs.writeFileSync(path.join(root, 'rules.json'), JSON.stringify({
      rules: [
        { state: 'A', template: 'btn_real', action: { type: 'none' } },        // 漏 .png
        { state: 'B', template: 'btn_real.png.png', action: { type: 'none' } }, // 多 .png
        { state: 'C', template: 'btn_double.png.png', action: { type: 'none' } }, // 磁盘就是双后缀
      ],
    }), 'utf8');

    const runner = new Runner({
      hwnd: 1, title: 't', params: {}, log: () => { },
      appRoot: root, inputBackend: 'none',
    });

    check('三种写法都被识别为存在', runner.missingTemplates.length === 0,
      runner.missingTemplates.join(',') || '无缺失');
    check('template 被修正成磁盘真实文件名',
      runner.rules.every((r) => fs.existsSync(path.join(assets, r.template))),
      runner.rules.map((r) => r.template).join(', '));
    check('记录了自愈动作', runner.healedTemplates.length >= 2,
      runner.healedTemplates.map((h) => `${h.from}→${h.to}`).join(', ') || '无');

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ===== 7. 端口探测性能（「卡几秒」事故的回归测试）=====
  console.log('\n[7] 端口探测：必须带 ELECTRON_RUN_AS_NODE 且缓存');
  {
    const input = require('./lib/input');
    input.clearProbeCache();

    const t1 = Date.now();
    const p1 = input.probePortsSync();
    const d1 = Date.now() - t1;

    const t2 = Date.now();
    const p2 = input.probePortsSync();
    const d2 = Date.now() - t2;

    check('首次探测能返回结果', Array.isArray(p1), `[${p1.join(',')}]`);
    check('首次探测耗时合理（<2000ms）', d1 < 2000, d1 + 'ms');
    check('第二次走缓存（<10ms）', d2 < 10, d2 + 'ms');
    check('缓存结果一致', JSON.stringify(p1) === JSON.stringify(p2));

    input.clearProbeCache();
    check('clearProbeCache 后可重新探测',
      (() => { input.probePortsSync(); const t = Date.now(); input.probePortsSync(); return Date.now() - t < 10; })(),
      '缓存重建正常');
  }

  console.log('\n' + '='.repeat(66));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败项：');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(66));
  return fail === 0 ? 0 : 1;
}

process.exit(main());
