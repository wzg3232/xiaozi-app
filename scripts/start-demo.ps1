$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.\node_modules\ws')) { & npm ci --no-fund --no-audit; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& node '.\scripts\build-web.mjs'
$env:HOST = '0.0.0.0'
& node '.\server\index.mjs' --demo
