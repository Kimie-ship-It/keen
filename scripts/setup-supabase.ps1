$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env.local"
$hostName = "aws-0-us-east-1.pooler.supabase.com"
$port = 6543
$userName = "postgres.hogystsoivfmexdixdmi"
$password = Read-Host "Enter Supabase database password (input hidden)" -AsSecureString
$credential = New-Object System.Management.Automation.PSCredential($userName, $password)
$plain = $credential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($plain)) { throw "Database password cannot be empty" }
$encoded = [System.Uri]::EscapeDataString($plain)
$uri = "postgresql://$userName`:$encoded@$hostName`:$port/postgres"
$lines = if (Test-Path -LiteralPath $envFile) { [System.IO.File]::ReadAllLines($envFile) } else { @() }
$filtered = @($lines | Where-Object { $_ -notmatch '^SUPABASE_DB_URL=' })
$filtered += "SUPABASE_DB_URL=$uri"
[System.IO.File]::WriteAllLines($envFile, $filtered, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "Supabase connection saved to local .env.local."
