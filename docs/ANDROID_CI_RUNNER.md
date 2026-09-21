# Android CI Runner — `vps-50cc1602`

How the self-hosted Actions runner host is configured, and why each piece is
there. The decision to self-host, and the choice of this host over
`analyticsme.site`, are in `docs/adr/ADR-003-native-android-app.md` §5.

Prepared and registered 2026-09-21. The runner is live:
`actions.runner.pc30cc-kindred-core-build.vps-50cc1602-android.service`,
labels `self-hosted,linux,x64,android`, enabled at boot.

## The constraint this whole file is about

This host serves production. It runs Coolify, the full Supabase stack
(auth/GoTrue, storage, realtime, supavisor, studio, meta) and the WordPress
shop across 24 containers, on 4 cores and 7.7GB.

An Android build is not a small guest. An unconstrained Gradle daemon wants
2–4GB and an emulator ~4GB more, against roughly 2.9GB free. Everything below
exists so that when memory runs short, the kernel kills the build and not
Postgres.

## What was changed

### 1. Swap — 4GB, where there was none

```
/swapfile  4G  ext4  priority -2      # persistent via /etc/fstab
vm.swappiness = 10                    # /etc/sysctl.d/99-swap-tuning.conf
```

The host had **zero** swap while running the database stack, which meant any
memory spike went straight to an OOM kill with no buffer at all. That was a
pre-existing production exposure, independent of CI.

`swappiness=10` rather than the default 60: swap here is an emergency
overflow, not somewhere the kernel should be moving warm Postgres pages to
under normal load.

It was in use within minutes of being enabled — 375MB out, and available
memory rose from 2904MB to 3320MB. The host had been running with no headroom.

To undo: `swapoff /swapfile && rm /swapfile`, remove the `fstab` line.
`/etc/fstab.bak.<timestamp>` holds the original.

### 2. `ci.slice` — the ceiling

`/etc/systemd/system/ci.slice`:

```
MemoryHigh=1536M   # throttle and reclaim here
MemoryMax=2G       # hard stop; the build dies, nothing else does
CPUWeight=20       # production outweighs the build 5:1
IOWeight=20
TasksMax=4096
```

This is the actual safety belt. The swap and the capped heap only make
reaching it unlikely; the cgroup limit is what decides *who* dies when
something has to. The runner's systemd unit joins this slice through a
drop-in written by `finish-setup.sh`, along with `Nice=10` and
`IOSchedulingClass=idle`.

### 3. `needrestart` — list-only

`/etc/needrestart/conf.d/50-never-prompt.conf` sets `$nrconf{restart} = 'l'`.

This is a fix for something found rather than something anticipated. A package
install started **2026-09-17 00:03** was still holding
`/var/lib/dpkg/lock-frontend` on 2026-09-21 — four days and twenty hours. The
process tree was four deep and every member sat in `do_wait`; the leaf was
`needrestart`'s `apt-pinvoke`, which wanted to ask which services to restart
and had no TTY to ask on. `dpkg` itself was clean throughout (no pending
transaction, `dpkg --audit` empty), so the install had finished and only the
post-hook was stuck.

The consequence was that **no apt operation ran on this host for those four
days, security updates included.** The tree was killed and the lock released.

`'l'` lists what would need restarting and returns, restarting nothing by
itself — the safe answer on a host serving production, and it cannot hang
waiting for an answer.

### 4. Toolchain and runner

- `openjdk-17-jdk-headless` (17.0.20.1) and `openjdk-21-jdk-headless`. The
  workflow runs Gradle on 21; the app still compiles to Java 17 bytecode.
- `unzip` — the SDK's own packages need it.
- `actions-runner` 2.337.0 in `/home/ubuntu/actions-runner`.
- Android SDK in `/opt/android-sdk`, owned by `ubuntu`: `platform-tools`,
  `platforms;android-36`, `platforms;android-37.0`, `build-tools` 36.1.0 and
  37.0.0. About 950MB in total — far less than the ~14GB first estimated,
  because that figure was for a full Studio install with emulator images.

API 37 ships **minor platform versions**: the package is
`platforms;android-37.0`, and `platforms;android-37` does not exist. Asking
for the latter fails with "Failed to find package", which reads like a
network problem and is not one.

The bundled `cmdline-tools` also warns that it "only understands SDK XML
versions up to 3" against the version 4 files Google now serves. It still
works, but a self-update lands in `cmdline-tools/latest-2` rather than
replacing `latest`, and has to be moved into place by hand.

### 4a. Google Maven answers only over IPv4

