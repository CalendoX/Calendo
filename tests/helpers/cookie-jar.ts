/**
 * In-memory stand-in for `next/headers` cookies(). Route handlers read the session cookie from
 * it and login/logout write to it, exactly as they would against a browser.
 */

interface StoredCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

class CookieJar {
  private store = new Map<string, StoredCookie>();

  get(name: string) {
    const c = this.store.get(name);
    return c ? { name: c.name, value: c.value } : undefined;
  }

  getAll() {
    return [...this.store.values()].map((c) => ({ name: c.name, value: c.value }));
  }

  has(name: string) {
    return this.store.has(name);
  }

  set(name: string, value: string, options: Record<string, unknown> = {}) {
    if (value === '' || options.maxAge === 0) this.store.delete(name);
    else this.store.set(name, { name, value, options });
  }

  delete(name: string) {
    this.store.delete(name);
  }

  /** Options last used to set a cookie (to assert HttpOnly / SameSite / Secure). */
  optionsFor(name: string) {
    return this.store.get(name)?.options;
  }

  clear() {
    this.store.clear();
  }
}

export const cookieJar = new CookieJar();
