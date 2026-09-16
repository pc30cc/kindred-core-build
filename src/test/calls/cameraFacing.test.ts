import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  computeCanSwitchCamera, facingOfDevice, inferFacingFromLabel, type CameraDevice,
} from '@/features/calls/cameraFacing';

/**
 * "Flip camera" is only a real operation on a device that has a front AND a
 * back camera. The old rule was `cameras.length >= 2`, which put a dead
 * button on every laptop with a second webcam — a virtual camera, a capture
 * card, a USB cam — and then failed when it was pressed, because there is no
 * `environment` camera to flip to.
 */

const cam = (facing: CameraDevice['facing'], label = ''): CameraDevice =>
  ({ deviceId: `${facing || 'unknown'}-${label}`, label, facing });

/** A minimal InputDeviceInfo — capabilities present or absent. */
function device(label: string, facingMode?: string[]): MediaDeviceInfo {
  const base = { kind: 'videoinput', deviceId: 'd', label, groupId: 'g' };
  return (facingMode === undefined
    ? base
    : { ...base, getCapabilities: () => ({ facingMode }) }) as unknown as MediaDeviceInfo;
}

describe('which way a camera points', () => {
  it('trusts the facingMode capability above everything else', () => {
    expect(facingOfDevice(device('Integrated Webcam', ['environment']))).toBe('environment');
    // A label that disagrees with the capability does not get a vote.
    expect(facingOfDevice(device('Front Camera', ['environment']))).toBe('environment');
  });

  it('reads the label when the platform reports no facingMode', () => {
    // A laptop webcam reports an EMPTY facingMode list — that is exactly the
    // signal that distinguishes a desktop from a phone.
    expect(facingOfDevice(device('Integrated Webcam', []))).toBe('');
    // Safari never exposes getCapabilities here but does name its cameras.
    expect(facingOfDevice(device('Back Camera'))).toBe('environment');
    expect(facingOfDevice(device('Front Camera'))).toBe('user');
  });

  it('survives a getCapabilities that throws', () => {
    const hostile = {
      kind: 'videoinput', deviceId: 'd', label: 'Back Camera', groupId: 'g',
      getCapabilities: () => { throw new Error('not supported'); },
    } as unknown as MediaDeviceInfo;
    expect(facingOfDevice(hostile)).toBe('environment');
  });

  it('recognises how each platform words its camera labels', () => {
    for (const label of ['Back Camera', 'camera2 0, facing back', 'Rear wide', 'environment cam']) {
      expect(inferFacingFromLabel(label), label).toBe('environment');
    }
    for (const label of ['Front Camera', 'camera2 1, facing front', 'user facing', 'Selfie cam']) {
      expect(inferFacingFromLabel(label), label).toBe('user');
    }
    // Nothing to go on — and "unknown" must never be read as "switchable".
    for (const label of ['', 'Integrated Webcam', 'OBS Virtual Camera', 'Logitech C920']) {
      expect(inferFacingFromLabel(label), label).toBe('');
    }
  });
});

describe('whether flipping the camera means anything on this device', () => {
  it('needs a front and a back camera, not just two cameras', () => {
    expect(computeCanSwitchCamera([cam('user'), cam('environment')])).toBe(true);
  });

  it('refuses a laptop with several forward-facing or unclassifiable cameras', () => {
    // The exact case the user hit: a laptop, no back camera, dead button.
    expect(computeCanSwitchCamera([
      cam('', 'Integrated Webcam'), cam('', 'OBS Virtual Camera'),
    ])).toBe(false);
    expect(computeCanSwitchCamera([cam('user'), cam('user')])).toBe(false);
    expect(computeCanSwitchCamera([cam('user')])).toBe(false);
    expect(computeCanSwitchCamera([])).toBe(false);
  });

  it('refuses a back camera with no front camera to come back to', () => {
    expect(computeCanSwitchCamera([cam('environment')])).toBe(false);
  });

  it('still works when extra unclassifiable cameras are present', () => {
    expect(computeCanSwitchCamera([
      cam('user'), cam('environment'), cam('', 'Some virtual device'),
    ])).toBe(true);
  });
});

describe('the visitor widget answers the question the same way', () => {
  // The widget ships as a standalone ES5 bundle and cannot import from src/,
  // so the rule is written twice. This is the guard that keeps them in step.
  const CALL_RUNTIME = readFileSync('public/widget/runtime-call.js', 'utf8');

  it('gates on a front/back pair rather than on a camera count', () => {
    expect(CALL_RUNTIME).toContain('function computeCanSwitchCamera(cams)');
    expect(CALL_RUNTIME).toContain("cams[i].facing === 'user'");
    expect(CALL_RUNTIME).toContain("cams[i].facing === 'environment'");
    expect(CALL_RUNTIME).toContain('return hasUser && hasEnvironment;');
  });

  it('prefers the facingMode capability over the label, like the operator does', () => {
    expect(CALL_RUNTIME).toContain('function facingOfDevice(device)');
    expect(CALL_RUNTIME).toContain('device.getCapabilities');
    expect(CALL_RUNTIME).toContain('facing: facingOfDevice(d)');
  });

  it('refuses the switch in the engine, not only in the button', () => {
    // The control can be a render behind the enumeration, and the engine is
    // a public API — a switch that cannot succeed must not tear down the
    // live camera track trying.
    const fn = CALL_RUNTIME.slice(
      CALL_RUNTIME.indexOf('function switchCamera()'),
      CALL_RUNTIME.indexOf('function listCameras()'),
    );
    expect(fn).toContain('if (!canSwitchCamera) {');
  });

  it('publishes the capability to the UI instead of the raw camera list', () => {
    const RUNTIME = readFileSync('public/widget/runtime.js', 'utf8');
    expect(RUNTIME).toContain('canSwitchCamera: !!(info && info.canSwitch)');
    expect(RUNTIME).toContain('var canSwitchCam = isVideo && s.canSwitchCamera === true;');
    // The old count-based gate must be gone for good.
    expect(RUNTIME).not.toContain('s.cameras.length >= 2');
  });
});