This is the finding most likely to cost someone a day, so it is stated on its
own.

`dl.google.com` resolves to IPv6 from this host, and **every path under it
answers 404 over that route** — POMs that certainly exist included. The same
URL over IPv4 returns 200:

```
curl -6 …/androidx/core/core-ktx/1.12.0/core-ktx-1.12.0.pom   -> 404  (1449 bytes of Google's error page)
curl -4 …/androidx/core/core-ktx/1.12.0/core-ktx-1.12.0.pom   -> 200
```

Maven Central is unaffected; it is Google's edge only. The host is in Quebec
on OVH, so this is not geographic filtering.

Left alone, Gradle takes the IPv6 route and every AGP, androidx and Compose
artifact fails to resolve — reported as `Could not find
androidx.core:core-ktx:…`, which reads like a wrong version number rather
than a network fault. `android/gradle.properties` therefore sets
`-Djava.net.preferIPv4Stack=true` for the build JVM, and the workflow probes
for it in its own step so that the day this changes, the error says what it
is.

## Two security decisions worth not reversing

**The runner runs as `ubuntu`, never as root.** `config.sh` refuses to run as
root unless forced, and it is right to: a workflow running as root on this box
would have the Supabase data directory, the WordPress database and Coolify's
own credentials.

**`ubuntu` is deliberately not in the `docker` group.** Docker group membership
is equivalent to root — a container can bind-mount `/` — so adding it would
undo the point above completely. The Android build needs Gradle, a JDK and the
SDK; it does not need Docker.

### 5. Registration

Done via `/home/ubuntu/actions-runner/finish-setup.sh <token>`, which registers
as `ubuntu`, installs the service, writes the `ci.slice` drop-in and starts it.
The script is kept on the host for re-registering after a token rotation or a
rebuild; registration tokens are single-use and expire in about an hour, and
come from **Settings → Actions → Runners → New self-hosted runner**.

Confirmed at registration: `Connected to GitHub`, `Listening for Jobs`, runner
2.337.0, `User=ubuntu`, `Slice=ci.slice`, `Nice=10`,
`IOSchedulingClass=idle`, and `ci.slice` reporting `memory.max=2147483648` /
`memory.high=1610612736`. The unit is `enabled`, so it returns after a reboot.

### 6. One thing `svc.sh install` gets wrong

`svc.sh install` captures the PATH of whatever shell installed it and writes it
to `.path`, which the runner then hands to every job. Installed from an
automation shell, that file began:

```
/root/.npm/_npx/<hash>/node_modules/.bin:/home/ubuntu/node_modules/.bin:...
```

— root-owned npx directories in the PATH of a service running as `ubuntu`.
Dead entries rather than a privilege hole, since `ubuntu` cannot use them, but
they do not belong in a build environment and would be a confusing thing to
debug later. `.path` was replaced with a plain system PATH:

```
/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
```

Worth re-checking after any future `svc.sh install`.

## What the first real build did to the host

The first green build (`assembleDebug`, cold caches, Compose BOM 2026.09.00)
was measured rather than assumed:

| | |
|---|---|
| `ci.slice` peak | **1537 MB** of the 2048 MB ceiling |
| `memory.high` events | ~9000 — throttled and reclaimed constantly |
| `oom_kill` | **0** |
| Swap in use at peak | **2287 MB** of 4096 MB |
| Host memory still available | ~2900 MB |
| Load average | 6.55 on 4 cores |
| Wall clock | 3m 15s |

Two things follow. The guardrails are not theoretical headroom — the build
sat against `MemoryHigh` for essentially its whole duration and was held
there rather than allowed to grow. And the swap was not optional: 2.3GB of it
was in use at peak, so without it this build would have gone to the OOM
killer, on a host holding the database.

It also means there is little room above this. A larger app, a second
concurrent job, or an emulator will not fit as things stand. Raise
`MemoryMax` only after checking what the host has spare, and keep the
emulator on its own schedule as ADR-003 §6 requires.

## Verifying afterwards

```
swapon --show                                  # 4G present
systemctl show ci.slice -p MemoryMax           # 2147483648
systemctl show actions.runner.*.service -p Slice   # ci.slice
id ubuntu                                      # no docker group
df -h /                                        # watch this one
```

Disk is the resource that runs out quietly: 20G free against roughly 14G for
the Android SDK, one x86_64 system image, Gradle caches and build outputs.

The first few runs should be watched rather than assumed. If Supabase latency
moves while a build is in flight, ADR-003 §5 is the decision to revisit.
