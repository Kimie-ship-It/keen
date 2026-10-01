param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+\.pooler\.supabase\.com$')][string]$PoolerHost
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.local'
if (-not (Test-Path -LiteralPath $envFile)) { throw 'Local configuration is missing' }
$lines = [System.IO.File]::ReadAllLines($envFile)
$source = @($lines | Where-Object { $_ -match '^SUPABASE_DB_URL=' })
if ($source.Count -ne 1 -or $source[0] -match [regex]::Escape($ProjectRef)) { throw 'Restore target must differ from the live database' }
$form = New-Object System.Windows.Forms.Form
$form.Text = '校招雷达 - 独立恢复库连接'
$form.ClientSize = New-Object System.Drawing.Size(520, 205)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.SetBounds(18, 15, 485, 53)
$label.Text = "新项目：$ProjectRef`n只在本机保存新库密码，不修改网站现有连接。请勿在聊天中发送密码。"
$form.Controls.Add($label)
$password = New-Object System.Windows.Forms.TextBox
$password.SetBounds(18, 79, 485, 27)
$password.UseSystemPasswordChar = $true
$password.MaxLength = 512
$form.Controls.Add($password)
$status = New-Object System.Windows.Forms.Label
$status.SetBounds(18, 114, 485, 30)
$form.Controls.Add($status)
$save = New-Object System.Windows.Forms.Button
$save.SetBounds(275, 156, 110, 30)
$save.Text = '保存连接'
$form.Controls.Add($save)
$cancel = New-Object System.Windows.Forms.Button
$cancel.SetBounds(393, 156, 110, 30)
$cancel.Text = '取消'
$cancel.Add_Click({ $form.Close() })
$form.Controls.Add($cancel)
$form.AcceptButton = $save
$form.CancelButton = $cancel
$save.Add_Click({
  if ([string]::IsNullOrWhiteSpace($password.Text)) { $status.Text = '请输入新项目的数据库密码。'; return }
  $encoded = [uri]::EscapeDataString($password.Text)
  $url = "postgresql://postgres.$ProjectRef`:$encoded@$PoolerHost`:5432/postgres"
  $updated = @($lines | Where-Object { $_ -notmatch '^SUPABASE_RESTORE_DB_URL=' })
  $updated += "SUPABASE_RESTORE_DB_URL=$url"
  [System.IO.File]::WriteAllLines($envFile, $updated, [System.Text.UTF8Encoding]::new($false))
  $password.Clear()
  $status.Text = '新库连接已保存到本机，尚未写入数据库。'
  $save.Enabled = $false
  $cancel.Text = '关闭'
})
$null = $form.ShowDialog()
$password.Clear()
$form.Dispose()
