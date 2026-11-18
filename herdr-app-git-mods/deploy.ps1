param([string]$WslDistro = "ubuntu")

$ErrorActionPreference = "Stop"
$herdrMods = "$env:USERPROFILE\.config\herdr-app\mods"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Deploy-Mod($name, $modJsonObj, $mainJsContent) {
  $dir = Join-Path $herdrMods $name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $coreOld = Join-Path $dir "core.js"
  if (Test-Path $coreOld) { Remove-Item -Force $coreOld }
  if ($modJsonObj) {
    $json = $modJsonObj | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText((Join-Path $dir "mod.json"), $json, $utf8NoBom)
  }
  [System.IO.File]::WriteAllText((Join-Path $dir "main.js"), $mainJsContent, $utf8NoBom)
}

function Parse-HerdrImports($code) {
  $m = [regex]::Match($code, 'import\s+\{([^}]*)\}\s+from\s+"herdr";')
  if (-not $m.Success) { return @() }
  return $m.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
}

function Bundle-WithCommon($sourceRelPath) {
  $raw = [System.IO.File]::ReadAllText((Join-Path $repoRoot $sourceRelPath), $utf8NoBom)
  $commonRaw = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src\common.js"), $utf8NoBom)

  $merged = [System.Collections.Generic.List[string]]::new()
  foreach ($id in (Parse-HerdrImports $raw) + (Parse-HerdrImports $commonRaw)) {
    if (-not $merged.Contains($id)) { $merged.Add($id) }
  }
  $herdrLine = "import { $($merged -join ', ') } from `"herdr`";"

  $rawNoHerdr = [regex]::Replace($raw, 'import\s+\{[^}]*\}\s+from\s+"herdr";\s*', '', 1)
  $commonBody = ([regex]::Replace($commonRaw, '^import\s+\{[^}]*\}\s+from\s+"herdr";\s*', '')).Trim()

  $rx = [regex]::new('(?s)^((?:import\s+.*?;\s*\r?\n)*)')
  return $rx.Replace($rawNoHerdr, { param($m) $m.Groups[1].Value + $herdrLine + "`n`n" + $commonBody + "`n`n" }, 1)
}

function Inline-DefaultMode($rawCode, $defaultPropsObjLiteral) {
  $replaced = $rawCode -replace "export default class (\w+) extends View", 'class $1 extends View'
  $cls = ([regex]::Match($rawCode, "export default class (\w+) extends View")).Groups[1].Value
  return @"
$replaced

export default class ModEntry extends $cls {
  init(p, cx) {
    super.init({ ...$defaultPropsObjLiteral, ...(p ?? {}) }, cx);
  }
}
"@
}

function Inline-ForcedMode($rawCode, $forcedPropsObjLiteral) {
  $replaced = $rawCode -replace "export default class (\w+) extends View", 'class $1 extends View'
  $cls = ([regex]::Match($rawCode, "export default class (\w+) extends View")).Groups[1].Value
  return @"
$replaced

export default class ModEntry extends $cls {
  init(p, cx) {
    super.init({ ...(p ?? {}), ...$forcedPropsObjLiteral }, cx);
  }
}
"@
}

# 1. Git Branch Popups (Switch / Merge / Rename / New)
$branchRaw = Bundle-WithCommon "src\core.js"
$branchModes = @(
  @{ name = "git-branch"; mode = "switch"; title = "Git Branch";    height = 0.72; defaultOnly = $true },
  @{ name = "git-merge";  mode = "merge";  title = "Merge Branch";  height = 0.72; defaultOnly = $false },
  @{ name = "git-rename"; mode = "rename"; title = "Rename Branch"; height = 0.45; defaultOnly = $false },
  @{ name = "git-new";    mode = "new";    title = "New Branch";    height = 0.45; defaultOnly = $false }
)
foreach ($m in $branchModes) {
  $code = if ($m.defaultOnly) {
    Inline-DefaultMode $branchRaw "{ mode: `"$($m.mode)`" }"
  } else {
    Inline-ForcedMode $branchRaw "{ mode: `"$($m.mode)`" }"
  }
  Deploy-Mod $m.name @{
    place = "none"; title = $m.title
    overlay = @{ kind = "popup"; at = "top"; offset = 40; width = 540; height = $m.height }
  } $code
}

# 2. Git Quick Actions (Pull / Push / Undo Commit / AI Commit)
$qaRaw = Bundle-WithCommon "src\git-quick-action.js"
$actions = @(
  @{ name = "git-pull";      action = "pull";      title = "Git Pull";         width = 480; height = 140 },
  @{ name = "git-push";      action = "push";      title = "Git Push";         width = 480; height = 140 },
  @{ name = "git-sync";      action = "sync";      title = "Git Sync";         width = 480; height = 140 },
  @{ name = "git-undo";      action = "undo";      title = "Undo Commit";      width = 480; height = 140 },
  @{ name = "git-ai-commit"; action = "ai-commit"; title = "AI Commit";       width = 560; height = 360 },
  @{ name = "git-ai-sync";   action = "ai-sync";   title = "AI Commit & Sync"; width = 560; height = 380 }
)
foreach ($a in $actions) {
  $code = Inline-ForcedMode $qaRaw "{ action: `"$($a.action)`" }"
  Deploy-Mod $a.name @{
    place = "none"; title = $a.title
    overlay = @{ kind = "popup"; at = "top"; offset = 40; width = $a.width; height = $a.height }
  } $code
}

