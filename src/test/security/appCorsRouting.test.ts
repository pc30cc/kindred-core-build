import { describe, expect, it } from 'vitest';
import { isPublicWidgetApiPath, matchesRoutePrefix } from '../../../server/lib/routePrefix.js';

describe('application CORS route classification', () => {
  it('matches public widget routes only on segment boundaries', () => {
    expect(matchesRoutePrefix('/api/widget/bootstrap', '/api/widget')).toBe(true);
    expect(matchesRoutePrefix('/api/widget', '/api/widget')).toBe(true);
    expect(matchesRoutePrefix('/api/widget-settings/platform/config', '/api/widget')).toBe(false);
  });

  it('keeps existing public widget route families on dynamic widget CORS', () => {
    expect(isPublicWidgetApiPath('/api/widget/bootstrap')).toBe(true);
    expect(isPublicWidgetApiPath('/api/call-widget/bootstrap')).toBe(true);
    expect(isPublicWidgetApiPath('/api/visitors/track')).toBe(true);
    expect(isPublicWidgetApiPath('/api/realtime/connect')).toBe(true);
    expect(isPublicWidgetApiPath('/api/realtime/subscribe')).toBe(true);
  });

  it('routes authenticated widget settings through normal app CORS', () => {
    expect(isPublicWidgetApiPath('/api/widget-settings')).toBe(false);
    expect(isPublicWidgetApiPath('/api/widget-settings/platform/config')).toBe(false);
  });
});