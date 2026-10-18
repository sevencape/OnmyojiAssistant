/**
 * 纯文件操作的手动打包器（不 spawn 任何子进程）
 *
 * ── 为什么需要它 ──
 * 标准的 `electron-builder` 必须 spawn 子进程（收集 node_modules 信息、调用 npm），
 * 而 DSH 的受限沙箱**禁止 spawn**（`EPERM: syscall 'spawn'`）。
 * 所以约束模式下 electron-builder 跑不起来。
 *
 * 这个脚本只用 fs 的复制/删除操作，把 Electron 运行时和我们的 app 拼成一个
 * 可直接运行的目录 —— 也就是 electron-builder `--dir` 模式的等价产物。
 *
 * ── 产物结构 ──
 *   dist/manual-unpacked/
 *   ├── OnmyojiAssistant.exe      (由 electron.exe 改名)
 *   ├── *.dll / *.pak / *.dat / *.bin   (Electron 运行时)
 *   ├── locales/
 *   └── resources/
 *       ├── app/                  (我们的代码)
 *       │   ├── main.js
 *       │   ├── preload.js
 *       │   ├── renderer/
 *       │   ├── lib/
 *       │   ├── package.json
 *       │   └── node_modules/     (只含运行时真依赖 koffi / pngjs)
 *       └── (没有 app.asar 和 default_app.asar)
 *
 * ── 与 electron-builder 的差异 ──
 *   ✓ 不需要 spawn，约束模式下也能跑
 *   ✓ 产物可直接运行
 *   ✗ 没有 asar 打包（代码是明文目录，体积略大）
 *   ✗ 没有代码签名
 *   ✗ 没有图标替换
 *
 * 用法：
 *   node pack-manual.js                 # 输出到 ../dist/manual-unpacked
 *   node pack-manual.js --out <dir>     # 指定输出目录
 *   node pack-manual.js --force         # 目标已存在时先删除
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { outDir: null, force: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}

// ---------------------------------------------------------------- 工具

function log(msg) { console.log(msg); }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

/** 递归复制目录（跳过 target 目录自身，避免无限递归） */
function copyDir(srcDir, dstDir, skipNames) {
  const skip = new Set(skipNames || []);
  ensureDir(dstDir);

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);

    if (e.isDirectory()) {
      copyDir(s, d, null);
    } else if (e.isSymbolicLink()) {
      // 打包时不保留软链，直接跳过（Electron 分发目录里通常没有）
      continue;
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** 统计目录大小与文件数 */
function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        try {
          bytes += fs.statSync(p).size;
          files++;
        } catch (err) { /* 忽略统计失败的项 */ }
      }
    }
  }
  return { bytes, files };
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

// ---------------------------------------------------------------- 主流程

