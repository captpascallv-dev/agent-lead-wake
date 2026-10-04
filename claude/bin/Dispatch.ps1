# Dispatch one task card to an external agent CLI, detached; print the watch command.
# 派一个任务卡给外部 agent CLI（后台隐藏进程），输出守候命令。
#
#   pwsh -File Dispatch.ps1 -Executor codex -Workspace <dir> -Outbox <dir> -PromptFile <card.md> -Task "name"
#
# Executors are defined in executors.json (copy executors.example.json). No model/account is hard-coded here.
param(
    [Parameter(Mandatory = $true)][string]$Executor,
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$Outbox,
    [Parameter(Mandatory = $true)][string]$PromptFile,
    [Parameter(Mandatory = $true)][string]$Task,
    [string]$Project = '',
    [ValidatePattern('^$|^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')][string]$JobId = '',
    [int]$TimeoutMinutes = 90,
    [string]$Config = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
if (-not $Config) { $Config = Join-Path $root 'executors.json' }
if (-not (Test-Path -LiteralPath $Config)) { Write-Error "Config not found: $Config (copy executors.example.json to executors.json)"; exit 2 }
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json -AsHashtable
if (-not $cfg.executors.ContainsKey($Executor)) { Write-Error "Unknown executor '$Executor'. Known: $($cfg.executors.Keys -join ', ')"; exit 2 }
$e = $cfg.executors[$Executor]

foreach ($p in $Workspace, $PromptFile) { if (-not (Test-Path -LiteralPath $p)) { Write-Error "Not found: $p"; exit 2 } }
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$PromptFile = (Resolve-Path -LiteralPath $PromptFile).Path
if (Test-Path -LiteralPath (Join-Path $Outbox 'READY.json')) {
    throw "Outbox already contains READY.json: $Outbox. Use a new outbox for each task; existing delivery files are preserved."
}
New-Item -ItemType Directory -Force $Outbox | Out-Null
$Outbox = (Resolve-Path -LiteralPath $Outbox).Path
if (-not $JobId) { $JobId = [guid]::NewGuid().ToString('D') }
$jobDir = Join-Path $root "jobs/$JobId"

$tokens = @{ '{workspace}' = $Workspace; '{outbox}' = $Outbox; '{card}' = $PromptFile; '{carddir}' = (Split-Path -Parent $PromptFile); '{jobdir}' = $jobDir }
function Expand([string]$s) { foreach ($k in $tokens.Keys) { $s = $s.Replace($k, $tokens[$k]) }; $s }
$pointerTemplate = if ($cfg.pointer) { $cfg.pointer } else { 'Read the task card file "{card}" (UTF-8) in full and follow it exactly. Do nothing outside the card.' }
$tokens['{pointer}'] = Expand $pointerTemplate

$cmd = Get-Command $e.command -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cmd) { Write-Error "Command not found on PATH: $($e.command)"; exit 2 }
$spec = [ordered]@{
    command    = $cmd.Source
    args       = @($e.args | ForEach-Object { Expand $_ })
    cwd        = if ($e.cwd) { Expand $e.cwd } else { $Workspace }
    stdin_card = [bool]$e.stdin_card
    card       = $PromptFile
    env        = if ($e.env) { $e.env } else { @{} }
}

if ($DryRun) { "DRYRUN JobId=$JobId executor=$Executor"; $spec | ConvertTo-Json -Depth 5; exit 0 }
if (Test-Path -LiteralPath $jobDir) { Write-Error "Job exists: $jobDir"; exit 2 }
New-Item -ItemType Directory -Force $jobDir | Out-Null
Copy-Item -LiteralPath $PromptFile (Join-Path $jobDir 'TASK_CARD.md')
$spec | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $jobDir 'spec.json') -Encoding utf8

$runner = Join-Path $PSScriptRoot 'Run-Agent.ps1'
$startArgs = @{ FilePath = 'pwsh'; ArgumentList = @('-NoProfile', '-File', "`"$runner`"", '-JobDir', "`"$jobDir`""); PassThru = $true }
if ($IsWindows) { $startArgs.WindowStyle = 'Hidden' }
$proc = Start-Process @startArgs

[ordered]@{
    job_id = $JobId; project = $Project; task = $Task; executor = $Executor
    workspace = $Workspace; outbox = $Outbox; host_pid = $proc.Id
    timeout_minutes = $TimeoutMinutes; dispatched_at = (Get-Date -Format o)
} | ConvertTo-Json | Set-Content (Join-Path $jobDir 'job.json') -Encoding utf8

"DISPATCHED JobId=$JobId executor=$Executor pid=$($proc.Id)"
"WATCH: pwsh -NoProfile -File `"$PSScriptRoot/Wait-Delivery.ps1`" -JobDir `"$Outbox`" -ProcessId $($proc.Id) -TimeoutMinutes 29 -IntervalSeconds 20"
"NOTE: The 29-min watcher default is based on a contributor-reported ~30-min Claude Code background limit; verify your version. If the watcher exits with code 2 while pid is alive, re-arm WATCH."
