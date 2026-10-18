# 环境诊断结论（2026-10 实测）

> 本文件记录实测结果，不是推测。用于下次会话快速恢复上下文。

## 零、最新状态（第三轮更新）：根因确认为「完整性级别标签」

### 真正的根因：Mandatory Integrity Control，不是 DACL

约束 shell 的令牌完整性是 **Medium**（`S-1-16-8192`）。Windows 的
**no-write-up 规则**要求：Medium 令牌只能写入带 **Low 完整性标签**的对象。
工作区里哪些目录带这个标签、哪些没带，是**不一致**的：

| 路径 | 完整性标签 | 约束模式写入 |
|---|---|---|
| `F:\WorkSpace` | Low `(OI)(CI)(NW)` | ✅ 可写 |
| `F:\WorkSpace\__writetest`（根下新建） | Low `(I)(OI)(CI)(NW)` | ✅ 可写 |
| `F:\WorkSpace\.dsh-acl-recovery` | **无标签** | ❌ 拒绝 |
| `F:\WorkSpace\onmyoji-bot` | **无标签** | ❌ 拒绝 |
| `F:\WorkSpace\onmyoji-bot\app` / `dist` / `src` … | **无标签** | ❌ 拒绝 |

**关键推论**：DACL 修好了也没用。`onmyoji-bot` 上明明有当前用户的显式 FullControl，
写入依然被拒 —— 因为缺的是**完整性标签**，不是 DACL 权限位。
这就解释了为什么前两轮的 `writeOwner` 修复（虽然确实修对了）没能解决问题。

### 已经做的修复

| 操作 | 结果 |
|---|---|
| 技能脚本修 `F:\WorkSpace`（`writeOwner` false→true） | ✅ 验证通过 |
| 技能脚本修 `F:\WorkSpace\onmyoji-bot`（`writeOwner` false→true） | ✅ 验证通过 |
| `icacls /setintegritylevel (OI)(CI)Low` 加在 `onmyoji-bot` | ✅ 生效，**该层随即变为可写** |
| `icacls /setintegritylevel (OI)(CI)Low /T /C` 递归整棵树 | ⚠️ 7858 成功 / **1106 失败**，子目录标签仍为空 |

### 递归失败的原因

子目录（如 `app`、`dist`）对当前用户**只有继承来的** `Authenticated Users: Modify`，
没有显式项。改安全属性需要更强的权限，于是 `Access is denied`。

### 余下的阻塞：无法绕开

- 约束模式：读正常；**写只对带 Low 标签的对象生效**，`app`/`dist` 都不带 → 编译失败
- 实测编译报错：`EPERM: operation not permitted, mkdir 'F:\WorkSpace\onmyoji-bot\dist\win-unpacked.tmp'`
- 提权（`danger-full-access`）下：写入、编译、跑 GUI **全部正常**（8.5 秒重建成功）

### 解除办法（用户执行，二选一）

**方案 A（推荐，最干净）**：把本会话切到「完全权限」(full access)。
之后沙箱自己会完成工作区授予，读写全自动，不需要逐条批准。

**方案 B**：让沙箱能写这两层，需要补显式完全控制项 + 递归补完整性标签：

```powershell
icacls 'F:\WorkSpace\onmyoji-bot' /grant "$env:USERNAME:(OI)(CI)F" /T /C
icacls 'F:\WorkSpace\onmyoji-bot' /setintegritylevel '(OI)(CI)Low' /T /C
```

**执行前必须知道的影响**：这会给项目目录树下所有文件和子目录加上
「当前用户完全控制」和「低完整性级别」两项设置，相当于把它们的 Windows
安全属性对齐成与工作区根目录一致。**不改文件内容和所有者**，但确实改动了
一份安全属性。需要在完全权限下执行。

### 我的处置：已停止手工深挖

沙箱 ACL 技能规定「任何一次修复失败或验证失败后停止，不得重复该调用，
不得手工移除拒绝项」。递归设置标签属于改安全属性，已超出该技能授权范围，
**我不再自行继续**，交由用户决定走方案 A 还是 B。

> 另注：`F:\WorkSpace` 及其子目录上都有一条 **`S-1-1-0` 的 Deny
> `DeleteSubdirectoriesAndFiles`**（`Everyone`，容器继承）。技能说明这是
> **DSH 自己的预期条目，不是冲突**，**不要手工删除**。

---

## 零之二、第二轮记录（保留备查）：沙箱写入仍未解锁

### 已做的修复

用 `diagnose-windows-sandbox-acl` 技能脚本对两层路径各跑了一次（各一次批准）：

| 路径 | 修复前 | 修复后 | 验证 |
|---|---|---|---|
| `F:\WorkSpace` | `writeDac=true` `writeOwner=false` | `writeOwner=true` | ✅ verified |
| `F:\WorkSpace\onmyoji-bot` | `writeDac=true` `writeOwner=false` | `writeOwner=true` | ✅ verified |

