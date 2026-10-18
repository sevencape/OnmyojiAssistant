/**
 * 统一的「数据目录」解析 —— assets/ 和 rules.json 都放在这里
 *
 * ── 为什么需要这个模块 ──
 * 之前标定保存和运行加载**各自算各自的根目录**，导致线上事故：
 *
 *   标定保存：__dirname 在 resources/app.asar/lib，
 *             path.join(__dirname, '..', '..') → resources/
 *             → 素材写到 resources/assets，规则写到 resources/rules.json
 *
 *   运行加载：appRoot 启发式优先命中硬编码的 F:\WorkSpace\onmyoji-bot
 *             → 素材读 onmyoji-bot/assets，规则读 onmyoji-bot/rules.json
 *
 *   结果：用户标定的 3 个素材**完全没被加载**，程序报「12 个素材缺失」，
 *   因为读到的是项目里那份开发用的 12 条规则。
 *
 * 修复思路：只保留**一个**数据根目录，保存和加载都必须用它。
 *
 * ── 数据根目录优先级 ──
 *   1. 显式传入的 dataRoot（测试用）
 *   2. 环境变量 OMJ_DATA
 *   3. 打包后：
 *      a. exe 旁边有 portable.txt → exe 目录（便携模式）
 *      b. 否则 → %APPDATA%\OnmyojiAssistant\data
 *         （用 data 子目录隔开 Chromium 缓存，用户打开目录时只看得到素材和规则）
 *   4. 开发态：项目根目录（含 rules.json 和 assets/ 的那层）
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 进程内缓存，避免每次构造 Runner 都去做写入探测 */
let cachedRoot = null;

/** 目录是否可写（建目录 + 写探测文件 + 删除） */
function isWritableDir(dir) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.omj-write-probe-' + process.pid);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    return false;
  }
}

/** 是否运行在打包后的环境 */
function isPackaged() {
  // 最可靠的信号：代码在被 asar 打包的路径里
  if (__dirname.indexOf('app.asar') >= 0) return true;
  try {
    const { app } = require('electron');
    if (app && typeof app.isPackaged === 'boolean') return app.isPackaged;
  } catch (err) { /* 纯 node 环境没有 electron */ }
  return false;
}

/** 可执行文件所在目录 */
function exeDir() {
  try {
    return path.dirname(process.execPath);
  } catch (err) {
    return null;
  }
}

/** 开发态项目根目录：lib/paths.js → app/lib → app → 项目根 */
function devProjectRoot() {
  return path.resolve(__dirname, '..', '..');
}

/** Electron 的 userData 目录 */
function userDataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (err) { /* ignore */ }
  return null;
}

/**
 * 解析数据根目录（assets/ 与 rules.json 的共同父目录）。
 * @param {{dataRoot?:string}} [opts]
 * @returns {string}
 */
function resolveDataRoot(opts) {
  opts = opts || {};

  // 显式指定优先，且不缓存（测试会在同一进程里用不同目录）
  if (opts.dataRoot) return path.resolve(opts.dataRoot);
  if (process.env.OMJ_DATA) return path.resolve(process.env.OMJ_DATA);

  if (cachedRoot) return cachedRoot;

  let root;
  if (isPackaged()) {
    root = packagedDataRoot();
  } else {
    // 开发态用项目根目录（源码和 rules.json 在一起，方便调试）
    root = devProjectRoot();
  }

  cachedRoot = root;

  // 打包后首次运行：铺一份空规则 + assets 目录
  if (isPackaged()) {
    try { ensureDefaultRules(root); } catch (err) { /* 不致命 */ }
  }

  return root;
}

/**
 * 打包后的数据根目录 = **exe 所在目录**（安装目录）。
 *
 * ★ 为什么改成安装目录（需求变更）：
 *   用户要把 config（素材 + 副本流程 json）直接放在安装目录里，
 *   这样整个文件夹打包发别人就能直接用 —— 配置和程序在一起，开箱即改。
 *
 *   代价：`electron-builder` 重新打包会清空 win-unpacked，所以**配置的母本**
 *   放在仓库的 `<项目>/config/`，构建时由 electron-builder 的 extraFiles 复制过来。
 *   改配置要改仓库里那份（否则下次构建会被覆盖）。
 *
 * 如果安装目录不可写（例如装在 Program Files），退到 userData。
 */
function packagedDataRoot() {
  const ed = exeDir();
  if (ed && isWritableDir(ed)) return ed;

  const ud = userDataDir();
  if (ud) {
    try { fs.mkdirSync(ud, { recursive: true }); } catch (err) { /* ignore */ }
    return ud;
  }
  return ed || process.cwd();
}

/**
 * 配置根目录（放 dungeons/ 和 assets/）。
 *
 *   打包后：<exe 所在目录>/config
 *   开发态：<项目根>/config
 *
 * 可用环境变量 OMJ_CONFIG 覆盖（测试/多套配置切换）。
 */
