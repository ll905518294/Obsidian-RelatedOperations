$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'deploy-and-restart.ps1'
. $scriptPath

$root = Join-Path $env:TEMP ('related-operations-test-' + [guid]::NewGuid())
try {
	$vault = Join-Path $root 'vault'
	New-Item -ItemType Directory -Path $vault -Force | Out-Null
	$registry = Join-Path $root 'obsidian.json'
	@{ vaults = @{ a = @{ path = $vault; open = $true } } } | ConvertTo-Json | Set-Content $registry
	if ((Get-OpenVaultPath $registry) -ne (Resolve-Path $vault).Path) { throw 'open vault mismatch' }
	'main' | Set-Content (Join-Path $root 'main.js')
	'{}' | Set-Content (Join-Path $root 'manifest.json')
	if ((Get-DeploymentArtifacts $root).Count -ne 2) { throw 'artifact count mismatch' }
	'{"id":"safe.plugin-id"}' | Set-Content (Join-Path $root 'manifest.json')
	if ((Get-PluginId (Join-Path $root 'manifest.json')) -ne 'safe.plugin-id') { throw 'valid plugin id rejected' }
	'{"id":"unsafe*id"}' | Set-Content (Join-Path $root 'manifest.json')
	try { Get-PluginId (Join-Path $root 'manifest.json'); throw 'unsafe plugin id accepted' } catch { if ($_.Exception.Message -notmatch 'invalid path characters') { throw } }
	'{"id":"unsafe."}' | Set-Content (Join-Path $root 'manifest.json')
	try { Get-PluginId (Join-Path $root 'manifest.json'); throw 'trailing-dot plugin id accepted' } catch { if ($_.Exception.Message -notmatch 'invalid path characters') { throw } }
	$config = Join-Path $root 'data.json'; '{"keep":true}' | Set-Content $config
	Copy-DeploymentArtifacts (Get-DeploymentArtifacts $root) (Join-Path $root 'plugin')
	if (-not (Test-Path $config) -or -not (Test-Path (Join-Path $root 'plugin\main.js'))) { throw 'artifact copy removed config or missed output' }
	if ((Get-FileSha256 (Join-Path $root 'main.js')) -ne (Get-FileSha256 (Join-Path $root 'plugin\main.js'))) { throw 'artifact hash mismatch' }
	$pluginsRoot = Join-Path $root 'plugins'
	$validPlugin = Join-Path $pluginsRoot 'demo'
	$backup = "$validPlugin.backup"
	New-Item -ItemType Directory -Path $validPlugin, $backup -Force | Out-Null
	Set-Content (Join-Path $backup 'data.json') '{"restored":true}'
	Restore-DeploymentBackup $validPlugin $backup
	if ((Get-Content (Join-Path $validPlugin 'data.json') -Raw).Trim() -ne '{"restored":true}') { throw 'backup contents were not restored' }
	$otherBackup = Join-Path $root 'other.backup'
	New-Item -ItemType Directory -Path $otherBackup -Force | Out-Null
	try { Restore-DeploymentBackup $validPlugin $otherBackup; throw 'mismatched backup path accepted' } catch { if ($_.Exception.Message -notmatch 'does not match plugin directory') { throw } }
	Assert-ObsidianRestartAcknowledged 'Restarting...' $null
	try { Assert-ObsidianRestartAcknowledged 'Error: Command failed' 0; throw 'restart error output accepted' } catch { if ($_.Exception.Message -notmatch 'failed') { throw } }
	@{ vaults = @{ a = @{ path = $vault } } } | ConvertTo-Json | Set-Content $registry
	try { Get-OpenVaultPath $registry; throw 'missing open property accepted' } catch { if ($_.Exception.Message -notmatch 'No open=true') { throw } }
	'{invalid' | Set-Content $registry
	try { Get-OpenVaultPath $registry; throw 'invalid json accepted' } catch { if ($_.Exception.Message -notmatch 'invalid JSON') { throw } }
	@{ vaults = @{ a = @{ path = $vault; open = $true }; b = @{ path = $vault; open = $true } } } | ConvertTo-Json | Set-Content $registry
	try { Get-OpenVaultPath $registry; throw 'multiple vaults accepted' } catch { if ($_.Exception.Message -notmatch 'Multiple') { throw } }
	Write-Host 'PASS: deploy script helper tests'
} finally {
	if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}
