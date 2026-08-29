# Fix Telegram offline lock delivery

## Goal
Show one offline response only and apply the Telegram reply keyboard/placeholder in that same first response.

## Changes
- Make the Telegram offline-screen enqueue the single authoritative visitor-facing response and atomically reserve its deduplication marker before any competing routing/AI path can enqueue the same text.
- Ensure the first queued offline message includes the reduced persistent keyboard and offline input placeholder; remove the artificial typing delay for this lock-critical screen.
- Prevent generic AI handoff/routing messages from creating a second Telegram delivery when the offline screen owns the response, while preserving the internal Inbox notice for operators.
- Add regression tests for single delivery, immediate lock payload, and race-safe deduplication.

## Technical note
Telegram does not expose an API to truly disable its native text field. The strongest supported lock is an immediate persistent reply keyboard with only allowed actions plus `input_field_placeholder`; typed messages can still be received and consistently answered/ignored by policy.
