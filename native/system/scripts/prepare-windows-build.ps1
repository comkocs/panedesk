# Prepare matching Node development files and MSVC for native Windows CI builds.
$ErrorActionPreference = 'Stop'
$architecture = (node -p 'process.arch').Trim()
$version = (node -p 'process.version').Trim()
if ($architecture -notin @('x64', 'arm64') -or $version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Unsupported Node build target' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$installation) { throw 'MSVC development tools unavailable' }
$developer = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
$target = if ($architecture -eq 'arm64') { 'arm64' } else { 'x64' }
$environment = & cmd.exe /d /s /c "`"`"$developer`" -no_logo -arch=$target -host_arch=x64 >nul && set`""
if ($LASTEXITCODE -ne 0) { throw 'MSVC development environment failed' }
foreach ($line in $environment) {
  if ($line -match '^(PATH|INCLUDE|LIB|LIBPATH|WindowsSdkDir|WindowsSDKVersion|VCINSTALLDIR|VCToolsInstallDir)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    if ($env:GITHUB_ENV) { "$($Matches[1])=$($Matches[2])" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append }
  }
}
$nodeDirectory = Split-Path (Get-Command node).Source
$work = Join-Path (Get-Location) ('.release/node-development-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $base = "https://nodejs.org/dist/$version"
  $headersName = "node-$version-headers.tar.gz"
  foreach ($name in @('checksums-download', 'headers-download', 'library-download')) {
    New-Item -ItemType Directory -Path (Join-Path $work $name) | Out-Null
  }
  $headers = Join-Path $work "headers-download/$headersName"
  $library = Join-Path $work 'library-download/node.lib'
  $checksumFile = Join-Path $work 'checksums-download/SHASUMS256.txt'
  Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $checksumFile
  Invoke-WebRequest "$base/$headersName" -OutFile $headers
  Invoke-WebRequest "$base/win-$architecture/node.lib" -OutFile $library
  $checksums = Get-Content $checksumFile
  foreach ($item in @(@($headersName, $headers), @("win-$architecture/node.lib", $library))) {
    $expected = $checksums | Where-Object { $_ -match ('^[a-f0-9]{64}\s+' + [regex]::Escape($item[0]) + '$') }
    if (@($expected).Count -ne 1 -or (Get-FileHash -Algorithm SHA256 $item[1]).Hash.ToLowerInvariant() -ne $expected.Split(' ')[0]) { throw 'Node development file checksum mismatch' }
  }
  $extracted = Join-Path $work 'headers'
  New-Item -ItemType Directory -Path $extracted | Out-Null
  & tar -xzf $headers -C $extracted
  if ($LASTEXITCODE -ne 0) { throw 'Node headers extraction failed' }
  New-Item -ItemType Directory -Force -Path (Join-Path $nodeDirectory 'include') | Out-Null
  $include = Join-Path $nodeDirectory 'include/node'
  New-Item -ItemType Directory -Force -Path $include | Out-Null
  Copy-Item -Recurse -Force (Join-Path $extracted "node-$version/include/node/*") $include
  Copy-Item -Force $library (Join-Path $nodeDirectory 'node.lib')
} finally { Remove-Item -Recurse -Force $work }
