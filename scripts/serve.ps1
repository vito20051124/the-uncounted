<#
.SYNOPSIS
    Launch "The Uncounted" (P0 prototype) dev server.

.DESCRIPTION
    Starts the Vite dev server on port 4174 (codex/ owns 4173).
    Runs npm install on first launch. Kills stale node processes that
    would otherwise hold the port and serve an outdated build.

    NOTE: kept ASCII-only on purpose. Windows PowerShell 5.1 mis-decodes
    UTF-8-without-BOM scripts as ANSI, which corrupts CJK and breaks
    parsing. The repo folder name is CJK, so the path is derived from
    $PSScriptRoot at run time and never written literally.

.EXAMPLE
    .\serve.ps1 -Open
#>

param(
    [int]$Port = 4174,
    [switch]$Open,
    [switch]$Build
)

$ErrorActionPreference = "Stop"

# game/scripts/ -> game/
$GameDir = (Get-Item $PSScriptRoot).Parent.FullName
$PkgJson = Join-Path $GameDir "package.json"

if (-not (Test-Path $PkgJson)) {
    Write-Warning "package.json not found under: $GameDir"
    exit 2
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Warning "Node.js not found on PATH. Node >= 20 required."; exit 3 }
if (-not $npm) { Write-Warning "npm not found on PATH."; exit 3 }

# Free the port: a stale server would silently serve an outdated build.
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
        try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop }
        catch { }
    }

Push-Location $GameDir
try {
    if (-not (Test-Path (Join-Path $GameDir "node_modules"))) {
        Write-Host "Installing dependencies (first run)..."
        & $npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Write-Warning "npm install failed."; exit 4 }
    }

    Write-Host "Validating game data..."
    & $node "scripts/validate-data.mjs"
    if ($LASTEXITCODE -ne 0) { Write-Warning "Data validation failed. Fix data before running."; exit 5 }

    if ($Build) {
        & $npm run build
        if ($LASTEXITCODE -ne 0) { Write-Warning "Build failed."; exit 6 }
        Write-Host "Built to game/dist/ (fully offline, no CDN)."
        exit 0
    }

    if ($Open) { Start-Process "http://localhost:$Port/" }

    $env:PORT = "$Port"
    & $npm run dev
}
finally {
    Pop-Location
}
