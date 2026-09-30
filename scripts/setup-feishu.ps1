$ErrorActionPreference = "Stop"

$webhook = (Read-Host "请输入目标飞书群自定义机器人的 webhook 地址").Trim()
try { $uri = [Uri]$webhook } catch { throw "webhook 地址格式不正确" }
if ($uri.Scheme -ne "https" -or $uri.Host -ne "open.feishu.cn" -or -not $uri.AbsolutePath.StartsWith("/open-apis/bot/v2/hook/")) {
  throw "请输入 https://open.feishu.cn/open-apis/bot/v2/hook/ 开头的地址"
}

$secureSecret = Read-Host "请输入签名密钥（机器人未开启签名校验时直接回车）" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }

$envPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.env.local"))
$lines = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllLines($envPath) } else { @() }

function Set-EnvValue([string[]]$CurrentLines, [string]$Name, [string]$Value) {
  $result = [Collections.Generic.List[string]]::new()
  $found = $false
  foreach ($line in $CurrentLines) {
    if ($line -match "^$([Regex]::Escape($Name))=") {
      if (-not $found) { $result.Add("$Name=$Value") }
      $found = $true
    } else {
      $result.Add($line)
    }
  }
  if (-not $found) { $result.Add("$Name=$Value") }
  return $result.ToArray()
}

$lines = Set-EnvValue $lines "FEISHU_WEBHOOK_URL" $webhook
$lines = Set-EnvValue $lines "FEISHU_SIGN_SECRET" $secret
[IO.File]::WriteAllText($envPath, (($lines -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

Write-Host "飞书机器人配置已安全保存到本机 .env.local。"
Write-Host "接下来运行 npm run test:feishu 验证群内是否收到消息。"
