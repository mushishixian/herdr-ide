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
  @{ name = "git-pull";      action = "pull";      title = "Git Pull";    width = 480; height = 140 },
  @{ name = "git-push";      action = "push";      title = "Git Push";    width = 480; height = 140 },
  @{ name = "git-undo";      action = "undo";      title = "Undo Commit"; width = 480; height = 140 },
  @{ name = "git-ai-commit"; action = "ai-commit"; title = "AI Commit";   width = 560; height = 260 }
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
  overlay = @{ kind = "popup"; at = "top"; offset = 32; width = 960; height = 0.82 }
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

# 8. Top bar for terminals-git layout & larger Toast notifications
$tbCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src\terminals-bar-git.js"), $utf8NoBom)
Deploy-Mod "terminals-bar-git" $null $tbCode

$toastCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src\ide-toast.js"), $utf8NoBom)
Deploy-Mod "ide-toast" @{ place = "none" } $toastCode

# 9. Git status bar (embedded by layoutside.json; mod.json keeps it from docking on its own)
$gsCode = [System.IO.File]::ReadAllText((Join-Path $repoRoot "mods\git-status\main.js"), $utf8NoBom)
Deploy-Mod "git-status" @{ place = "none"; title = "Git Status" } $gsCode
