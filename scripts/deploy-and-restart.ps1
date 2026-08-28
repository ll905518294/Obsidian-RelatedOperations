[CmdletBinding()]
param(
    [string]$VaultRegistryPath = (Join-Path $env:APPDATA 'obsidian\obsidian.json'),
    [string]$ProjectRoot = '',
    [string]$ObsidianCommand = 'obsidian.com',
    [int]$ShutdownTimeoutSeconds = 20,
    [int]$StartupTimeoutSeconds = 20
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
    if ($id -match '[\\/:]' -or $id -eq '.' -or $id -eq '..') { throw "Manifest 'id' contains invalid path characters: $id" }
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
function Stop-ObsidianGracefully([int]$TimeoutSeconds) {
    $processes = @(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) { return }
    foreach ($process in ($processes | Where-Object { $_.MainWindowHandle -ne 0 })) { [void]$process.CloseMainWindow() }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do { Start-Sleep -Milliseconds 250; $running = @(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue) } while ($running.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($running.Count -eq 0) { return }
    $windows = @($running | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($windows.Count -gt 0) { throw "Obsidian did not close within $TimeoutSeconds seconds; a window may have unsaved changes. Deployment stopped." }
    Write-Warning "Obsidian's main window has closed, but $($running.Count) background process(es) remain; stopping them to clear the loaded plugin code."
    foreach ($process in $running) { Stop-Process -Id $process.Id -Force }
    $killDeadline = (Get-Date).AddSeconds(5)
    do { Start-Sleep -Milliseconds 250; $running = @(Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue) } while ($running.Count -gt 0 -and (Get-Date) -lt $killDeadline)
    if ($running.Count -gt 0) { throw "Obsidian did not exit within $TimeoutSeconds seconds; deployment stopped." }
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
    }
}
function Test-ObsidianVaultProcess([string]$VaultPath) {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'Obsidian.exe'" -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.CommandLine -notmatch '--type=' }).Count -gt 0
}
function Invoke-ObsidianPluginReload([string]$Launcher, [string]$PluginId, [string]$VaultPath) {
    if (-not (Test-ObsidianVaultProcess $VaultPath)) {
        throw "Obsidian is not running with the target Vault: $VaultPath"
    }
    try { & $Launcher "plugin:reload" "id=$PluginId" 2>&1 | Out-Null }
    catch { throw "Obsidian plugin reload failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds 2
    if (-not (Test-ObsidianVaultProcess $VaultPath)) {
        throw 'Obsidian exited while reloading the plugin.'
    }
}
function Restore-DeploymentBackup([string]$PluginDir, [string]$BackupDir) {
    if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) { return }
    $pluginsRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PluginDir))
    $resolvedPluginDir = [IO.Path]::GetFullPath($PluginDir)
    if (-not $resolvedPluginDir.StartsWith($pluginsRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to restore: plugin directory is not under plugins root: $resolvedPluginDir"
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
        $pluginId = Get-PluginId (Join-Path $ProjectRoot 'manifest.json')
        $vault = Get-OpenVaultPath $VaultRegistryPath
        $resolvedObsidian = Get-Command $ObsidianCommand -ErrorAction SilentlyContinue
        if (-not $resolvedObsidian) { throw "Obsidian launch command not found: $ObsidianCommand" }
        $launcher = $resolvedObsidian.Source
        if ([IO.Path]::GetExtension($launcher) -ieq '.com') {
            $exe = Join-Path (Split-Path -Parent $launcher) 'Obsidian.exe'
            if (Test-Path -LiteralPath $exe) { $launcher = $exe }
        }
        $pluginDir = Join-Path $vault ('.obsidian\plugins\' + $pluginId)
        $backupDir = "$pluginDir.backup"
        Write-Host "[2/5] Target vault: $vault"
        Write-Host '[3/5] Preparing build artifacts...'
        if (Test-Path -LiteralPath $pluginDir) {
            if (Test-Path -LiteralPath $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }
            Copy-Item -LiteralPath $pluginDir -Destination $backupDir -Recurse -Force
        }
        Write-Host '[4/5] Copying and verifying plugin artifacts...'
        try {
            Copy-DeploymentArtifacts $artifacts $pluginDir
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
        Write-Host '[5/5] Reloading the plugin in the running Obsidian process...'
        Invoke-ObsidianPluginReload $launcher $pluginId $vault
        Write-Host 'Deployment complete. The plugin was reloaded without restarting Obsidian.' -ForegroundColor Green
    } catch {
        throw
    } finally { Pop-Location }
}
if ($MyInvocation.InvocationName -ne '.') { try { Invoke-DeployAndRestart } catch { Write-Error $_; Read-Host 'Press Enter to exit'; exit 1 } }
