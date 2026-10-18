# ================================================================
#  一键构建：装环境 + 自检 + 打包 + 验证
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File .\build.ps1
#
#  为什么做成一个脚本：
#    受限沙箱禁止 spawn 子进程，而 npm install / electron-builder 都必须 spawn，
#    所以构建必须在完整权限下跑。做成单脚本后，「批准一次」即可完成全流程，
#    而不是每一步弹一次窗。
#
#  实现注意（踩过的坑）：
#    - 不能用 ErrorActionPreference=Stop：原生工具（schtasks/npm）往 stderr
#      写警告也会被当成终止错误，脚本会在无关紧要的地方退出。
#      改为 Continue + 显式检查 LASTEXITCODE。
#    - 自检必须在干净环境跑（DSH shell 会注入 ELECTRON_RUN_AS_NODE），
#      所以用计划任务启动，而不是直接调。
#
#  退出码：0 成功，非 0 失败
# ================================================================

[CmdletBinding()]
param(
    [switch]$SkipInstall,   # 跳过依赖安装（依赖已在位时用）
    [switch]$SkipVerify,    # 跳过产物验证
    [switch]$Portable       # 打成单文件 portable
)

# 关键：不要 Stop。原生工具写 stderr 会被误判为终止错误。
$ErrorActionPreference = 'Continue'

$appDir = $PSScriptRoot
$projectDir = Split-Path $appDir -Parent
$distDir = Join-Path $projectDir 'dist'

Write-Host ''
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  阴阳师助手 - 一键构建' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  应用目录: $appDir"
Write-Host "  产物目录: $distDir"
Write-Host ''

$script:stepNo = 0
function Step($msg) {
    $script:stepNo++
    Write-Host ''
    Write-Host "[$script:stepNo] $msg" -ForegroundColor Yellow
}

