import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type Download, type Page } from 'playwright';

export type ExtractionMode = 'dom' | 'network' | 'download';

export async function ensureArtifactDirectories(): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join('artifacts', 'raw'), { recursive: true }),
    fs.mkdir(path.join('artifacts', 'normalized'), { recursive: true }),
    fs.mkdir(path.join('artifacts', 'metrics'), { recursive: true }),
    fs.mkdir(path.join('artifacts', 'screenshots'), { recursive: true }),
    fs.mkdir(path.join('artifacts', 'downloads'), { recursive: true })
  ]);
}

function sanitizeFileSegment(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'report-export';
}

async function inferExtensionFromDownload(download: Download): Promise<string> {
  const suggestedExtension = path.extname(download.suggestedFilename()).toLowerCase();
  if (suggestedExtension) {
    return suggestedExtension;
  }

  const stream = await download.createReadStream();
  if (!stream) {
    return '.bin';
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
    if (chunks.reduce((sum, item) => sum + item.length, 0) >= 1024) {
      break;
    }
  }

  const header = Buffer.concat(chunks);
  const headerText = header.toString('utf8');

  if (header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) {
    return '.xlsx';
  }
  if (/^[\s\S]*[,;\t][\s\S]*\n/.test(headerText)) {
    return '.csv';
  }
  if (headerText.trimStart().startsWith('{') || headerText.trimStart().startsWith('[')) {
    return '.json';
  }
  if (header.length >= 4 && header.slice(0, 4).toString('utf8') === '%PDF') {
    return '.pdf';
  }

  return '.bin';
}

export async function saveDownloadArtifact(download: Download, baseName: string): Promise<{ savedPath: string; failure?: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeBaseName = sanitizeFileSegment(baseName);
  const extension = await inferExtensionFromDownload(download);
  const finalName = `${stamp}-${safeBaseName}${extension}`;
  const finalPath = path.join('artifacts', 'downloads', finalName);

  try {
    await download.saveAs(finalPath);
    return { savedPath: finalPath };
  } catch (error) {
    return {
      savedPath: finalPath,
      failure: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function extractViaDomTable(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    if (rows.length === 0) {
      return [];
    }

    const headerCells = Array.from(rows[0].querySelectorAll('th,td')).map((cell) =>
      (cell.textContent ?? '').trim() || 'column'
    );

    return rows.slice(1).map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      const record: Record<string, unknown> = {};
      cells.forEach((cell, i) => {
        const key = headerCells[i] ?? `column_${i + 1}`;
        record[key] = (cell.textContent ?? '').trim();
      });
      return record;
    });
  });
}

export async function extractViaNetworkCapture(page: Page, timeoutMs = 20_000): Promise<unknown[]> {
  const captured: unknown[] = [];

  const handler = async (response: { url: () => string; headers: () => Record<string, string>; json: () => Promise<unknown> }) => {
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      return;
    }

    const url = response.url();
    if (!/report|sales|data|metric/i.test(url)) {
      return;
    }

    try {
      captured.push(await response.json());
    } catch {
      // Ignore non-JSON parse errors for now.
    }
  };

  page.on('response', handler as never);
  await page.waitForTimeout(timeoutMs);
  page.off('response', handler as never);

  return captured;
}

export async function saveArtifact(type: 'raw' | 'normalized' | 'metrics', name: string, data: unknown): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join('artifacts', type);
  await fs.mkdir(directory, { recursive: true });

  const filePath = path.join(directory, `${stamp}-${name}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}
