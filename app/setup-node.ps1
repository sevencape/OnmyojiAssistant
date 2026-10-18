# 一键准备 Node / Electron 构建环境
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\app\setup-node.ps1
#
# 本脚本做四件事:
#   1. 检查 Node.js 版本（要求 >= 18，实测本机 v24.19.0）
#   2. 检查 npm registry 与 Electron 镜像连通性
#   3. 安装依赖（Electron 二进制 + 原生模块，注意 npm 12 的脚本放行问题）
#   4. 跑 probe.js 验证 Win32 窗口枚举 / 截图 / PNG 解码三条链路

$ErrorActionPreference = "Stop"
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $appDir

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  阴阳师助手 - Node 构建环境准备" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  工作目录: $appDir"
Write-Host ""

# ---------- 1. Node ----------
Write-Host "[1/4] 检查 Node.js ..." -ForegroundColor Yellow
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  [错误] 未找到 Node.js" -ForegroundColor Red
    Write-Host "         请安装 Node.js 18+ : https://nodejs.org/"
    Write-Host "         或用 winget: winget install OpenJS.NodeJS.LTS"
    exit 1
}
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
Write-Host "  Node $nodeVersion  ($($node.Source))" -ForegroundColor Green
if ($nodeMajor -lt 18) {
    Write-Host "  [错误] Node 版本过低，Electron 需要 >= 18" -ForegroundColor Red
    exit 1
}

$npmVersion = (& npm --version).Trim()
$npmMajor = [int]($npmVersion.Split('.')[0])
Write-Host "  npm  $npmVersion" -ForegroundColor Green
if ($npmMajor -ge 12) {
    Write-Host "  [注意] npm $npmVersion 默认不执行依赖的 install 脚本，" -ForegroundColor Yellow
    Write-Host "         Electron 二进制与原生模块需要显式放行（.npmrc 已配置）。" -ForegroundColor Yellow
}

# ---------- 2. 连通性 ----------
Write-Host ""
Write-Host "[2/4] 检查网络 ..." -ForegroundColor Yellow
$registry = (& npm config get registry).Trim()
Write-Host "  registry: $registry"
Write-Host "  重新读取 .npmrc 中的镜像设置 ..."
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
Write-Host "  ELECTRON_MIRROR=$env:ELECTRON_MIRROR" -ForegroundColor Green

$ok = $true
foreach ($u in @(
    @{ name = "npm registry"; url = $registry.TrimEnd('/') + "/electron" },
    @{ name = "electron 镜像"; url = $env:ELECTRON_MIRROR }
)) {
    try {
        $r = Invoke-WebRequest -Uri $u.url -Method Head -TimeoutSec 15 -UseBasicParsing
        Write-Host ("  [OK]   {0}  {1}" -f $u.name, $r.StatusCode) -ForegroundColor Green
    } catch {
        Write-Host ("  [FAIL] {0}  {1}" -f $u.name, $_.Exception.Message) -ForegroundColor Red
        $ok = $false
    }
}
if (-not $ok) {
    Write-Host "  [错误] 网络不通，无法下载 Electron 二进制" -ForegroundColor Red
    Write-Host "         可尝试: npm config set registry https://registry.npmmirror.com"
    exit 1
}

# ---------- 3. 安装依赖 ----------
Write-Host ""
Write-Host "[3/4] 安装依赖（首次约 100-200MB，可能需要几分钟）..." -ForegroundColor Yellow

$npmArgs = @("install", "--no-audit", "--no-fund")
if ($npmMajor -ge 12) {
    # npm 12: 显式放行 install 脚本
    $npmArgs += "--allow-scripts=@electron/get,electron,node-window-manager"
}
Write-Host "  npm $($npmArgs -join ' ')" -ForegroundColor DarkGray

& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [警告] 安装失败或部分失败。常见原因与对策：" -ForegroundColor Yellow
    Write-Host "    1) Electron 二进制下载失败 -> 已设置 ELECTRON_MIRROR，可重试"
    Write-Host "    2) 原生模块 node-window-manager 编译失败 -> 需要 VS Build Tools"
    Write-Host "       下载: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    Write-Host "       勾选 '使用 C++ 的桌面开发'"
    Write-Host "    3) 代理问题 -> npm config set proxy / https-proxy"
    Write-Host ""
    Write-Host "  提示: 即使 node-window-manager 失败，其余功能仍可继续开发。" -ForegroundColor Yellow
    Write-Host "        贴边停靠功能会退化为不可用（probe 会明确报出来）。" -ForegroundColor Yellow
}

# ---------- 4. 验证 ----------
Write-Host ""
Write-Host "[4/4] 验证运行链路 ..." -ForegroundColor Yellow
$electronExe = Join-Path $appDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "  [错误] 未找到 $electronExe" -ForegroundColor Red
    Write-Host "         Electron 二进制没下载成功。" -ForegroundColor Red
    Write-Host "         确认 ELECTRON_MIRROR 生效，然后重跑本脚本。" -ForegroundColor Red
    exit 1
}
Write-Host "  Electron: $electronExe" -ForegroundColor Green

# ★ 关键：必须清掉 ELECTRON_RUN_AS_NODE
# 如果这个变量为 1，electron.exe 会退化成纯 Node 运行：
#   - require('electron') 返回可执行文件路径字符串而不是 API 对象
#   - process.type 为 undefined
#   - 报错 "Cannot read properties of undefined (reading 'whenReady')"
# 实测该变量由 DSH harness 的 shell 环境注入（User/Machine 级都是空）。
if ($env:ELECTRON_RUN_AS_NODE) {
    Write-Host "  [注意] 检测到 ELECTRON_RUN_AS_NODE=$env:ELECTRON_RUN_AS_NODE，已临时清除" -ForegroundColor Yellow
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

Write-Host "  运行 probe.js（会弹出一个测试窗口，自动关闭）..." -ForegroundColor DarkGray
& npm run probe
$probeExit = $LASTEXITCODE

Write-Host ""
Write-Host "  运行主程序自检 ..." -ForegroundColor DarkGray
& npm run selfcheck
$selfExit = $LASTEXITCODE

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
if ($probeExit -eq 0 -and $selfExit -eq 0) {
    Write-Host "  环境准备完成，可以开始构建" -ForegroundColor Green
    Write-Host ""
    Write-Host "  开发运行:  npm start" -ForegroundColor White
    Write-Host "  自检:      npm run selfcheck" -ForegroundColor White
    Write-Host "  打包 exe:  npm run dist" -ForegroundColor White
    Write-Host "  产物位置:  ..\dist\win-unpacked\OnmyojiAssistant.exe" -ForegroundColor White
} else {
    Write-Host "  验证未全部通过 (probe=$probeExit, selfcheck=$selfExit)" -ForegroundColor Yellow
    Write-Host "  请查看上方输出，确认哪些链路不可用。" -ForegroundColor Yellow
    Write-Host "  详细排查参考: ..\VERIFIED-FACTS.md" -ForegroundColor Yellow
}
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""
if ($selfExit -ne 0) { exit $selfExit }
exit $probeExit
