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
$appConfiguration = (Get-Content -LiteralPath (Join-Path $mobileRoot 'app.json') -Raw | ConvertFrom-Json).expo
$androidBuild = $appConfiguration.android.versionCode
$env:VIOLETTA_ALLOW_CLEARTEXT = if ($env:EXPO_PUBLIC_API_URL -match '^http://') { 'true' } else { 'false' }
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $mobileRoot)
$toolAncestor = Get-Item -LiteralPath $mobileRoot
$jdkRoot = $null
$androidSdk = $null
while ($null -ne $toolAncestor) {
    $candidateTools = Join-Path $toolAncestor.FullName '.tools'
    $candidateJdkParent = Join-Path $candidateTools 'jdk17'
    $candidateSdk = Join-Path $candidateTools 'android-sdk'
    if ((Test-Path -LiteralPath $candidateJdkParent -PathType Container) -and
        (Test-Path -LiteralPath $candidateSdk -PathType Container)) {
        $candidateJdk = Get-ChildItem -LiteralPath $candidateJdkParent -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe') } |
            Select-Object -First 1 -ExpandProperty FullName
        if ($candidateJdk) {
            $jdkRoot = $candidateJdk
            $androidSdk = $candidateSdk
            break
        }
    }
    $toolAncestor = $toolAncestor.Parent
}
if (-not $jdkRoot -or -not $androidSdk) {
    throw 'No ancestor .tools directory contains both a portable JDK 17 and Android SDK.'
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

$stageCandidates = @('C:\v', 'C:\w', 'C:\x', 'C:\y', 'C:\z') + @(1..99 | ForEach-Object { "C:\v$_" })
$stageRoot = $stageCandidates |
    Where-Object { -not (Test-Path -LiteralPath $_) } |
    Select-Object -First 1
if (-not $stageRoot) {
    throw 'No free short staging directory (C:\v, C:\w through C:\z, or C:\v1 through C:\v99).'
}
$stageMobile = $stageRoot
New-Item -ItemType Directory -Path $stageMobile -Force | Out-Null

$directories = @('assets', 'plugins', 'scripts', 'src')
$files = @(
    '.npmrc',
    '.env.example',
    'app.json',
    'app.config.js',
    'app.config.ts',
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

$googleServicesRelative = $appConfiguration.android.googleServicesFile
if ($googleServicesRelative) {
    if ([System.IO.Path]::IsPathRooted($googleServicesRelative)) {
        throw 'android.googleServicesFile must be a relative path inside the mobile project.'
    }
    $googleServicesTarget = [System.IO.Path]::GetFullPath((Join-Path $stageMobile $googleServicesRelative))
    $stagePrefix = [System.IO.Path]::GetFullPath($stageMobile).TrimEnd('\') + '\'
    if (-not $googleServicesTarget.StartsWith($stagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'android.googleServicesFile must stay inside the build staging directory.'
    }
    $googleServicesSource = Join-Path $mobileRoot $googleServicesRelative
    if (-not (Test-Path -LiteralPath $googleServicesSource -PathType Leaf)) {
        $googleServicesSource = $null
        $configAncestor = Get-Item -LiteralPath $mobileRoot
        while ($null -ne $configAncestor) {
            $candidateConfig = Join-Path $configAncestor.FullName 'apps\mobile\google-services.json'
            if (Test-Path -LiteralPath $candidateConfig -PathType Leaf) {
                $googleServicesSource = $candidateConfig
                break
            }
            $configAncestor = $configAncestor.Parent
        }
    }
    if ($googleServicesSource) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $googleServicesTarget) -Force | Out-Null
        Copy-Item -LiteralPath $googleServicesSource -Destination $googleServicesTarget -Force
    }
    elseif ($Configuration -eq 'Release') {
        throw "Android release requires '$googleServicesRelative'; no project file or ancestor apps\mobile\google-services.json was found."
    }
}

Push-Location $stageMobile
try {
    # A hoisted layout keeps CMake object paths below Windows' 260-character limit.
    & pnpm install --frozen-lockfile --config.node-linker=hoisted
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed.' }

    & pnpm exec expo prebuild --platform android --no-install
    if ($LASTEXITCODE -ne 0) { throw 'Expo Android prebuild failed.' }

    if ($Configuration -eq 'Release' -and $env:VIOLETTA_ALLOW_CLEARTEXT -ne 'true') {
        $expectedUpdateUrl = 'https://31-10-64-46.sslip.io/api/v1/mobile/updates/manifest'
        $expectedRuntime = $appConfiguration.android.runtimeVersion
        if ($expectedRuntime -isnot [string] -or -not $expectedRuntime) {
            throw 'Production Android requires an explicit runtimeVersion string in app.json.'
        }
        [xml]$nativeManifest = Get-Content -LiteralPath 'android\app\src\main\AndroidManifest.xml' -Raw
        $androidNamespace = 'http://schemas.android.com/apk/res/android'
        $updateMetadata = @{}
        foreach ($entry in $nativeManifest.manifest.application.'meta-data') {
            $updateMetadata[$entry.GetAttribute('name', $androidNamespace)] = $entry.GetAttribute('value', $androidNamespace)
        }
        if ($updateMetadata['expo.modules.updates.EXPO_UPDATE_URL'] -ne $expectedUpdateUrl) {
            throw "Production Android native update URL must be $expectedUpdateUrl. Check Expo config plugins."
        }
        if ($updateMetadata['expo.modules.updates.ENABLED'] -ne 'true' -or
            $updateMetadata['expo.modules.updates.EXPO_UPDATES_CHECK_ON_LAUNCH'] -ne 'ALWAYS') {
            throw 'Production Android native Expo updates must be enabled and checked on launch.'
        }
        $nativeRuntime = $updateMetadata['expo.modules.updates.EXPO_RUNTIME_VERSION']
        if ($nativeRuntime -like '@string/*') {
            [xml]$nativeStrings = Get-Content -LiteralPath 'android\app\src\main\res\values\strings.xml' -Raw
            $runtimeResource = $nativeRuntime.Substring('@string/'.Length)
            $runtimeEntry = $nativeStrings.resources.string | Where-Object { $_.name -eq $runtimeResource }
            $nativeRuntime = $runtimeEntry.InnerText
        }
        if ($nativeRuntime -ne $expectedRuntime) {
            throw "Production Android native runtime '$nativeRuntime' does not match app.json runtime '$expectedRuntime'."
        }
    }

    # React Native codegen creates object paths longer than Windows' legacy
    # 260-character limit even when the project itself is staged at C:\x.
    # Put only the app CMake worktree at a deterministic drive-root path.
    $cmakeCandidates = if ($Architecture -eq 'x86_64') {
        @('C:\cx') + @(1..99 | ForEach-Object { "C:\cx$_" })
    }
    else {
        @('C:\ca') + @(1..99 | ForEach-Object { "C:\ca$_" })
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
