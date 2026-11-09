[CmdletBinding()]
param(
    [string]$RuntimeVersion = '',
    [string]$Server = '100.86.121.91',
    [string]$ServerUser = 'stepan',
    [string]$SshKey = 'C:\Users\User\.ssh\vita29_codex'
)

$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeVersion) {
    $configuration = Get-Content -LiteralPath (Join-Path $mobileRoot 'app.json') -Raw | ConvertFrom-Json
    $RuntimeVersion = $configuration.expo.android.runtimeVersion
    if (-not $RuntimeVersion -or $RuntimeVersion -isnot [string]) {
        throw 'Android runtime version must be an explicit string in app.json.'
    }
}
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $mobileRoot)
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$publishRoot = Join-Path $workspaceRoot ".test-env\ota-publish\$stamp"
$archive = Join-Path $workspaceRoot ".test-env\ota-publish\violetta-$RuntimeVersion-$stamp.tar.gz"
New-Item -ItemType Directory -Path $publishRoot -Force | Out-Null

Push-Location $mobileRoot
try {
    & pnpm exec expo export --platform android --output-dir $publishRoot --max-workers 2
    if ($LASTEXITCODE -ne 0) { throw 'Expo update export failed.' }
}
finally {
    Pop-Location
}

$metadataPath = Join-Path $publishRoot 'metadata.json'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
foreach ($platform in $metadata.fileMetadata.PSObject.Properties) {
    $platform.Value.bundle = $platform.Value.bundle.Replace('\', '/')
    foreach ($asset in $platform.Value.assets) { $asset.path = $asset.path.Replace('\', '/') }
}
$metadataJson = $metadata | ConvertTo-Json -Depth 30 -Compress
[System.IO.File]::WriteAllText($metadataPath, $metadataJson, [System.Text.UTF8Encoding]::new($false))

& tar.exe -czf $archive -C $publishRoot .
if ($LASTEXITCODE -ne 0) { throw 'Could not package the update.' }

$remoteArchive = "/tmp/violetta-$RuntimeVersion-$stamp.tar.gz"
& scp -i $SshKey -o BatchMode=yes -o StrictHostKeyChecking=accept-new $archive "${ServerUser}@${Server}:$remoteArchive"
if ($LASTEXITCODE -ne 0) { throw 'Could not upload the update package.' }

$remoteTarget = "/srv/vita29/app-data/mobile-updates/$RuntimeVersion/$stamp"
$remoteStage = "/srv/vita29/app-data/mobile-updates/staging-$RuntimeVersion-$stamp"
$remoteCommand = "set -eu; sudo -n mkdir -p '$remoteStage'; sudo -n tar -xzf '$remoteArchive' -C '$remoteStage'; sudo -n test -f '$remoteStage/metadata.json'; sudo -n mkdir -p '/srv/vita29/app-data/mobile-updates/$RuntimeVersion'; sudo -n mv '$remoteStage' '$remoteTarget'; rm -f '$remoteArchive'"
& ssh -i $SshKey -o BatchMode=yes "${ServerUser}@${Server}" $remoteCommand
if ($LASTEXITCODE -ne 0) { throw 'Could not activate the update on the server.' }

Write-Output "Published Android OTA update: runtime=$RuntimeVersion id=$stamp"
