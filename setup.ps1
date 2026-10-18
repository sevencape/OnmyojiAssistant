# 一键安装：创建虚拟环境并安装依赖
# 用法: powershell -ExecutionPolicy Bypass -File .\setup.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

Write-Host "==> 项目目录: $root" -ForegroundColor Cyan

# --- 1. 检查 Python ---
$python = $null
foreach ($candidate in @("python", "py -3.12", "py -3.11", "py -3")) {
    $parts = $candidate.Split(" ")
    $exe = $parts[0]
    if (Get-Command $exe -ErrorAction SilentlyContinue) {
        try {
            $verArgs = if ($parts.Length -gt 1) { $parts[1..($parts.Length - 1)] + @("--version") } else { @("--version") }
            $out = & $exe @verArgs 2>&1
            if ($LASTEXITCODE -eq 0) {
                $python = $candidate
                Write-Host "==> 使用 Python: $candidate ($out)" -ForegroundColor Green
                break
            }
        } catch { }
    }
}

if (-not $python) {
    Write-Host "[错误] 没有找到可用的 Python。" -ForegroundColor Red
    Write-Host "       请安装 Python 3.11 或 3.12: https://www.python.org/downloads/"
    Write-Host "       安装时务必勾选 'Add python.exe to PATH'"
    exit 1
}

# --- 2. 版本检查 ---
$verText = & ($python.Split(" ")[0]) @($python.Split(" ")[1..($python.Split(" ").Length - 1)]) --version 2>&1
if ($verText -match "3\.(13|14|15)") {
    Write-Host "[警告] 检测到 Python $verText，部分依赖可能没有对应轮子。" -ForegroundColor Yellow
    Write-Host "       建议改用 Python 3.11 或 3.12。" -ForegroundColor Yellow
}

# --- 3. 创建虚拟环境 ---
$venv = Join-Path $root ".venv"
if (Test-Path $venv) {
    Write-Host "==> 虚拟环境已存在，跳过创建" -ForegroundColor Green
} else {
    Write-Host "==> 创建虚拟环境 .venv ..." -ForegroundColor Cyan
    $parts = $python.Split(" ")
    if ($parts.Length -gt 1) {
        & $parts[0] $parts[1..($parts.Length - 1)] -m venv $venv
    } else {
        & $parts[0] -m venv $venv
    }
    if ($LASTEXITCODE -ne 0) { Write-Host "[错误] 创建虚拟环境失败" -ForegroundColor Red; exit 1 }
}

$venvPython = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "[错误] 找不到 $venvPython" -ForegroundColor Red
    exit 1
}

# --- 4. 安装依赖 ---
Write-Host "==> 升级 pip ..." -ForegroundColor Cyan
& $venvPython -m pip install --upgrade pip --quiet

Write-Host "==> 安装依赖（可能需要 1-3 分钟）..." -ForegroundColor Cyan
& $venvPython -m pip install -r (Join-Path $root "requirements.txt")
if ($LASTEXITCODE -ne 0) { Write-Host "[错误] 依赖安装失败，请检查网络或换用国内镜像" -ForegroundColor Red; exit 1 }

Write-Host "==> 验证关键依赖 ..." -ForegroundColor Cyan
& $venvPython -c "import cv2, mss, numpy, win32gui, pydirectinput, yaml; print('  opencv', cv2.__version__); print('  numpy', numpy.__version__); print('  全部导入成功')"
if ($LASTEXITCODE -ne 0) { Write-Host "[错误] 依赖导入失败" -ForegroundColor Red; exit 1 }

# --- 5. 准备目录 ---
foreach ($d in @("assets", "debug")) {
    $p = Join-Path $root $d
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
}

# --- 6. 完成 ---
Write-Host ""
Write-Host "==================== 安装完成 ====================" -ForegroundColor Green
Write-Host ""
Write-Host "接下来按顺序执行：" -ForegroundColor Yellow
Write-Host ""
Write-Host "  1) 激活环境"
Write-Host "     .\.venv\Scripts\Activate.ps1"
Write-Host ""
Write-Host "  2) 找到游戏窗口标题，填进 config.yaml 的 window.title_keywords"
Write-Host "     python -m src.main --list-windows"
Write-Host ""
Write-Host "  3) 游戏切到副本界面，抓一张实机截图"
Write-Host "     python -m src.main --dump-frame"
Write-Host ""
Write-Host "  4) 按 ASSETS.md 从这张图里裁素材，放进 assets/"
Write-Host "     (第一批只需要 4 个: btn_start_battle / btn_result_confirm /"
Write-Host "      title_battle_result / icon_in_battle)"
Write-Host ""
Write-Host "  5) 检查素材"
Write-Host "     python -m src.main --check-assets"
Write-Host ""
Write-Host "  6) 只识别不点击，验证阈值"
Write-Host "     python -m src.main --dry-run -v"
Write-Host ""
Write-Host "  7) 正式运行"
Write-Host "     python -m src.main"
Write-Host ""
Write-Host "风险提示：脚本违反游戏服务条款，可能导致封号。详见 README.md" -ForegroundColor Red
Write-Host "==================================================" -ForegroundColor Green
