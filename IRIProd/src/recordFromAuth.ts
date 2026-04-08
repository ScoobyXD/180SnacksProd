import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const iriUrl = 'https://advantage.iriworldwide.com/unify-CRX/plus/landing/0';
const authStatePath = path.join('playwright', '.auth', 'iri.json');

async function assertAuthStateExists(): Promise<void> {
  try {
    await fs.access(authStatePath);
  } catch {
    throw new Error(
      `Missing auth storage state at ${authStatePath}. Run "npm run auth:setup" first and complete login.`
    );
  }
}

async function main(): Promise<void> {
  await assertAuthStateExists();
  process.env.PWDEBUG = '1';

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();

  await page.goto(iriUrl, { waitUntil: 'domcontentloaded' });

  console.log('Opened authenticated context. Playwright Inspector is active.');
  console.log('Click through your report workflow and copy generated actions from Inspector.');
  console.log('Press Resume/Play in Inspector when done.');

  await page.pause();

  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
