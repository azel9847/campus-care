$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    throw "Backend environment not found. Run .\scripts\setup.ps1 first."
}
Push-Location $backend
try {
    & $python -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed with exit code $LASTEXITCODE." }
    & $python -m app.seed_admin
    if ($LASTEXITCODE -ne 0) { throw "Administrator setup failed with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}
