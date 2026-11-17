$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $root "frontend"
npm --prefix $frontend run dev
if ($LASTEXITCODE -ne 0) { throw "Vite stopped with exit code $LASTEXITCODE." }
