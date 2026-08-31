import { describe, it, expect, beforeEach } from 'vitest';
import {
  readSendActionPref, writeSendActionPref, DEFAULT_SEND_ACTION,
} from '../../lib/send-action-pref';

describe('per-agent preferred Send action', () => {
  beforeEach(() => window.localStorage.clear());

  it('falls back to the default when the agent never chose', () => {
    expect(readSendActionPref('u1')).toBe(DEFAULT_SEND_ACTION);
  });

  it('restores the last selected action', () => {
    writeSendActionPref('u1', 'wait_for_customer');
    expect(readSendActionPref('u1')).toBe('wait_for_customer');
    writeSendActionPref('u1', 'none');
    expect(readSendActionPref('u1')).toBe('none');
  });

  it('is isolated per agent', () => {
    writeSendActionPref('u1', 'resolve');
    expect(readSendActionPref('u2')).toBe(DEFAULT_SEND_ACTION);
  });

  it('ignores corrupted values', () => {
    window.localStorage.setItem('inbox.sendAction.u1', 'garbage');
    expect(readSendActionPref('u1')).toBe(DEFAULT_SEND_ACTION);
  });
});
