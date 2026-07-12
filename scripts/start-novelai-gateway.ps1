$ErrorActionPreference = "Stop"
$gatewayDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\novelai-gateway"))
$python = Join-Path $gatewayDir ".venv\Scripts\python.exe"

$client = [System.Net.Sockets.TcpClient]::new()
try {
  $connected = $client.ConnectAsync("127.0.0.1", 31555).Wait(500)
} catch {
  $connected = $false
} finally {
  $client.Dispose()
}
if ($connected) {
  Write-Host "[Cyrene] NovelAI Gateway is already running."
  exit 0
}

if (-not (Test-Path -LiteralPath $python)) {
  Write-Host "[Cyrene] NovelAI Gateway dependencies are missing. Run 'uv sync' in $gatewayDir first."
  exit 0
}

Start-Process -FilePath $python -ArgumentList "main.py" -WorkingDirectory $gatewayDir -WindowStyle Hidden
Write-Host "[Cyrene] NovelAI Gateway started at http://127.0.0.1:31555"
