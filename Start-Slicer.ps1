param([switch]$Plan, [switch]$ClearLockout)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Install Node.js 22 or newer and reopen PowerShell.' }
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath './node_modules')) { npm install }
    if ($Plan) { & $nodeCommand.Source src/plan.js }
    elseif ($ClearLockout) { & $nodeCommand.Source src/index.js --clear-lockout }
    else { & $nodeCommand.Source src/index.js }
    exit $LASTEXITCODE
} finally { Pop-Location }
