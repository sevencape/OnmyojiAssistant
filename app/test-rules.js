/**
 * 规则与动作测试
 *
 * 覆盖：
 *   1. 项目 rules.json 能正确解析、加载、字段校验
 *   2. 所有用到的 action.type 都是受支持的
 *   3. stop 动作能正确触发运行停止（保命机制）
 *   4. none 动作不点击
 *   5. region 限制生效（区域外的相同图样不命中）
 *   6. isBattleEnd 标记能传到决策里
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { Runner } = require('./lib/runner');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

// ---------- 极简 PNG 写入 ----------
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

/** 棋盘格图样（强特征，适合当模板） */
const checker = (stage) => (x, y) => {
  const on = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0;
  return on ? [245, 245, 245] : [15, 15, 15];
};

/** 造一帧：背景 + 在指定位置贴一个棋盘格 */
function makeFrame(W, H, rects) {
  const bgra = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      bgra[o] = 40; bgra[o + 1] = 45; bgra[o + 2] = 50; bgra[o + 3] = 255;
    }
  }
  for (const r of rects) {
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        const px = r.x + dx, py = r.y + dy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const on = (Math.floor(dx / 5) + Math.floor(dy / 5)) % 2 === 0;
        const v = on ? 245 : 15;
        const o = (py * W + px) * 4;
        bgra[o] = v; bgra[o + 1] = v; bgra[o + 2] = v; bgra[o + 3] = 255;
      }
    }
  }
  return { width: W, height: H, bgra };
}

// ---------- 主流程 ----------

