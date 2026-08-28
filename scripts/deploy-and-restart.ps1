[CmdletBinding()]
param(
    [string]$VaultRegistryPath = (Join-Path $env:APPDATA 'obsidian\obsidian.json'),
    [string]$ProjectRoot = '',
    [string]$ObsidianCommand = 'obsidian.com',
    [int]$ShutdownTimeoutSeconds = 20
)
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-OpenVaultPath([string]$RegistryPath) {
    if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) { throw "Obsidian registry not found: $RegistryPath" }
    try { $registry = [IO.File]::ReadAllText($RegistryPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { throw "Obsidian registry is invalid JSON: $RegistryPath" }
    $open = @($registry.vaults.psobject.Properties | Where-Object { $_.Value.open -eq $true })
    if ($open.Count -eq 0) { throw 'No open=true Obsidian vault was found.' }
    if ($open.Count -gt 1) { throw "Multiple open=true vaults found ($($open.Count)); deployment stopped." }
    $path = [string]$open[0].Value.path
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Container)) { throw "Open vault path does not exist: $path" }
    return (Resolve-Path -LiteralPath $path).Path
}
function Get-DeploymentArtifacts([string]$Root) {
    $artifacts = @()
    foreach ($name in @('main.js', 'manifest.json')) {
        $path = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing build artifact: $name" }
        $artifacts += $path
    }
    $styles = Join-Path $Root 'styles.css'
    if (Test-Path -LiteralPath $styles -PathType Leaf) { $artifacts += $styles }
    return $artifacts
}
function Stop-ObsidianGracefully([int]$TimeoutSeconds) {
    $processes = @(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($process in $processes) { [void]$process.CloseMainWindow() }
    if ($processes.Count -eq 0) { return }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do { Start-Sleep -Milliseconds 250; $running = @(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) } while ($running.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($running.Count -gt 0) { throw "Obsidian did not exit within $TimeoutSeconds seconds; deployment stopped." }
}
function Copy-DeploymentArtifacts([string[]]$Artifacts, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($artifact in $Artifacts) { Copy-Item -LiteralPath $artifact -Destination (Join-Path $Destination (Split-Path $artifact -Leaf)) -Force }
}
function Invoke-DeployAndRestart {
    $pluginDir = $null
    Push-Location -LiteralPath $ProjectRoot
    try {
        Write-Host '[1/5] Building plugin...' -ForegroundColor Cyan
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit code $LASTEXITCODE)." }
        $artifacts = @(Get-DeploymentArtifacts $ProjectRoot)
        $vault = Get-OpenVaultPath $VaultRegistryPath
        $resolvedObsidian = Get-Command $ObsidianCommand -ErrorAction SilentlyContinue
        if (-not $resolvedObsidian) { throw "Obsidian launch command not found: $ObsidianCommand" }
        $launcher = $resolvedObsidian.Source
        if ([IO.Path]::GetExtension($launcher) -ieq '.com') {
            $exe = Join-Path (Split-Path -Parent $launcher) 'Obsidian.exe'
            if (Test-Path -LiteralPath $exe) { $launcher = $exe }
        }
        $pluginDir = Join-Path $vault '.obsidian\plugins\Obsidian-RelatedOperations'
        $backupDir = "$pluginDir.backup"
        Write-Host "[2/5] Target vault: $vault"
        Write-Host '[3/5] Preparing build artifacts...'
        if (Test-Path -LiteralPath $pluginDir) {
            if (Test-Path -LiteralPath $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }
            Copy-Item -LiteralPath $pluginDir -Destination $backupDir -Recurse -Force
        }
        Write-Host '[4/5] Closing Obsidian gracefully...'
        Stop-ObsidianGracefully $ShutdownTimeoutSeconds
        Copy-DeploymentArtifacts $artifacts $pluginDir
        Write-Host '[5/5] Restarting Obsidian...'
        $started = Start-Process -FilePath $launcher -ArgumentList @($vault) -WorkingDirectory (Split-Path -Parent $launcher) -PassThru
        Start-Sleep -Seconds 2
        if ($started.HasExited -and -not (Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue)) { throw 'Obsidian failed to start after deployment.' }
        Write-Host 'Deployment complete.' -ForegroundColor Green
    } catch {
        throw
    } finally { Pop-Location }
}
if ($MyInvocation.InvocationName -ne '.') { try { Invoke-DeployAndRestart } catch { Write-Error $_; Read-Host 'Press Enter to exit'; exit 1 } }
