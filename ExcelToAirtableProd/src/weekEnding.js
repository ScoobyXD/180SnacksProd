import fs from 'node:fs/promises';

function normalizeToMMDDYYYY(rawDate) {
  const cleaned = String(rawDate ?? '').trim();
  const match = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (!match) {
    return '';
  }

  const mm = match[1].padStart(2, '0');
  const dd = match[2].padStart(2, '0');
  const yyyy = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${mm}-${dd}-${yyyy}`;
}

export function normalizeReportDate(rawDate) {
  return normalizeToMMDDYYYY(rawDate);
}

export function mmddyyyyToIsoDate(date) {
  const normalized = normalizeToMMDDYYYY(date);
  if (!normalized) {
    return '';
  }

  const [mm, dd, yyyy] = normalized.split('-');
  return `${yyyy}-${mm}-${dd}`;
}

export function extractReportDateFromText(text) {
  const dateRegex = /(?:day|week)\s*ending[^0-9]*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i;
  const match = String(text ?? '').match(dateRegex);
  if (!match) {
    return '';
  }
  return normalizeToMMDDYYYY(match[1]);
}

function decodeXmlEntities(input) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function collectShapeText(xml) {
  const texts = [];
  const tagRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>|<v:txbxContent[\s\S]*?<w:t[^>]*>([\s\S]*?)<\/w:t>/gi;

  for (const match of xml.matchAll(tagRegex)) {
    const raw = match[1] ?? match[2] ?? '';
    const cleaned = decodeXmlEntities(raw).trim();
    if (cleaned) {
      texts.push(cleaned);
    }
  }

  return texts.join(' ');
}

function normalizeZipPath(input) {
  return input.replace(/^\//, '').replace(/\\/g, '/');
}

function resolveZipPath(basePath, target) {
  const baseParts = normalizeZipPath(basePath).split('/');
  baseParts.pop();

  for (const segment of target.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      baseParts.pop();
      continue;
    }
    baseParts.push(segment);
  }

  return baseParts.join('/');
}

function getSheetNameToPath(zip) {
  const workbookXml = zip.files['xl/workbook.xml'];
  const workbookRelsXml = zip.files['xl/_rels/workbook.xml.rels'];
  if (!workbookXml || !workbookRelsXml) {
    return new Map();
  }

  const sheets = [];
  const workbookTextPromise = workbookXml.async('string');
  const workbookRelsTextPromise = workbookRelsXml.async('string');

  return Promise.all([workbookTextPromise, workbookRelsTextPromise]).then(([workbookText, workbookRelsText]) => {
    const sheetTagRegex = /<sheet\b[^>]*\/?>/gi;
    for (const tagMatch of workbookText.matchAll(sheetTagRegex)) {
      const tag = tagMatch[0] ?? '';
      const name = tag.match(/\bname="([^"]+)"/i)?.[1] ?? '';
      const relId = tag.match(/\br:id="([^"]+)"/i)?.[1] ?? '';
      if (!name || !relId) {
        continue;
      }
      sheets.push({ name: decodeXmlEntities(name), relId });
    }

    const relMap = new Map();
    const relTagRegex = /<Relationship\b[^>]*\/?>/gi;
    for (const tagMatch of workbookRelsText.matchAll(relTagRegex)) {
      const tag = tagMatch[0] ?? '';
      const id = tag.match(/\bId="([^"]+)"/i)?.[1] ?? '';
      const target = tag.match(/\bTarget="([^"]+)"/i)?.[1] ?? '';
      if (!id || !target) {
        continue;
      }
      relMap.set(id, normalizeZipPath(resolveZipPath('xl/workbook.xml', target)));
    }

    const output = new Map();
    for (const sheet of sheets) {
      const target = relMap.get(sheet.relId);
      if (target) {
        output.set(sheet.name, target);
      }
    }

    return output;
  });
}

function findDrawingTargetsForSheet(zip, sheetPath) {
  const relPath = `${sheetPath.replace(/\/+$/, '').replace(/\.xml$/i, '')}.xml.rels`;
  const worksheetRelsPath = relPath.replace('xl/worksheets/', 'xl/worksheets/_rels/');
  const relFile = zip.files[worksheetRelsPath];
  if (!relFile) {
    return Promise.resolve([]);
  }

  return relFile.async('string').then((relsXml) => {
    const targets = [];
    const relTagRegex = /<Relationship\b[^>]*\/?>/gi;

    for (const tagMatch of relsXml.matchAll(relTagRegex)) {
      const tag = tagMatch[0] ?? '';
      const relType = tag.match(/\bType="([^"]+)"/i)?.[1] ?? '';
      const target = tag.match(/\bTarget="([^"]+)"/i)?.[1] ?? '';
      if (!target || !relType) {
        continue;
      }

      if (
        relType.includes('/drawing') ||
        relType.includes('/legacyDrawing') ||
        relType.includes('/vmlDrawing') ||
        relType.includes('/control')
      ) {
        // Relationship targets in *.rels are resolved relative to the owning part
        // (the worksheet XML), not relative to the _rels folder path.
        const resolved = normalizeZipPath(resolveZipPath(sheetPath, target));
        targets.push(resolved);
      }
    }

    return targets;
  });
}

export async function detectReportDatesByWorksheet(inputPath) {
  const fileBuffer = await fs.readFile(inputPath);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fileBuffer);

  const sheetMap = await getSheetNameToPath(zip);
  const reportDates = new Map();

  for (const [sheetName, sheetPath] of sheetMap.entries()) {
    const drawingTargets = await findDrawingTargetsForSheet(zip, sheetPath);

    for (const drawingPath of drawingTargets) {
      const drawingFile = zip.files[drawingPath];
      if (!drawingFile) {
        continue;
      }

      const xml = await drawingFile.async('string');
      const textBlob = collectShapeText(xml);
      const detected = extractReportDateFromText(textBlob);
      if (detected) {
        reportDates.set(sheetName, detected);
        break;
      }
    }
  }

  return reportDates;
}
