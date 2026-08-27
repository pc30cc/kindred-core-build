import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const entrypoint = join(process.cwd(), 'docker-entrypoint.sh');

function normalize(value: string): string {
  return execFileSync('sh', [entrypoint, '--normalize-backend-url', value], {
    encoding: 'utf8',
  }).trim();
}

describe('frontend BACKEND_URL normalization', () => {
  it('keeps a bare backend origin unchanged', () => {
    expect(normalize('https://api.example.com')).toBe('https://api.example.com');
  });

  it('removes a trailing /api path and trailing slashes', () => {
    expect(normalize('https://api.example.com/api')).toBe('https://api.example.com');
    expect(normalize('https://api.example.com/api/')).toBe('https://api.example.com');
    expect(normalize('https://api.example.com/api///')).toBe('https://api.example.com');
  });

  it('cannot create an /api/api proxy target after normalization', () => {
    for (const configured of ['https://api.example.com', 'https://api.example.com/api/']) {
      expect(`${normalize(configured)}/api/widget-settings/platform/config`).not.toContain('/api/api/');
    }
  });
});