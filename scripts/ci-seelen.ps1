$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Run this bootstrap only on a disposable GitHub Actions runner.' }

# Check the native desktop before installing anything; the suite needs real input.
$probe = Join-Path $env:RUNNER_TEMP 'SeelenDesktopProbe.exe'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/support/build-window.ps1 -Source tests/support/Window.cs -Destination $probe
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the desktop probe.' }
$check = Start-Process $probe -ArgumentList 'desktop' -WindowStyle Hidden -Wait -PassThru
if ($check.ExitCode -ne 0) { throw 'The hosted runner does not have an active, unlocked desktop.' }

# WebView2 reads this policy even when Seelen is launched through Explorer and
# does not inherit the runner process environment. This VM is discarded afterward.
$policy = 'HKLM:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
New-Item -Path $policy -Force | Out-Null
New-ItemProperty -Path $policy -Name '*' -Value '--remote-debugging-port=9222' -PropertyType String -Force | Out-Null
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'

# Fresh Seelen profiles require native confirmation before third-party widgets
# can launch programs. Grant only the taskbar's launch permission in this
# disposable runner profile, before Seelen caches its permission decisions.
# Schema: Seelen v2.8.6 src/background/widgets/permissions.rs.
$profileDir = Join-Path $env:APPDATA 'com.seelen.seelen-ui'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
'{"@dvirtz/workspace-taskbar":{"run":"allowed"}}' | Set-Content -LiteralPath (Join-Path $profileDir 'permissions.json') -Encoding utf8

$installer = Join-Path $env:RUNNER_TEMP 'seelen-setup.exe'
$installDir = Join-Path $env:RUNNER_TEMP 'Seelen'
Invoke-WebRequest 'https://github.com/eythaann/Seelen-UI/releases/download/v2.8.6/Seelen.UI_2.8.6_x64-setup.exe' -OutFile $installer
$setup = Start-Process $installer -ArgumentList "/S /D=$installDir" -WindowStyle Hidden -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Seelen installer exited with $($setup.ExitCode)." }
$exe = Join-Path $installDir 'seelen-ui.exe'
$cli = Join-Path $installDir 'slu.exe'
if (!(Test-Path $exe) -or !(Test-Path $cli)) { throw 'Seelen installation is incomplete.' }
"SLU_PATH=$cli" >> $env:GITHUB_ENV

Start-Process $exe -ArgumentList '--silent' -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(90)
do {
    foreach ($endpoint in @('http://127.0.0.1:9222', 'http://[::1]:9222')) {
        try {
            $version = Invoke-RestMethod "$endpoint/json/version" -TimeoutSec 2
            if ($version.webSocketDebuggerUrl) {
                # CDP appears during Seelen's integrity check. On a cold runner
                # that check can fail and trigger a restart, losing loaded dev
                # widgets. Wait for the current launch's built-in UI to be ready.
                $logPath = Join-Path $env:LOCALAPPDATA 'com.seelen.seelen-ui/logs/Seelen UI.log'
                $log = Get-Content -LiteralPath $logPath -Raw -ErrorAction Stop
                $launch = $log.LastIndexOf('Starting Seelen UI v')
                if ($launch -lt 0 -or $log.Substring($launch) -notmatch '@seelen/fancy-toolbar[^\r\n]+status changed to: Ready') { continue }
                "SEELEN_CDP_URL=$endpoint" >> $env:GITHUB_ENV
                Write-Output "Seelen CDP is ready at $endpoint"
                exit 0
            }
        } catch { }
    }
    Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)
throw 'Seelen did not expose CDP within 90 seconds. See the uploaded service and application logs.'
