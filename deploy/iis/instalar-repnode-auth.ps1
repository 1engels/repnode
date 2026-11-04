#Requires -RunAsAdministrator
# Instala la aplicacion IIS /repnode-auth: un endpoint minimo que devuelve el usuario de la sesion de PME a RepNode.
# No modifica las aplicaciones de PME: crea un application pool y una aplicacion nuevos en "Default Web Site".
#
# PME usa machineKey AutoGenerate: Windows genera las claves por identidad del application pool. Para poder leer la
# cookie de PME, /repnode-auth corre con la misma identidad que el pool de /Web (NetworkService en PME 13.2). Si esa
# identidad es propia del pool (ApplicationPoolIdentity) o un usuario especifico, se usa directamente el pool de /Web.
#
# Uso (PowerShell como administrador, en el servidor de PME, desde la carpeta deploy\iis del repositorio):
#   powershell -ExecutionPolicy Bypass -File .\instalar-repnode-auth.ps1
# Opcional: -Destino C:\RepNode\repnode-auth  -Sitio "Default Web Site"

param(
  [string]$Destino = 'C:\RepNode\repnode-auth',
  [string]$Sitio = 'Default Web Site',
  [string]$Pool = 'RepNodeAuth',
  [string]$AplicacionPme = '/Web'
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

function Paso([string]$t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

# Huella del machineKey (nunca se muestran las claves)
function MachineKeyHash([string]$webConfig) {
  if (-not (Test-Path -LiteralPath $webConfig)) { return $null }
  $xml = New-Object System.Xml.XmlDocument
  $xml.Load($webConfig)
  $mk = $xml.SelectSingleNode('/configuration/system.web/machineKey')
  if ($null -eq $mk) { return $null }
  $raw = ($mk.validationKey, $mk.decryptionKey, $mk.validation, $mk.decryption) -join '|'
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))).Replace('-', '').Substring(0, 16)
}

# Atributos del machineKey que no son claves (p. ej. compatibilityMode), para compararlos a la vista
function MachineKeyAttributes([string]$webConfig) {
  if (-not (Test-Path -LiteralPath $webConfig)) { return '(sin web.config)' }
  $xml = New-Object System.Xml.XmlDocument
  $xml.Load($webConfig)
  $mk = $xml.SelectSingleNode('/configuration/system.web/machineKey')
  if ($null -eq $mk) { return '(sin machineKey: hereda)' }
  # Las claves solo se muestran si son "AutoGenerate..." (no son secretas); una clave real nunca
  $attrs = @($mk.Attributes | Where-Object { $_.Name -notin @('validationKey', 'decryptionKey') -or $_.Value -like 'AutoGenerate*' } | ForEach-Object { "$($_.Name)=$($_.Value)" })
  if ($attrs.Count -eq 0) { return '(solo claves)' }
  return $attrs -join ' '
}

Paso 'Comprobando que /repnode-auth podra leer la cookie de PME'
$site = Get-Website -Name $Sitio
if (-not $site) { throw "No existe el sitio '$Sitio'" }
$rootConfig = Join-Path ([Environment]::ExpandEnvironmentVariables($site.PhysicalPath)) 'web.config'
$pmeApp = Get-WebApplication -Site $Sitio -Name $AplicacionPme.TrimStart('/')
if (-not $pmeApp) { throw "No existe la aplicacion $AplicacionPme en '$Sitio'" }
$pmeConfig = Join-Path ([Environment]::ExpandEnvironmentVariables($pmeApp.PhysicalPath)) 'web.config'
$rootHash = MachineKeyHash $rootConfig
$pmeHash = MachineKeyHash $pmeConfig
if (-not $rootHash) { throw "El web.config raiz ($rootConfig) no tiene machineKey: /repnode-auth no podria validar la cookie de PME" }
if ($pmeHash -and $pmeHash -ne $rootHash) {
  throw "El machineKey de $AplicacionPme no coincide con el del web.config raiz (huellas $pmeHash / $rootHash). Avisa antes de continuar."
}
Write-Host "machineKey del sitio y de $AplicacionPme coinciden (huella $rootHash)"
Write-Host "  atributos raiz : $(MachineKeyAttributes $rootConfig)"
Write-Host "  atributos $AplicacionPme : $(MachineKeyAttributes $pmeConfig)"
if ((MachineKeyAttributes $rootConfig) -match 'Isolate') {
  Write-Warning 'El machineKey usa IsolateApps/IsolateByAppId: las claves dependen de cada aplicacion y /repnode-auth no podria leer la cookie de PME. Avisa antes de seguir.'
}