function main() {
  const args = parseArgs(process.argv.slice(2));

  const appDir = __dirname;
  const projectDir = path.join(appDir, '..');
  const outDir = args.outDir
    ? path.resolve(args.outDir)
    : path.join(projectDir, 'dist', 'manual-unpacked');

  log('='.repeat(62));
  log('  手动打包（纯 fs，不 spawn）');
  log('='.repeat(62));
  log(`  源码: ${appDir}`);
  log(`  输出: ${outDir}`);
  log('');

  // ---------- 1. 检查 Electron 运行时 ----------
  const electronDist = path.join(appDir, 'node_modules', 'electron', 'dist');
  const srcExe = path.join(electronDist, 'electron.exe');

  if (!fs.existsSync(srcExe)) {
    log('[错误] 找不到 Electron 运行时：' + srcExe);
    log('       需要先安装依赖：npm install');
    log('       （约束模式下 npm install 会因 spawn 限制失败，需在完整权限下装一次）');
    return 2;
  }
  log('[1/5] Electron 运行时已就位');
  log(`      ${srcExe}`);

  // ---------- 2. 准备输出目录 ----------
  //
  // 默认输出到 <project>/dist/manual-unpacked。
  // 但某些环境（比如受限沙箱）里已有目录可能不可写，这时自动降级到
  // 一个**新建**的目录 —— 新建目录会继承父目录的权限，通常可写。
  // 真实 Windows 环境不会遇到，但降级逻辑对"权限受限的目录"通用有效。

  const outCandidates = [
    outDir,
    path.join(projectDir, 'dist-manual'),
    path.join(require('os').tmpdir(), 'omj-packed-' + Date.now()),
  ];

  let finalOutDir = null;
  const mkErrors = [];
  for (const cand of outCandidates) {
    try {
      if (fs.existsSync(cand)) {
        if (!args.force) {
          // 已存在但没加 --force：跳过这个候选
          mkErrors.push(`${cand}: 已存在（需 --force 覆盖）`);
          continue;
        }
        rmrf(cand);
      }
      ensureDir(cand);
      // 实际写一个探测文件，确认真的可写
      const probe = path.join(cand, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      finalOutDir = cand;
      break;
    } catch (err) {
      mkErrors.push(`${cand}: ${err.code || err.message}`);
    }
  }

  if (!finalOutDir) {
    log('');
    log('[错误] 没有任何可用的输出目录：');
    for (const e of mkErrors) log('       ' + e);
    return 3;
  }

  if (finalOutDir !== outDir) {
    log('');
    log(`[提示] 默认输出目录不可写，已改用: ${finalOutDir}`);
    for (const e of mkErrors) log(`       (跳过 ${e})`);
  }

  log('');
  log('[2/5] 输出目录已准备: ' + finalOutDir);

  // ---------- 3. 复制 Electron 运行时 ----------
  log('');
  log('[3/5] 复制 Electron 运行时（约 200MB，通常几秒内完成）...');
  const t0 = Date.now();

  // 跳过 resources（里面是 default_app.asar，我们要放自己的 app）
  copyDir(electronDist, finalOutDir, ['resources']);

  // 改名为我们的应用名
  const outExe = path.join(finalOutDir, 'OnmyojiAssistant.exe');
  fs.renameSync(path.join(finalOutDir, 'electron.exe'), outExe);

  // resources 目录：只保留 Electron 需要的东西（去掉 default_app.asar）
  const srcResources = path.join(electronDist, 'resources');
  const dstResources = path.join(finalOutDir, 'resources');
  ensureDir(dstResources);
  if (fs.existsSync(srcResources)) {
    for (const e of fs.readdirSync(srcResources, { withFileTypes: true })) {
      // 跳过所有 app 相关（default_app.asar 等），我们会放自己的 app/
      if (/^(app|app\.asar|default_app\.asar)$/i.test(e.name)) continue;
      const s = path.join(srcResources, e.name);
      const d = path.join(dstResources, e.name);
      if (e.isDirectory()) copyDir(s, d, null);
      else fs.copyFileSync(s, d);
    }
  }

  log(`      完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  // ---------- 4. 放入应用代码 ----------
  log('');
  log('[4/5] 放入应用代码...');
  const appOut = path.join(dstResources, 'app');
  ensureDir(appOut);

  // 顶层文件
  const topFiles = ['main.js', 'preload.js', 'package.json'];
  for (const f of topFiles) {
    const s = path.join(appDir, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(appOut, f));
  }

  // 目录：renderer、lib
  for (const d of ['renderer', 'lib']) {
    const s = path.join(appDir, d);
    if (fs.existsSync(s)) copyDir(s, path.join(appOut, d), null);
  }

  // 运行时真依赖（不是全部 node_modules —— 那些是开发依赖，体积大且不需要）
  // 注意 package.json 的 dependencies 里只列了这些，必须一起带上：
  //   koffi  —— Win32 FFI，带原生二进制（必须连同 build/koffi/win32_x64 一起复制）
  //   pngjs  —— 纯 JS
  const runtimeDeps = ['koffi', 'pngjs'];
  const nmOut = path.join(appOut, 'node_modules');
  const copiedDeps = [];
  for (const dep of runtimeDeps) {
    const s = path.join(appDir, 'node_modules', dep);
    if (!fs.existsSync(s)) {
      log(`      [警告] 缺少运行时依赖: ${dep}`);
      continue;
    }
    copyDir(s, path.join(nmOut, dep), null);
    copiedDeps.push(dep);
  }
  log(`      代码 + 依赖: ${topFiles.join(', ')} + renderer/ lib/ + [${copiedDeps.join(', ')}]`);

  // 检查 koffi 的原生二进制是否在
  const koffiNative = path.join(nmOut, 'koffi', 'build', 'koffi', 'win32_x64');
  if (fs.existsSync(path.join(nmOut, 'koffi')) && !fs.existsSync(koffiNative)) {
    log('      [警告] koffi 的 win32_x64 原生二进制目录缺失，运行时会加载失败');
  } else if (fs.existsSync(koffiNative)) {
    const n = fs.readdirSync(koffiNative).filter((f) => f.endsWith('.node'));
    log(`      koffi 原生二进制: ${n.join(', ')}`);
  }

  // 版本信息（方便排查"这个包是什么时候打的"）
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(finalOutDir, 'build-info.json'), JSON.stringify({
      packagedAt: new Date().toISOString(),
      packager: 'pack-manual.js (fs only, no spawn)',
      appVersion: pkg.version,
      productName: pkg.productName,
      electronVersion: (() => {
        try {
          return JSON.parse(fs.readFileSync(
            path.join(appDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
        } catch (e) { return null; }
      })(),
      runtimeDeps: copiedDeps,
      note: '未做 asar 打包与代码签名，产物为明文目录',
    }, null, 2), 'utf8');
  } catch (err) { /* 版本信息写失败不影响产物 */ }

  // ---------- 5. 统计 ----------
  log('');
  log('[5/5] 产物统计');
  const st = dirStats(finalOutDir);
  log(`      文件数: ${st.files}`);
  log(`      总大小: ${mb(st.bytes)} MB`);
  log(`      可执行: ${outExe}`);

  // 基本自检：关键文件都在
  const required = [
    outExe,
    path.join(appOut, 'main.js'),
    path.join(appOut, 'preload.js'),
    path.join(appOut, 'package.json'),
    path.join(appOut, 'renderer', 'index.html'),
    path.join(appOut, 'lib', 'native.js'),
    path.join(appOut, 'lib', 'vision.js'),
    path.join(appOut, 'lib', 'calibration.js'),
  ];
  let missing = 0;
  for (const p of required) {
    if (!fs.existsSync(p)) {
      log(`      [缺失] ${path.relative(finalOutDir, p)}`);
      missing++;
    }
  }
  log('');

  if (missing > 0) {
    log(`[失败] 有 ${missing} 个关键文件缺失`);
    return 4;
  }

  log('='.repeat(62));
  log('  打包完成');
  log('='.repeat(62));
  log('');
  log('  运行: 双击 ' + outExe);
  log('  验证: 用干净环境启动（计划任务或直接双击）');
  log('        在 DSH shell 里直接跑会被 ELECTRON_RUN_AS_NODE 干扰');
  log('');
  return 0;
}

process.exit(main());
