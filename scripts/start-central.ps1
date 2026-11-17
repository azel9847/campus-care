$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$python = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    throw "Backend environment not found. Run .\scripts\setup.ps1 first."
}
if (-not (Test-Path (Join-Path $backend ".env"))) {
    throw "backend\.env is missing. Run setup and configure the database before startup."
}

$bindAddress = if ($env:CAMPUS_BIND_ADDRESS) { $env:CAMPUS_BIND_ADDRESS } else { "0.0.0.0" }
$port = if ($env:CAMPUS_PORT) { $env:CAMPUS_PORT } else { "8000" }
Push-Location $backend
try {
    & $python -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed with exit code $LASTEXITCODE." }
    & $python -m uvicorn app.main:app --host $bindAddress --port $port --workers 1
    if ($LASTEXITCODE -ne 0) { throw "FastAPI stopped with exit code $LASTEXITCODE." }
}
finally {
    Pop-Location
}
