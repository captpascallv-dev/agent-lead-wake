# Wait for one dispatched job to reach any terminal state, then exit so the Lead session is woken.
# Local only: no model calls. Exit codes: 0 delivered (READY.json), 3 executor ended without READY,
# 4 executor process gone without READY, 2 timed out.
param(
    [Parameter(Mandatory = $true)][string]$JobDir,
    [string[]]$TerminalFiles = @(),   # executor-native end markers, e.g. <state>\jobs\<id>\receipt.json
    [int]$ProcessId = 0,              # optional executor PID; its exit without READY counts as terminal
    [double]$TimeoutMinutes = 720,
    [int]$IntervalSeconds = 15
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ready = Join-Path $JobDir 'READY.json'
$log = Join-Path $JobDir 'watch.log'
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)

function Finish([int]$code, [string]$state, [string]$detail) {
    $line = "{0} {1} {2}" -f (Get-Date -Format s), $state, $detail
    Add-Content -LiteralPath $log -Value $line -Encoding utf8
    "DELIVERY-WATCH job=$JobDir state=$state $detail"
    exit $code
}

Add-Content -LiteralPath $log -Value ("{0} watching pid={1} timeout_min={2}" -f (Get-Date -Format s), $ProcessId, $TimeoutMinutes) -Encoding utf8
while ($true) {
    if (Test-Path -LiteralPath $ready) {
        $status = 'unknown'
        try { $status = (Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json).status } catch { $status = 'unparseable' }
        Finish 0 'ready' "ready_status=$status"
    }
    foreach ($f in $TerminalFiles) {
        if (Test-Path -LiteralPath $f) { Start-Sleep -Seconds 5; if (-not (Test-Path -LiteralPath $ready)) { Finish 3 'ended-without-ready' "marker=$f" } }
    }
    if ($ProcessId -gt 0 -and -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        Start-Sleep -Seconds 5
        if (-not (Test-Path -LiteralPath $ready)) { Finish 4 'process-gone-without-ready' "pid=$ProcessId" }
    }
    if ((Get-Date) -ge $deadline) { Finish 2 'timeout' "after_min=$TimeoutMinutes" }
    Start-Sleep -Seconds $IntervalSeconds
}
