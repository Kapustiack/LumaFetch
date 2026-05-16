$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

npm ci
npm run build

Write-Host ""
Write-Host "Built LumaFetch release artifacts in: $PSScriptRoot\release"
