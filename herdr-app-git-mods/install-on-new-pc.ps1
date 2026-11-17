param(
  [switch]$ConnectWsl,
  [string]$WslDistro = "ubuntu"
)

$ErrorActionPreference = "Stop"
$herdrHome = "$env:USERPROFILE\.config\herdr-app"
$herdrAppExe = "$env:LOCALAPPDATA\Programs\herdr-app\herdr-app.exe"
$hcExe = "$env:LOCALAPPDATA\Programs\herdr-core\hc.exe"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundleDir = Join-Path $repoRoot "bundle"
$assetsDir = Join-Path $repoRoot "assets"

if (-not (Test-Path $herdrAppExe)) {
  throw "Herdr Desktop (herdr-app.exe) not found at $herdrAppExe. Install Herdr Desktop first and run it once."
}

New-Item -ItemType Directory -Force -Path $herdrHome | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $herdrHome "layouts") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $herdrHome "mods") | Out-Null

# 1. Restore base assets for cloned mods (spaces-ide, terminals-bar-git)
foreach ($m in @("terminals-bar-git", "spaces-ide")) {
  $src = Join-Path $assetsDir $m
  if (Test-Path $src) {
    $dst = Join-Path $herdrHome "mods\$m"
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -Force "$src\*" $dst
  }
}

# 2. Deploy all custom mods
& (Join-Path $repoRoot "deploy.ps1")

# 3. Restore all layouts & configuration files (including ai-commit.json & ide-settings.json)
$bundleFiles = @(
  "ai-commit.json",
  "ide-settings.json",
  "programs.json",
  "keys.json",
  "settings.json",
  "layouts\terminals-git.json",
  "layouts\ide.json"
)
foreach ($f in $bundleFiles) {
  $src = Join-Path $bundleDir $f
  if (Test-Path $src) {
    $dst = Join-Path $herdrHome $f
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -Force $src $dst
    Write-Host "Restored: $f"
  }
}

# 4. Validate all deployed mods
$mods = @("git-branch","git-merge","git-rename","git-new","git-pull","git-push","git-undo","git-ai-commit","git-line-history","git-history","merge-editor","ide-pane-header","quick-open","content-search","replace-popup","symbol-search","ide-sidebar","ide-editor","ide-menu","ide-recent","ide-toast","spaces-ide","terminals-bar-git","git-status")
foreach ($m in $mods) {
  $dir = Join-Path $herdrHome "mods\$m"
  if (Test-Path $dir) {
    & $herdrAppExe check $dir | Out-Null
    Write-Host "Checked: $m"
  }
}

# 5. Switch active layout if herdr-app is running
& $herdrAppExe do layout.switch --name terminals-git 2>$null | Out-Null

# 6. Optionally connect WSL2
if ($ConnectWsl -and (Test-Path $hcExe)) {
  & $hcExe machine add --via "wsl.exe -d $WslDistro -e sh -c" --name wsl --install
  $freshNotify = Join-Path $assetsDir "fresh-plugins\active_file_notify.ts"
  if (Test-Path $freshNotify) {
    Get-Content -Raw $freshNotify | wsl.exe -d $WslDistro -e sh -c 'mkdir -p "$HOME/.config/fresh/plugins" && cat > "$HOME/.config/fresh/plugins/active_file_notify.ts"'
  }
}

Write-Host "All Herdr IDE mods and configs installed successfully!"
