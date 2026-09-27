import { describe, expect, it } from 'vitest';
import { isInternalCallEvent } from '../../../server/routes/callCenter.js';

describe('call detail timeline', () => {
  it('leaves out the server’s own bookkeeping', () => {
    for (const t of ['lk.room_started', 'lk.participant_joined', 'lk.egress_ended', 'call_assigned_on_accept', null, '']) {
      expect(isInternalCallEvent(t)).toBe(true);
    }
  });

  it('keeps what operators read', () => {
    for (const t of ['call_requested', 'call_accepted', 'visitor_joined', 'call_ended', 'operator_note_added', 'call_transferred']) {
      expect(isInternalCallEvent(t)).toBe(false);
    }
  });
});
