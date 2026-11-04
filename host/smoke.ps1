# Teste de fumaça do CI: abre o .exe e fala com ele como o navegador falaria.
# Sem -Exe, testa o hub que já estiver rodando na porta 7787.
param([string]$Exe)
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:7787'
$wsBase = 'ws://127.0.0.1:7787'
$origin = 'https://oblita.giuli.dev'
$never = [Threading.CancellationToken]::None
$binary = [Net.WebSockets.WebSocketMessageType]::Binary
$text = [Net.WebSockets.WebSocketMessageType]::Text
$closeType = [Net.WebSockets.WebSocketMessageType]::Close
$normal = [Net.WebSockets.WebSocketCloseStatus]::NormalClosure

function Check($ok, $what) {
  if (-not $ok) { throw "FALHOU: $what" }
  Write-Host "ok: $what"
}

function Http($method, $path, [string[]]$headers = @()) {
  $curl = @('-s', '-i', '--max-time', '5', '-X', $method)
  foreach ($h in $headers) { $curl += @('-H', $h) }
  $lines = @(& curl.exe @curl "$base$path")
  $res = @{ Status = 0; Headers = @{}; Body = '' }
  if ($lines.Count -eq 0) { return $res }
  $res.Status = [int]($lines[0] -split ' ')[1]
  $i = 1
  while ($i -lt $lines.Count -and $lines[$i] -ne '') {
    $name, $value = $lines[$i] -split ':\s*', 2
    $res.Headers[$name.ToLowerInvariant()] = $value
    $i++
  }
  $res.Body = ($lines | Select-Object -Skip ($i + 1)) -join "`n"
  return $res
}

function CheckCors($res, $expectedOrigin, $label) {
  Check ($res.Headers['access-control-allow-origin'] -eq $expectedOrigin) "$label`: Allow-Origin = $expectedOrigin"
  Check ($res.Headers['access-control-allow-private-network'] -eq 'true') "$label`: Allow-Private-Network"
  Check ($res.Headers['access-control-allow-local-network'] -eq 'true') "$label`: Allow-Local-Network"
  Check ($res.Headers['access-control-allow-headers'] -eq '*') "$label`: Allow-Headers"
  Check ($res.Headers['access-control-allow-methods'] -match 'GET') "$label`: Allow-Methods"
}

function WaitTask($task, $what) {
  if (-not $task.Wait(8000)) { throw "FALHOU: tempo esgotado em $what" }
}

function Connect($url) {
  $ws = New-Object Net.WebSockets.ClientWebSocket
  WaitTask $ws.ConnectAsync([Uri]$url, $never) "conectar em $url"
  return $ws
}

function Send($ws, [byte[]]$bytes, $type = $binary) {
  $segment = New-Object 'ArraySegment[byte]' (, $bytes)
  WaitTask $ws.SendAsync($segment, $type, $true, $never) 'enviar'
}

function Recv($ws) {
  $buffer = New-Object byte[] 1048576
  $all = New-Object IO.MemoryStream
  do {
    $task = $ws.ReceiveAsync((New-Object 'ArraySegment[byte]' (, $buffer)), $never)
    WaitTask $task 'receber'
    $all.Write($buffer, 0, $task.Result.Count)
  } while (-not $task.Result.EndOfMessage)
  return @{ Type = $task.Result.MessageType; Data = $all.ToArray() }
}

function Frame([uint32]$conn, [byte]$op, [byte[]]$data = @()) {
  $head = [BitConverter]::GetBytes($conn)
  [Array]::Reverse($head)
  $out = New-Object IO.MemoryStream
  $out.Write($head, 0, 4)
  $out.WriteByte($op)
  $out.Write($data, 0, $data.Length)
  return , $out.ToArray()
}

function RecvFrame($ws) {
  $msg = Recv $ws
  Check ($msg.Type -eq $binary) 'painel recebe quadro binário'
  $d = $msg.Data
  $conn = ([uint32]$d[0] -shl 24) -bor ([uint32]$d[1] -shl 16) -bor ([uint32]$d[2] -shl 8) -bor [uint32]$d[3]
  $rest = New-Object byte[] ($d.Length - 5)
  [Array]::Copy($d, 5, $rest, 0, $rest.Length)
  return @{ Conn = $conn; Op = $d[4]; Data = $rest }
}

function PingHub { return (Http 'GET' '/ping').Body | ConvertFrom-Json }

function WaitPing($test, $what) {
  for ($i = 0; $i -lt 40; $i++) {
    if (& $test (PingHub)) { Check $true $what; return }
    Start-Sleep -Milliseconds 100
  }
  Check $false $what
}

