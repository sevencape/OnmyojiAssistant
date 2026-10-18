/**
 * 端到端集成测试：识别 → 决策 → 点击坐标换算
 *
 * 不依赖游戏，用合成画面验证整条链路：
 *   1. 造一张"假游戏画面"，其中画一个明显的按钮
 *   2. 从画面里裁出按钮素材（模拟用户采集素材）
 *   3. 写 rules.json 指向该素材
 *   4. 构造 Runner，用假 ADB 捕获点击
 *   5. 调用 evaluateFrame + executeAction，验证：
 *      - 命中正确的 state
 *      - 屏幕坐标 = windowOrigin + roi + 内容区坐标
 *      - 设备坐标按分辨率比例换算正确
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const R = 'F:\\WorkSpace\\onmyoji-bot\\app';
const vision = require('F:\\WorkSpace\\onmyoji-bot\\app\\lib\\vision');
const { Runner } = require('F:\\WorkSpace\\onmyoji-bot\\app\\lib\\runner');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

// ---------- PNG 写入 ----------
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
function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = y * (width * 3 + 1) + 1 + x * 3;
      raw[d] = rgb[s]; raw[d + 1] = rgb[s + 1]; raw[d + 2] = rgb[s + 2];
    }
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---------- 造"假游戏画面" ----------
const W = 1141, H = 665;          // 与真实内容区一致的尺寸
const BGRA = Buffer.alloc(W * H * 4);

// 背景：随机块状纹理（有特征但不像按钮）
let seed = 99;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 16) & 0xff; };
const BS = 20;
const bw = Math.ceil(W / BS), bh = Math.ceil(H / BS);
const blocks = new Uint8Array(bw * bh);
for (let i = 0; i < blocks.length; i++) blocks[i] = 30 + (rnd() % 60);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const v = blocks[Math.floor(y / BS) * bw + Math.floor(x / BS)];
    const o = (y * W + x) * 4;
    BGRA[o] = v; BGRA[o + 1] = v; BGRA[o + 2] = v; BGRA[o + 3] = 255;
  }
}

// 画一个"开始战斗"按钮：亮色圆角矩形 + 深色文字条
const BTN_X = 470, BTN_Y = 540, BTN_W = 200, BTN_H = 64;
function px(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  BGRA[o] = b; BGRA[o + 1] = g; BGRA[o + 2] = r; BGRA[o + 3] = 255;
}
for (let y = 0; y < BTN_H; y++) {
  for (let x = 0; x < BTN_W; x++) {
    const edge = x < 4 || y < 4 || x >= BTN_W - 4 || y >= BTN_H - 4;
    px(BTN_X + x, BTN_Y + y, edge ? 90 : 230, edge ? 90 : 200, edge ? 70 : 80);
  }
}
// 文字笔画（保证有强特征）
for (let i = 0; i < 6; i++) {
  const tx = BTN_X + 26 + i * 26;
  for (let y = 18; y < 46; y++) {
    for (let x = 0; x < 5; x++) px(tx + x, BTN_Y + y, 40, 35, 30);
  }
}

// ---------- 目标 ----------
const TMP = 'F:\\WorkSpace\\integration-test';
fs.mkdirSync(TMP, { recursive: true });
const assetsDir = path.join(TMP, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

// 从画面裁出按钮素材（比按钮稍小一点，留出边缘）
const TX = BTN_X + 6, TY = BTN_Y + 6, TW = BTN_W - 12, TH = BTN_H - 12;
const rgb = Buffer.alloc(TW * TH * 3);
for (let y = 0; y < TH; y++) {
  for (let x = 0; x < TW; x++) {
    const o = ((TY + y) * W + (TX + x)) * 4;
    const d = (y * TW + x) * 3;
    rgb[d] = BGRA[o + 2]; rgb[d + 1] = BGRA[o + 1]; rgb[d + 2] = BGRA[o];
  }
}
writePng(path.join(assetsDir, 'btn_start_battle.png'), TW, TH, rgb);

// rules.json
fs.writeFileSync(path.join(TMP, 'rules.json'), JSON.stringify({
  rules: [
    {
      state: '开始战斗',
      template: 'btn_start_battle.png',
      threshold: 0.85,
      action: { type: 'tap' },
      cooldownMs: 500,
    },
  ],
}, null, 2), 'utf8');

console.log('='.repeat(64));
console.log('  端到端集成测试：识别 → 决策 → 点击坐标');
console.log('='.repeat(64));
console.log(`  假画面 ${W}x${H}  按钮素材 ${TW}x${TH} @(${TX},${TY})`);
console.log('');

// ---------- 构造 Runner ----------
// 注意 clickJitter: 0 —— 本节验的是**坐标换算**（内容区→屏幕→设备），
// 需要点击点精确落在中心。抖动行为由 test-rules.js 的「随机点击点」专门覆盖。
const logs = [];
const runner = new Runner({
  hwnd: 999999,
  title: '集成测试',
  params: { actionInterval: 0.3, clickJitter: 0 },
  log: (level, msg) => logs.push(`[${level}] ${msg}`),
  appRoot: TMP,
  assetsDir,
});

const setup = runner.describeSetup();
check('规则已加载', setup.rulesCount === 1, `${setup.rulesCount} 条, 来源 ${path.basename(String(setup.rulesSource || ''))}`);
check('素材无缺失', setup.missingTemplates.length === 0, setup.missingTemplates.join(',') || '无');

// 模拟 capture.grabContent 的输出
const frame = { width: W, height: H, bgra: BGRA };
const WINDOW_ORIGIN = { left: 100, top: 50 };
const ROI = { x: 0, y: 0 };
runner.origin = WINDOW_ORIGIN;
runner.roi = ROI;
runner.stats.frames = 1;

// ---------- 识别 ----------
console.log('\n[1] 识别');
// 第一次调用包含冷启动成本（建 FrameContext、算 FFT、解码模板），
// 之后每帧复用缓存 —— 稳定性看的是**热路径**。
const tCold = Date.now();
const decision = runner.evaluateFrame(frame);
const coldMs = Date.now() - tCold;

// 热路径：连跑几次取平均
let warmTotal = 0;
const warmRuns = 3;
for (let i = 0; i < warmRuns; i++) {
  runner.stats.frames++;          // 模拟新的一帧（会重建帧上下文）
  runner._cooldowns.clear();      // 清冷却，确保真的走匹配
  const t = Date.now();
  runner.evaluateFrame(frame);
  warmTotal += (Date.now() - t);
}
const warmMs = warmTotal / warmRuns;

check('识别到状态', decision !== null, decision ? decision.state : '未识别');
if (decision) {
  check('state 正确', decision.state === '开始战斗', decision.state);
  check('分数达标', decision.score >= 0.85, decision.score.toFixed(4));
  // 冷启动允许慢一些（要建缓存）；热路径也要为每帧重建 FFT（真实情况如此），
  // 阈值放宽到 600ms —— 依然能抓住「由粗到精没生效」那种退化（早期是 1055ms）。
  check('冷启动耗时 < 1200ms', coldMs < 1200, `${coldMs}ms`);
  check('热路径平均耗时 < 600ms', warmMs < 600,
    `冷 ${coldMs}ms / 热 ${warmMs.toFixed(0)}ms`);

  // 内容区内的期望中心
  const expCx = TX + Math.floor(TW / 2);
  const expCy = TY + Math.floor(TH / 2);
  check('内容区坐标正确（误差<=1px）',
    Math.abs(decision.contentX - expCx) <= 1 && Math.abs(decision.contentY - expCy) <= 1,
    `实测(${decision.contentX},${decision.contentY}) 期望(${expCx},${expCy})`);

  // 屏幕坐标 = 窗口原点 + ROI + 内容区坐标
  check('屏幕坐标换算正确',
    decision.screenX === WINDOW_ORIGIN.left + ROI.x + decision.contentX &&
    decision.screenY === WINDOW_ORIGIN.top + ROI.y + decision.contentY,
    `屏幕(${decision.screenX},${decision.screenY})`);
}

// ---------- 点击（假 ADB 后端）----------
console.log('\n[2] 点击坐标（ADB 后端）');
const taps = [];
runner.input = {
  tap: (x, y) => { taps.push({ x, y }); return true; },
  deviceSize: () => null,
  status: () => ({ backend: 'adb', available: true, connected: true }),
};
runner.adb = runner.input;
runner.inputBackend = 'adb';
runner.deviceSize = null;

try {
  runner.executeAction(decision);
  check('ADB tap 被调用', taps.length === 1, JSON.stringify(taps[0] || null));
  if (taps.length && decision) {
    check('设备坐标 = 屏幕坐标（无分辨率信息时）',
      taps[0].x === decision.screenX && taps[0].y === decision.screenY,
      `tap(${taps[0].x},${taps[0].y}) screen(${decision.screenX},${decision.screenY})`);
  }
} catch (err) {
  check('ADB tap 被调用', false, err.message);
}

// ---------- 设备坐标换算（ADB 后端）----------
console.log('\n[3] 设备坐标按分辨率换算（ADB 后端）');
if (decision) {
  const DEV = { width: W * 2, height: H * 2 }; // 设备分辨率是内容区的 2 倍
  const taps2 = [];
  runner.input = {
    tap: (x, y) => { taps2.push({ x, y }); return true; },
    deviceSize: () => DEV,
    status: () => ({ backend: 'adb', available: true, connected: true }),
  };
  runner.adb = runner.input;
  runner.inputBackend = 'adb';
  runner.deviceSize = DEV;
  runner._cooldowns.clear();
  try {
    runner.executeAction(decision);
    const expX = Math.round(decision.contentX * 2);
    const expY = Math.round(decision.contentY * 2);
    check('按比例缩放到设备坐标',
      taps2.length === 1 && Math.abs(taps2[0].x - expX) <= 1 && Math.abs(taps2[0].y - expY) <= 1,
      `tap(${taps2[0] ? taps2[0].x : '?'},${taps2[0] ? taps2[0].y : '?'}) 期望(${expX},${expY})`);
  } catch (err) {
    check('按比例缩放到设备坐标', false, err.message);
  }
}

// ---------- Windows 后端：应直接使用屏幕坐标 ----------
console.log('\n[3b] Windows 后端应直接使用屏幕坐标');
if (decision) {
  const taps3 = [];
  runner.input = {
    tap: (x, y) => { taps3.push({ x, y }); return true; },
    deviceSize: () => ({ width: 2560, height: 1440 }),
    status: () => ({ backend: 'win32', available: true }),
  };
  runner.adb = runner.input;
  runner.inputBackend = 'win32';
  runner.deviceSize = null;
  runner._cooldowns.clear();
  try {
    runner.executeAction(decision);
    check('win32 tap 用屏幕坐标',
      taps3.length === 1 && taps3[0].x === decision.screenX && taps3[0].y === decision.screenY,
      `tap(${taps3[0] ? taps3[0].x : '?'},${taps3[0] ? taps3[0].y : '?'}) ` +
      `屏幕(${decision.screenX},${decision.screenY})`);
  } catch (err) {
    check('win32 tap 用屏幕坐标', false, err.message);
  }
}

// ---------- 冷却 ----------
console.log('\n[4] 冷却与优先级');
{
  runner._cooldowns.clear();
  runner.deviceSize = null;
  const d1 = runner.evaluateFrame(frame);
  const d2 = runner.evaluateFrame(frame); // 立即再问一次，应被冷却挡住
  check('第一次命中', d1 !== null);
  check('冷却期内不重复命中', d2 === null, d2 ? '仍命中' : '正确挡住');
}

// ---------- 无素材时的降级 ----------
console.log('\n[5] 素材缺失时的行为');
{
  const emptyDir = path.join(TMP, 'empty-assets');
  fs.mkdirSync(emptyDir, { recursive: true });
  const r2 = new Runner({
    hwnd: 888888, title: 't2', params: {}, log: () => { },
    appRoot: TMP, assetsDir: emptyDir,
  });
  r2.origin = WINDOW_ORIGIN; r2.roi = ROI; r2.stats.frames = 1;
  let threw = false;
  let d = null;
  try { d = r2.evaluateFrame(frame); } catch (e) { threw = true; }
  check('素材缺失时不抛异常', !threw);
  check('素材缺失时返回 null（不点击）', d === null, d ? '误命中' : '正确返回 null');
  check('素材缺失时有告警日志', r2.describeSetup().missingTemplates.length === 1,
    String(r2.describeSetup().missingTemplates));
}

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(64));
console.log(`  通过 ${pass}  失败 ${fail}`);
if (failures.length) {
  console.log('\n  失败项：');
  failures.forEach((f) => console.log('    - ' + f));
}
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