async function main() {
  console.log('='.repeat(66));
  console.log('  规则与动作测试');
  console.log('='.repeat(66));

  // ===== 1. 项目里所有副本配置的规则校验 =====
  // 规则不再放在单个 rules.json，而是分散在 config/dungeons/*.json，
  // 这里把所有副本的规则合起来做一遍统一校验。
  console.log('\n[1] 项目副本配置的规则');
  const dungeonsLib = require('./lib/dungeons');
  const pathsLib = require('./lib/paths');
  const cfgDir = pathsLib.resolveConfigDir();
  const dungeonList = dungeonsLib.listDungeons(
    pathsLib.dungeonsDirFor(cfgDir), pathsLib.assetsDirFor(cfgDir));

  check('能读到副本配置', dungeonList.length > 0, `${dungeonList.length} 种`);
  check('没有配置错误', dungeonList.every((d) => !d.error),
    dungeonList.filter((d) => d.error).map((d) => d.id).join(',') || '无');

  let projectRules = [];
  for (const d of dungeonList) {
    for (const r of d.rules) projectRules.push({ ...r, _dungeon: d.name });
  }
  check('规则总数合理', projectRules.length > 0, `${projectRules.length} 条（4 套副本合计）`);

  if (projectRules.length) {
    const SUPPORTED = ['tap', 'none', 'stop'];
    const badType = projectRules.filter((r) => !r.action || SUPPORTED.indexOf(r.action.type) < 0);
    check('所有动作类型受支持', badType.length === 0,
      badType.length ? badType.map((r) => r.state + ':' + (r.action && r.action.type)).join(',') : SUPPORTED.join('/'));

    const missingTpl = projectRules.filter((r) => !r.template);
    check('每条规则都有 template', missingTpl.length === 0,
      missingTpl.length ? missingTpl.map((r) => r.state).join(',') : '');

    const missingState = projectRules.filter((r) => !r.state);
    check('每条规则都有 state', missingState.length === 0);

    const badThreshold = projectRules.filter(
      (r) => r.threshold != null && (typeof r.threshold !== 'number' || r.threshold <= 0 || r.threshold > 1));
    check('threshold 都在 0-1 内', badThreshold.length === 0,
      badThreshold.map((r) => r.state).join(',') || '');

    const badRegion = projectRules.filter(
      (r) => r.region != null && (!Array.isArray(r.region) || r.region.length !== 4));
    check('region 格式为 [x,y,w,h]', badRegion.length === 0,
      badRegion.map((r) => r.state).join(',') || '');

    // 保命规则如果存在，必须排在前部（优先级高）
    const stopIdx = projectRules.findIndex((r) => r.action && r.action.type === 'stop');
    if (stopIdx < 0) {
      check('stop 规则（可选）', 'skip', '当前配置未使用 stop');
    } else {
      check('stop 规则排在前部（优先级高）', stopIdx <= 2,
        `第一个 stop 在第 ${stopIdx + 1} 条`);
    }

    // 每套副本至少有一条 isBattleEnd（用于统计场次）
    const noBattleEnd = dungeonList.filter(
      (d) => d.rules.length && !d.rules.some((r) => r.isBattleEnd === true));
    check('每套副本都有 isBattleEnd 规则', noBattleEnd.length === 0,
      noBattleEnd.map((d) => d.name).join(',') || '全部具备');
  }

  // ===== 2. stop 动作 =====
  console.log('\n[2] stop 动作（保命机制）');
  {
    const tmp = path.join(os.tmpdir(), 'omj-rules-stop-' + Date.now());
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'stop_btn.png'), 40, 20, checker(0));
    fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({
      rules: [{
        state: '体力不足', template: 'stop_btn.png', threshold: 0.8,
        action: { type: 'stop', reason: '测试停止' }, cooldownMs: 100,
      }],
    }), 'utf8');

    const logs = [];
    const r = new Runner({
      hwnd: 1, title: 't', params: {},
      log: (l, m) => logs.push(l + ': ' + m),
      appRoot: tmp, assetsDir: assets, inputBackend: 'none',
    });
    r.origin = { left: 0, top: 0 };
    r.roi = { x: 0, y: 0 };
    r.stats.frames = 1;
    r.running = true;
    r.startedAt = Date.now();

    const frame = makeFrame(300, 200, [{ x: 100, y: 100, w: 40, h: 20 }]);
    const d = r.evaluateFrame(frame);
    check('识别到 stop 规则', d !== null, d ? `${d.state} ${d.score.toFixed(4)}` : '未识别');

    if (d) {
      r.executeAction(d);
      check('触发了停止', r.stopping === true, `stopping=${r.stopping}`);
      check('日志含停止原因', logs.some((l) => l.indexOf('测试停止') >= 0),
        logs.filter((l) => l.indexOf('停止') >= 0).join(' | ') || '无');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 3. none 动作不点击 =====
  console.log('\n[3] none 动作不点击');
  {
    const tmp = path.join(os.tmpdir(), 'omj-rules-none-' + Date.now());
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'inbattle.png'), 40, 20, checker(1));
    fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({
      rules: [{
        state: '战斗中', template: 'inbattle.png', threshold: 0.8,
        action: { type: 'none' }, cooldownMs: 100,
      }],
    }), 'utf8');

    const taps = [];
    const logs = [];
    const r = new Runner({
      hwnd: 1, title: 't', params: {},
      log: (l, m) => logs.push(l + ': ' + m),
      appRoot: tmp, assetsDir: assets, inputBackend: 'none',
    });
    r.origin = { left: 0, top: 0 };
    r.roi = { x: 0, y: 0 };
    r.stats.frames = 1;
    r.input = { tap: (x, y) => { taps.push({ x, y }); return true; }, deviceSize: () => null, status: () => ({ backend: 'test' }) };
    r.inputBackend = 'win32';

    const frame = makeFrame(300, 200, [{ x: 50, y: 50, w: 40, h: 20 }]);
    const d = r.evaluateFrame(frame);
    check('识别到 none 规则', d !== null, d ? d.state : '未识别');
    if (d) {
      r.executeAction(d);
      check('没有产生点击', taps.length === 0, `${taps.length} 次点击`);
      check('日志说明了不执行动作', logs.some((l) => l.indexOf('不执行动作') >= 0));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 4. region 限制 =====
  console.log('\n[4] region 限制生效');
  {
    const tmp = path.join(os.tmpdir(), 'omj-rules-region-' + Date.now());
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'btn.png'), 40, 20, checker(2));
    // region 只覆盖左上角 (0,0,150,100)
    fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({
      rules: [{
        state: '限定区域', template: 'btn.png', threshold: 0.8,
        region: [0, 0, 150, 100], action: { type: 'tap' }, cooldownMs: 100,
      }],
    }), 'utf8');

    // 图样放在 region 之外 (200,150)
    const outside = makeFrame(400, 300, [{ x: 200, y: 150, w: 40, h: 20 }]);
    // 图样放在 region 之内 (40,40)
    const inside = makeFrame(400, 300, [{ x: 40, y: 40, w: 40, h: 20 }]);

    const mkRunner = () => {
      const r = new Runner({
        hwnd: 1, title: 't', params: {}, log: () => { },
        appRoot: tmp, assetsDir: assets, inputBackend: 'none',
      });
      r.origin = { left: 0, top: 0 };
      r.roi = { x: 0, y: 0 };
      r.stats.frames = 1;
      return r;
    };

    const dOut = mkRunner().evaluateFrame(outside);
    check('region 外的图样不命中', dOut === null, dOut ? '误命中 ' + dOut.state : '正确拒绝');

    const dIn = mkRunner().evaluateFrame(inside);
    check('region 内的图样命中', dIn !== null, dIn ? `${dIn.state} ${dIn.score.toFixed(3)}` : '未命中');
    if (dIn) {
      check('命中坐标在 region 内',
        dIn.contentX >= 0 && dIn.contentX <= 150 && dIn.contentY >= 0 && dIn.contentY <= 100,
        `(${dIn.contentX},${dIn.contentY})`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 5. isBattleEnd =====
  console.log('\n[5] isBattleEnd 传递');
  {
    const tmp = path.join(os.tmpdir(), 'omj-rules-end-' + Date.now());
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'confirm.png'), 40, 20, checker(3));
    fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({
      rules: [{
        state: '结算', template: 'confirm.png', threshold: 0.8,
        action: { type: 'tap' }, cooldownMs: 100, isBattleEnd: true,
      }],
    }), 'utf8');

    const r = new Runner({
      hwnd: 1, title: 't', params: {}, log: () => { },
      appRoot: tmp, assetsDir: assets, inputBackend: 'none',
    });
    r.origin = { left: 0, top: 0 };
    r.roi = { x: 0, y: 0 };
    r.stats.frames = 1;

    const d = r.evaluateFrame(makeFrame(300, 200, [{ x: 80, y: 60, w: 40, h: 20 }]));
    check('识别到结算规则', d !== null, d ? d.state : '未识别');
    check('isBattleEnd 传递为 true', d && d.isBattleEnd === true,
      d ? String(d.isBattleEnd) : '');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 6. 随机点击点（避免固定像素）=====
  console.log('\n[6] 随机点击点');
  {
    const mkRunner = (params) => new Runner({
      hwnd: 1, title: 't', params: params || {}, log: () => { },
      appRoot: os.tmpdir(), assetsDir: os.tmpdir(), inputBackend: 'none',
    });

    // 命中矩形：屏幕 (1000,500) 起，200x100
    const decision = {
      state: '测试', action: { type: 'tap' }, score: 0.99, isBattleEnd: false,
      screenX: 1100, screenY: 550,     // 中心
      contentX: 1100, contentY: 550,
      boxScreenX: 1000, boxScreenY: 500, boxW: 200, boxH: 100,
    };

    // jitter=0 → 必须等于中心
    const r0 = mkRunner({ clickJitter: 0 });
    const p0 = r0._pickClickPoint(decision);
    check('抖动为 0 时点击中心', p0.screenX === 1100 && p0.screenY === 550,
      `(${p0.screenX},${p0.screenY})`);

    // 默认抖动 → 点必须在矩形内，且多次不同
    const r1 = mkRunner({ clickJitter: 0.35 });
    const pts = [];
    for (let i = 0; i < 60; i++) pts.push(r1._pickClickPoint(decision));

    const inside = pts.every((p) =>
      p.screenX >= 1000 && p.screenX <= 1200 &&
      p.screenY >= 500 && p.screenY <= 600);
    check('所有点击点都在命中矩形内', inside,
      inside ? `60 个点全部在 1000-1200 x 500-600` : '有点越界');

    const uniqX = new Set(pts.map((p) => p.screenX));
    const uniqY = new Set(pts.map((p) => p.screenY));
    check('横坐标有变化', uniqX.size > 5, `${uniqX.size} 个不同值`);
    check('纵坐标有变化', uniqY.size > 5, `${uniqY.size} 个不同值`);
    check('不再是固定中心点', pts.some((p) => p.screenX !== 1100 || p.screenY !== 550));

    // 抖动越大分布越宽
    const r2 = mkRunner({ clickJitter: 0.9 });
    const pts2 = [];
    for (let i = 0; i < 60; i++) pts2.push(r2._pickClickPoint(decision));
    const spread1 = Math.max(...pts.map((p) => p.screenX)) - Math.min(...pts.map((p) => p.screenX));
    const spread2 = Math.max(...pts2.map((p) => p.screenX)) - Math.min(...pts2.map((p) => p.screenX));
    check('抖动越大分布越宽', spread2 > spread1, `抖动35%: ${spread1}px  抖动90%: ${spread2}px`);

    // contentX 应跟着屏幕点同步偏移（ADB 需要）
    const p = r1._pickClickPoint(decision);
    check('内容区坐标同步偏移',
      (p.contentX - 1100) === (p.screenX - 1100) && (p.contentY - 550) === (p.screenY - 550),
      `屏幕(${p.screenX},${p.screenY}) 内容(${p.contentX},${p.contentY})`);
  }

  // ===== 7. 点击结果校验（点击失败必须报错，不能静默）=====
  console.log('\n[7] 点击结果校验');
  {
    const tmp = path.join(os.tmpdir(), 'omj-rules-click-' + Date.now());
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'b.png'), 40, 20, checker(4));
    fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({
      rules: [{ state: '按钮', template: 'b.png', threshold: 0.8, action: { type: 'tap' }, cooldownMs: 50 }],
    }), 'utf8');

    const logs = [];
    const r = new Runner({
      hwnd: 1, title: 't', params: { clickJitter: 0 },
      log: (l, m) => logs.push(l + ': ' + m),
      appRoot: tmp, assetsDir: assets, inputBackend: 'none',
    });
    r.origin = { left: 0, top: 0 };
    r.roi = { x: 0, y: 0 };
    r.stats.frames = 1;
    r.inputBackend = 'win32';

    // 后端返回 ok:false（模拟系统拒收）
    let tapArgs = null;
    r.input = {
      tap: (x, y) => { tapArgs = { x, y }; return { ok: false, sent: 2, steps: [32769, 2] }; },
      lastTapInfo: () => ({ ok: false, error: '抬起事件未被接受' }),
      deviceSize: () => null,
      status: () => ({ backend: 'win32' }),
    };

    const d = r.evaluateFrame(makeFrame(300, 200, [{ x: 100, y: 80, w: 40, h: 20 }]));
    check('识别到点击规则', d !== null, d ? d.state : '未识别');
    if (d) {
      r.executeAction(d);
      check('点击被调用', tapArgs !== null, tapArgs ? `(${tapArgs.x},${tapArgs.y})` : '未调用');
      const errLog = logs.filter((l) => l.indexOf('未被系统接受') >= 0);
      check('点击未被接受时记录错误日志', errLog.length === 1,
        errLog[0] || '没有错误日志 ← 会让人以为游戏没反应');
      check('错误日志含已发送步数', errLog.length > 0 && errLog[0].indexOf('/3') >= 0,
        errLog[0] || '');
    }

    // 后端返回 ok:true → 记普通 info
    logs.length = 0;
    r.input = {
      tap: () => ({ ok: true, sent: 3, steps: [32769, 2, 4] }),
      lastTapInfo: () => ({ ok: true, error: '' }),
      deviceSize: () => null,
      status: () => ({ backend: 'win32' }),
    };
    r._cooldowns.clear();
    r.stats.frames = 2;
    const d2 = r.evaluateFrame(makeFrame(300, 200, [{ x: 100, y: 80, w: 40, h: 20 }]));
    if (d2) {
      r.executeAction(d2);
      const okLog = logs.filter((l) => l.indexOf('点击 [') >= 0);
      check('点击成功时记录 info 日志', okLog.length === 1, okLog[0] || '');
      check('成功时不应有错误日志',
        logs.filter((l) => l.indexOf('未被系统接受') >= 0).length === 0);
    }

    // ---- action.repeat：连点两下（「点击屏幕继续」用）----
    logs.length = 0;
    // 用非零抖动，才能验证「两次落点各不相同」
    r.params.clickJitter = 0.35;
    const taps = [];
    r.input = {
      tap: (x, y) => { taps.push({ x, y, t: Date.now() }); return { ok: true, sent: 3, steps: [] }; },
      lastTapInfo: () => ({ ok: true, error: '' }),
      deviceSize: () => null,
      status: () => ({ backend: 'win32' }),
    };
    r._cooldowns.clear();
    r.stats.frames = 3;
    const d3 = r.evaluateFrame(makeFrame(300, 200, [{ x: 100, y: 80, w: 40, h: 20 }]));
    if (d3) {
      // 直接改动作，模拟 json 里写了 repeat: 2
      d3.action = { type: 'tap', repeat: 2 };
      r.running = true;
      r.executeAction(d3);
      check('repeat=2 时点击两次', taps.length === 2, `${taps.length} 次`);
      if (taps.length === 2) {
        check('两次落点不完全相同（各自随机）',
          taps[0].x !== taps[1].x || taps[0].y !== taps[1].y,
          `(${taps[0].x},${taps[0].y}) vs (${taps[1].x},${taps[1].y})`);
        check('两次点击之间有间隔', taps[1].t - taps[0].t >= 100,
          `${taps[1].t - taps[0].t}ms`);
      }
      const repLogs = logs.filter((l) => l.indexOf('(1/2)') >= 0 || l.indexOf('(2/2)') >= 0);
      check('日志标出连点序号', repLogs.length === 2, `${repLogs.length} 条`);
    }

    // repeat 非法值应退化为 1 次
    taps.length = 0;
    r._cooldowns.clear();
    r.stats.frames = 4;
    const d4 = r.evaluateFrame(makeFrame(300, 200, [{ x: 100, y: 80, w: 40, h: 20 }]));
    if (d4) {
      d4.action = { type: 'tap', repeat: 0 };
      r.executeAction(d4);
      check('repeat=0 退化为 1 次', taps.length === 1, `${taps.length} 次`);
    }
    taps.length = 0;
    r._cooldowns.clear();
    r.stats.frames = 5;
    const d5 = r.evaluateFrame(makeFrame(300, 200, [{ x: 100, y: 80, w: 40, h: 20 }]));
    if (d5) {
      d5.action = { type: 'tap', repeat: 99 };
      r.executeAction(d5);
      check('repeat 有上限（不超过 5 次）', taps.length === 5, `${taps.length} 次`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 8. 概率触发与随机间隔（真实跑循环）=====
  console.log('\n[8] 概率触发与随机间隔');
  {
    const capture = require('./lib/capture');
    const native = require('./lib/native');

    // 用桩替换截图和窗口检查，这样可以在没有真实游戏窗口的情况下跑循环
    const origGrab = capture.grabContent;
    const origIsWindow = native.isWindow;

    const W = 300, H = 200;
    const frame = makeFrame(W, H, [{ x: 100, y: 80, w: 40, h: 20 }]);
    capture.grabContent = () => ({
      frame,
      roi: { x: 0, y: 0, width: W, height: H },
      fullSize: { width: W, height: H },
      windowOrigin: { left: 0, top: 0 },
      method: 'stub',
    });
    native.isWindow = () => true;

    const tmp = path.join(os.tmpdir(), 'omj-rules-prob-' + Date.now());
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'btn.png'), 40, 20, checker(5));
    fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({
      rules: [{
        state: '按钮', template: 'btn.png', threshold: 0.8,
        action: { type: 'tap' }, cooldownMs: 0,
      }],
    }), 'utf8');

    const runFor = async (params, ms) => {
      const taps = [];
      const r = new Runner({
        hwnd: 1, title: 't', params,
        log: () => {}, appRoot: tmp, assetsDir: assets, inputBackend: 'none',
      });
      r.origin = { left: 0, top: 0 };
      r.roi = { x: 0, y: 0 };
      r.inputBackend = 'win32';
      r.input = {
        tap: (x, y) => { taps.push({ x, y, t: Date.now() }); return { ok: true, sent: 3, steps: [] }; },
        lastTapInfo: () => ({ ok: true, error: '' }),
        deviceSize: () => null,
        status: () => ({ backend: 'win32' }),
      };
      r.running = true;
      r.stopping = false;
      r.startedAt = Date.now();
      r.stats = { actions: 0, battles: 0, frames: 0, errors: 0, skipped: 0, lastError: '', fps: 0, state: '运行中' };
      const p = r._loop();
      await new Promise((res) => setTimeout(res, ms));
      r.stopping = true;
      await p;
      return { taps, stats: r.stats };
    };

    // 概率 0：命中也绝不点击
    const zero = await runFor({ actionInterval: 0.12, clickJitter: 0.35, triggerChance: 0 }, 1500);
    check('触发概率 0% 时一次都不点', zero.taps.length === 0, `${zero.taps.length} 次点击`);
    check('概率跳过被统计', (zero.stats.skipped || 0) > 0, `skipped=${zero.stats.skipped}`);
    check('跳过时不计入 actions', zero.stats.actions === 0, `actions=${zero.stats.actions}`);

    // 概率 1：每轮都点（跑久一点，攒够样本验证间隔随机性）
    // 注意 cooldownMs:0 现在真的等于"无冷却"（之前被 || 吞成 800ms）
    const one = await runFor(
      { actionInterval: 0.2, actionIntervalMax: 0.6, clickJitter: 0.35, triggerChance: 1 }, 2600);
    check('触发概率 100% 时会点击', one.taps.length > 0, `${one.taps.length} 次点击`);
    check('全部点击都被计入 actions', one.stats.actions === one.taps.length,
      `actions=${one.stats.actions} taps=${one.taps.length}`);

    // 点击点各不相同（随机）
    const uniq = new Set(one.taps.map((t) => t.x + ',' + t.y));
    check('多次点击落在不同像素', uniq.size > 1, `${uniq.size} 个不同点 / ${one.taps.length} 次`);

    // 随机间隔：点击时间差不应全部相同
    if (one.taps.length >= 3) {
      const gaps = [];
      for (let i = 1; i < one.taps.length; i++) gaps.push(one.taps[i].t - one.taps[i - 1].t);
      const uniqGap = new Set(gaps.map((g) => Math.round(g / 50))); // 50ms 粒度归类
      check('点击间隔有随机性（非固定）', uniqGap.size > 1,
        `间隔: ${gaps.join(', ')}ms`);
    } else {
      check('点击间隔有随机性（非固定）', false, `样本不足（只有 ${one.taps.length} 次点击）`);
    }

    // 最短=最长时退化为固定间隔（但仍可运行）
    const fixed = await runFor({ actionInterval: 0.2, actionIntervalMax: 0, triggerChance: 1 }, 900);
    check('最长间隔为 0 时退化为固定间隔且能运行', fixed.taps.length > 0, `${fixed.taps.length} 次`);

    capture.grabContent = origGrab;
    native.isWindow = origIsWindow;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 9. 无匹配时的日志（避免「看起来卡死」）=====
  console.log('\n[9] 等待日志与步骤日志');
  {
    const capture = require('./lib/capture');
    const native = require('./lib/native');
    const origGrab = capture.grabContent;
    const origIsWindow = native.isWindow;

    const W = 300, H = 200;
    const matchFrame = makeFrame(W, H, [{ x: 100, y: 80, w: 40, h: 20 }]);
    const blankFrame = makeFrame(W, H, []);   // 没有任何特征块

    const tmp = path.join(os.tmpdir(), 'omj-wait-' + Date.now());
    const assets = path.join(tmp, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    writePng(path.join(assets, 'btn.png'), 40, 20, checker(6));
    fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({
      rules: [{
        state: '我的按钮', template: 'btn.png', threshold: 0.8,
        action: { type: 'none' }, cooldownMs: 0,
      }],
    }), 'utf8');

    native.isWindow = () => true;

    const mkRunner = (logs, params) => {
      const r = new Runner({
        hwnd: 1, title: 't', params: params || {},
        log: (l, m) => logs.push(l + ': ' + m),
        appRoot: tmp, assetsDir: assets, inputBackend: 'none',
      });
      r.origin = { left: 0, top: 0 };
      r.roi = { x: 0, y: 0 };
      return r;
    };

    // --- 情况 A：一直没匹配上 → 必须打出「等待中」和「正在等」 ---
    capture.grabContent = () => ({
      frame: blankFrame,
      roi: { x: 0, y: 0, width: W, height: H },
      fullSize: { width: W, height: H },
      windowOrigin: { left: 0, top: 0 },
      method: 'stub',
    });
    {
      const logs = [];
      const r = mkRunner(logs, { actionInterval: 0.2 });
      r.running = true; r.stopping = false; r.startedAt = Date.now();
      r.stats = { actions: 0, battles: 0, frames: 0, errors: 0, skipped: 0, lastError: '', fps: 0, state: 'x' };
      const p = r._loop();
      await new Promise((res) => setTimeout(res, 2200));
      r.stopping = true;
      await p;

      const waited = logs.filter((l) => l.indexOf('等待中') >= 0);
      check('无匹配时打出「等待中」日志', waited.length >= 1, waited[0] || '没有');
      const listLog = logs.filter((l) => l.indexOf('正在等这些画面') >= 0);
      check('列出了正在等哪些画面', listLog.length >= 1, listLog[0] || '没有');
      check('等待日志带帧数与时长', waited.length > 0 && /连续 \d+ 帧/.test(waited[0]),
        waited[0] || '');
      check('状态标记为 waiting', r.stats.waiting === true, String(r.stats.waiting));
      check('「等待中」不刷屏（只出现一次）', waited.length === 1, `${waited.length} 次`);
    }

    // --- 情况 B：匹配到 → 打「步骤」日志 ---
    capture.grabContent = () => ({
      frame: matchFrame,
      roi: { x: 0, y: 0, width: W, height: H },
      fullSize: { width: W, height: H },
      windowOrigin: { left: 0, top: 0 },
      method: 'stub',
    });
    {
      const logs = [];
      const r = mkRunner(logs, { actionInterval: 0.2, dryRun: true });
      r.running = true; r.stopping = false; r.startedAt = Date.now();
      r.stats = { actions: 0, battles: 0, frames: 0, errors: 0, skipped: 0, lastError: '', fps: 0, state: 'x' };
      const p = r._loop();
      await new Promise((res) => setTimeout(res, 1400));
      r.stopping = true;
      await p;

      const stepLogs = logs.filter((l) => l.indexOf('步骤:') >= 0);
      check('匹配到后打出「步骤: X」日志', stepLogs.length >= 1, stepLogs[0] || '没有');
      check('步骤名正确', stepLogs.length > 0 && stepLogs[0].indexOf('我的按钮') >= 0,
        stepLogs[0] || '');
      check('步骤日志不刷屏（同一步骤只打一次）', stepLogs.length === 1, `${stepLogs.length} 次`);
      check('匹配后 waiting 复位', r.stats.waiting === false, String(r.stats.waiting));
    }

    capture.grabContent = origGrab;
    native.isWindow = origIsWindow;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 汇总 =====
  console.log('\n' + '='.repeat(66));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  if (failures.length) {
    console.log('\n  失败项：');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(66));
  return fail === 0 ? 0 : 1;
}

// test-rules.js 的 main 现在是异步的（第 8 节要真的跑循环）
main().then((code) => process.exit(code)).catch((err) => {
  console.error('测试异常:', err && err.stack ? err.stack : err);
  process.exit(1);
});