$process = $null
$log = Join-Path ([IO.Path]::GetTempPath()) 'oblita-host.log'
$errLog = Join-Path ([IO.Path]::GetTempPath()) 'oblita-host.err.log'
try {
  if ($Exe) {
    $process = Start-Process -FilePath (Resolve-Path $Exe).Path -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog
  }
  $up = $false
  for ($i = 0; $i -lt 40 -and -not $up; $i++) {
    $up = (Http 'GET' '/ping').Status -eq 200
    if (-not $up) { Start-Sleep -Milliseconds 250 }
  }
  Check $up 'hub responde em /ping'

  $res = Http 'GET' '/ping'
  $json = $res.Body | ConvertFrom-Json
  Check ($json.app -eq 'oblita' -and $json.v -eq 1 -and $json.students -eq 0 -and $json.host -eq $false) "/ping: $($res.Body)"
  CheckCors $res '*' 'ping sem Origin'
  CheckCors (Http 'GET' '/ping' @("Origin: $origin")) $origin 'ping com Origin'

  $res = Http 'OPTIONS' '/host-token' @("Origin: $origin", 'Access-Control-Request-Method: GET', 'Access-Control-Request-Private-Network: true', 'Access-Control-Request-Local-Network: true')
  Check ($res.Status -eq 204) 'preflight responde 204'
  CheckCors $res $origin 'preflight'
  CheckCors (Http 'GET' '/nao-existe' @("Origin: $origin")) $origin 'rota inexistente'

  Check ((Http 'GET' '/host-token').Status -eq 403) '/host-token sem Origin = 403'
  $res = Http 'GET' '/host-token' @('Origin: https://exemplo.com')
  Check ($res.Status -eq 403) '/host-token com Origin estranha = 403'
  CheckCors $res 'https://exemplo.com' '403 também leva CORS'
  $res = Http 'GET' '/host-token' @("Origin: $origin")
  Check ($res.Status -eq 200) '/host-token com Origin certa = 200'
  $auth = $res.Body | ConvertFrom-Json
  Check ($auth.token -cmatch '^[0-9a-f]{32}$') 'token tem 128 bits em hexadecimal'
  Check ($auth.PSObject.Properties.Name -contains 'addresses') 'token vem com addresses'

  $upgrade = @('Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
  Check ((Http 'GET' '/ws/host?token=errado' $upgrade).Status -eq 403) '/ws/host com token errado = 403'

  $panel = Connect "$wsBase/ws/host?token=$($auth.token)"
  $student = Connect "$wsBase/ws/student"
  $f = RecvFrame $panel
  $conn = $f.Conn
  Check ($conn -ge 1 -and $f.Op -eq 0) 'painel recebe open do aluno'

  Send $student ([byte[]](1, 2, 3))
  $f = RecvFrame $panel
  Check ($f.Conn -eq $conn -and $f.Op -eq 2 -and ($f.Data -join ',') -eq '1,2,3') 'aluno -> painel'

  Send $panel ([byte[]](0, 0))
  Send $panel (Frame $conn 2 ([byte[]](9, 8)))
  $m = Recv $student
  Check ($m.Type -eq $binary -and ($m.Data -join ',') -eq '9,8') 'painel -> aluno, ignorando quadro curto'

  Send $student ([Text.Encoding]::UTF8.GetBytes('oi')) $text
  Send $student ([byte[]](7))
  $f = RecvFrame $panel
  Check ($f.Op -eq 2 -and ($f.Data -join ',') -eq '7') 'texto do aluno é ignorado'

  $big = New-Object byte[] (2 * 1024 * 1024)
  Send $panel (Frame $conn 2 $big)
  Check ((Recv $student).Data.Length -eq $big.Length) 'quadro de 2 MiB painel -> aluno'
  Send $student $big
  Check ((RecvFrame $panel).Data.Length -eq $big.Length) 'quadro de 2 MiB aluno -> painel'

  WaitTask $panel.CloseAsync($normal, 'recarregou', $never) 'fechar o painel'
  WaitPing { param($p) $p.host -eq $false -and $p.students -eq 1 } 'aluno sobrevive à queda do painel'
  Check ($student.State -eq 'Open') 'socket do aluno continua aberto'

  $panel = Connect "$wsBase/ws/host?token=$($auth.token)"
  $f = RecvFrame $panel
  Check ($f.Conn -eq $conn -and $f.Op -eq 0) 'painel novo recebe open de quem já estava'
  Send $student ([byte[]](5))
  $f = RecvFrame $panel
  Check ($f.Op -eq 2 -and ($f.Data -join ',') -eq '5') 'relay volta depois de reconectar'

  $second = Connect "$wsBase/ws/host?token=$($auth.token)"
  $f = RecvFrame $second
  Check ($f.Conn -eq $conn -and $f.Op -eq 0) 'segundo painel recebe open'
  Check ((Recv $panel).Type -eq $closeType) 'painel antigo é substituído e fechado'
  [void]$panel.CloseOutputAsync($normal, '', $never)

  # O último dado precisa chegar antes do fechamento: é assim que o aluno recebe "refused".
  Send $second (Frame $conn 2 ([byte[]](4)))
  Send $second (Frame $conn 1)
  Check (((Recv $student).Data -join ',') -eq '4') 'dado chega antes do fechamento'
  Check ((Recv $student).Type -eq $closeType) 'op close fecha o aluno'
  [void]$student.CloseOutputAsync($normal, '', $never)
  $f = RecvFrame $second
  Check ($f.Conn -eq $conn -and $f.Op -eq 1) 'painel recebe close do aluno'
  WaitPing { param($p) $p.students -eq 0 -and $p.host -eq $true } 'contagem final em /ping'

  if ($process) {
    Check (-not $process.HasExited) 'programa continua rodando'
    Start-Sleep -Milliseconds 300
    Stop-Process -Id $process.Id -Force
    [void]$process.WaitForExit(5000)
    $output = Get-Content -Raw -Encoding UTF8 $log
    Check ($output -match 'tudo certo') 'log de início saiu'
    Check ($output -match 'Painel do professor conectado') 'log do painel saiu'
    Check ($output -match 'Aluno desconectou') 'log do aluno saiu'
  }
  Write-Host 'Teste de fumaça passou.'
} finally {
  if ($process) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    if (Test-Path $log) { Write-Host '--- saída do programa ---'; Get-Content -Encoding UTF8 $log }
    if ((Test-Path $errLog) -and (Get-Item $errLog).Length) { Write-Host '--- erros ---'; Get-Content -Encoding UTF8 $errLog }
  }
}
exit 0
