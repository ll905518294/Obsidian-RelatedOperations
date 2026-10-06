[CmdletBinding()]
param(
    [string]$VaultRegistryPath = (Join-Path $env:APPDATA 'obsidian\obsidian.json'),
    [string]$ProjectRoot = '',
    [string]$ObsidianCommand = 'obsidian.com',
    [int]$StartupTimeoutSeconds = 20,
    [switch]$CheckOnly
)
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-OpenVaultPath([string]$RegistryPath) {
    if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) { throw "Obsidian registry not found: $RegistryPath" }
    try { $registry = [IO.File]::ReadAllText($RegistryPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { throw "Obsidian registry is invalid JSON: $RegistryPath" }
    $open = @(
        $registry.vaults.psobject.Properties |
            Where-Object {
                $openProperty = $_.Value.PSObject.Properties['open']
                $null -ne $openProperty -and $openProperty.Value -eq $true
            }
    )
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
function Get-PluginId([string]$ManifestPath) {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Manifest not found: $ManifestPath" }
    try { $manifest = [IO.File]::ReadAllText($ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { throw "Manifest is invalid JSON: $ManifestPath" }
    $idProperty = $manifest.PSObject.Properties['id']
    $id = if ($null -ne $idProperty) { [string]$idProperty.Value } else { '' }
    if ([string]::IsNullOrWhiteSpace($id)) { throw "Manifest is missing required 'id' property: $ManifestPath" }
    if ($id -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$') { throw "Manifest 'id' contains invalid path characters: $id" }
    return $id
}
function Get-FileSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "File not found: $Path" }
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '') }
        finally { $sha256.Dispose() }
    } finally { $stream.Dispose() }
}
function Copy-DeploymentArtifacts([string[]]$Artifacts, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($name in @('main.js', 'manifest.json', 'styles.css')) {
        $target = Join-Path $Destination $name
        if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
    foreach ($artifact in $Artifacts) { Copy-Item -LiteralPath $artifact -Destination (Join-Path $Destination (Split-Path $artifact -Leaf)) -Force }
    foreach ($artifact in $Artifacts) {
        $target = Join-Path $Destination (Split-Path $artifact -Leaf)
        if ((Get-FileSha256 $artifact) -ne (Get-FileSha256 $target)) {
            throw "Deployment artifact verification failed: $(Split-Path $artifact -Leaf)"
        }
        Write-Host ("Verified {0}: {1}" -f (Split-Path $artifact -Leaf), (Get-FileSha256 $target))
    }
}
function Get-ObsidianMainProcesses {
    return @(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        ForEach-Object { [PSCustomObject]@{ Id = $_.Id; StartTime = $_.StartTime } })
}
function Assert-ObsidianRestartAcknowledged([string]$Output, [Nullable[int]]$ExitCode) {
    if ($null -ne $ExitCode -and $ExitCode -ne 0) { throw "Obsidian restart command failed with exit code ${ExitCode}: $Output" }
    if ($Output -match '(?im)^\s*Error:') { throw "Obsidian restart command failed: $($Output.Trim())" }
    if ($Output -notmatch '(?im)^\s*Restarting\.\.\.') { throw "Obsidian restart command was not accepted: $($Output.Trim())" }
}
function Wait-ForObsidianRestart([int[]]$PreviousProcessIds, [int]$TimeoutSeconds, [int]$StableSeconds = 3) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $running = @(Get-ObsidianMainProcesses)
        $oldStillRunning = @($running | Where-Object { $PreviousProcessIds -contains $_.Id })
        $newProcesses = @($running | Where-Object { $PreviousProcessIds -notcontains $_.Id })
        if ($oldStillRunning.Count -eq 0 -and $newProcesses.Count -gt 0) {
            $stable = $true
            $stableDeadline = (Get-Date).AddSeconds($StableSeconds)
            do {
                Start-Sleep -Milliseconds 250
                $current = @(Get-ObsidianMainProcesses)
                if (@($current | Where-Object { $PreviousProcessIds -notcontains $_.Id }).Count -eq 0) { $stable = $false; break }
            } while ((Get-Date) -lt $stableDeadline)
            if ($stable) { return $true }
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $false
}
function Invoke-ObsidianRestart([string]$CliPath, [string]$VaultPath) {
    $previousProcesses = @(Get-ObsidianMainProcesses)
    if ($previousProcesses.Count -eq 0) {
        $exePath = Join-Path (Split-Path -Parent $CliPath) 'Obsidian.exe'
        if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw "Obsidian is not running and executable was not found: $exePath" }
        [void](Start-Process -FilePath $exePath -ArgumentList @($VaultPath) -WorkingDirectory (Split-Path -Parent $exePath))
        if (-not (Wait-ForObsidianRestart @() $StartupTimeoutSeconds)) { throw "Obsidian did not start stably: $VaultPath" }
        return
    }
    $vaultName = Split-Path -Leaf ([IO.Path]::GetFullPath($VaultPath).TrimEnd('\'))
    try {
        $outputLines = @(& $CliPath "vault=$vaultName" 'restart' 2>&1)
        $exitCode = if ($null -eq $LASTEXITCODE) { $null } else { [int]$LASTEXITCODE }
        $output = $outputLines -join [Environment]::NewLine
        Assert-ObsidianRestartAcknowledged $output $exitCode
    } catch { throw "Obsidian restart failed: $($_.Exception.Message)" }
    if (-not (Wait-ForObsidianRestart @($previousProcesses | ForEach-Object { [int]$_.Id }) $StartupTimeoutSeconds)) {
        throw "Obsidian did not complete a stable restart: $VaultPath"
    }
}
function Get-DeploymentBackupPath([string]$PluginDir) {
    $resolvedPluginDir = [IO.Path]::GetFullPath($PluginDir)
    $configDir = Split-Path -Parent (Split-Path -Parent $resolvedPluginDir)
    return Join-Path $configDir ('plugin-backups\' + (Split-Path -Leaf $resolvedPluginDir) + '.backup')
}
function Restore-DeploymentBackup([string]$PluginDir, [string]$BackupDir) {
    if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) { return }
    $resolvedPluginDir = [IO.Path]::GetFullPath($PluginDir)
    $resolvedBackupDir = [IO.Path]::GetFullPath($BackupDir)
    $expectedBackupDir = Get-DeploymentBackupPath $resolvedPluginDir
    if (-not $resolvedBackupDir.Equals($expectedBackupDir, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to restore: backup directory does not match plugin directory: $resolvedBackupDir"
    }
    if (Test-Path -LiteralPath $PluginDir) { Remove-Item -LiteralPath $PluginDir -Recurse -Force }
    Copy-Item -LiteralPath $BackupDir -Destination $PluginDir -Recurse -Force
}
function Invoke-DeployAndRestart {
    Push-Location -LiteralPath $ProjectRoot
    try {
        Write-Host '[1/5] Building plugin...' -ForegroundColor Cyan
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit code $LASTEXITCODE)." }
        $artifacts = @(Get-DeploymentArtifacts $ProjectRoot)
        $buildStamp = (Get-Item (Join-Path $ProjectRoot 'main.js')).LastWriteTimeUtc
        Write-Host "Built main.js: $buildStamp"
        $pluginId = Get-PluginId (Join-Path $ProjectRoot 'manifest.json')
        $vault = Get-OpenVaultPath $VaultRegistryPath
        $resolvedObsidian = Get-Command $ObsidianCommand -ErrorAction SilentlyContinue
        if (-not $resolvedObsidian) { throw "Obsidian launch command not found: $ObsidianCommand" }
        $cliPath = $resolvedObsidian.Source
        $pluginDir = Join-Path $vault ('.obsidian\plugins\' + $pluginId)
        $backupDir = Get-DeploymentBackupPath $pluginDir
        Write-Host "[2/5] Target vault: $vault"
		if ($CheckOnly) {
			$targetState = if (Test-Path -LiteralPath $pluginDir -PathType Container) { 'existing, will update' } else { 'missing, will install' }
			Write-Host "Preflight OK: $pluginId ($targetState)"
			return
		}
        Write-Host '[3/5] Preparing build artifacts...'
        $backupRoot = Split-Path -Parent $backupDir
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $legacyBackupDir = "$pluginDir.backup"
        if (Test-Path -LiteralPath $legacyBackupDir -PathType Container) {
            $legacyDestination = Join-Path $backupRoot ($pluginId + '.legacy-' + [guid]::NewGuid())
            Move-Item -LiteralPath $legacyBackupDir -Destination $legacyDestination
            Write-Host "Moved legacy backup outside plugins: $legacyDestination"
        }
        if (Test-Path -LiteralPath $pluginDir) {
            if (Test-Path -LiteralPath $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }
            Copy-Item -LiteralPath $pluginDir -Destination $backupDir -Recurse -Force
        }
        Write-Host '[4/5] Copying and verifying plugin artifacts...'
        try {
            Copy-DeploymentArtifacts $artifacts $pluginDir
            $deployedStamp = (Get-Item (Join-Path $pluginDir 'main.js')).LastWriteTimeUtc
            if ($deployedStamp -lt $buildStamp) { throw "Deployed main.js is older than build output: $deployedStamp < $buildStamp" }
        } catch {
            $copyError = $_
            Write-Warning 'Deployment copy failed; attempting to restore previous version...'
            try {
                Restore-DeploymentBackup $pluginDir $backupDir
                Write-Warning 'Previous plugin version restored from backup.'
            } catch {
                Write-Warning "Backup restore also failed: $($_.Exception.Message)"
            }
            throw $copyError
        }
        Write-Host '[5/5] Restarting Obsidian to reload the plugin...'
        try {
            Invoke-ObsidianRestart $cliPath $vault
        } catch {
            $restartError = $_
            if (Test-Path -LiteralPath $backupDir -PathType Container) {
                Write-Warning 'Obsidian restart failed; attempting to restore previous plugin version...'
                try {
                    Restore-DeploymentBackup $pluginDir $backupDir
                    Write-Warning 'Previous plugin version restored from backup.'
                } catch {
                    Write-Warning "Backup restore also failed: $($_.Exception.Message)"
                }
            }
            throw $restartError
        }
        Write-Host 'Deployment complete. Obsidian restarted and the plugin was reloaded.' -ForegroundColor Green
    } catch {
        throw
    } finally { Pop-Location }
}
if ($MyInvocation.InvocationName -ne '.') { try { Invoke-DeployAndRestart } catch { Write-Error $_; Read-Host 'Press Enter to exit'; exit 1 } }
