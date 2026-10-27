@echo off
set REGASM=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe
"%REGASM%" /u "%~dp0AperioPlan.SwAddin.dll"
pause
