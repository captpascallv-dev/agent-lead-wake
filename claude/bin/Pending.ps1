# List dispatched jobs whose outbox has no READY.json yet, with the command to re-arm the watcher.
# Run once after the Claude session restarts. 会话重启后跑一次，重挂守候。
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$found = 0
Get-ChildItem (Join-Path $root 'jobs/*/job.json') -ErrorAction SilentlyContinue | ForEach-Object {
    $j = Get-Content $_.FullName -Raw | ConvertFrom-Json
    if (Test-Path -LiteralPath (Join-Path $j.outbox 'READY.json')) { return }
    $found++
    $alive = $j.host_pid -and [bool](Get-Process -Id $j.host_pid -ErrorAction SilentlyContinue)
    "PENDING $($j.job_id) | $($j.executor) | $($j.task) | pid=$($j.host_pid) alive=$alive | outbox=$($j.outbox)"
    "  WATCH: pwsh -NoProfile -File `"$PSScriptRoot/Wait-Delivery.ps1`" -JobDir `"$($j.outbox)`" -ProcessId $($j.host_pid) -TimeoutMinutes 29 -IntervalSeconds 20"
}
if ($found -eq 0) { 'NO PENDING JOBS' }