# 3. 3-Way Merge Editor
$meCode = Bundle-WithCommon "src\merge-editor.js"
Deploy-Mod "merge-editor" @{
  place = "none"; title = "3-Way Merge Editor"
  overlay = @{ kind = "popup"; at = "top"; offset = 24; width = 0.76; height = 0.90 }
} $meCode

# 4. Search / Navigation Popups (Quick Open / Content Search / Replace / Symbol Search)
$spRaw = Bundle-WithCommon "src\search-popups.js"
$searches = @(
  @{ name = "quick-open";     mode = "files";   title = "Quick Open" },
  @{ name = "content-search"; mode = "search";  title = "Search in Files" },
  @{ name = "replace-popup";  mode = "replace"; title = "Replace in Files" },
  @{ name = "symbol-search";  mode = "symbols"; title = "Go to Symbol" }
)
foreach ($s in $searches) {
  $code = Inline-ForcedMode $spRaw "{ mode: `"$($s.mode)`" }"
  Deploy-Mod $s.name @{
    place = "none"; title = $s.title
    overlay = @{ kind = "popup"; at = "top"; offset = 32; width = 940; height = 0.80 }
  } $code
}

# 5. Unified IDE Sidebar (Explorer / Search / Source Control / Settings)
$sbCode = Bundle-WithCommon "src\ide-sidebar.js"
Deploy-Mod "ide-sidebar" @{
  place = "none"; title = "IDE Sidebar"
} $sbCode

# 6. Center File Editor Pane (Built-in fallback & center Diff viewer)
$edCode = Bundle-WithCommon "src\ide-editor.js"
Deploy-Mod "ide-editor" @{
  place = "none"; title = "Editor"
} $edCode

# 7. Context Menu Popup for Files & Git
$menuCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src\ide-menu.js"), $utf8NoBom)
Deploy-Mod "ide-menu" @{
  place = "none"; title = "Menu"
} $menuCode

# 7b. Terminal right-click menu (layout root "terminal_menu"): Fresh items + herdr pane items
$tmCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src\ide-term-menu.js"), $utf8NoBom)
Deploy-Mod "ide-term-menu" @{
  place = "none"; title = "Terminal Menu"
  overlay = @{ width = 260; height = 520 }
} $tmCode

# 8. Top bar for terminals-git layout & larger Toast notifications
$tbCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src\terminals-bar-git.js"), $utf8NoBom)
Deploy-Mod "terminals-bar-git" $null $tbCode

$toastCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src\ide-toast.js"), $utf8NoBom)
Deploy-Mod "ide-toast" @{ place = "none" } $toastCode

# Git history popups: selected-line history (opened by ide-editor Ctrl+Alt+O or
# relayed from Fresh via ide-sidebar) and repository commit history (Ctrl+Alt+H).
$glhRaw = Bundle-WithCommon "src\git-line-history.js"
$glhLineCode = Inline-ForcedMode $glhRaw '{ mode: "line" }'
Deploy-Mod "git-line-history" @{
  place = "none"; title = "Line History"
  overlay = @{ kind = "popup"; at = "top"; offset = 40; width = 860; height = 560 }
} $glhLineCode

$glhRepoCode = Inline-ForcedMode $glhRaw '{ mode: "repo" }'
Deploy-Mod "git-history" @{
  place = "none"; title = "Commit History"
  overlay = @{ kind = "popup"; at = "top"; offset = 40; width = 860; height = 560 }
} $glhRepoCode

# Recent-files list popup (ide-sidebar opens it on ctrl-tab)
$rcCode = Bundle-WithCommon "src\ide-recent.js"
Deploy-Mod "ide-recent" @{
  place = "none"; title = "Recent Files"
  overlay = @{ kind = "popup"; at = "top"; offset = 32; width = 560; height = 420 }
} $rcCode

# 9. Git status bar (embedded by layoutside.json; mod.json keeps it from docking on its own)
$gsCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "mods\git-status\main.js"), $utf8NoBom)
Deploy-Mod "git-status" @{ place = "none"; title = "Git Status" } $gsCode

# 10. Spaces rail (hand-written mod: agent status probing lives here)
$spCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "assets\spaces-ide\main.js"), $utf8NoBom)
Deploy-Mod "spaces-ide" $null $spCode

# 11. Pane header with a per-agent icon (replaces the shipped terminals-pane)
$phCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "mods\ide-pane-header\main.js"), $utf8NoBom)
Deploy-Mod "ide-pane-header" @{ place = "none"; title = "Pane Header" } $phCode

# 12. Layout root "terminal_menu" (text edit, idempotent; no JSON rewrite)
function Set-TerminalMenuKey($path, $mod) {
  if (-not (Test-Path $path)) { return }
  $text = [System.IO.File]::ReadAllText($path, $utf8NoBom)
  if ($text -match '"terminal_menu"\s*:') { Write-Host "terminal_menu already set: $path"; return }
  $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $rx = [regex]'(?m)^([ \t]*)"id": "root",(?=\r?$)'
  if (-not $rx.IsMatch($text)) { Write-Warning "no root id line in $path"; return }
  $new = $rx.Replace($text, { param($m) $m.Value + $nl + $m.Groups[1].Value + '"terminal_menu": "' + $mod + '",' }, 1)
  [System.IO.File]::WriteAllText($path, $new, $utf8NoBom)
  Write-Host "Added terminal_menu to $path"
}
$appHome = "$env:USERPROFILE\.config\herdr-app"
# herdr-app hot-reloads a changed layout file and rebuilds its panes (closing running
# terminals), so only edit layouts while the app is closed.
$layoutsToFix = @("terminals-git.json", "ide.json") | ForEach-Object { Join-Path $appHome "layouts\$_" } |
  Where-Object { (Test-Path $_) -and -not ([System.IO.File]::ReadAllText($_) -match '"terminal_menu"\s*:') }
if ($layoutsToFix -and (Get-Process herdr-app -ErrorAction SilentlyContinue)) {
  Write-Warning "herdr-app is running: terminal_menu not added to layouts (editing them would rebuild open panes). Close herdr-app and run deploy.ps1 again."
} else {
  foreach ($path in $layoutsToFix) { Set-TerminalMenuKey $path "ide-term-menu" }
}

# 13. Fresh plugins into WSL ~/.config/fresh/plugins (every assets\fresh-plugins\*.ts)
$freshDir = Join-Path $repoRoot "assets\fresh-plugins"
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  Write-Host "wsl.exe not found: Fresh plugins not copied (copy assets\fresh-plugins\*.ts to ~/.config/fresh/plugins/ in WSL)."
} else {
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false  # pipe to wsl.exe as UTF-8, not ASCII
  foreach ($plugin in Get-ChildItem -Path $freshDir -Filter *.ts -File -ErrorAction SilentlyContinue) {
    # A symlink with the same name is someone's dotfiles link: leave it alone.
    # No double quotes in the script: Windows PowerShell 5.1 mangles them in native args.
    $cmd = 'd=$HOME/.config/fresh/plugins; f=$d/$1; mkdir -p $d && { [ -L $f ] && echo skip symlink $f >&2 || cat > $f; }'
    Get-Content -Raw -Encoding UTF8 $plugin.FullName | wsl.exe -d $WslDistro -e sh -c $cmd sh $plugin.Name
    Write-Host "Fresh plugin: $($plugin.Name)"
  }
}
