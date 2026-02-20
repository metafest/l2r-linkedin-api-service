import { chromium, Browser, BrowserContext, Page } from 'playwright';

interface BrowserSessionConfig {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }>;
  headless?: boolean;
}

/**
 * Manages a Playwright browser session for making LinkedIn API calls.
 *
 * All API calls are executed via page.evaluate(fetch(...)) inside a real
 * Chromium instance, giving us:
 *   - Chrome's TLS fingerprint (passes PerimeterX checks)
 *   - Automatic cookie handling (including httpOnly cookies)
 *   - Natural _px3 token regeneration by PerimeterX JS
 *   - Same-origin fetch (no CORS issues)
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private csrfToken = '';
  private ready = false;
  private headless = true;
  private sessionRefreshCount = 0;

  // Simple mutex to serialize API calls through the single page
  private mutexQueue: Array<() => void> = [];
  private mutexLocked = false;

  async init(config: BrowserSessionConfig): Promise<void> {
    console.log('🌐 Launching Chromium browser...');

    this.headless = config.headless ?? true;

    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      locale: 'en-US',
      timezoneId: 'Asia/Calcutta',
    });

    // Remove automation signals
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

      // Make navigator.plugins non-empty
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override permissions
      const origQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions
      );
      (window.navigator.permissions as any).query = (params: any) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : origQuery(params);
    });

    // Inject cookies
    await this.context.addCookies(config.cookies);

    // Create main worker page
    this.page = await this.context.newPage();

    // Navigate to LinkedIn to establish session + let PerimeterX JS execute
    console.log('🔄 Navigating to LinkedIn to establish session...');
    try {
      await this.page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch {
      // Even if navigation times out, the session/cookies are likely set
      console.log('   ⚠ Feed page load timed out, continuing with session...');
    }

    // Give PerimeterX JS time to execute and regenerate _px3
    await this.sleep(3000);

    // Extract csrf-token from JSESSIONID cookie
    const cookies = await this.context.cookies('https://www.linkedin.com');
    const jsession = cookies.find((c) => c.name === 'JSESSIONID');
    if (jsession) {
      this.csrfToken = jsession.value.replace(/"/g, '');
    }

    if (!this.csrfToken) {
      throw new Error(
        'Could not extract CSRF token from browser cookies. Session may be invalid.'
      );
    }

    this.ready = true;
    console.log('✅ Browser session established');
    console.log(`   CSRF token: ${this.csrfToken.substring(0, 20)}...`);
  }

  /**
   * Make a LinkedIn API call through the browser's fetch().
   * This runs inside the Chromium JS context, so TLS fingerprint,
   * cookies, and _px3 all match a real browser.
   */
  async makeApiCall(url: string): Promise<{
    error: boolean;
    status: number;
    statusText?: string;
    data?: any;
  }> {
    this.ensureReady();
    await this.acquireMutex();

    try {
      const csrfToken = this.csrfToken;

      const result = await this.page!.evaluate(
        async ({ url, csrfToken }) => {
          try {
            const resp = await fetch(url, {
              method: 'GET',
              headers: {
                accept: 'application/vnd.linkedin.normalized+json+2.1',
                'csrf-token': csrfToken,
                'x-li-lang': 'en_US',
                'x-restli-protocol-version': '2.0.0',
                'x-li-track': JSON.stringify({
                  clientVersion: '1.13.42450',
                  mpVersion: '1.13.42450',
                  osName: 'web',
                  timezoneOffset: 5.5,
                  timezone: 'Asia/Calcutta',
                  deviceFormFactor: 'DESKTOP',
                  mpName: 'voyager-web',
                  displayDensity: 2,
                  displayWidth: 5120,
                  displayHeight: 2880,
                }),
              },
              credentials: 'include',
            });

            if (!resp.ok) {
              const text = await resp.text().catch(() => '');
              return {
                error: true,
                status: resp.status,
                statusText: resp.statusText,
                data: text,
              };
            }

            const json = await resp.json();
            return { error: false, status: resp.status, data: json };
          } catch (err: any) {
            return {
              error: true,
              status: 0,
              statusText: err?.message || 'Unknown error',
            };
          }
        },
        { url, csrfToken }
      );

      return result;
    } finally {
      this.releaseMutex();
    }
  }

  /**
   * Navigate to a LinkedIn page (for ambient traffic).
   */
  async navigateTo(url: string): Promise<void> {
    this.ensureReady();
    await this.acquireMutex();
    try {
      await this.page!.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      }).catch(() => {});
    } finally {
      this.releaseMutex();
    }
  }

  /**
   * Scroll the current page (for ambient traffic).
   */
  async scrollPage(): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(() => {
      window.scrollBy(0, 300 + Math.random() * 500);
    });
  }

  /**
   * Refresh the session by logging in with email/password.
   * Creates a brand new browser context, performs the login flow,
   * extracts fresh cookies, and swaps out the old context.
   *
   * Returns the new credentials (cookies + csrfToken) so the caller
   * can persist them.
   */
  /**
   * Refresh the session by logging in with email/password.
   * Creates a brand new browser context, performs the login flow,
   * extracts fresh cookies, and swaps out the old context only on success.
   * If login fails, the old session is preserved.
   */
  async refreshSessionViaLogin(
    email: string,
    password: string
  ): Promise<{ csrfToken: string; cookies: Record<string, string> }> {
    if (!this.browser) {
      throw new Error('Browser not launched. Call init() first.');
    }

    this.sessionRefreshCount++;
    console.log(
      `\n🔄 Session refresh #${this.sessionRefreshCount} — logging in as ${email}...`
    );

    // Keep references to old context/page so we can restore on failure
    const oldContext = this.context;
    const oldPage = this.page;
    const oldCsrf = this.csrfToken;

    // Create a fresh context (don't close the old one yet)
    const newContext = await this.createStealthContext();
    const loginPage = await newContext.newPage();

    try {
      await loginPage.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await this.sleep(1500);

      await loginPage.fill('#username', email);
      await this.sleep(500);
      await loginPage.fill('#password', password);
      await this.sleep(500);

      await loginPage.click('button[type="submit"]');

      // Wait for navigation — either feed (success) or checkpoint (verification)
      await loginPage.waitForURL(
        (url) => {
          const p = url.pathname;
          return (
            p.startsWith('/feed') ||
            p.startsWith('/checkpoint') ||
            p.startsWith('/check/') ||
            p.startsWith('/security/')
          );
        },
        { timeout: 30000 }
      );

      const currentUrl = loginPage.url();

      if (
        currentUrl.includes('checkpoint') ||
        currentUrl.includes('/check/') ||
        currentUrl.includes('/security/')
      ) {
        // Login needs verification — discard the new context, keep old session
        await loginPage.close().catch(() => {});
        await newContext.close().catch(() => {});
        throw new Error(
          'LinkedIn requires verification (CAPTCHA/email/phone). ' +
            'Please login manually in a browser to clear the challenge, ' +
            'then update credentials.'
        );
      }

      // Login succeeded — let PerimeterX JS settle
      console.log('   ✓ Login successful, establishing session...');
      await this.sleep(3000);

      // Extract all cookies from the new context
      const rawCookies = await newContext.cookies('https://www.linkedin.com');
      const cookieMap: Record<string, string> = {};
      for (const c of rawCookies) {
        cookieMap[c.name] = c.value;
      }

      const jsession = rawCookies.find((c) => c.name === 'JSESSIONID');
      if (!jsession) {
        await loginPage.close().catch(() => {});
        await newContext.close().catch(() => {});
        throw new Error('Login succeeded but JSESSIONID cookie not found.');
      }

      // Everything good — swap out old context for the new one
      this.ready = false;
      if (oldPage) await oldPage.close().catch(() => {});
      if (oldContext) await oldContext.close().catch(() => {});

      this.context = newContext;
      this.csrfToken = jsession.value.replace(/"/g, '');

      await loginPage.close();
      this.page = await this.context.newPage();

      await this.page
        .goto('https://www.linkedin.com/feed/', {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        })
        .catch(() => {});
      await this.sleep(2000);

      this.ready = true;
      console.log(`   ✓ New session established (CSRF: ${this.csrfToken.substring(0, 20)}...)`);
      console.log(`   ✓ Got ${Object.keys(cookieMap).length} cookies\n`);

      return { csrfToken: this.csrfToken, cookies: cookieMap };
    } catch (err) {
      // Login failed — restore old session so the service can keep working
      await loginPage.close().catch(() => {});
      await newContext.close().catch(() => {});

      // Restore old state
      this.context = oldContext;
      this.page = oldPage;
      this.csrfToken = oldCsrf;
      this.ready = !!(oldPage && oldContext);

      throw err;
    }
  }

  getSessionRefreshCount(): number {
    return this.sessionRefreshCount;
  }

  isReady(): boolean {
    return this.ready;
  }

  async close(): Promise<void> {
    this.ready = false;
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private ensureReady(): void {
    if (!this.ready || !this.page) {
      throw new Error('Browser not initialized. Call init() first.');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async acquireMutex(): Promise<void> {
    if (!this.mutexLocked) {
      this.mutexLocked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.mutexQueue.push(resolve);
    });
  }

  private releaseMutex(): void {
    if (this.mutexQueue.length > 0) {
      const next = this.mutexQueue.shift()!;
      next();
    } else {
      this.mutexLocked = false;
    }
  }

  private async createStealthContext(): Promise<BrowserContext> {
    const ctx = await this.browser!.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      locale: 'en-US',
      timezoneId: 'Asia/Calcutta',
    });

    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      const origQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions
      );
      (window.navigator.permissions as any).query = (params: any) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : origQuery(params);
    });

    return ctx;
  }
}
