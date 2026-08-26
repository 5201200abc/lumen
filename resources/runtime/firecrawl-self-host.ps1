$ErrorActionPreference = "Stop"

$action = if ($args.Count) { $args[0] } else { "status" }
$homeDir = if ($env:FIRECRAWL_HOME) {
  $env:FIRECRAWL_HOME
} else {
  Join-Path $env:LOCALAPPDATA "Lumen\firecrawl"
}
$version = if ($env:FIRECRAWL_VERSION) { $env:FIRECRAWL_VERSION } else { "v2.11.0" }
$compose = Join-Path $homeDir "docker-compose.yaml"

function Install-Stack {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required." }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker is required." }
  if (-not (Test-Path -LiteralPath $compose -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $homeDir) | Out-Null
    git clone --depth 1 --branch $version https://github.com/firecrawl/firecrawl.git $homeDir
  }
}

switch ($action) {
  "install" { Install-Stack }
  "start" { Install-Stack; docker compose -f $compose up -d }
  "stop" { if (Test-Path $compose) { docker compose -f $compose down } }
  "restart" {
    if (Test-Path $compose) { docker compose -f $compose down }
    Install-Stack
    docker compose -f $compose up -d
  }
  "status" {
    if (Test-Path $compose) { docker compose -f $compose ps }
    else { Write-Output "Firecrawl is not installed." }
  }
  default { throw "Usage: firecrawl-self-host.ps1 {install|start|stop|restart|status}" }
}