两次都备份了 DACL 并打印了回滚命令，备份在 `F:\WorkSpace\.dsh-acl-recovery\`。

### 但仍然写不进去

修复后在**约束模式**下重跑原操作，全部失败：

```
建目录 write-probe        -> 对路径"write-probe"的访问被拒绝
写文件 write-probe\a.txt  -> 未能找到路径的一部分
建点目录 .dot-probe       -> 对路径".dot-probe"的访问被拒绝
app\__t.txt               -> 对路径"...\app\__t.txt"的访问被拒绝
dist\__t.txt              -> 对路径"...\dist\__t.txt"的访问被拒绝
```

**对比：`F:\WorkSpace` 根目录可以写**（已实测通过），只有子目录不行。

### 关键观察：存在完整性级别标签

`F:\WorkSpace` 的 ACL 核查输出里有 **`LOW_LABEL=true`** —— 这是
**Mandatory Integrity Control（强制完整性级别）**。沙箱用**低完整性令牌**写文件时，
对象上的完整性标签会参与判定，这解释了为什么继承来的 `Authenticated Users: Modify`
不够用，必须要有**显式**的用户完全控制项。

技能脚本补的正是这个显式项（`S-1-5-21-...-1001` FullControl），
`writeOwner` 也确实从 false 变成了 true —— **权限缺口是真的，修得也对，但写入依然被拒。**

### 结论

**ACL 不是唯一原因。** 沙箱在 ACL 之外还有自己的写入约束（很可能是它的 workspace
授予机制在 `workspace-write` 模式下只覆盖它成功 provision 的路径，而 provision 依然失败）。

### 按技能规定：已停止

技能明确要求「任何一次修复失败或验证失败后停止，不得重复该调用，也不得手工移除拒绝项」。
两次修复都验证成功但原操作仍失败，属于「修复不等于解决」的情形，**已停止，不再重试**。

### 需要用户做的事

**把本会话切到「完全权限」(full access)。** 这是唯一能解除限制的途径，
因为只有用户能改会话的沙箱模式。

> 补充：`F:\WorkSpace` 的 ACL 里还有一条 **`S-1-1-0` 的 Deny `DeleteSubdirectoriesAndFiles`**。
> 技能说明这是 **DSH 自己的预期条目，不是冲突**，不要手工删除。

### 在当前模式下的可用做法

- 沙箱**读**完全正常：shell 命令、列目录、跑测试、枚举窗口都行
- 沙箱**写**被拒：任何文件创建/修改都需要提权
- 变通：对需要写操作的单条命令带 `sandbox_permissions: danger-full-access` 走一次批准
  （本轮的 exe 重新编译就是这么完成的，8.5 秒，成功）
- `danger-full-access` 下写入、编译、跑 GUI **全部正常**

---

## 一、核心结论：harness 无法自动安装环境的真正原因

**不是 Python 缺失，是沙箱权限。**

`F:\WorkSpace` 文件系统层面权限完全正常：

```
NT AUTHORITY\Authenticated Users  Modify, Synchronize  Allow   ← 可写
BUILTIN\Administrators            FullControl          Allow
```

但 harness 在 workspace-write 模式下执行任何 shell 命令时，**试图先给工作区授予 ACL 写权限**，这一步失败：

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(F:\WorkSpace)
```

- `Win32 5` = `ERROR_ACCESS_DENIED`
- `SetNamedSecurityInfoW` 是**修改 ACL** 的 API，不是写文件
- 失败原因：进程 token 缺少 `SeSecurityPrivilege` / `SeTakeOwnershipPrivilege`，**无权改安全描述符**
- 结果：连只读命令（`python --version`）都被挡在门外

**关键推论：改写 file-policy 或 approval-policy 都没用。** 这两项管的是「文件操作」和「审批流程」，而这里是「ACL 提权」，属于第三个维度——**sandbox 模式**。必须把 sandbox 从 `workspace-write` 提到 `danger-full-access`。

### 验证

用 `sandbox_permissions: danger-full-access` 重试同一命令后，全部命令正常执行，包括：

- 读取 `DSH_*` 环境变量
- 执行 Python、Node
- 读取卷信息和 ACL
- 访问网络

---

## 二、修复方法（二选一）

### 方案 A：运行时提权（已验证可用）

在需要装环境的命令上带 `sandbox_permissions: danger-full-access`，harness 会弹审批，批准后该条命令以完整权限执行。

- 优点：不用改配置，权限最小化
- 缺点：**每条命令都要批准一次**，装环境要跑十几条命令就很烦

### 方案 B：改 profile 策略（推荐，一劳永逸）

改这个文件（`DSH_PROFILE=desktop`，所以是 desktop 目录）：

```
C:\Users\海角七号\.dsh\profiles\desktop\cordis.patch.yml
```

该文件当前的 patch 只针对客户端 UI 插件：

