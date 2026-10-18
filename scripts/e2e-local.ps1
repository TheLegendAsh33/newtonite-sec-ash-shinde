$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$backendDirectory = Join-Path $repositoryRoot "backend"
$frontendDirectory = Join-Path $repositoryRoot "frontend"
$python = Join-Path $backendDirectory ".venv\Scripts\python.exe"
$node = (Get-Command node -ErrorAction Stop).Source
$testDirectory = Join-Path $repositoryRoot "tmp\playwright-sqlite"
$runId = [guid]::NewGuid().ToString("N")
$databasePath = Join-Path $testDirectory "workbench-$runId.db"
$apiLog = Join-Path $testDirectory "api-$runId.log"
$apiErrorLog = Join-Path $testDirectory "api-$runId.err.log"
$webLog = Join-Path $testDirectory "web-$runId.log"
$webErrorLog = Join-Path $testDirectory "web-$runId.err.log"
$apiProcess = $null
$webProcess = $null
$testExitCode = 1
$testsPassed = $false
$environmentNames = @("DATABASE_URL", "APP_ENV", "SEED_DEMO_DATA", "CORS_ORIGINS", "NEXT_PUBLIC_API_URL", "E2E_BASE_URL", "E2E_API_URL", "E2E_MANAGED_EXTERNALLY")
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Wait-ForUrl([string]$url, [string]$service, [System.Diagnostics.Process]$process, [string]$errorLog) {
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    try {
        $client.Timeout = [TimeSpan]::FromSeconds(3)
        for ($attempt = 0; $attempt -lt 120; $attempt++) {
            if ($process.HasExited) {
                $details = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Tail 40 | Out-String } else { "" }
                throw "$service exited before becoming ready.`n$details"
            }
            $response = $null
            try {
                $response = $client.GetAsync($url).GetAwaiter().GetResult()
                $statusCode = [int]$response.StatusCode
                if ($statusCode -ge 200 -and $statusCode -lt 400) { return }
            } catch {
                # A service can take a few seconds to bind its local port.
            } finally {
                if ($null -ne $response) { $response.Dispose() }
            }
            Start-Sleep -Seconds 1
        }
    } finally {
        $client.Dispose()
    }
    $details = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Tail 40 | Out-String } else { "" }
    throw "$service did not become ready at $url.`n$details"
}

function Stop-ProcessTree([int]$processId) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $processId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        Stop-ProcessTree ([int]$child.ProcessId)
    }
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

function Stop-StartedProcess($process) {
    if ($null -ne $process -and -not $process.HasExited) {
        # Next.js creates a child server process; stop the whole owned tree so a
        # subsequent run cannot accidentally connect to an earlier test app.
        Stop-ProcessTree $process.Id
        $process.WaitForExit(5000) | Out-Null
    }
}

New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
$databasePathForUrl = $databasePath.Replace("\", "/")
$env:DATABASE_URL = "sqlite:///$databasePathForUrl"
$env:APP_ENV = "development"
$env:SEED_DEMO_DATA = "true"
$env:CORS_ORIGINS = "http://127.0.0.1:13100"
$env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:18001/api"
$env:E2E_BASE_URL = "http://127.0.0.1:13100"
$env:E2E_API_URL = "http://127.0.0.1:18001/api"
$env:E2E_MANAGED_EXTERNALLY = "true"

try {
    Push-Location $backendDirectory
    try {
        & $python -m alembic upgrade head
        if ($LASTEXITCODE -ne 0) { throw "Could not migrate the disposable SQLite database." }
    } finally {
        Pop-Location
    }

    $apiProcess = Start-Process -FilePath $python -ArgumentList @(
        "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "18001"
    ) -WorkingDirectory $backendDirectory -PassThru -WindowStyle Hidden -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog

    $nextCli = Join-Path $frontendDirectory "node_modules\next\dist\bin\next"
    $webArguments = "`"$nextCli`" dev --hostname 127.0.0.1 --port 13100"
    $webProcess = Start-Process -FilePath $node -ArgumentList $webArguments -WorkingDirectory $frontendDirectory -PassThru -WindowStyle Hidden -RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog

    Wait-ForUrl "http://127.0.0.1:18001/api/health/ready" "API" $apiProcess $apiErrorLog
    Wait-ForUrl "http://127.0.0.1:13100" "web frontend" $webProcess $webErrorLog

    Push-Location $frontendDirectory
    try {
        & npm run e2e
        $testExitCode = $LASTEXITCODE
        $testsPassed = $testExitCode -eq 0
    } finally {
        Pop-Location
    }
    if ($testExitCode -ne 0) { throw "Playwright exited with code $testExitCode." }
} finally {
    Stop-StartedProcess $webProcess
    Stop-StartedProcess $apiProcess
    foreach ($path in @($databasePath, "$databasePath-wal", "$databasePath-shm")) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
    if ($testsPassed) {
        foreach ($path in @($apiLog, $apiErrorLog, $webLog, $webErrorLog)) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
}
