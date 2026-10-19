import { describe, expect, it } from 'vitest';
import { isPrivateHostUrl } from './privateHost';

describe('isPrivateHostUrl', () => {
  it.each([
    'http://192.168.1.1/cgi?a=1',
    'http://10.0.0.5/v.mp4',
    'http://172.20.3.4/v.mp4',
    'http://127.0.0.1:8000/api',
    'http://169.254.169.254/latest',
    'http://localhost/v.mp4',
    'http://nas.localhost/v.mp4',
    'http://[::1]/v.mp4',
    'http://[fd12::1]/v.mp4',
    'http://[::ffff:192.168.1.1]/v.mp4',
    'http://0.0.0.0/',
  ])('refuse %s', (url) => {
    expect(isPrivateHostUrl(url)).toBe(true);
  });

  it.each(['https://video.twimg.com/a.mp4', 'https://172.32.0.1/v.mp4', 'https://8.8.8.8/v.mp4', 'https://cdn.example.com/192.168.1.1.mp4'])(
    'accepte %s',
    (url) => {
      expect(isPrivateHostUrl(url)).toBe(false);
    },
  );
});
