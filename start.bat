@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 goto npm_missing

if not exist "node_modules\" goto dependencies_missing

if not exist "dist\main\main\index.js" goto build_missing

echo [Cyrene] 正在启动...
call npm.cmd start
set "CYRENE_EXIT_CODE=%ERRORLEVEL%"
if not "%CYRENE_EXIT_CODE%"=="0" goto start_failed
exit /b 0

:npm_missing
echo [错误] 未找到 npm，请先安装 Node.js 24。
echo 安装完成后，请重新双击 start.bat。
pause
exit /b 1

:dependencies_missing
echo [提示] 项目依赖尚未安装。
echo 请先双击 setup.bat 完成初始化，然后再运行 start.bat。
pause
exit /b 1

:build_missing
echo [提示] 项目尚未构建。
echo 请先双击 setup.bat 完成初始化，然后再运行 start.bat。
pause
exit /b 1

:start_failed
echo.
echo [错误] Cyrene 启动失败，错误码：%CYRENE_EXIT_CODE%
pause
exit /b %CYRENE_EXIT_CODE%
