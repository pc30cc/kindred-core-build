# The call widget's pixel gate: system fonts

Tier A (`e2e/callWidgetScreens.spec.ts`) compares the live widget with a
re-render of the handoff's boards in the same browser. Text that falls back
to a system face (`system-ui`, `sans-serif`) and the way text is rasterised
come from the machine's fontconfig, so the gate passes only on a machine
set up like the one it was tuned on:

- `fonts-inter` installed (Ubuntu 24.04: `apt-get install fonts-inter`);
- `56-prefer-inter.conf`: Inter for `sans-serif`, `system-ui` and the
  platforms' UI faces;
- `12-unhinted-grayscale.conf`: text drawn as images, not for a screen (no
  hinting, no subpixel colour fringes).

CI's job "Call widget pixel gate (Tier A)" (`.github/workflows/ci.yml`)
copies both into `/etc/fonts/conf.d/`. Do the same on a machine of your own
before running the gate there.
