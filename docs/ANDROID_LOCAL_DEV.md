# Running the Android app on a Mac

Building is easy and is covered in one section. The emulator is not, and the
rest of this file is about that.

Server-side CI is a separate thing entirely — see `docs/ANDROID_CI_RUNNER.md`
and `docs/adr/ADR-003-native-android-app.md` §5. Nothing here runs in CI.

## Build and test

There is no Android Studio requirement for either. From the repo root:

```
cd android
./gradlew assembleDebug          # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # 20 JVM tests, Robolectric-backed
```

Gradle needs a JDK 21 to *run*; the app still compiles to Java 17 bytecode.
If `sdkmanager` or `gradlew` says `Unable to locate a Java Runtime`, Android
Studio ships one and nothing else needs installing:

```
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
```

Measured on a 2019 Intel i9 MacBook Pro, cold caches: `BUILD SUCCESSFUL in
2m 13s`, 20/20 tests green.

## The emulator

### Use a system image whose major.minor matches the emulator

This is the finding most likely to cost someone a day, so it is stated first.

`emulator -version` and the system image are **not independently choosable**.
Emulator 37.1.11 against the `android-37.0` image produces a boot that looks
like it half-works — `adb devices` shows `emulator-5554 device`,
`sys.boot_completed` reads `1`, and then every install fails with:

```
adb: failed to install app-debug.apk: cmd: Can't find service: package
```

which reads like an adb or a packaging problem and is neither. What is
actually happening is in logcat:

```
F mapper.ranchu: Assertion failed: !rcEnc->featureInfo()->hasReadColorBufferDma
F libc    : Fatal signal 6 (SIGABRT) in tid 622 (RegionSampling), pid 510 (surfaceflinger)
F DEBUG   : #03 GoldfishMapper::readFromHost(cb_handle_t const&) const
F DEBUG   : #09 android::RegionSamplingThread::threadMain()
```

The guest's gralloc (`mapper.ranchu.so`) asserts that the host does **not**
advertise the `ANDROID_EMU_read_color_buffer_dma` renderControl extension.
Emulator 37.1.11 advertises it unconditionally. So every time SystemUI's
status bar asks SurfaceFlinger to sample the screen region beneath it,
SurfaceFlinger aborts — and it takes `system_server` down with it:

```
I init : Untracked process (pid: 2569 name: (system_server) ... state: Z) received SIGKILL
```

`system_server` owns the `package` service, so the install window closes every
time the loop comes round, roughly every 20 seconds. `sys.boot_completed`
stays `1` throughout because a framework restart does not clear it, which is
why the device looks booted while nothing works.

Four things that look like the fix and are not. Each was tried, not
reasoned about:

| Suspected | Result |
|---|---|
| Memory | Reproduces with GB free; unrelated |
| Renderer | `-gpu host` **and** `-gpu swiftshader_indirect` both abort |
| `-feature -GLDMA` | Applied (`Feature 'GLDMA' (51) is overridden to 'disabled'`), still aborts |
| Image revision | `android-37.0` rev 6 **and** `android-37.1` rev 9 both abort |

The renderer one is worth a sentence, because it is the one most likely to
be tried first and it costs a boot each time. `readFromHost` is a CPU
readback path, so software rendering looks like the obvious culprit — but
the extension is a host *transport* feature, not a rendering one, and the
abort happens identically on the host GPU. Confirm which renderer you
actually got before drawing any conclusion from a run:

```
INFO | emuglConfig_init: vulkan_mode_selected:swiftshader gles_mode_selected:host
```

The emulator downgrades to software silently under memory pressure (see
below), so a run you believe was on the host GPU may not have been.
`ANDROID_EMU_SKIP_GPU_CHECKS=1` suppresses that fallback, which is how the
`-gpu host` row above was established rather than assumed.

### What works

`system-images;android-36;google_apis;x86_64` — Android 16. Measured on the
same machine, same emulator binary, same AVD settings:

```
[02:11:11] boot=1  pkg=[Service package: found]  sf_crashes=0
[02:11:43] sf crashes after settle: 0
[02:11:43] installing -> Success
[02:12:01] topResumedActivity=com.webyar.operator/.MainActivity
```

API 36 is a device the app supports anyway — `minSdk` is 24 — so nothing
about the app changes to run on it. CI still builds and tests against 37 on
the server; this is only about having something to look at locally.

Creating it, start to finish:

```
sdkmanager --install "system-images;android-36;google_apis;x86_64"
avdmanager create avd -n Webyar_API36 -k "system-images;android-36;google_apis;x86_64" -d pixel_6
emulator -avd Webyar_API36 -gpu swiftshader_indirect -no-snapshot -no-boot-anim -no-audio -memory 2048
```

### A black emulator window is not a dead emulator

Separately from all of the above, `-gpu host` on this machine produces a
**window that stays black while Android renders correctly behind it**. The
two are easy to confuse and the distinguishing test takes one command:

```
adb exec-out screencap -p > /tmp/shot.png
```

`screencap` reads the guest framebuffer directly and owes nothing to the
host window. A good screenshot from a black window means the guest is fine
and only presentation is broken — so do not go back to debugging the boot.

Two ways out, in order:

