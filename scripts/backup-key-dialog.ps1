param(
  [ValidateSet('export', 'verify')][string]$Mode = 'export',
  [string]$Destination,
  [Parameter(Mandatory = $true)][string]$Snapshot,
  [string]$DriveLetter = 'D:',
  [string]$VolumeName = 'KINGSTON'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path ($DriveLetter + '\') '校招雷达密钥备份' }
$snapshotPath = (Resolve-Path -LiteralPath $Snapshot).Path
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
if (-not $destinationPath.StartsWith($DriveLetter + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must be on the confirmed USB drive' }
function Assert-Usb {
  $disk = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $DriveLetter }
  if (-not $disk -or $disk.DriveType -ne 2 -or $disk.VolumeName -ne $VolumeName) { throw 'Confirmed USB drive is unavailable; no export performed' }
}
Assert-Usb
$form = New-Object System.Windows.Forms.Form
$form.Text = '校招雷达 - U盘密钥备份'
$form.ClientSize = New-Object System.Drawing.Size(510, 290)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.SetBounds(20, 15, 470, 64)
$label.Text = "目标：$DriveLetter $VolumeName`n设置独立保护密码，至少12个字符。不是数据库密码。`n请另行记住或保管密码；不要发送到聊天或网盘。"
$form.Controls.Add($label)
$firstLabel = New-Object System.Windows.Forms.Label
$firstLabel.SetBounds(20, 87, 140, 22)
$firstLabel.Text = '保护密码'
$form.Controls.Add($firstLabel)
$first = New-Object System.Windows.Forms.TextBox
$first.SetBounds(165, 82, 320, 28)
$first.UseSystemPasswordChar = $true
$first.MaxLength = 256
$form.Controls.Add($first)
$secondLabel = New-Object System.Windows.Forms.Label
$secondLabel.SetBounds(20, 125, 140, 22)
$secondLabel.Text = '再次输入保护密码'
$form.Controls.Add($secondLabel)
$second = New-Object System.Windows.Forms.TextBox
$second.SetBounds(165, 120, 320, 28)
$second.UseSystemPasswordChar = $true
$second.MaxLength = 256
$form.Controls.Add($second)
$status = New-Object System.Windows.Forms.Label
$status.SetBounds(20, 158, 470, 64)
$status.Text = '只保存加密后的备份密钥，不复制本机配置。'
$form.Controls.Add($status)
$submit = New-Object System.Windows.Forms.Button
$submit.SetBounds(260, 235, 110, 32)
$submit.Text = if ($Mode -eq 'export') { '保存并验证' } else { '重新验证' }
$form.Controls.Add($submit)
$cancel = New-Object System.Windows.Forms.Button
$cancel.SetBounds(380, 235, 105, 32)
$cancel.Text = '取消'
$cancel.Add_Click({ $form.Close() })
$form.Controls.Add($cancel)
$form.AcceptButton = $submit
$form.CancelButton = $cancel
$submit.Add_Click({
  if ($first.Text.Trim().Length -lt 12 -or $first.Text -cne $second.Text) {
    $status.Text = '两次密码须完全相同，且至少12个字符。'
    return
  }
  $submit.Enabled = $false
  $cancel.Enabled = $false
  $status.Text = '正在写入并从U盘读回，执行隔离恢复检查，请稍候。'
  $form.Refresh()
  $process = $null
  try {
    Assert-Usb
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command node -ErrorAction Stop).Source
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $start.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($argument in @((Join-Path $PSScriptRoot 'backup-key.mjs'), $Mode, $destinationPath, $snapshotPath)) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    # Send the password only through the child's private stdin, not arguments, environment or a file.
    $process.StandardInput.WriteLine((@{ password = $first.Text } | ConvertTo-Json -Compress))
    $process.StandardInput.Close()
    $first.Clear()
    $second.Clear()
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(300000)) {
      $process.Kill($true)
      throw 'Verification timed out'
    }
    $output = $outputTask.GetAwaiter().GetResult()
    $null = $errorTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'Verification failed' }
    $result = $output | ConvertFrom-Json
    if ($result.verifiedUsing -ne 'external-key-file' -or $result.contents -ne 'identical' -or $result.productionWrites -ne $false) { throw 'Incomplete verification' }
    $record = Join-Path $root 'data/key-backup-result.json'
    [System.IO.File]::WriteAllText($record, $output, [System.Text.UTF8Encoding]::new($false))
    $status.Text = "已完成U盘读回和八表隔离恢复检查。`n未覆盖正式数据库，请妥善保管U盘和密码。"
    $cancel.Text = '关闭'
  } catch {
    $status.Text = '没有完成验证。请检查U盘、密码和网络；可能已有加密文件，请勿删除，未更换本机密钥。'
    $submit.Enabled = $true
  } finally {
    $first.Clear()
    $second.Clear()
    if ($process) { $process.Dispose() }
    $cancel.Enabled = $true
  }
})
$null = $form.ShowDialog()
$form.Dispose()
