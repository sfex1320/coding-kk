@echo off
setlocal
cd /d %~dp0

echo CodeStatus Mobile APK build
echo.

where java >nul 2>nul
if errorlevel 1 (
  echo [Missing] Java JDK was not found in PATH.
  echo Install Android Studio or Temurin JDK 17, then reopen this terminal.
  pause
  exit /b 1
)

if "%ANDROID_HOME%"=="" (
  if "%ANDROID_SDK_ROOT%"=="" (
    echo [Missing] ANDROID_HOME or ANDROID_SDK_ROOT is not set.
    echo Install Android Studio and Android SDK, then set ANDROID_HOME to your SDK path.
    pause
    exit /b 1
  )
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Generating Android native project...
call npx expo prebuild --platform android
if errorlevel 1 exit /b 1

echo Building installable debug APK...
cd android
call gradlew.bat assembleDebug
if errorlevel 1 exit /b 1
cd ..

if not exist dist mkdir dist
copy /Y android\app\build\outputs\apk\debug\app-debug.apk dist\CodeStatus-Mobile-debug.apk >nul

echo.
echo Done: %cd%\dist\CodeStatus-Mobile-debug.apk
echo You can copy this APK to an Android phone and install it after allowing unknown-source apps.
pause