1. `-gpu swiftshader_indirect`, which presents through a different path.
2. Android Studio's **Running Devices** panel, which streams frames over
   gRPC rather than drawing a native GL window, and therefore tends to work
   precisely when the standalone window does not.

### Android Studio hides the emulator window

If Studio launched the emulator, the process carries `-qt-hide-window`:

```
qemu-system-x86_64 ... -avd Webyar_API37 -qt-hide-window -grpc-use-token ...
```

Studio renders it inside its own **Running Devices** tool window rather than
as a desktop window. An emulator that is running and adb-visible but nowhere
on screen is usually this, not a crash. Launching from a terminal gives a
normal window.

### After a hard kill, clear the lock files

`pkill`ing qemu leaves the AVD locked, and the next launch dies with
`Running multiple emulators with the same AVD is an experimental feature`:

```
rm -rf ~/.android/avd/<name>.avd/*.lock
```

## Memory, on a 16GB machine

Worth knowing before blaming the emulator for something else. On this Mac the
emulator alone accounted for essentially all of the memory pressure:

| | with emulator | after killing it |
|---|---|---|
| unused | 28 MB | 3337 MB |
| compressor | 3244 MB | 129 MB |
| swap in use | 9701 MB | — |

The other large resident process, at ~2.5GB, is the Colima VM holding the
local Supabase stack (two Postgres containers among six). That is a working
database, not idle overhead — do not stop it to make room.

When the emulator decides there is not enough free memory it does not fail,
it silently downgrades:

```
WARNING | Software GL rendering will be used due to system memory pressure,
          performance will be affected! (Available Memory: 3798 MB, Required: 5120 MB)
```

so a slow emulator on a loaded machine is usually this line, scrolled past.

## Seeing the sample data on a device

`Backend` (in `src/debug`) only reaches `SampleApi` when `webyar.sample` is
set as a JVM property or `WEBYAR_SAMPLE=1` is in the environment — which the
instrumentation runner does and `adb shell am start` cannot. A plain launch
therefore talks to the real server and stops at the login screen, which is
the intended behaviour, not a fault.

To get the sample inbox on screen without an account, set the environment
variable through Android's `wrap.` debug property:

```
adb root
adb shell setprop wrap.com.webyar.operator "WEBYAR_SAMPLE=1"
adb shell am force-stop com.webyar.operator
adb shell am start -n com.webyar.operator/.MainActivity
```

`adb root` is required — the property is SELinux-protected and the call
fails with "See dmesg for error reason" without it. It works on
`google_apis` images and not on `google_apis_playstore` ones, which is a
reason to prefer the former for an AVD used for looking at things. Confirm
it took effect by reading the app's own environment rather than trusting the
property:

```
adb shell cat /proc/$(adb shell pidof com.webyar.operator)/environ | tr '\0' '\n' | grep -i webyar
```

The property does not survive a reboot of the guest, so it has to be set
again after every emulator restart.

## What was measured, and on what

Numbers rather than adjectives, all from the Mac's emulator (Pixel-class,
1080×2400, API 36) on 2026-09-22 unless another device is named.

### Size

R8 and the ABI split together take the app from a 74MB debug APK to what a
phone actually downloads:

| Build | Size |
|---|---|
| `app-debug.apk` (all four ABIs, unminified) | 74.0 MB |
| `app-armeabi-v7a-minified.apk` | 11.0 MB |
| `app-arm64-v8a-minified.apk` | 16.4 MB |
| `app-x86_64-minified.apk` | 20.5 MB |
| `app-universal-minified.apk` | 53.8 MB |

51MB of the debug APK was native code, and a seventh of that was for mips,
mips64 and armeabi — architectures Android dropped in 2019. `abiFilters` is
what removes them; the split is what stops a directly-installed APK carrying
four copies of WebRTC.

The universal APK exists for the one case that needs it (a workspace handing
out a single file), and is not what Play serves.

### R8

`assembleMinified` builds with the release rules and the debug signature, so
what R8 produces can actually be installed and looked at. It was: installed,
launched, login screen, no `ClassNotFound`, no `NoSuchMethod`, no
`SerializationException`, fonts intact after resource shrinking.

The failure mode the keep rules exist for is quieter than a crash. The models
are decoded by name out of JSON and nothing reflects on them, so R8 has every
reason to rename their fields — and a renamed field decodes to null. The app
would show an inbox of blank rows and blame the server.

### Compatibility

Swept at 1x and 2x font scale, light and dark, portrait and landscape, and at
720×1280 @320dpi (a cheap five-inch phone). Two real faults came out of it,
both now fixed: the flag badge vanished at 2x (an `sp` line height inside a
`dp` circle), and the floating tab bar stretched across the full width in
landscape.

`lintDebug` passes, which is the honest answer on minSdk 24 — `NewApi` checks
every call against the declared minimum, and it is more thorough than
clicking around an old emulator.

**API 24 was not run.** The x86_64 system image needs full CPU emulation on
an Apple Silicon Mac and its QEMU threads hang before boot. Lint covers the
API surface; what it cannot cover is font and vendor behaviour, which is why
the flag badge now asks `Paint.hasGlyph` rather than assuming.
