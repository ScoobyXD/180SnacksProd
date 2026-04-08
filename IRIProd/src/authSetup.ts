import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const iriUrl = 'https://advantage.iriworldwide.com/unify-CRX/plus/landing/0';
const authDir = path.join('playwright', '.auth');
const authFile = path.join(authDir, 'iri.json');

async function main(): Promise<void> {
  await fs.mkdir(authDir, { recursive: true });

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`Opening ${iriUrl}`);
  await page.goto(iriUrl, { waitUntil: 'domcontentloaded' });

  console.log('Please complete login + MFA in the opened browser window.');
  console.log('After you reach the post-login landing page, press Enter here to save auth state.');

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  await context.storageState({ path: authFile });
  console.log(`Saved storage state to ${authFile}`);

  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
