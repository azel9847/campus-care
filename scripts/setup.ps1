$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"
$pythonEnv = Join-Path $backend ".venv"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3.11+ is required. Install Python and reopen PowerShell."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js 20+ (including npm) is required."
}

if (-not (Test-Path $pythonEnv)) {
    python -m venv $pythonEnv
}
$python = Join-Path $pythonEnv "Scripts\python.exe"
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $backend "requirements.txt")
npm --prefix $frontend install
npm --prefix $frontend run build

$envTarget = Join-Path $backend ".env"
if (-not (Test-Path $envTarget)) {
    Copy-Item (Join-Path $root ".env.example") $envTarget
    Write-Output "Created backend\.env from .env.example. Edit its PostgreSQL password and JWT_SECRET before startup."
}
Write-Output "Setup complete. Configure PostgreSQL, then run scripts\create-admin.ps1 and scripts\start-central.ps1."
