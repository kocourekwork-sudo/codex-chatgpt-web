@echo off
REM Obal pro deploy-local.sh - vynucuje spravny bash (Git\bin, ne Git\usr\bin).
"C:\Program Files\Git\bin\bash.exe" "%~dp0deploy-local.sh" %*
