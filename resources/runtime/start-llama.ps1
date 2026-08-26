$ErrorActionPreference = "Stop"

$modelsDir = $env:LLAMA_MODELS_DIR
$modelsMax = if ($env:LLAMA_MODELS_MAX) { $env:LLAMA_MODELS_MAX } else { "1" }
$hostAddress = if ($env:LLAMA_HOST) { $env:LLAMA_HOST } else { "127.0.0.1" }
$port = $env:LLAMA_PORT
$context = if ($env:LLAMA_CTX) { $env:LLAMA_CTX } else { "16384" }
$parallel = if ($env:LLAMA_PARALLEL) { $env:LLAMA_PARALLEL } else { "1" }
$threads = if ($env:LLAMA_THREADS) { $env:LLAMA_THREADS } else { "5" }
$logDir = if ($env:LLAMA_LOG_DIR) { $env:LLAMA_LOG_DIR } else { Join-Path $env:LOCALAPPDATA "Lumen\logs" }
$restart = $env:LUMEN_RESTART -eq "1"
$server = if ($env:LLAMA_SERVER_BIN) { $env:LLAMA_SERVER_BIN } else {
  (Get-Command "llama-server.exe" -ErrorAction SilentlyContinue).Source
}

if (-not $modelsDir) {
  throw "Lumen requires LLAMA_MODELS_DIR for its multi-model router."
}
if (-not $port) {
  throw "Lumen requires the detected or configured LLAMA_PORT."
}
if (-not (Test-Path -LiteralPath $modelsDir -PathType Container)) {
  throw "Lumen models directory does not exist: $modelsDir"
}
if (-not $server -or -not (Test-Path -LiteralPath $server -PathType Leaf)) {
  throw "llama-server.exe is not installed or is not on PATH. Install llama.cpp first."
}

$arguments = @(
  "--models-dir", $modelsDir, "--models-max", $modelsMax, "--models-autoload",
  "-ngl", "999", "-c", $context, "-np", $parallel,
  "-b", "2048", "-ub", "2048", "-t", $threads, "-fa", "on",
  "-ctk", "q4_0", "-ctv", "q4_0", "--jinja", "--reasoning-format", "auto",
  "--host", $hostAddress, "--port", $port
)

if ($env:LUMEN_DRY_RUN -eq "1") {
  Write-Output "$server $($arguments -join ' ')"
  exit 0
}

$healthy = $false
try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1
  $healthy = $health.StatusCode -eq 200
} catch {
  $healthy = $false
}

if ($healthy) {
  $router = $false
  try {
    $props = Invoke-RestMethod -Uri "http://127.0.0.1:$port/props" -TimeoutSec 1
    $router = $props.role -eq "router"
  } catch {
    $router = $false
  }
  if ($router -and -not $restart) {
    Write-Output "Lumen multi-model router is already ready on port $port."
    exit 0
  }

  $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $listener = if ($connection) { Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue } else { $null }
  if (-not $listener -or $listener.ProcessName -notin @("llama-server", "llama-server.exe")) {
    throw "Port $port is occupied by a non-Lumen service; cannot start the multi-model router."
  }
  Write-Output "Replacing old llama-server pid=$($listener.Id) with Lumen multi-model router."
  Stop-Process -Id $listener.Id -Force
  Start-Sleep -Milliseconds 300
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "llama-server.log"
$errorLog = Join-Path $logDir "llama-server.error.log"
$process = Start-Process -FilePath $server -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errorLog -PassThru
$process.Id | Set-Content -Encoding ascii (Join-Path $logDir "llama-server.pid")
Write-Output "llama-server pid=$($process.Id) log=$logFile"
