@echo off
rem Registriert den CAD-Wächter in SolidWorks (als Administrator ausführen)
set REGASM=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe
"%REGASM%" /codebase "%~dp0AperioPlan.SwAddin.dll"
if errorlevel 1 (echo Registrierung fehlgeschlagen & pause & exit /b 1)
echo AperioPlan CAD-Waechter registriert. Bitte SolidWorks neu starten.
pause
