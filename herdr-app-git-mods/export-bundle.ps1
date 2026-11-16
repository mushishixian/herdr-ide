$ErrorActionPreference = "Stop"
$herdrHome = "$env:USERPROFILE\.config\herdr-app"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundleDir = Join-Path $repoRoot "bundle"
$assetsDir = Join-Path $repoRoot "assets"

New-Item -ItemType Directory -Force -Path (Join-Path $bundleDir "layouts") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $assetsDir "terminals-bar-git") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $assetsDir "spaces-ide") | Out-Null

# 1. Export all user configurations (including AI Commit API key/model, keymap, layout, font settings)
$files = @(
  "ai-commit.json",
  "ide-settings.json",
  "programs.json",
  "keys.json",
  "settings.json",
  "layouts\terminals-git.json",
  "layouts\ide.json"
)
foreach ($f in $files) {
  $src = Join-Path $herdrHome $f
  if (Test-Path $src) {
    $dst = Join-Path $bundleDir $f
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -Force $src $dst
    Write-Host "Exported: $f"
  }
}

# 2. Export static assets & cloned mods needed on a fresh PC
Copy-Item -Force "$herdrHome\mods\terminals-bar-git\*" (Join-Path $assetsDir "terminals-bar-git")
Copy-Item -Force "$herdrHome\mods\spaces-ide\*" (Join-Path $assetsDir "spaces-ide")

# 3. Create one portable zip archive
$zipPath = Join-Path (Split-Path -Parent $repoRoot) "herdr-ide-portable.zip"
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path "$repoRoot\*" -DestinationPath $zipPath -Force
Write-Host "Created portable archive: $zipPath"
