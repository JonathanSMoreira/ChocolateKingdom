# Copia prints do fluxo para docs/imagens-fluxo com os nomes esperados pela documentação.
# Uso: .\scripts\copiar-prints-fluxo.ps1 -Source "C:\Users\...\Downloads\pasta_com_prints"
param(
    [Parameter(Mandatory = $true)]
    [string] $Source
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dest = Join-Path $root "docs\imagens-fluxo"

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Error "Pasta não encontrada: $Source"
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$files = @(Get-ChildItem -LiteralPath $Source -File | Where-Object {
    $_.Extension -match '\.(png|jpg|jpeg)$'
})
if ($files.Count -eq 0) {
    Write-Error "Nenhum .png/.jpg encontrado em: $Source"
}

# Ordenação por nome (prints WhatsApp incluem data/hora no nome)
$byName = $files | Sort-Object Name

$targets = @(
    "01-login-perfil-visitante.png",
    "02-configuracoes-funcionario.png",
    "03-cadastro-cargos.png",
    "04-mapa-legenda.png",
    "05-equipe-presenca.png",
    "06-mapa-parque.png",
    "07-perfil-visitante-logado.png"
)

$n = [Math]::Min($targets.Length, $byName.Length)
for ($i = 0; $i -lt $n; $i++) {
    $src = $byName[$i].FullName
    $out = Join-Path $dest $targets[$i]
    Copy-Item -LiteralPath $src -Destination $out -Force
    Write-Host "OK" $targets[$i] "<-" $byName[$i].Name
}

Write-Host "`nDestino: $dest"
Write-Host "Confira a ordem na tabela do apêndice em docs/FLUXO_APP_SIMPLES.md; ajuste nomes manualmente se necessário."
