import { type Locator, type Page } from 'playwright';

const BLOCKED_TERMS = [
  'save',
  'submit',
  'delete',
  'remove',
  'update',
  'create',
  'edit',
  'apply',
  'confirm',
  'send',
  'post'
];

function includesBlockedTerm(value: string): string | null {
  const normalized = value.toLowerCase();
  return BLOCKED_TERMS.find((term) => normalized.includes(term)) ?? null;
}

export async function assertSafeClick(locator: Locator, stepLabel: string): Promise<void> {
  const handle = await locator.first().elementHandle();
  if (!handle) {
    throw new Error(`[READ-ONLY] Could not resolve target element for step: ${stepLabel}`);
  }

  const details = await handle.evaluate((el) => {
    const htmlEl = el as HTMLElement;
    return {
      tag: htmlEl.tagName,
      text: (htmlEl.innerText ?? '').trim(),
      ariaLabel: htmlEl.getAttribute('aria-label') ?? '',
      title: htmlEl.getAttribute('title') ?? '',
      value: (htmlEl as HTMLInputElement).value ?? ''
    };
  });

  const signals = [details.text, details.ariaLabel, details.title, details.value].filter(Boolean);
  for (const signal of signals) {
    const blocked = includesBlockedTerm(signal);
    if (blocked) {
      throw new Error(
        `[READ-ONLY] Blocked click at step "${stepLabel}" due to blocked term "${blocked}" in target signals.`
      );
    }
  }
}

export async function safeClick(page: Page, locator: Locator, stepLabel: string): Promise<void> {
  await assertSafeClick(locator, stepLabel);
  await locator.click();
  await page.waitForLoadState('networkidle');
}

export function installReadOnlyNetworkGuard(page: Page, allowPostPatterns: RegExp[] = []): void {
  page.route('**/*', (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();

    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      route.continue();
      return;
    }

    const url = request.url();
    const isAllowlisted = allowPostPatterns.some((pattern) => pattern.test(url));
    if (isAllowlisted) {
      route.continue();
      return;
    }

    route.abort();
  });
}
