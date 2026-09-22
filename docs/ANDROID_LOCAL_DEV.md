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

The AVD is configured that way on purpose, and it does not look like it:

```
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
```

`hw.gpu.enabled=no` was there before and reads like an oversight — an idle
Radeon Pro 5500M in the machine, and acceleration apparently switched off.
Turning it on with `hw.gpu.mode=host` was tried, and reproduced this section
exactly: a good `screencap` out of a black window. If the picture is poor,
the answer is one of the two above or fewer pixels to push
(`hw.lcd.width`/`height`/`density`), never `-gpu host`.

And check free memory before blaming the renderer at all. Measured while
this was being chased: 18MB of free pages with 5.3GB inactive. Nothing
configured in the emulator repairs a host that has run out of room.

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

**API 24 was not run,** and the reason was never established. An earlier note
in this file blamed CPU emulation on an Apple Silicon Mac; that was simply
wrong, and is corrected here rather than quietly deleted. The machine is an
Intel Core i9-9880H, so an x86_64 guest runs natively and there is no
emulation to be slow. Whatever hung it, it was something else.

Lint covers the API surface in the meantime; what it cannot cover is font and
vendor behaviour, which is why the flag badge asks `Paint.hasGlyph` rather
than assuming.

### Speed, and what an emulator can and cannot tell you

Cold start, `am start -W` `TotalTime`, 12 launches per filter with a
`force-stop` between each, against the R8'd `minified` APK on the same API 36
x86_64 emulator:

| ART filter | min | median | max |
|---|---|---|---|
| `verify` — nothing compiled ahead of time | 993 ms | 1102 ms | 1359 ms |
| `speed-profile` — compiled from the baseline profile | 992 ms | 1130 ms | 1461 ms |
| `speed` — the whole app compiled ahead of time | 1004 ms | 1090 ms | 1424 ms |

Read the third row first. `speed` is the ceiling: there is no profile, present
or possible, that can do more than compiling every method in the app. It came
out **12 ms** ahead of compiling nothing at all, inside a spread of 366 ms.

That is not a result about the profile. It is a result about the instrument.
The guest is x86_64 on an x86_64 host, so it runs natively on a 2.3GHz Core
i9 with the whole app in page cache: the JIT keeps up easily and the work AOT
removes is work this machine barely does. Any number from here about
compilation would be noise with a decimal point on it.

So the question was put a different way: not *how long did it take*, but *what
did ART actually compile*. That is measurable and it is not noisy — the files
are on disk after `cmd package compile`:

| ART filter | `base.odex` | `base.art` (app image) |
|---|---|---|
| `verify` | 66 KB | — |
| `speed-profile` | **5.35 MB** | **753 KB** |
| `speed` | 18.3 MB | — |

The profile moves **5.35 MB** of machine code off the phone's first run — 80×
what `verify` produces, and 29% of what compiling the entire app would. It is
also the only filter of the three that produces an app image: 753 KB of
pre-loaded, pre-initialised classes, which `speed` does not build because it
has no startup rules to build one from.

Cost in the APK is **12 KB**, not the 1.6 MB the rules occupy as text —
`assets/dexopt/baseline.prof` is the compiled form, with the names already
mapped through R8's mapping file. `androidx.profileinstaller` accepted it on
first launch (`result=1`) and ART is holding a 12,016-byte `primary.prof` for
the app.

**What is still unmeasured: whether any of that reaches the first frame on a
real phone.** It should — a mid-range device with slow flash and a weak little
core is exactly where 5.35 MB of pre-compiled code and a preloaded class image
pay — but this document does not claim a number it has not taken. That needs
hardware.

### The keyboard, and why the emulator hides it

Two separate things, found together when the login screen appeared not to
open a keyboard at all.

**The emulator was the reason nothing appeared.** `Webyar_API36.avd` had
`hw.keyboard = yes`, which tells Android a physical keyboard is attached — so
it suppresses the soft one and you type with the Mac's. It is now `no`; the
old file is at `config.ini.bak`. A change here needs the emulator restarted,
not just the app.

**The app had a real fault underneath it.** `enableEdgeToEdge` sets
`decorFitsSystemWindows = false`, and from that moment
`windowSoftInputMode="adjustResize"` resizes nothing — the window draws behind
the IME and the app applies the inset. The chat, team and email screens did.
Login, profile and security — the three screens that are forms — did not.

Measured on the device by dumping the view hierarchy with the field focused:

| | scroll viewport | "Log in" button |
|---|---|---|
| before | `[0,128]–[1080,2337]` | y 1544–1603 |
| after | `[0,128]–[1080,1517]` | y 1134–1193 |

The keyboard's top edge is y=1517. Before, the button sat at 1544 — entirely
underneath it, on a centred form inside a scroll with nothing to scroll, so
there was no way to reach it at all. After, the viewport ends where the
keyboard begins and everything is above it.

The inset goes **outside** the scroll modifier. Inside, the padding travels
with the content and the field stays under the keyboard.
