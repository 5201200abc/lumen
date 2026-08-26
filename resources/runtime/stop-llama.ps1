$ErrorActionPreference = "Stop"

$port = $env:LLAMA_PORT
if (-not $port) {
  throw "Lumen requires the detected or configured LLAMA_PORT."
}

$connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $connection) {
  Write-Output "No listener on port $port."
  exit 0
}

$listener = Get-Process -Id $connection.OwningProcess -ErrorAction Stop
if ($listener.ProcessName -notin @("llama-server", "llama-server.exe")) {
  throw "Refusing to stop non-llama listener pid=$($listener.Id) on port $port."
}

Stop-Process -Id $listener.Id
Write-Output "Stopped llama-server pid=$($listener.Id) on port $port."