function resolveConfigDir(opts) {
  const o = opts || {};
  if (o.configDir) return path.resolve(o.configDir);
  if (process.env.OMJ_CONFIG) return path.resolve(process.env.OMJ_CONFIG);
  if (isPackaged()) {
    const ed = exeDir();
    if (ed) return path.join(ed, 'config');
  }
  return path.join(devProjectRoot(), 'config');
}

/**
 * 打包后首次运行时，如果数据目录里还没有 rules.json，
 * 就放一份空规则（而不是让用户面对一份可能不匹配的示例规则）。
 *
 * 为什么不是铺完整示例：示例里的 12 条规则都引用不存在的素材，
 * 运行时会刷 12 条「素材缺失」告警，反而让人困惑。
 * 需要示例的用户可以看 README 或 assets/rules.example.json。
 */
function ensureDefaultRules(dataRoot) {
  const rulesPath = path.join(dataRoot, 'rules.json');
  if (fs.existsSync(rulesPath)) return;

  fs.writeFileSync(rulesPath, JSON.stringify({
    _说明: '规则文件。用程序里的「素材标定」自动生成，或手动编辑。每条规则需要 app 同目录下 assets/ 里的素材 PNG。',
    _示例: {
      state: '开始战斗',
      template: 'btn_start_battle.png',
      threshold: 0.86,
      region: [515, 730, 690, 250],
      action: { type: 'tap' },
      cooldownMs: 2000,
    },
    rules: [],
  }, null, 2), 'utf8');

  // 顺带建 assets 目录，省得用户自己建
  try { fs.mkdirSync(path.join(dataRoot, 'assets'), { recursive: true }); } catch (err) { /* ignore */ }
}

/** 素材目录（config/assets） */
function assetsDirFor(root) {
  return path.join(root, 'assets');
}

/** 规则文件路径 */
function rulesPathFor(root) {
  return path.join(root, 'rules.json');
}

/** 副本配置目录（config/dungeons） */
function dungeonsDirFor(configDir) {
  return path.join(configDir, 'dungeons');
}

/** 清掉缓存（测试用） */
function _resetCache() {
  cachedRoot = null;
}

// ---------------------------------------------------------------- 素材名规范化
//
// 用户很自然会带扩展名输入（btn_start_battle.png），或者手工编辑 rules.json 时
// 只写名字不带扩展名。这两种都不能让程序找不到文件。
//
// 早期这里直接**拒绝**带点的名字（「含非法字符，已跳过」），
// 用户看到素材没保存却不知道为什么；而手工编辑 rules.json 时又可能写成
// btn_start_battle.png.png 之类的双重扩展名。
// 现在统一：去掉尾部所有 .png，再决定落盘/查找用的文件名。

/**
 * 规范化素材基名：去掉首尾空白和尾部的 .png（可重复出现）。
 * @param {string} name
 * @returns {string} 不含扩展名的基名
 */
function normalizeAssetName(name) {
  let s = String(name == null ? '' : name).trim();
  if (!s) return '';
  // 循环去掉多重 .png（btn_x.png.png → btn_x）
  while (/\.png$/i.test(s)) s = s.slice(0, -4).trim();
  return s;
}

/** 由任意写法得到标准文件名（基名 + .png） */
function pngFileName(name) {
  const base = normalizeAssetName(name);
  return base ? base + '.png' : '';
}

/**
 * 在素材目录里找到规则真正该用的文件名。
 * 容忍：缺扩展名、多扩展名、大小写不一致。
 *
 * @param {string} assetsDir
 * @param {string} template  规则里写的 template
 * @returns {string|null} 磁盘上实际存在的文件名；找不到返回 null
 */
function resolveActualTemplate(assetsDir, template) {
  const raw = String(template == null ? '' : template).trim();
  if (!raw) return null;

  let files;
  try {
    files = fs.readdirSync(assetsDir);
  } catch (err) {
    return null;
  }

  // 1. 原样匹配（最常见）
  if (files.indexOf(raw) >= 0) return raw;

  // 2. 规范成 base.png 再匹配
  const canon = pngFileName(raw);
  if (canon && files.indexOf(canon) >= 0) return canon;

  // 3. 大小写不敏感匹配
  const lower = canon.toLowerCase();
  const ci = files.find((f) => f.toLowerCase() === lower);
  if (ci) return ci;

  return null;
}

module.exports = {
  resolveDataRoot,
  resolveConfigDir,
  packagedDataRoot,
  isPackaged,
  exeDir,
  devProjectRoot,
  userDataDir,
  isWritableDir,
  assetsDirFor,
  rulesPathFor,
  dungeonsDirFor,
  ensureDefaultRules,
  normalizeAssetName,
  pngFileName,
  resolveActualTemplate,
  _resetCache,
};
