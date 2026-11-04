/**
 * The operator's voice note (team chat, mobile inbox): a note that reaches
 * the five-minute limit stops by itself, lets go of the microphone, and is
 * still sent when the operator presses send.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';

/** Spec-like MediaRecorder: stop() on an inactive recorder does nothing and fires nothing. */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (m: string) => m === 'audio/webm';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stopCalls = 0;
  constructor(public stream: unknown) { FakeRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    this.stopCalls += 1;
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // The browser hands the data, then the stop event, a task later.
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)], { type: 'audio/webm' }) });
      this.onstop?.();
    }, 0);
  }
}

let track: { stop: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecorder.instances = [];
  track = { stop: vi.fn() };
  (window as unknown as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
});

async function startRecording(maxSeconds = 5) {
  const hook = renderHook(() => useVoiceRecorder(maxSeconds));
  await act(async () => { await hook.result.current.start(); });
  expect(hook.result.current.recording).toBe(true);
  return hook;
}

describe('useVoiceRecorder', () => {
  it('a note stopped by hand is sent and the microphone released', async () => {
    const { result } = await startRecording();
    await act(async () => { vi.advanceTimersByTime(2000); });
    let file: File | null = null;
    await act(async () => {
      const p = result.current.stop();
      await vi.runAllTimersAsync();
      file = await p;
    });
    expect(file).toBeInstanceOf(File);
    expect(file!.type).toBe('audio/webm');
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.recording).toBe(false);
  });

  it('at the limit it stops by itself, frees the mic, freezes the clock, and the note is still sent', async () => {
    const { result } = await startRecording(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const rec = FakeRecorder.instances[0];
    expect(rec.state).toBe('inactive');
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.seconds).toBe(5);
    // The clock does not run past the limit.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.seconds).toBe(5);
    // Waiting to be sent or dropped.
    expect(result.current.recording).toBe(true);

    let file: File | null = null;
    await act(async () => {
      const p = result.current.stop();
      await vi.runAllTimersAsync();
      file = await p;
    });
    expect(file).toBeInstanceOf(File);
    expect(file!.size).toBeGreaterThan(512);
    // No second stop() on the stopped recorder.
    expect(rec.stopCalls).toBe(1);
    expect(result.current.recording).toBe(false);
  });

  it('cancel drops the note and frees the mic', async () => {
    const { result } = await startRecording();
    act(() => { result.current.cancel(); });
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.recording).toBe(false);
    expect(result.current.seconds).toBe(0);
    let file: File | null = null;
    await act(async () => { file = await result.current.stop(); });
    expect(file).toBeNull();
  });

  it('unmounting while recording frees the mic', async () => {
    const { unmount } = await startRecording();
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(FakeRecorder.instances[0].state).toBe('inactive');
  });
});