Paso "Copiando archivos a $Destino"
New-Item -ItemType Directory -Force -Path $Destino | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'repnode-auth\*') -Destination $Destino -Force
# El application pool (IIS_IUSRS, NetworkService por SID: su nombre cambia con el idioma) y el usuario anonimo solo leen
icacls $Destino /grant 'IIS_IUSRS:(OI)(CI)RX' 'IUSR:(OI)(CI)RX' '*S-1-5-20:(OI)(CI)RX' | Out-Null

Paso "Application pool (misma identidad que $AplicacionPme)"
$pmePool = $pmeApp.applicationPool
$pmeIdentity = (Get-ItemProperty "IIS:\AppPools\$pmePool" -Name processModel.identityType)
if ($pmeIdentity -isnot [string]) { $pmeIdentity = [string]$pmeIdentity.Value }
Write-Host "Pool de $AplicacionPme : $pmePool (identidad $pmeIdentity)"
if ($pmeIdentity -in @('NetworkService', 'LocalService', 'LocalSystem')) {
  if (-not (Test-Path "IIS:\AppPools\$Pool")) {
    New-WebAppPool -Name $Pool | Out-Null
  }
  Set-ItemProperty "IIS:\AppPools\$Pool" -Name managedRuntimeVersion -Value 'v4.0'
  Set-ItemProperty "IIS:\AppPools\$Pool" -Name managedPipelineMode -Value 'Integrated'
  Set-ItemProperty "IIS:\AppPools\$Pool" -Name processModel.identityType -Value $pmeIdentity
  try { Restart-WebAppPool -Name $Pool } catch { Start-WebAppPool -Name $Pool -ErrorAction SilentlyContinue }
  Write-Host "Pool $Pool listo (.NET v4.0, integrado, $pmeIdentity)"
} else {
  # Identidad propia del pool o usuario especifico: solo el mismo pool tiene las mismas claves
  $Pool = $pmePool
  Write-Host "Se usa el pool de PME ($Pool): su identidad no se puede replicar en otro pool"
}

Paso 'Aplicacion /repnode-auth'
if (Get-WebApplication -Site $Sitio -Name 'repnode-auth') {
  Set-ItemProperty "IIS:\Sites\$Sitio\repnode-auth" -Name physicalPath -Value $Destino
  Set-ItemProperty "IIS:\Sites\$Sitio\repnode-auth" -Name applicationPool -Value $Pool
  Write-Host 'Ya existia: actualizada'
} else {
  New-WebApplication -Site $Sitio -Name 'repnode-auth' -PhysicalPath $Destino -ApplicationPool $Pool | Out-Null
  Write-Host 'Creada'
}

Paso 'Prueba sin sesion de PME (debe responder 401)'
Start-Sleep -Seconds 2
$code = & curl.exe -s -o NUL -w '%{http_code}' 'http://127.0.0.1/repnode-auth/whoami.ashx'
Write-Host "Respuesta: $code"
if ($code -ne '401') {
  Write-Warning 'Se esperaba 401. Encabezados de la respuesta:'
  & curl.exe -s -i -o NUL -D - 'http://127.0.0.1/repnode-auth/whoami.ashx' | Select-String -Pattern '^(HTTP/|Location:)'
  Write-Warning 'Si el error persiste, abre la URL en el navegador del servidor o revisa el visor de eventos.'
}

Write-Host ''
$ver = & curl.exe -s -o NUL -D - 'http://127.0.0.1/repnode-auth/whoami.ashx' | Select-String -Pattern '^X-RepNode-Auth:'
Write-Host "Version instalada: $(if ($ver) { $ver.Line } else { 'desconocida (archivo anterior?)' })"

Write-Host ''
Write-Host 'Siguiente paso: probar con tu cookie de PME (ver README, "Despliegue en PME").' -ForegroundColor Green
