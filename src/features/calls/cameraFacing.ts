/**
 * Which way a camera points, and whether "flip camera" means anything here.
 *
 * The visitor widget carries the same logic in plain ES5 (see
 * `computeCanSwitchCamera` in `public/widget/runtime-call.js`) because it
 * ships as a standalone bundle and cannot import from `src/`. Keep the two
 * in step.
 */

/** Cameras report their side either as a capability or only in their label. */
export type CameraFacing = 'user' | 'environment' | '';

export interface CameraDevice {
  deviceId: string;
  label: string;
  facing: CameraFacing;
}

/**
 * Some browsers never fill in `facingMode`, but every platform names its
 * phone cameras in a way that says which side they are on — Safari reports
 * "Front Camera" / "Back Camera", Android Chrome "camera2 0, facing back".
 */
export function inferFacingFromLabel(label: string): CameraFacing {
  const s = String(label || '').toLowerCase();
  if (!s) return '';
  if (s.includes('back') || s.includes('rear') || s.includes('environment')) return 'environment';
  if (s.includes('front') || s.includes('user') || s.includes('face') || s.includes('selfie')) return 'user';
  return '';
}

/**
 * `InputDeviceInfo.getCapabilities().facingMode` is the authoritative answer
 * and the one that tells desktops apart: a laptop webcam reports an EMPTY
 * facingMode list, a phone camera reports ['user'] or ['environment'].
 */
export function facingOfDevice(device: MediaDeviceInfo): CameraFacing {
  const withCaps = device as MediaDeviceInfo & { getCapabilities?: () => MediaTrackCapabilities };
  try {
    if (typeof withCaps.getCapabilities === 'function') {
      const modes = withCaps.getCapabilities()?.facingMode;
      if (modes?.length) {
        for (const mode of modes) {
          if (mode === 'environment' || mode === 'user') return mode;
        }
      }
    }
  } catch {
    // getCapabilities throws on some builds rather than returning nothing.
  }
  return inferFacingFromLabel(device.label || '');
}

/**
 * Whether switching cameras is a real operation on this device.
 *
 * Switching flips between the front and the back camera, so the only thing
 * that makes the control meaningful is having BOTH. Counting cameras is a
 * different question and gets this wrong: a laptop with a built-in webcam
 * plus a USB or virtual camera has two devices and nothing to flip to.
 * A device whose cameras cannot be classified at all counts as not
 * switchable — a control that does nothing is worse than an absent one.
 */
export function computeCanSwitchCamera(cameras: readonly CameraDevice[]): boolean {
  return cameras.some((c) => c.facing === 'user')
    && cameras.some((c) => c.facing === 'environment');
}

/** Enumerate video inputs, classified. Returns [] when the API is missing. */
export async function enumerateCameras(): Promise<CameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({
        deviceId: d.deviceId || '',
        label: d.label || '',
        facing: facingOfDevice(d),
      }));
  } catch {
    return [];
  }
}
