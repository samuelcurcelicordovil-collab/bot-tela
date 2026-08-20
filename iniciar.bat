@echo off
title Bot Tela - Iniciador
cd /d "%~dp0"

echo ============================================
echo   BOT TELA - iniciando...
echo ============================================
echo.

if not exist "node_modules\" (
  echo Instalando dependencias pela primeira vez...
  call npm install
  echo.
)

echo [1/2] Subindo o servidor na porta 3000...
start "Bot Tela - Servidor" cmd /k node server.js

timeout /t 3 /nobreak >nul

echo [2/2] Abrindo o tunel do ngrok...
start "Bot Tela - ngrok" cmd /k ngrok http 3000

timeout /t 5 /nobreak >nul

echo.
echo ============================================
echo  Pegue o link "Forwarding" na janela do ngrok
echo  (algo como https://xxxx.ngrok-free.app)
echo  e mande para os seus amigos.
echo ============================================
echo.
echo Para encerrar tudo, feche as duas janelas que abriram.
echo.
pause
