[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [ValidateSet('arm64-v8a', 'x86_64')]
    [string]$Architecture = 'arm64-v8a'
)

$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$appVersion = (Get-Content -LiteralPath (Join-Path $mobileRoot 'package.json') -Raw | ConvertFrom-Json).version
$androidBuild = (Get-Content -LiteralPath (Join-Path $mobileRoot 'app.json') -Raw | ConvertFrom-Json).expo.android.versionCode
$env:VIOLETTA_ALLOW_CLEARTEXT = if ($env:EXPO_PUBLIC_API_URL -match '^http://') { 'true' } else { 'false' }
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $mobileRoot)
$toolsRoot = Join-Path $workspaceRoot '.tools'
$jdkRoot = Get-ChildItem -LiteralPath (Join-Path $toolsRoot 'jdk17') -Directory |
    Select-Object -First 1 -ExpandProperty FullName
$androidSdk = Join-Path $toolsRoot 'android-sdk'

if (-not $jdkRoot -or -not (Test-Path -LiteralPath (Join-Path $jdkRoot 'bin\java.exe'))) {
    throw 'Portable JDK 17 was not found under .tools\jdk17.'
}
if (-not (Test-Path -LiteralPath $androidSdk)) {
    throw 'Portable Android SDK was not found under .tools\android-sdk.'
}

$asciiToolsRoot = 'C:\cb'
$asciiJdk = Join-Path $asciiToolsRoot 'jdk'
$asciiAndroidSdk = Join-Path $asciiToolsRoot 'sdk'
$cmakeVersion = '3.22.1'
$cmakeSource = Join-Path $androidSdk "cmake\$cmakeVersion"
$asciiCmakeParent = Join-Path $asciiToolsRoot 'cmake'
$asciiCmake = Join-Path $asciiCmakeParent $cmakeVersion
New-Item -ItemType Directory -Path $asciiToolsRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $asciiJdk)) {
    New-Item -ItemType Junction -Path $asciiJdk -Target $jdkRoot | Out-Null
}
if (-not (Test-Path -LiteralPath $asciiAndroidSdk)) {
    New-Item -ItemType Junction -Path $asciiAndroidSdk -Target $androidSdk | Out-Null
}
if (-not (Test-Path -LiteralPath (Join-Path $asciiCmake 'bin\cmake.exe'))) {
    New-Item -ItemType Directory -Path $asciiCmakeParent -Force | Out-Null
    Copy-Item -LiteralPath $cmakeSource -Destination $asciiCmakeParent -Recurse -Force
}

$stageRoot = @('C:\v', 'C:\w', 'C:\x', 'C:\y', 'C:\z', 'C:\v1', 'C:\v2', 'C:\v3', 'C:\v4', 'C:\v5', 'C:\v6', 'C:\v7', 'C:\v8', 'C:\v9', 'C:\v10') |
    Where-Object { -not (Test-Path -LiteralPath $_) } |
    Select-Object -First 1
if (-not $stageRoot) {
    throw 'No free short staging directory (C:\v through C:\v4).'
}
$stageMobile = $stageRoot
New-Item -ItemType Directory -Path $stageMobile -Force | Out-Null

$directories = @('assets', 'plugins', 'scripts', 'src')
$files = @(
    '.npmrc',
    '.env.example',
    'app.json',
    'App.tsx',
    'eas.json',
    'google-services.json',
    'index.ts',
    'LICENSE',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json'
)

foreach ($directory in $directories) {
    Copy-Item -LiteralPath (Join-Path $mobileRoot $directory) -Destination $stageMobile -Recurse
}
foreach ($file in $files) {
    $source = Join-Path $mobileRoot $file
    if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination $stageMobile
    }
}

Push-Location $stageMobile
try {
    # A hoisted layout keeps CMake object paths below Windows' 260-character limit.
    & pnpm install --frozen-lockfile --config.node-linker=hoisted
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed.' }

    & pnpm exec expo prebuild --platform android --no-install
    if ($LASTEXITCODE -ne 0) { throw 'Expo Android prebuild failed.' }

    # React Native codegen creates object paths longer than Windows' legacy
    # 260-character limit even when the project itself is staged at C:\x.
    # Put only the app CMake worktree at a deterministic drive-root path.
    $cmakeCandidates = if ($Architecture -eq 'x86_64') {
        @('C:\cx', 'C:\cx1', 'C:\cx2', 'C:\cx3', 'C:\cx4', 'C:\cx5')
    }
    else {
        @('C:\ca', 'C:\ca1', 'C:\ca2', 'C:\ca3', 'C:\ca4', 'C:\ca5')
    }
    $cmakeBuildRoot = $cmakeCandidates |
        Where-Object { -not (Test-Path -LiteralPath $_) } |
        Select-Object -First 1
    if (-not $cmakeBuildRoot) {
        throw "No free short CMake staging directory for $Architecture."
    }
    $appGradlePath = 'android\app\build.gradle'
    $appGradle = Get-Content -LiteralPath $appGradlePath -Raw
    $nativeBuildBlock = @"
    externalNativeBuild {
        cmake {
            buildStagingDirectory "$($cmakeBuildRoot.Replace('\', '/'))"
        }
    }

"@
    $appGradle = $appGradle.Replace('    androidResources {', "$nativeBuildBlock    androidResources {")
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    $appGradleFullPath = (Resolve-Path -LiteralPath $appGradlePath).Path
    [System.IO.File]::WriteAllText($appGradleFullPath, $appGradle, $utf8WithoutBom)

    Add-Content -LiteralPath 'android\gradle.properties' -Value "`nandroid.overridePathCheck=true"
    $sdkPath = $asciiAndroidSdk.Replace('\', '/')
    $cmakePath = $asciiCmake.Replace('\', '/')
    Set-Content -LiteralPath 'android\local.properties' -Value @(
        "sdk.dir=$sdkPath"
        "cmake.dir=$cmakePath"
    )

    $env:JAVA_HOME = $asciiJdk
    $env:ANDROID_HOME = $asciiAndroidSdk
    $env:ANDROID_SDK_ROOT = $asciiAndroidSdk
    $env:GRADLE_OPTS = '-Dfile.encoding=UTF-8'

    $task = if ($Configuration -eq 'Release') { 'assembleRelease' } else { 'assembleDebug' }
    Push-Location 'android'
    try {
        # Internal APK targets current physical devices; production EAS builds all ABIs.
        & .\gradlew.bat $task "-PreactNativeArchitectures=$Architecture" '-Pkotlin.compiler.execution.strategy=in-process' --max-workers=2 --no-daemon --console=plain
        if ($LASTEXITCODE -ne 0) { throw "Gradle $task failed." }
    }
    finally {
        Pop-Location
    }

    $variant = $Configuration.ToLowerInvariant()
    $apkName = if ($Configuration -eq 'Release') { 'app-release.apk' } else { 'app-debug.apk' }
    $apk = Join-Path $stageMobile "android\app\build\outputs\apk\$variant\$apkName"
    $artifactDir = Join-Path $workspaceRoot 'artifacts\android'
    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
    $architectureLabel = $Architecture.Replace('-', '').Replace('_', '')
    $destination = Join-Path $artifactDir "VIOLETTA-$variant-$appVersion-build$androidBuild-$architectureLabel.apk"
    Copy-Item -LiteralPath $apk -Destination $destination -Force

    Get-FileHash -Algorithm SHA256 -LiteralPath $destination |
        Select-Object Path, Hash
}
finally {
    Pop-Location
    Write-Host "Build staging directory: $stageRoot"
}