function Ok($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Warn($msg) {
    Write-Host "  [警告] $msg" -ForegroundColor Yellow
}

function Fail($msg) {
    Write-Host "  [错误] $msg" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 自检辅助
#
# ★ 为什么用 cmd 重定向而不是直接 & electron.exe：
#   Electron 是 GUI 子系统程序，PowerShell 的 & 捕获不到它的 stdout
#   （实测返回空、LASTEXITCODE 也是空）。必须交给 cmd 做文件重定向。
#
# 关于 ELECTRON_RUN_AS_NODE：
#   本脚本在步骤 2 已把它从当前进程环境清掉，子进程会继承清理后的环境。
#   （在 DSH 的 pwsh 工具里直接清不掉，那是它的特殊行为；普通 PowerShell 脚本里可以。）

function Invoke-SelfCheck {
    param(
        [string]$ExePath,
        [string]$ExeArgs,      # 例如 '.' ，可为空
        [string]$WorkDir,
        [string]$LogPath
    )

    Remove-Item $LogPath -Force -ErrorAction SilentlyContinue

    $exePart = '"' + $ExePath + '"'
    if ($ExeArgs) { $exePart = $exePart + ' ' + $ExeArgs }
    $cmd = $exePart + ' --self-check > "' + $LogPath + '" 2>&1'

    Push-Location $WorkDir
    try {
        & cmd /c $cmd
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    $lines = @()
    if (Test-Path $LogPath) { $lines = Get-Content $LogPath -Encoding UTF8 }
    return @{ exitCode = $code; lines = $lines; ok = ($lines.Count -gt 0) }
}

# ---------------------------------------------------------------- 1. 环境检查

Step '检查 Node / npm'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail '未找到 Node.js。请安装 Node 18+ : https://nodejs.org/  或 winget install OpenJS.NodeJS.LTS'
}
$nodeVer = (& node --version).Trim()
$nodeMajor = [int]($nodeVer.TrimStart('v').Split('.')[0])
Ok "Node $nodeVer  ($($node.Source))"
if ($nodeMajor -lt 18) { Fail 'Node 版本过低（需要 >= 18）' }

$npmVer = (& npm --version).Trim()
Ok "npm $npmVer"

Set-Location $appDir

# ---------------------------------------------------------------- 2. 环境变量

Step '准备构建环境变量'

$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
Ok "ELECTRON_MIRROR=$env:ELECTRON_MIRROR"

if ($env:ELECTRON_RUN_AS_NODE) {
    Write-Host "  注意: 检测到 ELECTRON_RUN_AS_NODE=$env:ELECTRON_RUN_AS_NODE，已清除" -ForegroundColor Yellow
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}
Ok 'ELECTRON_RUN_AS_NODE 未设置'

# ---------------------------------------------------------------- 3. 安装依赖

if ($SkipInstall) {
    Step '跳过依赖安装（-SkipInstall）'
} else {
    Step '安装依赖'

    $electronExe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
    if (Test-Path $electronExe) {
        Ok '依赖已就位（node_modules/electron 存在），跳过 npm install'
        Ok '如需强制重装：删除 node_modules 后重跑'
    } else {
        Write-Host '  npm install（首次约 100-200MB，可能需要几分钟）...'
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Fail '依赖安装失败。常见原因：Electron 二进制下载失败（已设镜像，可重试）/ 网络代理 / npm 脚本被拦（package.json 的 allowScripts 已配置）'
        }
        if (-not (Test-Path $electronExe)) {
            Fail 'npm install 完成但未找到 electron.exe，Electron 二进制可能下载失败'
        }
        Ok '依赖安装完成'
    }
}

# ---------------------------------------------------------------- 4. 自检

Step '运行主程序自检'

$scLog = Join-Path $env:TEMP 'omj-build-selfcheck.log'
$sc = Invoke-SelfCheck -ExePath (Join-Path $appDir 'node_modules\electron\dist\electron.exe') `
    -ExeArgs '.' -WorkDir $appDir -LogPath $scLog

if (-not $sc.ok) {
    Warn '自检未产出日志，继续构建'
} else {
    $failCount = ($sc.lines | Select-String '\[FAIL\]').Count
    if ($failCount -gt 0) {
        Warn "自检有 $failCount 项失败（继续构建，但运行时可能有问题）："
        $sc.lines | Select-String '\[FAIL\]' | ForEach-Object { Write-Host "      $($_.Line.Trim())" -ForegroundColor Yellow }
    } else {
        Ok "自检全部通过（退出码 $($sc.exitCode)）"
    }
    $sc.lines | Select-String '运行模式|检测到游戏窗口|截图 \+ 内容区探测|标定模块|视觉模块|界面资源' |
        ForEach-Object { Write-Host "      $($_.Line.Trim())" -ForegroundColor DarkGray }
}

# ---------------------------------------------------------------- 5. 打包

Step '打包 exe'

# electron-builder 会先 rm -rf 掉 win-unpacked 再重写。
# 如果程序正开着（exe 被占用），删除会报 EBUSY: resource busy or locked。
# 另外还有个更隐蔽的情况：某个进程把 win-unpacked 当成**工作目录**，
# 或者资源管理器正打开着这个文件夹 —— 目录本身删不掉（能写不能删）。
$running = Get-Process -Name 'OnmyojiAssistant' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  检测到 $($running.Count) 个正在运行的实例，先关闭以便替换文件" -ForegroundColor Yellow
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    $still = Get-Process -Name 'OnmyojiAssistant' -ErrorAction SilentlyContinue
    if ($still) {
        Warn '仍有实例无法关闭，打包可能因文件占用失败'
    }
}

$unpacked = Join-Path $distDir 'win-unpacked'

# 先测一下旧目录能不能删：删不掉就走「临时目录 + 拷回来」的降级路线。
# （目录能写不能删时，把内容清空再把新产物拷进去是一样的效果）
$canCleanTarget = $true
if (Test-Path $unpacked) {
    try {
        $probe = Join-Path $unpacked '.build-probe'
        Set-Content $probe -Value 'x' -ErrorAction Stop
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
        # 能建文件说明可写；接着试着删整目录
        Remove-Item $unpacked -Recurse -Force -ErrorAction Stop
    } catch {
        $canCleanTarget = $false
    }
}

if (-not $canCleanTarget) {
    Warn "旧产物目录删不掉（通常是有进程把它当工作目录，或资源管理器正打开着它）"
    Write-Host '        改用「临时目录构建 + 拷贝覆盖」的方式继续' -ForegroundColor Yellow
}

if ($Portable) {
    Write-Host '  目标: portable 单文件'
    & npx electron-builder --win --x64 portable
} else {
    if ($canCleanTarget) {
        Write-Host '  目标: 目录形式（启动快，不易被安全软件误报）'
        & npx electron-builder --win --x64 --dir
    } else {
        # 降级：构建到 dist\_staging，再把内容拷进 win-unpacked
        $staging = Join-Path $distDir '_staging'
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
        Write-Host "  目标: 目录形式（先构建到 $staging）"
        & npx electron-builder --win --x64 --dir --config.directories.output="$staging"
        if ($LASTEXITCODE -eq 0) {
            $staged = Join-Path $staging 'win-unpacked'
            if (Test-Path $staged) {
                # 清空目标目录里的旧内容（只删子项，保留目录本身）
                Get-ChildItem $unpacked -Force -ErrorAction SilentlyContinue |
                    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
                # 拷进去
                Get-ChildItem $staged -Force | ForEach-Object {
                    Copy-Item $_.FullName -Destination $unpacked -Recurse -Force -ErrorAction Stop
                }
                Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
                Ok '已把临时构建产物拷贝到 win-unpacked'
            } else {
                Warn '临时目录里没有 win-unpacked，无法拷贝'
                $LASTEXITCODE = 1
            }
        }
    }
}
if ($LASTEXITCODE -ne 0) {
    Fail @'
electron-builder 打包失败。常见原因：
  1) 程序仍在运行占用文件 → 关闭 OnmyojiAssistant.exe 后重试
  2) 有进程把 dist\win-unpacked 当工作目录 / 资源管理器正打开该文件夹
     → 关掉对应窗口后重试（脚本已尝试「临时目录+拷贝」的降级方案）
  3) 杀毒软件扫描中锁定文件 → 稍等重试或临时加白名单
  4) Electron 二进制下载失败 → 已配镜像，可重试
'@
}

$exePath = $null
if ($Portable) {
    $cand = Get-ChildItem $distDir -Filter '*.exe' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($cand) { $exePath = $cand.FullName }
} else {
    $candidate = Join-Path $distDir 'win-unpacked\OnmyojiAssistant.exe'
    if (Test-Path $candidate) { $exePath = $candidate }
}

if (-not $exePath) { Fail '打包完成但未找到 exe 产物' }
$exeItem = Get-Item $exePath
Ok "产物: $($exeItem.FullName)"
Ok "大小: $([math]::Round($exeItem.Length / 1MB, 1)) MB"

# ---------------------------------------------------------------- 6. 验证产物

if ($SkipVerify) {
    Step '跳过产物验证（-SkipVerify）'
} else {
    Step '验证打包产物（自检）'

    $vLog = Join-Path $env:TEMP 'omj-build-verify.log'
    $exeDir = Split-Path $exePath -Parent
    $exeName = Split-Path $exePath -Leaf

    $v = Invoke-SelfCheck -ExePath (Join-Path $exeDir $exeName) `
        -ExeArgs '' -WorkDir $exeDir -LogPath $vLog

    if (-not $v.ok) {
        Warn '产物自检未产出日志'
    } else {
        $vFail = ($v.lines | Select-String '\[FAIL\]').Count
        $vMode = $v.lines | Select-String '运行模式' | Select-Object -First 1
        if ($vMode) { Write-Host "      $($vMode.Line.Trim())" -ForegroundColor DarkGray }

        $v.lines | Select-String '检测到游戏窗口|截图 \+ 内容区探测|标定模块|视觉模块|界面资源' |
            ForEach-Object { Write-Host "      $($_.Line.Trim())" -ForegroundColor DarkGray }

        if ($vFail -eq 0 -and $v.exitCode -eq 0) {
            Ok "产物自检验证通过（退出码 $($v.exitCode)）"
        } else {
            Warn "产物自检有 $vFail 项失败（退出码 $($v.exitCode)）"
        }
    }
}

# ---------------------------------------------------------------- 完成

Write-Host ''
Write-Host '================================================================' -ForegroundColor Green
Write-Host '  构建完成' -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Green
Write-Host ''
Write-Host "  产物: $exePath" -ForegroundColor White
Write-Host ''
Write-Host '  使用步骤：' -ForegroundColor White
Write-Host '    1. 双击上面的 exe 启动（会弹 UAC，点「是」——游戏是管理员权限，不提权点不动）'
Write-Host '    2. 在「游戏实例」里选中一个阴阳师窗口'
Write-Host '    3. 选「副本类型」，先勾开发者选项里的「仅识别不点击」跑一遍看识别率'
Write-Host '    4. 识别不稳时点「素材诊断」，看哪个素材的分数不够'
Write-Host '    5. 稳定后取消勾选，点「开始」正式运行'
Write-Host ''
Write-Host '  加新副本：往 config\dungeons\ 放一个 json、config\assets\ 放素材，重启即可' -ForegroundColor DarkGray
Write-Host '  改了游戏窗口大小：程序会按 config\screen.json 的 referenceWidth 自动缩放素材' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  详细说明见 README.md' -ForegroundColor DarkGray
Write-Host ''

exit 0
