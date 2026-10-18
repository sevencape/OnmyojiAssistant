/**
 * 副本流程配置加载
 *
 * ── 设计目标 ──
 * 让「加一套新副本流程」变成纯配置工作：往 config/dungeons/ 里放一个 json，
 * 把对应的素材 png 放进 config/assets/，重启程序就能在「副本类型」下拉栏里选到。
 * 不需要改代码、不需要重新打包。
 *
 * ── 目录结构 ──
 *   <安装目录>/config/
 *   ├── dungeons/
 *   │   ├── soul.json      ← 一个 json = 一种副本类型
 *   │   ├── awaken.json
 *   │   ├── evolve.json
 *   │   └── common.json
 *   └── assets/            ← 所有素材 png，多个副本可共用
 *       └── *.png
 *
 * ── 单个副本 json 的字段 ──
 *   id          必填，英文/数字/下划线，作为内部标识（也用于日志）
 *   name        必填，显示在「副本类型」下拉栏里的名字
 *   description 可选，显示在名字下方的说明
 *   order       可选，下拉栏排序（小的在前，默认 100）
 *   rules       必填，规则数组，**顺序即优先级**，命中第一条就执行
 *
 * ── 单条规则字段 ──
 *   state       必填，状态名（日志里显示）
 *   template    必填，assets/ 下的 png 文件名
 *   threshold   可选，0-1，默认 0.86
 *   region      可选，[x,y,w,h] 内容区坐标，限定搜索范围
 *   action      可选，{type:'tap'|'none'|'stop'}，默认 tap
 *   cooldownMs  可选，命中后多少毫秒内不再重复命中，默认 800
 *   isBattleEnd 可选，true 表示这条命中代表一场战斗结束（用于统计场次）
 *   以 _ 开头的字段会被忽略，可以当注释写
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD = 0.86;
const DEFAULT_COOLDOWN = 800;

/** 副本 id 允许的字符：避免路径穿越和奇怪字符 */
const ID_RE = /^[\w-]+$/;

/**
 * 列出所有副本配置。
 *
 * 单个文件坏了不会影响其它副本 —— 返回结果里带 error 字段，
 * 界面上可以把这条显示成「配置有误」，而不是整个下拉栏空掉。
 *
 * @param {string} dungeonsDir
 * @param {string} [assetsDir] 传入则会校验素材是否齐全
 * @returns {Array<{id:string,name:string,description:string,order:number,
 *                  rules:Array,file:string,missingAssets:string[],error?:string}>}
 */
function listDungeons(dungeonsDir, assetsDir) {
  let files = [];
  try {
    files = fs.readdirSync(dungeonsDir).filter((f) => /\.json$/i.test(f));
  } catch (err) {
    return [];
  }

  let assets = null;
  if (assetsDir) {
    try { assets = fs.readdirSync(assetsDir); } catch (err) { assets = null; }
  }

  const out = [];
  for (const file of files) {
    const full = path.join(dungeonsDir, file);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      out.push({
        id: path.basename(file, '.json'),
        name: path.basename(file, '.json') + '（配置有误）',
        description: 'JSON 解析失败: ' + err.message,
        order: 999,
        rules: [],
        file: full,
        missingAssets: [],
        error: 'JSON 解析失败: ' + err.message,
      });
      continue;
    }

    const id = String(doc.id || path.basename(file, '.json')).trim();
    const name = String(doc.name || id).trim();
    const rules = Array.isArray(doc.rules) ? doc.rules : [];

    // 素材校验：把缺失的模板名收集起来，界面/自检里能直接看到要补哪张图
    let missing = [];
    if (assets) {
      const seen = new Set();
      for (const r of rules) {
        const t = r && r.template;
        if (!t || seen.has(t)) continue;
        seen.add(t);
        if (assets.indexOf(t) < 0) missing.push(t);
      }
    }

    out.push({
      id,
      name,
      description: String(doc.description || ''),
      order: Number.isFinite(Number(doc.order)) ? Number(doc.order) : 100,
      rules: normalizeRules(rules),
      ruleCount: rules.length,
      file: full,
      missingAssets: missing,
      error: !ID_RE.test(id) ? `id「${id}」只能用字母数字下划线横线` : undefined,
    });
  }

  // 排序：order 小的在前，同 order 按名字
  out.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
  return out;
}

/** 取单个副本；找不到返回 null */
function loadDungeon(dungeonsDir, id, assetsDir) {
  const all = listDungeons(dungeonsDir, assetsDir);
  return all.find((d) => d.id === id) || null;
}

/**
 * 规则归一化：补默认值、剔除以 _ 开头的注释字段。
 * 保留 _ 开头的键其实无害（runner 只读已知字段），这里清掉是为了日志干净。
 */
function normalizeRules(rules) {
  return rules.map((r) => {
    const clean = {};
    for (const k of Object.keys(r || {})) {
      if (k.charAt(0) === '_') continue;
      clean[k] = r[k];
    }
    if (!clean.action) clean.action = { type: 'tap' };
    if (clean.threshold == null) clean.threshold = DEFAULT_THRESHOLD;
    if (clean.cooldownMs == null) clean.cooldownMs = DEFAULT_COOLDOWN;
    return clean;
  });
}

/**
 * 读取屏幕/缩放配置（config/screen.json）。
 *
 * 素材是按某个固定窗口尺寸裁的；窗口改尺寸后，模板匹配会因为**缩放**而全面失效
 * （实测缩 5% 分数就从 1.0 掉到 0.6，缩 12% 直接 0）。
 * 这里提供的 referenceWidth 用来把素材按比例缩放到当前窗口尺寸。
 *
 * 文件不存在时返回默认值（referenceWidth=1718, autoScale=true），
 * 这样删了配置也能跑。
 */
function loadScreenConfig(configDir) {
  const defaults = {
    referenceWidth: 1718,
    referenceHeight: 1019,
    autoScale: true,
    warnDeviation: 0.02,
  };
  if (!configDir) return defaults;

  const file = path.join(configDir, 'screen.json');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return defaults;
  }

  const rw = Number(doc.referenceWidth);
  const rh = Number(doc.referenceHeight);
  const wd = Number(doc.warnDeviation);
  return {
    referenceWidth: Number.isFinite(rw) && rw > 100 ? rw : defaults.referenceWidth,
    referenceHeight: Number.isFinite(rh) && rh > 100 ? rh : defaults.referenceHeight,
    autoScale: doc.autoScale !== false,
    warnDeviation: Number.isFinite(wd) && wd >= 0 ? wd : defaults.warnDeviation,
    file,
  };
}

module.exports = {
  listDungeons,
  loadDungeon,
  loadScreenConfig,
  normalizeRules,
  DEFAULT_THRESHOLD,
  DEFAULT_COOLDOWN,
};
