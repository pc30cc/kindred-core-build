#!/usr/bin/env python3
"""
Generates the app's incoming-call ringtone.

Synthesised rather than sampled, for two reasons. A ringtone lifted from
another app is somebody else's copyright, and a generated one can be tuned and
regenerated from this file rather than being an opaque blob nobody dares
touch.

The motif is the classic double ring: two short tones, a beat, the same two
tones, then silence — the shape a phone has made since bells, which is why it
reads as "answer me" and not as "notification". A perfect two-cycle loop, so
CallKit can repeat it for as long as it rings without an audible seam.

Run: python3 scripts/ios/make-ringtone.py
Out: ios/WebyarNative/Resources/Ringtone.wav
"""
import math
import struct
import wave
from pathlib import Path

RATE = 22_050          # Plenty for two pure tones, and a quarter the bytes of 44.1k.
CYCLE = 3.0            # Seconds per double ring.
CYCLES = 2             # A two-cycle file loops seamlessly.
PEAK = 0.62            # Headroom: a ringtone that clips sounds cheap.

# E5 and A5. A rising fourth is the interval nearly every ringtone uses: it
# resolves upward, which is why it sounds like a question rather than an alarm.
LOW = 659.25
HIGH = 880.00

# start, duration, frequency — the double ring, then silence to fill the cycle.
TONES = [
    (0.00, 0.20, LOW),
    (0.22, 0.20, HIGH),
    (0.60, 0.20, LOW),
    (0.82, 0.22, HIGH),
]

ATTACK = 0.012         # Seconds. Long enough that nothing clicks.
RELEASE = 0.070        # A soft tail is what makes it sound like an instrument.


def envelope(t: float, duration: float) -> float:
    """Attack/sustain/release, clamped so a short tone never goes negative."""
    if t < ATTACK:
        return t / ATTACK
    if t > duration - RELEASE:
        remaining = max(0.0, duration - t)
        return remaining / RELEASE
    return 1.0


def sample_at(t: float) -> float:
    """One sample of the cycle at time `t`, summed over any active tone."""
    value = 0.0
    for start, duration, freq in TONES:
        if not (start <= t < start + duration):
            continue
        local = t - start
        phase = 2.0 * math.pi * freq * local
        # A little second harmonic gives the tone a body a bare sine lacks.
        tone = math.sin(phase) + 0.22 * math.sin(2.0 * phase)
        value += tone * envelope(local, duration)
    return value


def main() -> None:
    frames = bytearray()
    total = int(RATE * CYCLE)
    for index in range(total):
        t = index / RATE
        value = max(-1.0, min(1.0, sample_at(t) * PEAK / 1.22))
        frames += struct.pack('<h', int(value * 32_767))
    one_cycle = bytes(frames)

    out = Path(__file__).resolve().parents[2] / 'ios/WebyarNative/Resources/Ringtone.wav'
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(one_cycle * CYCLES)
    print(f'wrote {out} ({out.stat().st_size:,} bytes, {CYCLE * CYCLES:g}s)')


if __name__ == '__main__':
    main()
