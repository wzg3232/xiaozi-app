param([switch]$Preview)
$ErrorActionPreference = 'Stop'
$ichatProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ichatProjectRoot
$ichatKeystore = Join-Path $ichatProjectRoot 'build-tools\ichat-demo.keystore'
if (-not (Test-Path -LiteralPath $ichatKeystore -PathType Leaf)) { throw 'The original application signing key is required for an in-place upgrade. Restore the existing private key; do not generate a replacement.' }
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) {
    $ichatJdk = Get-ChildItem -LiteralPath '.\build-tools\jdk' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $ichatJdk) { throw 'A full JDK 21 is required. Set JAVA_HOME or prepare build-tools/jdk.' }
    $env:JAVA_HOME = $ichatJdk.FullName
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $ichatProjectRoot 'build-tools\android-sdk' }
$ichatJava = Join-Path $env:JAVA_HOME 'bin\java.exe'
$ichatJavac = Join-Path $env:JAVA_HOME 'bin\javac.exe'
$ichatPlatform = Join-Path $env:ANDROID_HOME 'platforms\android-36\android.jar'
$ichatTools = Join-Path $env:ANDROID_HOME 'build-tools\36.0.0'
if (-not (Test-Path -LiteralPath $ichatPlatform)) { throw 'Install Android SDK Platform 36.' }
if (-not (Test-Path -LiteralPath (Join-Path $ichatTools 'aapt2.exe'))) { throw 'Install Android SDK Build-Tools 36.0.0.' }
$ichatOutput = Join-Path $ichatProjectRoot 'build-tools\native-android-build'
$ichatClasses = Join-Path $ichatOutput 'classes'
$ichatDex = Join-Path $ichatOutput 'dex'
New-Item -ItemType Directory -Path $ichatOutput,$ichatClasses,$ichatDex,'.\deliverables' -Force | Out-Null
foreach ($ichatCleanPath in @($ichatClasses,$ichatDex)) {
    $ichatResolved = [IO.Path]::GetFullPath($ichatCleanPath)
    if (-not $ichatResolved.StartsWith([IO.Path]::GetFullPath($ichatOutput) + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Build cleanup escaped native output directory.' }
    Get-ChildItem -LiteralPath $ichatResolved -Force | Remove-Item -Recurse -Force
}
Write-Output '1/7 Bundle the shared 小紫在 interface'
& node '.\scripts\build-web.mjs'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$ichatCompiledResources = Join-Path $ichatOutput 'resources.zip'
Write-Output '2/7 Compile Android resources and application manifest'
& (Join-Path $ichatTools 'aapt2.exe') compile --dir '.\native\android\res' -o $ichatCompiledResources
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$ichatUnsignedApk = Join-Path $ichatOutput 'ichat-unsigned.apk'
$ichatManifest = Join-Path $ichatProjectRoot 'native\android\AndroidManifest.xml'
if ($Preview) {
    $ichatPreviewManifest = Join-Path $ichatOutput 'manifest-preview.xml'
    $ichatPreviewXml = (Get-Content -LiteralPath $ichatManifest -Raw).Replace('package="com.ichat.studio"','package="com.ichat.studio.preview"').Replace('android:label="小紫在"','android:label="小紫在 预览"').Replace('android:authorities="com.ichat.studio.camera"','android:authorities="com.ichat.studio.preview.camera"')
    [IO.File]::WriteAllText($ichatPreviewManifest,$ichatPreviewXml,[Text.UTF8Encoding]::new($false))
    $ichatManifest = $ichatPreviewManifest
}
& (Join-Path $ichatTools 'aapt2.exe') link -I $ichatPlatform --manifest $ichatManifest -A '.\dist' -o $ichatUnsignedApk $ichatCompiledResources
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output '3/7 Compile the native Java activity'
$ichatJavaSources = @(Get-ChildItem -LiteralPath '.\native\android\src' -Filter '*.java' -File -Recurse | Select-Object -ExpandProperty FullName)
$ichatJavacArgs = @('-J-Duser.language=en','-encoding','UTF-8','-Xlint:-options','-source','8','-target','8','-classpath',$ichatPlatform,'-d',$ichatClasses) + $ichatJavaSources
& $ichatJavac @ichatJavacArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output '4/7 Produce Android DEX bytecode'
$ichatClassFiles = @(Get-ChildItem -LiteralPath $ichatClasses -Filter '*.class' -File -Recurse | Select-Object -ExpandProperty FullName)
$ichatDexArgs = @('-cp',(Join-Path $ichatTools 'lib\d8.jar'),'com.android.tools.r8.D8','--min-api','24','--lib',$ichatPlatform,'--output',$ichatDex) + $ichatClassFiles
& $ichatJava @ichatDexArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Node writes actual ZIP method 0 for Android's stored resources. Framework
# ZipArchive NoCompression can instead emit deflate level 0 under PowerShell 5.
# It also normalizes Windows aapt2 backslash paths and validates every CRC.
$ichatNormalizedApk = Join-Path $ichatOutput 'ichat-normalized.apk'
& node '.\scripts\normalize-apk.mjs' $ichatUnsignedApk (Join-Path $ichatDex 'classes.dex') $ichatNormalizedApk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output '5/7 Align the installable APK'
$ichatAlignedApk = Join-Path $ichatOutput 'ichat-aligned.apk'
& (Join-Path $ichatTools 'zipalign.exe') -f -p 4 $ichatNormalizedApk $ichatAlignedApk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Join-Path $ichatTools 'zipalign.exe') -c -p 4 $ichatAlignedApk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output '6/7 Sign the 小紫在 upgrade with the original application key'
$ichatVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$ichatBuildFlavor = if ($env:ICHAT_SERVER_URL) { 'public' } else { 'debug' }
if ($Preview) { $ichatBuildFlavor = 'preview'; New-Item -ItemType Directory -Path '.\build-tools\native-preview' -Force | Out-Null }
$ichatApkFolder = if ($Preview) { 'build-tools\native-preview' } else { 'deliverables' }
$ichatApk = Join-Path $ichatProjectRoot ($ichatApkFolder + '\xiaozi-' + $ichatVersion + '-android-' + $ichatBuildFlavor + '.apk')
& $ichatJava -jar (Join-Path $ichatTools 'lib\apksigner.jar') sign --ks $ichatKeystore --ks-pass pass:android --key-pass pass:android --ks-key-alias ichat-demo --out $ichatApk $ichatAlignedApk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output '7/7 Verify APK signatures'
$ichatSignatureReport = & $ichatJava -jar (Join-Path $ichatTools 'lib\apksigner.jar') verify --verbose --print-certs $ichatApk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$ichatSignatureReport | Write-Output
if (($ichatSignatureReport -join "`n") -notmatch 'Signer #1 certificate SHA-256 digest: 93886c5d26ef1ce5e615139d82b15f227bc2708f8434f1ba45a70fd344a29f4f') { throw 'Signing certificate differs from the installed iChat application. Do not publish this package.' }
Write-Output ('Android APK created: ' + $ichatApk)
