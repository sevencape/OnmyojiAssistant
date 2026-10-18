/**
 * 副本配置体系测试
 *
 * 目标：锁死「加一套新副本 = 丢一个 json + 素材」这个契约。
 *   - 能扫描到 config/dungeons/ 下所有 json
 *   - 排序按 order
 *   - 素材缺失能被检出（而不是运行时才发现）
 *   - 单个 json 坏了不影响其它副本
 *   - 规则默认值/注释字段处理正确
 *   - 项目自带的 4 套配置都完整可用
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dungeons = require('./lib/dungeons');
const paths = require('./lib/paths');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  [ OK ] ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ' ' + detail : '')); console.log(`  [FAIL] ${name}${detail ? '  -> ' + detail : ''}`); }
}

function writePng(file, w, h) {
  // 最小合法 PNG（1x1 就够，测试只关心文件存在性）
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
}

function main() {
  console.log('='.repeat(66));
  console.log('  副本配置体系测试');
  console.log('='.repeat(66));

  // ===== 1. 项目自带的配置 =====
  console.log('\n[1] 项目自带配置');
  const configDir = paths.resolveConfigDir();
  const dungeonsDir = paths.dungeonsDirFor(configDir);
  const assetsDir = paths.assetsDirFor(configDir);

  check('配置目录存在', fs.existsSync(configDir), configDir);
  check('dungeons 目录存在', fs.existsSync(dungeonsDir), dungeonsDir);
  check('assets 目录存在', fs.existsSync(assetsDir), assetsDir);

  const list = dungeons.listDungeons(dungeonsDir, assetsDir);
  check('能列出副本配置', list.length >= 4, `${list.length} 种`);
  check('没有任何配置错误', list.every((d) => !d.error),
    list.filter((d) => d.error).map((d) => `${d.id}:${d.error}`).join(',') || '无');

  const byId = {};
  for (const d of list) byId[d.id] = d;

  for (const id of ['soul', 'awaken', 'evolve', 'common']) {
    const d = byId[id];
    check(`存在副本「${id}」`, !!d, d ? d.name : '缺失');
    if (!d) continue;
    check(`「${d.name}」素材齐全`, d.missingAssets.length === 0,
      d.missingAssets.join(',') || `${d.rules.length} 条规则全部就位`);
    check(`「${d.name}」有规则`, d.rules.length > 0, `${d.rules.length} 条`);
    check(`「${d.name}」每条规则都有 template`,
      d.rules.every((r) => r.template), '');
    check(`「${d.name}」有战斗结束标记`,
      d.rules.some((r) => r.isBattleEnd === true));
  }

  check('通用副本不含探索入口',
    byId.common && byId.common.rules.every((r) => r.template !== 'explore.png'),
    byId.common ? byId.common.rules.map((r) => r.template).join(',') : '');
  check('御魂/觉醒/御灵 都含探索入口',
    ['soul', 'awaken', 'evolve'].every(
      (id) => byId[id] && byId[id].rules.some((r) => r.template === 'explore.png')));

  // 排序：order 小的在前
  const orders = list.map((d) => d.order);
  check('按 order 升序排列',
    orders.every((v, i) => i === 0 || orders[i - 1] <= v),
    orders.join(','));

  // ===== 2. 规则归一化 =====
  console.log('\n[2] 规则归一化');
  const norm = dungeons.normalizeRules([
    { state: 'A', template: 'a.png', _注释: '这行应该被丢掉' },
    { state: 'B', template: 'b.png', threshold: 0.9, cooldownMs: 0, action: { type: 'none' } },
  ]);
  check('注释字段（_ 开头）被剔除', !('_注释' in norm[0]), Object.keys(norm[0]).join(','));
  check('补上默认 threshold', norm[0].threshold === dungeons.DEFAULT_THRESHOLD, String(norm[0].threshold));
  check('补上默认 cooldownMs', norm[0].cooldownMs === dungeons.DEFAULT_COOLDOWN, String(norm[0].cooldownMs));
  check('补上默认 action=tap', norm[0].action && norm[0].action.type === 'tap');
  check('显式值不被覆盖',
    norm[1].threshold === 0.9 && norm[1].cooldownMs === 0 && norm[1].action.type === 'none',
    `${norm[1].threshold}/${norm[1].cooldownMs}/${norm[1].action.type}`);

  // ===== 3. 临时目录：加一套新副本 =====
  console.log('\n[3] 新增一套副本（模拟用户操作）');
  {
    const tmp = path.join(os.tmpdir(), 'omj-dg-' + Date.now());
    const dd = path.join(tmp, 'dungeons');
    const ad = path.join(tmp, 'assets');
    fs.mkdirSync(dd, { recursive: true });
    fs.mkdirSync(ad, { recursive: true });
    writePng(path.join(ad, 'mybtn.png'), 1, 1);

    fs.writeFileSync(path.join(dd, 'myrun.json'), JSON.stringify({
      id: 'myrun',
      name: '我的副本',
      order: 5,
      description: '测试用',
      rules: [{ state: '点我', template: 'mybtn.png', threshold: 0.8 }],
    }), 'utf8');

    const l = dungeons.listDungeons(dd, ad);
    check('新副本能被发现', l.length === 1 && l[0].id === 'myrun', l.map((x) => x.id).join(','));
    check('名称/描述读到', l[0].name === '我的副本' && l[0].description === '测试用');
    check('素材校验通过', l[0].missingAssets.length === 0);
    check('按文件名/order 排序生效', l[0].order === 5);

    // 缺素材要能检出
    fs.writeFileSync(path.join(dd, 'broken2.json'), JSON.stringify({
      id: 'broken2', name: '缺素材', rules: [{ state: 'x', template: 'nope.png' }],
    }), 'utf8');
    const l2 = dungeons.listDungeons(dd, ad);
    const b2 = l2.find((x) => x.id === 'broken2');
    check('缺失素材被检出', b2 && b2.missingAssets.indexOf('nope.png') >= 0,
      b2 ? b2.missingAssets.join(',') : '');

    // 坏 JSON 不影响其它
    fs.writeFileSync(path.join(dd, 'bad.json'), '{ 这不是 json', 'utf8');
    const l3 = dungeons.listDungeons(dd, ad);
    check('坏 JSON 被标记但不影响其它', l3.length === 3 && l3.some((x) => x.error),
      l3.map((x) => x.id + (x.error ? '(错)' : '')).join(','));

    // 非法 id
    fs.writeFileSync(path.join(dd, 'evil.json'), JSON.stringify({
      id: '../evil', name: '非法', rules: [],
    }), 'utf8');
    const l4 = dungeons.listDungeons(dd, ad);
    const evil = l4.find((x) => x.id === '../evil');
    check('非法 id 被标记', evil && !!evil.error, evil ? evil.error : '');

    // loadDungeon 单独取
    const one = dungeons.loadDungeon(dd, 'myrun', ad);
    check('loadDungeon 能按 id 取到', one && one.id === 'myrun', one ? one.name : 'null');
    check('loadDungeon 不存在的 id 返回 null', dungeons.loadDungeon(dd, 'nope', ad) === null);

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 4. 空目录不炸 =====
  console.log('\n[4] 边界情况');
  {
    const empty = path.join(os.tmpdir(), 'omj-dg-empty-' + Date.now());
    fs.mkdirSync(empty, { recursive: true });
    check('dungeons 目录为空时返回空数组',
      Array.isArray(dungeons.listDungeons(empty, null)) &&
      dungeons.listDungeons(empty, null).length === 0);
    check('目录不存在时返回空数组',
      dungeons.listDungeons(path.join(empty, 'nope'), null).length === 0);
    fs.rmSync(empty, { recursive: true, force: true });
  }

  // ===== 5. 屏幕/缩放配置 =====
  console.log('\n[5] 屏幕缩放配置（窗口改大小后的救命功能）');
  {
    // 项目自带配置
    const sc = dungeons.loadScreenConfig(configDir);
    check('读到项目 screen.json', !!sc.file && fs.existsSync(sc.file), sc.file || '');
    check('referenceWidth 合理', sc.referenceWidth > 100, String(sc.referenceWidth));
    check('autoScale 默认开启', sc.autoScale === true, String(sc.autoScale));

    // 读取计算属性
    const tmp = path.join(os.tmpdir(), 'omj-screen-' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });

    fs.writeFileSync(path.join(tmp, 'screen.json'), JSON.stringify({
      referenceWidth: 1728, referenceHeight: 1019, autoScale: false, warnDeviation: 0.05,
    }), 'utf8');
    const c1 = dungeons.loadScreenConfig(tmp);
    check('能读到自定义 referenceWidth', c1.referenceWidth === 1728, String(c1.referenceWidth));
    check('autoScale=false 生效', c1.autoScale === false);
    check('warnDeviation 生效', c1.warnDeviation === 0.05, String(c1.warnDeviation));

    // 缺文件 → 默认值（删了也能跑）
    const c2 = dungeons.loadScreenConfig(path.join(tmp, 'nope'));
    check('缺 screen.json 时回退默认值',
      c2.referenceWidth === 1718 && c2.autoScale === true, JSON.stringify(c2));

    // 坏 JSON → 默认值
    fs.writeFileSync(path.join(tmp, 'screen.json'), '{ 坏掉了', 'utf8');
    const c3 = dungeons.loadScreenConfig(tmp);
    check('坏 screen.json 时回退默认值', c3.referenceWidth === 1718);

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ===== 6. 缩放比计算 =====
  console.log('\n[6] 缩放比换算');
  {
    const ref = 1718;
    const cases = [
      { w: 1718, expect: 1.0, desc: '同尺寸' },
      { w: 1501, expect: 0.8737, desc: '窗口被调小 12.6%' },
      { w: 1920, expect: 1.1176, desc: '窗口被放大' },
    ];
    for (const c of cases) {
      const s = c.w / ref;
      const ok = Math.abs(s - c.expect) < 0.002;
      check(`${c.desc}: 内容 ${c.w} → 缩放 ${s.toFixed(3)}`, ok, `期望 ${c.expect}`);
    }
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
