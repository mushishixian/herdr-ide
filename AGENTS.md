# AGENTS.md — herdr-ide 定制版

这个仓库是 Herdr Desktop 的个人定制（mod + 便携包），不是 herdr 本体。

## 目录

- `herdr-app-git-mods/`：真正部署的 mod 源码与脚本，改这里
  - `src/*.js`：被 `deploy.ps1` 与 `src/common.js` 合包后部署的 mod
  - `assets/spaces-ide/main.js`：手写的 space 侧栏 mod（不合包，原样部署）
  - `mods/git-status/main.js`：被布局内嵌的状态栏 mod
  - `mods/ide-pane-header/main.js`：替换内置 `terminals-pane` 的 pane 头部，按 agent 换图标（`layout` 的 `pane.header.content.mod` 指向它）
  - `bundle/`：从本机运行配置导出的快照（布局、键位、AI commit 配置），随 zip 分发
- `herdr-sidebar/`：上游 herdr 的源码与文档（AGENTS.md、docs/），只作参考，不参与部署
- `herdr-ide-portable.zip`：可搬到新电脑的便携包（仓库根，由 `export-bundle.ps1` 生成）

## 运行位置与生效条件

- 软件：`%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe`（本体，不含 mods）
- mod 实际加载自：`%USERPROFILE%\.config\herdr-app\mods\<mod>\main.js`
- **mod 只在 herdr-app 启动时读取**：改完必须部署 + 重启 herdr-app。关闭 app 不影响 herdr-core，pane 与终端会保留。

## 改完的标准流程

```powershell
cd herdr-app-git-mods
.\deploy.ps1          # 合成 common.js、写 mod.json（含 spaces-ide）、同步 Fresh 插件
# 由 Agent 直接执行下方重启流程（不要让用户手动重启）
.\export-bundle.ps1   # 需要更新便携包时：导出现有配置并重打 zip
```

## 自动重启生效（Agent 直接执行，不要让用户手动重启）

改动常驻布局 mod（`ide-sidebar`、`spaces-ide`、`terminals-bar-git`、`ide-pane-header` 等）、layout（如 `deploy.ps1` 需在关闭 `herdr-app` 时补写 `terminal_menu`）或 Fresh 插件/配置后，**Agent 必须在部署并校验后主动完成重启**：

1. **关闭 `herdr-app` → 部署 → 重启 `herdr-app`**（关闭 `herdr-app` 不影响 `herdr-core`，Agent 终端会保留；从 WSL 调 PowerShell / `.exe` 务必带 `< /dev/null`）：
   ```bash
   powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '
     Get-Process herdr-app -ErrorAction SilentlyContinue | Stop-Process -Force
     Start-Sleep -Milliseconds 600
     & "C:\Project\herdr-ide\herdr-app-git-mods\deploy.ps1"
     Start-Process -FilePath "$env:LOCALAPPDATA\Programs\herdr-app\herdr-app.exe"
     Start-Sleep -Seconds 3
   ' < /dev/null
   timeout 6 /mnt/c/Users/64813/AppData/Local/Programs/herdr-app/herdr-app.exe status < /dev/null
   ```
   确认输出 `"errors": []`。

2. **重启 Fresh daemon（改动 `assets/fresh-plugins/*.ts` 或 `~/.config/fresh/config.json` 后执行）**：
   - 未激活的 Fresh 进程常被 `coolInactiveFresh` 用 `SIGSTOP` 冻结（`Tsl`），直接 `fresh --cmd daemon kill` 会卡死；**必须先 `CONT` 再用精确进程名 `pkill -x fresh`**（不要用 `pkill -f`，否则会误杀当前 `bash -c` 命令自己）：
   ```bash
   pkill -CONT -x fresh 2>/dev/null || true
   sleep 0.1
   pkill -TERM -x fresh 2>/dev/null || true
   sleep 0.6
   pkill -KILL -x fresh 2>/dev/null || true
   timeout 3 "$HOME/.local/share/fresh-editor/fresh" --cmd daemon list
   ps -eo pid,lstart,stat,args | grep '[f]resh-editor/fresh'
   ```
   清理旧 daemon 后，点击或切入文件即可拉起加载新插件/配置的新 Fresh 实例（开启 `autoRestoreFiles` 时当前 Space 会自动重建）。

验证手段：

- `node --input-type=module --check < src/x.js`：这些文件是 ESM，必须带 `--input-type=module`
- `herdr-app status`：看 `errors` 是否为空
- `herdr-app check <mod目录>`：只加载一次并报告 mod 问题（`spaces-ide` 在 `init()` 会调 `hc`，建议加 `timeout 6 ... < /dev/null`）
- `hc ls --json` / `hc read <终端> --lines 18`：看终端状态与实际屏幕内容
- `herdr-app shot out.png`：截图当前窗口

## 换机 / 分发

- 新电脑：装 Herdr Desktop 并**启动一次** → 解开 zip → `powershell -ExecutionPolicy Bypass -File .\install-on-new-pc.ps1`（WSL 机器加 `-ConnectWsl`）。脚本会拷 assets、跑 deploy、还原 bundle 配置、逐个 check、切到 terminals-git 布局。
- 已配置的电脑更新：`git pull` → `cd herdr-app-git-mods; .\deploy.ps1` → 重启 app。
- git 方式：`git clone https://github.com/mushishixian/herdr-ide.git`，然后同上跑 install 脚本。

## 踩过的坑（改之前先读）

- **Windows 上 herdr 的 `bash` 是 WSL bash**（`OSTYPE=linux-gnu`），`sh` 也走 WSL。不要用 `bash -lc` / `sh -c` 处理 Windows 路径；要 shell 就用 PowerShell，要快就用 node。
- **列目录不要用 PowerShell**：冷启动约 1 秒。`ide-sidebar` 的 `listMany()` 用一次 `node -e readdirSync` 列全部目录（约 180ms），PowerShell 只作兜底；`node` 不在 PATH 时会退化成慢路径。
- **space 的 ahead/behind** 由 `ide.git.dirtySeq` 即时刷新：push/pull/commit/保存后 `common.js` 的 `bumpGitDirty()` 递增，`spaces-ide` 每 250ms 检查。不要退回只靠 `watchFolder` + 60 秒兜底。
- **Resume / auto-resume agent 功能已删除**（活跃 agent 检测不可靠，会出现两个 agent 并存）。不要加回横幅或自动恢复；若要「已有 agent 时聚焦原 pane」，先和用户确认。
- **popup 都是固定尺寸 overlay**（`mod.json` 的 `overlay.height`）。长内容要按行数算高度，并用 `div().relative().h(n)` 包 `div().absolute().inset_0().overflow_y_scroll()` 内部滚动，否则会被裁掉（AI commit 弹窗即此修法）。
- `deploy.ps1` 用 `ConvertTo-Json` 重写 `mod.json`，会重排字段顺序，属正常。
- `assets/spaces-ide`、`assets/terminals-bar-git` 是**从运行中的 mods 复制回来**的（`export-bundle.ps1` 负责），所以改完要先部署再 export 才能保持一致。

## 安全

- `herdr-app-git-mods/bundle/ai-commit.json` 含明文 `api_key` 且已入库。不要外传 zip 或该文件；如已公开需换 key 并移出版本库。
- `bundle/` 的配置含个人设置（布局、键位、AI 接口地址/模型），分发前确认对象。