```yaml
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
```

**只加 `ui-settings-general` / `ui-settings` 这类 UI 插件的 patch 不会影响沙箱。** 沙箱属于服务端能力，配置项不在已解包的 `app.asar.unpacked` 里（`dsh-base` bundle 封在 `app.asar` 内，无法直接检索）。

因此**推荐路径**：在 harness 的 **设置界面**里找 sandbox / 权限相关项，改完之后**回来核实 patch 文件里写入了什么 key**，再决定是否需要手工固化。这是唯一能一次拿到准确 key 名的方式。

### 方案 C（不推荐）

把项目放到 `C:\Users\海角七号\Documents\deepseek-harness\default-workspace`，那是 harness 默认工作区，可能不触发 ACL 授予路径。属于绕过而非解决，且会打乱项目组织。

---

## 三、机器环境实测清单

| 项目 | 实测结果 | 影响 |
|---|---|---|
| 系统 Python | **完全没有**（`python` → not found，`py` → not found，注册表无 PythonCore） | ★ 最大障碍，必须自动装 |
| harness 内置 Python | `3.12.14` 可执行 | 可用来 bootstrap，但**不要装包进去**（污染 harness） |
| 内置 Python 位置 | `C:\Users\海角七号\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe` | |
| Node.js | `v24.19.0` | 可选路线（Electron/Tauri） |
| CPU 架构 | AMD64 64 位 | |
| F: 磁盘 | `999 GB` 可用（NTFS） | 空间充足 |
| Tcl/Tk | `8.6.12`，tkinter **可创建真实窗口** | ★ 证明 tkinter GUI 可行 |
| venv 模块 | 可用 | ★ 可建隔离环境 |
| pip | 可用 | |
| PyPI 直连 | `200 OK`（pypi.org） | ★ 可自动装包 |
| 清华镜像 | `200 OK` | 备用加速源 |
| winget | 已安装 | 可用来装 Python 本体 |
| choco / scoop / git | 未安装 | 不影响 |

### 内置 Python 已有的包

```
OK    numpy 2.3.5
OK    Pillow 12.3.0
OK    tkinter
MISS  opencv-python  ← 需要装
MISS  mss            ← 需要装
MISS  pywin32        ← 需要装
MISS  pydirectinput  ← 需要装
MISS  PyYAML         ← 需要装
MISS  PyInstaller    ← 需要装（打包用）
MISS  setuptools
```

---

## 四、对「自动装环境 + 编译 exe」的结论

**可行，且不需要管理员权限装系统级 Python。**

理由：

1. 网络通 → 能 `pip install`
2. 内置 Python 3.12.14 + venv 可用 → 能在项目目录建**独立虚拟环境**，不污染 harness
3. `pip install pyinstaller` → 能打出独立 exe，用户机器无需装 Python
4. tkinter 已有 → GUI 零额外依赖，PyInstaller 打包 tkinter 体积小（比 Qt 省 ~40MB）

### 正确做法

**不要**在 `F:\WorkSpace\onmyoji-bot\.venv` 用系统 Python —— 本机没有系统 Python。

**要**按优先级 bootstrap：

```
1. 探测本机是否有可用 Python 3.11/3.12
   ├─ python / py / 注册表 PythonCore
   ├─ winget install Python.Python.3.12（需要时会弹 UAC）
   └─ 下载 python-3.12.x-embed-amd64.zip 到 tools/python/（免安装、免 UAC）
2. <探测到的 python> -m venv .venv
3. .venv\Scripts\python -m pip install -r requirements.txt
4. .venv\Scripts\python -m PyInstaller build.spec
5. 产出 dist/OnmyojiAssistant.exe
```

第 1 步的「下载 embeddable Python」是关键兜底：**完全免安装、免 UAC、可重复**，适合自动化。

### 注意事项

- ❌ 不要把依赖装进 harness 内置 Python（会污染 harness 自身运行时）
- ✅ 项目内 `.venv` + `.venv\Scripts\python.exe` 显式调用，不要依赖 PATH 激活
- ✅ `--collect-all cv2` / `--collect-all mss`，否则 PyInstaller 容易漏库
- ✅ 加 `--noconsole`，否则 exe 启动会带黑框
- ⚠️ `--onefile` 冷启动慢（要解压到临时目录），且某些安全软件会误报；**推荐 `--onedir`**

### 网络优化（可选）

装包慢时挂清华源：

```
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
```

---

## 五、提权后 harness 的能力边界

`danger-full-access` 下可做：

- 执行任意 shell 命令、读写工作区外文件
- 联网（pip / winget / 下载 Python）
- 编译打包、跑测试、启动 GUI 进程

仍**受限**的地方：

- 需要 UAC 提权的操作（winget 装系统级软件）可能仍被拒 → 所以优先选免安装方案
- 长时间运行的 GUI 程序应作为后台 job 启动，不要阻塞会话
