#Requires -RunAsAdministrator
# Publica RepNode en el sitio de PME: https://<servidor>/repnode/ -> http://127.0.0.1:3210/repnode/ (URL Rewrite + ARR).
# Aplica con los comandos de IIS lo mismo que describe web.config.example, sin editar XML a mano.
# Se puede ejecutar varias veces (reemplaza sus propias reglas). Hace respaldo del web.config raiz antes de tocarlo.
# No modifica las aplicaciones de PME: las reglas solo capturan rutas que empiezan con /repnode.
#
# Uso (PowerShell como administrador, con RepNode corriendo en el puerto 3210):
#   powershell -ExecutionPolicy Bypass -File .\publicar-repnode.ps1
#   powershell -ExecutionPolicy Bypass -File .\publicar-repnode.ps1 -Quitar     (deshace todo)

param(
  [string]$Sitio = 'Default Web Site',
  [int]$Puerto = 3210,
  [switch]$Quitar
)

$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

function Paso([string]$t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

$apphost = 'MACHINE/WEBROOT/APPHOST'
$site = Get-Website -Name $Sitio
if (-not $site) { throw "No existe el sitio '$Sitio'" }
$pspath = "IIS:\Sites\$Sitio"
$rules = 'system.webServer/rewrite/rules'
$names = @('RepNode HTTPS', 'RepNode proxy')

Paso 'Respaldo del web.config raiz del sitio'
$webConfig = Join-Path ([Environment]::ExpandEnvironmentVariables($site.PhysicalPath)) 'web.config'
$backup = "$webConfig.bak-repnode-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $webConfig -Destination $backup
Write-Host "Respaldo: $backup"

Paso 'Quitando reglas anteriores de RepNode (si las hay)'
foreach ($n in $names) {
  if (Get-WebConfiguration -PSPath $pspath -Filter "$rules/rule[@name='$n']") {
    Remove-WebConfigurationProperty -PSPath $pspath -Filter $rules -Name '.' -AtElement @{ name = $n }
    Write-Host "Quitada: $n"
  }
}
try { Clear-WebConfiguration -PSPath $pspath -Location 'repnode' -Filter 'system.webServer/urlCompression' } catch { }

if ($Quitar) {
  Paso 'Desactivando el proxy de ARR (estaba apagado antes de RepNode)'
  Set-WebConfigurationProperty -PSPath $apphost -Filter 'system.webServer/proxy' -Name enabled -Value $false
  Write-Host ''
  Write-Host 'RepNode ya no se publica en IIS.' -ForegroundColor Green
  return
}

Paso 'Proxy de ARR'
# responseBufferLimit 0: el progreso de los reportes llega por SSE y no debe quedar retenido en el bufer
# timeout 30 min: descargas grandes y conexiones de progreso largas (RepNode envia un latido cada 15 s)
Set-WebConfigurationProperty -PSPath $apphost -Filter 'system.webServer/proxy' -Name enabled -Value $true
Set-WebConfigurationProperty -PSPath $apphost -Filter 'system.webServer/proxy' -Name preserveHostHeader -Value $true
Set-WebConfigurationProperty -PSPath $apphost -Filter 'system.webServer/proxy' -Name responseBufferLimit -Value 0
Set-WebConfigurationProperty -PSPath $apphost -Filter 'system.webServer/proxy' -Name timeout -Value '00:30:00'
if (-not (Get-WebConfiguration -PSPath $apphost -Filter "system.webServer/rewrite/allowedServerVariables/add[@name='HTTP_X_FORWARDED_PROTO']")) {
  Add-WebConfigurationProperty -PSPath $apphost -Filter 'system.webServer/rewrite/allowedServerVariables' -Name '.' -Value @{ name = 'HTTP_X_FORWARDED_PROTO' }
}
Write-Host 'Activado (conserva el Host, sin bufer de respuesta, timeout 30 min)'

Paso 'Reglas de URL Rewrite'
# 1) RepNode solo por HTTPS: su cookie de sesion es Secure
Add-WebConfigurationProperty -PSPath $pspath -Filter $rules -Name '.' -AtIndex 0 -Value @{ name = 'RepNode HTTPS'; stopProcessing = 'True' }
$r = "$rules/rule[@name='RepNode HTTPS']"
Set-WebConfigurationProperty -PSPath $pspath -Filter "$r/match" -Name url -Value '^repnode(/.*)?$'
Add-WebConfigurationProperty -PSPath $pspath -Filter "$r/conditions" -Name '.' -Value @{ input = '{HTTPS}'; pattern = 'off' }
Set-WebConfigurationProperty -PSPath $pspath -Filter "$r/action" -Name type -Value 'Redirect'
Set-WebConfigurationProperty -PSPath $pspath -Filter "$r/action" -Name url -Value 'https://{HTTP_HOST}/{R:0}'
Set-WebConfigurationProperty -PSPath $pspath -Filter "$r/action" -Name redirectType -Value 'Found'

# 2) Proxy hacia RepNode, avisando que el cliente llego por HTTPS
Add-WebConfigurationProperty -PSPath $pspath -Filter $rules -Name '.' -AtIndex 1 -Value @{ name = 'RepNode proxy'; stopProcessing = 'True' }
$r = "$rules/rule[@name='RepNode proxy']"
Set-WebConfigurationProperty -PSPath $pspath -Filter "$r/match" -Name url -Value '^repnode(/.*)?$'
Add-WebConfigurationProperty -PSPath $pspath -Filter "$r/serverVariables" -Name '.' -Value @{ name = 'HTTP_X_FORWARDED_PROTO'; value = 'https' }
Set-WebConfigurationProperty -PSPath $pspath -Filter "$r/action" -Name type -Value 'Rewrite'
Set-WebConfigurationProperty -PSPath $pspath -Filter "$r/action" -Name url -Value "http://127.0.0.1:$Puerto/repnode{R:1}"
Write-Host 'Reglas "RepNode HTTPS" y "RepNode proxy" listas'

Paso 'Sin compresion dinamica en /repnode (retendria los eventos de progreso)'
Set-WebConfigurationProperty -PSPath $pspath -Location 'repnode' -Filter 'system.webServer/urlCompression' -Name doDynamicCompression -Value $false
Write-Host 'Listo'

Paso 'Reglas vigentes en el sitio'
Get-WebConfiguration -PSPath $pspath -Filter "$rules/rule" |
  Select-Object name, @{ n = 'match'; e = { $_.match.url } }, @{ n = 'accion'; e = { "$($_.action.type) $($_.action.url)" } } | Format-Table -AutoSize

Paso 'Pruebas'
Start-Sleep -Seconds 2
$https = & curl.exe -k -s -o NUL -w '%{http_code}' 'https://127.0.0.1/repnode/api/session'
Write-Host "https://127.0.0.1/repnode/api/session -> $https (se espera 401 de RepNode; 502 = RepNode no esta corriendo)"
$http = & curl.exe -s -o NUL -w '%{http_code} %{redirect_url}' 'http://127.0.0.1/repnode/'
Write-Host "http://127.0.0.1/repnode/ -> $http (se espera 302 hacia https)"
Write-Host ''
Write-Host "Para deshacer: restaura $backup o ejecuta este script con -Quitar." -ForegroundColor Green
