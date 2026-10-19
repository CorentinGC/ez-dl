import { describe, expect, it } from 'vitest';
import { isExtensionSender } from './senderGuard';

const BASE = 'chrome-extension://abcdef/';

describe('isExtensionSender', () => {
  it('accepte une page de l\'extension', () => {
    expect(isExtensionSender('chrome-extension://abcdef/popup.html', BASE)).toBe(true);
  });

  it('refuse une page web, une autre extension et un expéditeur sans URL', () => {
    expect(isExtensionSender('https://evil.test/', BASE)).toBe(false);
    expect(isExtensionSender('chrome-extension://autre/popup.html', BASE)).toBe(false);
    expect(isExtensionSender(undefined, BASE)).toBe(false);
  });

  it('refuse un préfixe qui ressemble à la base sans la respecter', () => {
    expect(isExtensionSender('chrome-extension://abcdefghi/x.html', BASE)).toBe(false);
  });
});
