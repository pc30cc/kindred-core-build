/**
 * Strict scope test for the shared RecordingTimeline UX component.
 *
 * Verifies:
 *   - renders the underlying native media element (audio/video) and KEEPS
 *     native controls (we enhance, not replace, the existing engine)
 *   - exposes a seek slider with accessible role + time readout
 *   - skip controls call into the same media element
 *   - no destructive / retention / annotation controls leak into the UI
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecordingTimeline } from '@/components/recordings/RecordingTimeline';

describe('RecordingTimeline', () => {
  beforeEach(() => {
    // jsdom does not implement media element timing; provide a settable
    // currentTime so seek calls succeed without throwing.
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return (this as any)._t || 0; },
      set(v: number) { (this as any)._t = v; },
    });
  });

  it('renders an audio element with native controls for audio kind', () => {
    const { container } = render(
      <RecordingTimeline src="blob:fake" kind="audio" recordingId="rec_audio_1" durationHint={120} />,
    );
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('controls')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('renders a video element for video kind and exposes the slider', () => {
    const { container } = render(
      <RecordingTimeline src="blob:fake" kind="video" recordingId="rec_video_1" durationHint={60} />,
    );
    expect(container.querySelector('video')).not.toBeNull();
    const slider = screen.getByRole('slider', { name: /seek/i });
    expect(slider.getAttribute('aria-valuemax')).toBe('60');
  });

  it('skip buttons advance the media element currentTime', () => {
    render(<RecordingTimeline src="blob:fake" kind="audio" recordingId="rec_skip" durationHint={300} />);
    const fwd = screen.getByTestId('recording-timeline-fwd-rec_skip');
    fireEvent.click(fwd);
    fireEvent.click(fwd);
    // 0 + 10 + 10 = 20s shown
    expect(screen.getByText(/0:20\s*\/\s*5:00/)).toBeInTheDocument();
  });

  it('contains no destructive / retention / annotation controls', () => {
    const { container } = render(
      <RecordingTimeline src="blob:fake" kind="audio" recordingId="rec_safe" durationHint={10} />,
    );
    const text = container.textContent || '';
    for (const banned of ['Delete', 'Retention', 'Legal hold', 'Comment', 'Annotation']) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});