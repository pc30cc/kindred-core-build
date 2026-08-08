/**
 * Canonical network-profile unification guards.
 *
 * These lock the two rules every visitor surface depends on:
 *   1. read precedence — persisted geo wins over the IP cache, which wins over
 *      legacy session columns (so Inbox / Call Center / Visitors agree);
 *   2. the IP visibility policy — no plan → nothing leaves the server; no
 *      admin role → masked; store_raw_ip=false → never raw.
 */
import { describe, it, expect } from 'vitest';
import {
  buildIpView,
  buildNetworkProfile,
  geoFromPersistedSession,
  accuracyOf,
  legacyGeoSource,
} from '../../../server/services/visitors/networkProfile.js';

const session = {
  id: 's1',
  workspace_id: 'w1',
  visitor_id: 'v1',
  ip_hash: 'a1b2c3d4e5f6a7b8',
  ip_raw: '185.23.44.55',
};

describe('IP visibility policy', () => {
  it('leaks nothing when the plan lacks the capability', () => {
    const v = buildIpView(session, { entitled: false, canViewRaw: false });
    expect(v.raw).toBeNull();
    expect(v.hash).toBeNull();
    expect(v.display).toBe('');
    expect(v.locked).toBe(true);
  });

  it('masks the IP for non-admin members', () => {
    const v = buildIpView(session, { entitled: true, canViewRaw: false });
    expect(v.raw).toBeNull();
    expect(v.display).toBe('185.23.xxx.xxx');
    expect(v.locked).toBe(false);
  });

  it('returns the raw IP only for admins when it was persisted', () => {
    const v = buildIpView(session, { entitled: true, canViewRaw: true });
    expect(v.raw).toBe('185.23.44.55');
    expect(v.display).toBe('185.23.44.55');
  });

  it('falls back to a hash placeholder when store_raw_ip was off', () => {
    const v = buildIpView({ ip_hash: session.ip_hash, ip_raw: null }, { entitled: true, canViewRaw: true });
    expect(v.raw).toBeNull();
    expect(v.display).toContain('a1b2');
  });
});

describe('geo read precedence', () => {
  const persisted = {
    ...session,
    geo_country_code: 'tr',
    geo_country_name: null,
    geo_city: 'Istanbul',
    geo_region: 'Istanbul',
    geo_latitude: 41,
    geo_longitude: 29,
    geo_source_provider: 'maxmind_local',
    geo_accuracy_level: 'city',
    geo_is_fallback: false,
    geo_resolved_at: new Date().toISOString(),
  };

  it('prefers persisted geo over the ip cache', () => {
    const p = buildNetworkProfile(persisted, { entitled: true, canViewRaw: true }, {
      ip_hash: session.ip_hash,
      country_code: 'DE',
      city: 'Berlin',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(p.geo.city).toBe('Istanbul');
    expect(p.geo.country_code).toBe('TR');
    // Full localized country name, never the bare ISO code.
    expect(p.geo.country).toBeTruthy();
    expect(p.geo.country).not.toBe('TR');
    expect(p.geo.provider).toBe('maxmind_local');
  });

  it('falls back to the ip cache when nothing is persisted', () => {
    const p = buildNetworkProfile(
      { ...session, geo_resolved_at: null },
      { entitled: true, canViewRaw: true },
      {
        ip_hash: session.ip_hash,
        country_code: 'de',
        city: 'Berlin',
        source: 'maxmind_local',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    expect(p.geo.city).toBe('Berlin');
    expect(p.geo.country_code).toBe('DE');
    expect(p.geo.source).toBe('cache');
  });

  it('ignores an expired cache row', () => {
    const p = buildNetworkProfile(
      { ...session, geo_resolved_at: null },
      { entitled: true, canViewRaw: true },
      {
        ip_hash: session.ip_hash,
        country_code: 'DE',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    );
    expect(p.geo.country_code).not.toBe('DE');
  });

  it('derives accuracy from the finest available field', () => {
    expect(accuracyOf({ city: 'X', region: 'Y', country_code: 'TR' })).toBe('city');
    expect(accuracyOf({ city: null, region: 'Y', country_code: 'TR' })).toBe('region');
    expect(accuracyOf({ city: null, region: null, country_code: 'TR' })).toBe('country');
    expect(accuracyOf({ city: null, region: null, country_code: null })).toBeNull();
  });

  it('maps persisted geo onto the legacy map-legend union', () => {
    const geo = geoFromPersistedSession(persisted)!;
    expect(legacyGeoSource(geo)).toBe('provider');
  });
});
