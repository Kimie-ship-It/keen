param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$logs = Join-Path $root "data\logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$log = Join-Path $logs ("collect-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
$stdout = Join-Path $logs ("collector-" + $PID + ".stdout.tmp")
$stderr = Join-Path $logs ("collector-" + $PID + ".stderr.tmp")
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  $script = Join-Path $PSScriptRoot "collect-daily.mjs"
  $process = Start-Process -FilePath $NodePath -ArgumentList ('"' + $script + '"') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $code = $process.ExitCode
  $parts = @()
  if (Test-Path -LiteralPath $stdout) { $parts += [System.IO.File]::ReadAllText($stdout, $utf8).TrimEnd() }
  if (Test-Path -LiteralPath $stderr) { $parts += [System.IO.File]::ReadAllText($stderr, $utf8).TrimEnd() }
  $text = ($parts | Where-Object { $_ }) -join [Environment]::NewLine
  if ($text) { [System.IO.File]::AppendAllText($log, $text + [Environment]::NewLine, $utf8) }
} finally {
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
}
exit $code
