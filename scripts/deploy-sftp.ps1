param(
    [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [string]$BuildDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist')
)

if (-not (Test-Path $EnvFile)) {
    throw "Env file not found at $EnvFile. Copy .env.example to .env and fill in your values."
}

$settings = @{}
Get-Content $EnvFile | ForEach-Object {
    if ($_ -and $_ -notmatch '^[\s#]') {
        $parts = $_ -split '=', 2
        if ($parts.Length -eq 2) {
            $settings[$parts[0].Trim()] = $parts[1].Trim()
        }
    }
}

foreach ($var in @('SFTP_HOST', 'SFTP_PORT', 'SFTP_USER', 'SFTP_REMOTE_PATH')) {
    if (-not $settings.ContainsKey($var) -or [string]::IsNullOrWhiteSpace($settings[$var])) {
        throw "Missing required env variable: $var"
    }
}

$remotePath = $settings['SFTP_REMOTE_PATH'].TrimEnd('/')
$host = $settings['SFTP_HOST']
$port = $settings['SFTP_PORT']
$user = $settings['SFTP_USER']

if (-not (Test-Path $BuildDir)) {
    throw "Build directory not found at $BuildDir. Run npm run build first."
}

if (-not (Get-Command sftp -ErrorAction SilentlyContinue)) {
    throw "sftp command not found. Install OpenSSH client or use the Node deploy script with npm run deploy:sftp."
}

$commandFile = Join-Path $env:TEMP 'sftp-deploy-commands.txt'
@(
    "cd $remotePath",
    "lcd $BuildDir",
    "put -r *",
    "bye"
) | Set-Content -Path $commandFile -Encoding UTF8

Write-Host "Uploading built files from $BuildDir to sftp://${host}:${port}${remotePath}"

$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = 'sftp'
$processInfo.Arguments = "-P $port -b `"$commandFile`" $user@$host"
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::Start($processInfo)
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()

Write-Host $stdout
if ($stderr) { Write-Host $stderr }

if ($process.ExitCode -ne 0) {
    throw "SFTP upload failed with exit code $($process.ExitCode)"
}

Write-Host 'SFTP deployment completed successfully.'