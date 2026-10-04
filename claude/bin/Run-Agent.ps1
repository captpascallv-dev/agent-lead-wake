# Runs inside the detached process started by Dispatch.ps1. Do not call directly.
# 由 Dispatch.ps1 在后台进程里拉起：按 spec.json 执行 agent CLI，写日志和退出码。
param([Parameter(Mandatory = $true)][string]$JobDir)
$spec = Get-Content -LiteralPath (Join-Path $JobDir 'spec.json') -Raw | ConvertFrom-Json -AsHashtable
# UTF-8 both ways; otherwise non-ASCII prompts/logs get mangled on Windows (e.g. GBK code page).
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
foreach ($k in $spec.env.Keys) { if ($spec.env[$k]) { [Environment]::SetEnvironmentVariable($k, $spec.env[$k]) } }
Set-Location -LiteralPath $spec.cwd
$log = Join-Path $JobDir 'agent.log'
$cmdArgs = @($spec.args)
if ($spec.stdin_card) {
    Get-Content -LiteralPath $spec.card -Raw | & $spec.command @cmdArgs *> $log
} else {
    & $spec.command @cmdArgs *> $log
}
"$LASTEXITCODE" | Set-Content (Join-Path $JobDir 'exit_code.txt')
