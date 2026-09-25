import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../../server/config.js';
import { createCountingSupabase } from './helpers/countingSupabase';
vi.mock('../../../server/services/geo/index.js', () => ({ resolveVisitorGeo: async () => ({}) }));
import { syncStoreContact } from '../../../server/services/commerce/storeContact.js';

describe('verified OpenCart customer contact', () => {
  const identity = { name: 'سارا محمدی', email: 'sara@example.test', phone: '+90 555 123 4567' };
  function setup(extra = {}) {
    const fake = createCountingSupabase({ contacts: [{ id: 'contact', workspace_id: 'ws', visitor_code: 'ABCD',
      name: null, email: null, phone: null, metadata: { visitor_id: 'visitor', anonymous: true, keep: 'yes' }, ...extra }] });
    const sync = () => syncStoreContact({} as ServerConfig, fake.client as unknown as SupabaseClient, 'ws', 'visitor', identity);
    return { fake, sync };
  }
  it('upgrades the existing guest and calls the conversation/session merge', async () => {
    const { fake, sync } = setup();
    await sync();
    expect(fake.db.contacts).toHaveLength(1);
    expect(fake.db.contacts[0]).toMatchObject({ id: 'contact', name: identity.name, email: identity.email,
      phone: '+905551234567', metadata: { anonymous: false, keep: 'yes', visitor_id: 'visitor' } });
    expect(fake.counts['rpc:merge_visitor_into_contact'].rpc).toBe(1);
    fake.reset();
    await sync();
    expect(fake.total().update).toBe(0);
    expect(fake.total().rpc).toBe(0);
  });
  it('does not merge another signed-in account into the previous customer', async () => {
    const { fake, sync } = setup({ email: 'other@example.test', name: 'Other' });
    await expect(sync()).rejects.toMatchObject({ code: 'identity_expired' });
    expect(fake.total().update).toBe(0);
    expect(fake.total().rpc).toBe(0);
  });
});
