#!/usr/bin/env bash
# Local release APK (test-signed). Needs ~/android-toolchain (JDK 17 + Android SDK). Usage: scripts/build-apk.sh [server-url]
set -e
export JAVA_HOME=~/android-toolchain/jdk ANDROID_HOME=~/android-toolchain/sdk
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
export EXPO_PUBLIC_API_URL=${1:-http://192.168.0.192:4000} NODE_ENV=production
cd "$(dirname "$0")/.."
npx expo prebuild -p android --clean --no-install
cd android
./gradlew assembleRelease --no-daemon -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g" > build.log 2>&1 || { tail -40 build.log; exit 1; }
tail -3 build.log
ls -la app/build/outputs/apk/release/app-release.apk
