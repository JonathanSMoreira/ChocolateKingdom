@echo off
title Cacau Parque - iniciando...
echo.
echo 1) Abra o emulador no Android Studio (Device Manager) ANTES de usar o app.
echo 2) Abrindo backend (API) e Expo em janelas separadas...
echo.

echo Tentando liberar a porta 8081 (Metro antigo de ontem)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8081 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
timeout /t 1 /nobreak >nul

start "choco-backend" cmd /k "cd /d "%~dp0backend" && npm start"
timeout /t 2 /nobreak >nul
start "choco-expo" cmd /k "cd /d "%~dp0" && npx expo start"

echo Pronto. Na janela do Expo: pressione A (Android) ou R (recarregar).
timeout /t 4
