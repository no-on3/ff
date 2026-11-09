# Installs ff, FF's command, on Windows, from its downloads site, in PowerShell:
#   irm https://get.<domain>/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://get.<domain>/install.ps1))) -Prefix C:\Tools\ff
# It downloads ff's build for Windows, checks its SHA-256 against latest.json and, when minisign is on the machine,
# the signatures of both against the release's public key; then installs it as <prefix>\bin\ff.exe, ~\.local\bin\ff.exe
# by default, and says what to add to Path. When a check fails, nothing is installed. The site's copy names the site
# and holds the public key (hack/downloads-site.sh puts them in); FF_DOWNLOADS_URL names another copy of the site, as
# the tests' own. A refusal is an error, not an exit, so that the window it runs in stays open; everything runs from
# the last line, so that a download cut short runs nothing. Windows PowerShell 5.1 and PowerShell 7 alike.
param([string]$Prefix = '')

function Install-Ff([string]$Prefix) {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell's progress bar slows a download down tenfold
  $downloads = '@downloads@'
  $publicKey = '@public-key@'
  if ($env:FF_DOWNLOADS_URL) { $downloads = $env:FF_DOWNLOADS_URL }
  $downloads = $downloads.TrimEnd('/')
  if ($downloads.StartsWith('@')) {
    throw "ff not installed: this copy of install.ps1 isn't the downloads site's, which names the site: give FF_DOWNLOADS_URL"
  }
  if (-not $Prefix) { $Prefix = Join-Path $HOME '.local' }
  $bin = Join-Path $Prefix 'bin'
  # One build for Windows: Windows on an Arm processor runs x86_64's programs through its emulation.
  $processor = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($processor -notin @('AMD64', 'ARM64')) {
    throw "ff not installed: ff is built for x86_64 processors, which Windows on Arm runs too, and this one is $processor"
  }
  $file = 'ff-windows-x86_64.exe'
  # Windows PowerShell's default protocols may leave TLS 1.2 out.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $minisign = Get-Command minisign -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

  $work = Join-Path ([IO.Path]::GetTempPath()) ('ff-install-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    function Get-File([string]$Name, [string]$To) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$downloads/$Name" -OutFile (Join-Path $work $To)
      } catch {
        throw "ff not installed: $downloads/$Name couldn't be downloaded ($($_.Exception.Message))"
      }
    }
    function Test-Signature([string]$Path) { # its signature, <path>.minisig, against the release's key
      & $minisign.Source -Vqm $Path -P $publicKey *> $null
      return $LASTEXITCODE -eq 0
    }

    Get-File 'latest.json' 'latest.json'
    $signatures = "minisign isn't on this machine, so their signatures weren't checked: https://jedisct1.github.io/minisign/"
    if ($minisign) {
      Get-File 'latest.json.minisig' 'latest.json.minisig'
      if (-not (Test-Signature (Join-Path $work 'latest.json'))) {
        throw "ff not installed: latest.json's signature isn't the release key's"
      }
    }
    $latest = Get-Content -Raw -Path (Join-Path $work 'latest.json') | ConvertFrom-Json
    $version = $latest.version
    $expected = $latest.files.$file
    if (-not $version -or -not $expected) { throw "ff not installed: latest.json names no $file" }

    Get-File $file 'ff.exe'
    $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $work 'ff.exe')).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "ff not installed: $file's SHA-256 is $actual, and latest.json's is $expected" }
    if ($minisign) {
      Get-File "$file.minisig" 'ff.exe.minisig'
      if (-not (Test-Signature (Join-Path $work 'ff.exe'))) {
        throw "ff not installed: $file's signature isn't the release key's"
      }
      $signatures = "their signatures are the release key's"
    }

    $installed = Join-Path $bin 'ff.exe'
    try {
      New-Item -ItemType Directory -Force -Path $bin | Out-Null
      Copy-Item -Force -Path (Join-Path $work 'ff.exe') -Destination $installed
    } catch {
      throw "ff not installed: $installed can't be written, maybe as it runs: close it, or give -Prefix a folder of yours ($($_.Exception.Message))"
    }
    Write-Output "ff $version installed as ${installed}: its SHA-256 is latest.json's, and $signatures."
    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($env:Path -split ';') -contains $bin -or ($path -split ';') -contains $bin) {
      Write-Output 'Run ff --help to begin.'
    } else {
      Write-Output "$bin isn't in your Path: this line adds it for your account, then open a new terminal:"
      Write-Output "  [Environment]::SetEnvironmentVariable('Path', '$bin;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
    }
  } finally {
    Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
  }
}

Install-Ff $Prefix
