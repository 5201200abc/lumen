$ErrorActionPreference = "Stop"

$model = $env:LLAMA_MODEL
$hostAddress = if ($env:LLAMA_HOST) { $env:LLAMA_HOST } else { "127.0.0.1" }
$port = if ($env:LLAMA_PORT) { $env:LLAMA_PORT } else { "18082" }
$context = if ($env:LLAMA_CTX) { $env:LLAMA_CTX } else { "16384" }
$alias = if ($env:LLAMA_ALIAS) { $env:LLAMA_ALIAS } else { "Lumen-local" }
$parallel = if ($env:LLAMA_PARALLEL) { $env:LLAMA_PARALLEL } else { "1" }
$threads = if ($env:LLAMA_THREADS) { $env:LLAMA_THREADS } else { "5" }
$logDir = if ($env:LLAMA_LOG_DIR) { $env:LLAMA_LOG_DIR } else { Join-Path $env:LOCALAPPDATA "Lumen\logs" }
$server = if ($env:LLAMA_SERVER_BIN) { $env:LLAMA_SERVER_BIN } else {
  (Get-Command "llama-server.exe" -ErrorAction SilentlyContinue).Source
}

if (-not $model -or -not (Test-Path -LiteralPath $model -PathType Leaf)) {
  throw "Lumen could not find a GGUF model. Set LLAMA_MODEL or choose a models directory in Settings."
}
if (-not $server -or -not (Test-Path -LiteralPath $server -PathType Leaf)) {
  throw "llama-server.exe is not installed or is not on PATH. Install llama.cpp first."
}

try {
  $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1
  if ($health.StatusCode -eq 200) {
    Write-Output "A compatible llama-server is already ready on port $port; leaving it running."
    exit 0
  }
} catch {
  # No healthy server exists, so Lumen may safely start its own process.
}

$arguments = @(
  "-m", $model, "-a", $alias, "-ngl", "999", "-c", $context, "-np", $parallel,
  "-b", "2048", "-ub", "2048", "-t", $threads, "-fa", "on",
  "-ctk", "q4_0", "-ctv", "q4_0", "--jinja", "--reasoning-format", "auto",
  "--host", $hostAddress, "--port", $port
)

if ($env:LUMEN_DRY_RUN -eq "1") {
  Write-Output "$server $($arguments -join ' ')"
  exit 0
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "llama-server.log"
$errorLog = Join-Path $logDir "llama-server.error.log"
$process = Start-Process -FilePath $server -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errorLog -PassThru
$process.Id | Set-Content -Encoding ascii (Join-Path $logDir "llama-server.pid")
Write-Output "llama-server pid=$($process.Id) log=$logFile"
