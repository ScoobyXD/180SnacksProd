import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Download, type Page } from 'playwright';
import {
  ensureArtifactDirectories,
  extractViaDomTable,
  extractViaNetworkCapture,
  saveArtifact,
  saveDownloadArtifact,
  type ExtractionMode
} from './extractors.js';
import { installReadOnlyNetworkGuard } from './readOnlyGuard.js';

const iriUrl = 'https://advantage.iriworldwide.com/unify-CRX/plus/landing/0';
const authStatePath = path.join('playwright', '.auth', 'iri.json');
const reportTitle = '(BP226) US Costco Small Vendor Report_PREMIUM_Copy DAILY VERSION';

function getMode(): ExtractionMode {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
  const mode = (modeArg?.split('=')[1] ?? 'dom') as ExtractionMode;
  if (!['dom', 'network', 'download'].includes(mode)) {
    throw new Error(`Unsupported mode "${mode}". Use --mode=dom|network|download`);
  }
  return mode;
}

async function assertAuthStateExists(): Promise<void> {
  try {
    await fs.access(authStatePath);
  } catch {
    throw new Error(
      `Missing auth storage state at ${authStatePath}. Run "npm run auth:setup" first, login in the browser, and press Enter to save.`
    );
  }
}


function assertNonEmptyExtraction(mode: ExtractionMode, payload: unknown): void {
  if (mode === 'download') {
    return;
  }

  if (Array.isArray(payload) && payload.length === 0) {
    throw new Error(
      `Extraction returned 0 records in mode=${mode}. This usually means report-navigation steps from codegen have not been added yet.`
    );
  }
}

async function captureDownloadFromContext(
  context: BrowserContext,
  trigger: () => Promise<void>,
  timeoutMs = 120_000
): Promise<Download> {
  return new Promise<Download>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const listeningPages = new Set<Page>();

    const onDownload = (download: Download) => {
      finish(() => resolve(download));
    };

    const subscribeToPage = (candidate: Page) => {
      if (listeningPages.has(candidate)) {
        return;
      }
      listeningPages.add(candidate);
      candidate.on('download', onDownload);
    };

    const unsubscribeAllPages = () => {
      for (const candidate of listeningPages) {
        candidate.off('download', onDownload);
      }
      listeningPages.clear();
    };

    const cleanup = () => {
      unsubscribeAllPages();
      context.off('page', onPageCreated);
      context.off('close', onContextClose);
      if (timer) {
        clearTimeout(timer);
      }
    };

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const onPageCreated = (createdPage: Page) => {
      subscribeToPage(createdPage);
    };

    const onContextClose = () => {
      finish(() => reject(new Error('Browser context closed before a download event was emitted.')));
    };

    for (const existingPage of context.pages()) {
      subscribeToPage(existingPage);
    }
    context.on('page', onPageCreated);
    context.on('close', onContextClose);

    timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for a download event.`)));
    }, timeoutMs);

    trigger().catch((error) => {
      finish(() => reject(error));
    });
  });
}

async function clickExportFromInbox(page: Page): Promise<void> {
  const inbox = page.locator('#inbox:visible');
  await inbox.waitFor({ state: 'visible', timeout: 20_000 });

  const exportTitle = inbox
    .locator(`p.np-contentHdr[title*="${reportTitle}"]`)
    .first();
  await exportTitle.scrollIntoViewIfNeeded();
  await exportTitle.waitFor({ state: 'visible', timeout: 20_000 });

  const exportRow = exportTitle.locator('xpath=ancestor::*[contains(@class,"report") or contains(@class,"message")][1]');
  const exportExcelIcon = exportRow.locator('img[src*="xls"], img[src*="xlsx"]');

  if ((await exportExcelIcon.count()) > 0) {
    await exportExcelIcon.first().click();
    return;
  }

  await exportTitle.click();
}

async function clickVisibleMoreExport(page: Page): Promise<void> {
  await page.locator('a:visible').filter({ hasText: /^More$/ }).first().click();

  const exportMenu = page.locator('#SBMore-listUI:visible');
  await exportMenu.waitFor({ state: 'visible', timeout: 10_000 });
  await exportMenu.getByText('Export', { exact: true }).first().click();
}

async function main(): Promise<void> {
  const mode = getMode();
  await assertAuthStateExists();
  await ensureArtifactDirectories();

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    storageState: authStatePath,
    acceptDownloads: true,
    recordVideo: { dir: 'artifacts/screenshots' }
  });
  const page = await context.newPage();

  const runStart = Date.now();
  try {
    await page.goto(iriUrl, { waitUntil: 'domcontentloaded' });
    await page.goto('https://advantage.iriworldwide.com/unify-CRX/plus/landing/0');
    await page.locator('.fa.fa-grid-round:visible').first().click();
    await page.getByText('Library', { exact: true }).first().click();
    await page.getByText(reportTitle, { exact: true }).first().click();
    await clickVisibleMoreExport(page);
    await page.locator('#iterate:visible').getByText('Select All', { exact: true }).first().click();
    await page.locator('#btnexport:visible').first().click();
    await page.locator('#export-form:visible').getByText('OK', { exact: true }).first().click();
    await page.locator('#user div:visible').filter({ hasText: /^1$/ }).first().click();

    // In strict mode, only GET/HEAD/OPTIONS requests are allowed unless allowlisted.
    installReadOnlyNetworkGuard(page, [
      /auth/i,
      /session/i
    ]);

    let payload: unknown;
    switch (mode) {
      case 'dom':
        payload = await extractViaDomTable(page);
        break;
      case 'network':
        payload = await extractViaNetworkCapture(page);
        break;
      case 'download':
        {
          const download = await captureDownloadFromContext(context, async () => {
            await clickExportFromInbox(page);
          });
          const saved = await saveDownloadArtifact(download, '(BP226)-US-Costco-Small-Vendor-Report_PREMIUM');
          payload = {
            message: 'Report download captured and persisted to local artifacts/downloads.',
            suggestedFilename: download.suggestedFilename(),
            ...saved
          };
        }
        break;
    }

    assertNonEmptyExtraction(mode, payload);

    const rawPath = await saveArtifact('raw', `${mode}-extract`, payload);
    const metrics = {
      mode,
      success: true,
      durationMs: Date.now() - runStart,
      output: rawPath
    };
    const metricPath = await saveArtifact('metrics', `${mode}-metrics`, metrics);
    console.log(JSON.stringify({ metrics, metricPath }, null, 2));
  } catch (error) {
    await page.screenshot({ path: `artifacts/screenshots/failure-${Date.now()}.png`, fullPage: true });
    const metrics = {
      mode,
      success: false,
      durationMs: Date.now() - runStart,
      error: error instanceof Error ? error.message : String(error)
    };
    await saveArtifact('metrics', `${mode}-metrics-failure`, metrics);
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
