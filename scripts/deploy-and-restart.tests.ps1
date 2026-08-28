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
	$config = Join-Path $root 'data.json'; '{"keep":true}' | Set-Content $config
	Copy-DeploymentArtifacts (Get-DeploymentArtifacts $root) (Join-Path $root 'plugin')
	if (-not (Test-Path $config) -or -not (Test-Path (Join-Path $root 'plugin\main.js'))) { throw 'artifact copy removed config or missed output' }
	if ((Get-FileHash (Join-Path $root 'main.js')).Hash -ne (Get-FileHash (Join-Path $root 'plugin\main.js')).Hash) { throw 'artifact hash mismatch' }
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
