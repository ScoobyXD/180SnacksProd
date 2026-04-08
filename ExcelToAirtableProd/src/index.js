import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import {
  ensureAirtableBaseAndTable,
  getAirtableConfig,
  upsertRowsToAirtable
} from './airtable.js';
import { getOutputColumns, transformRows } from './transform.js';
import { detectReportDatesByWorksheet, mmddyyyyToIsoDate } from './weekEnding.js';

const CURRENCY_COLUMNS = new Set([
  'Dollar Sales',
  'Average Price per Unit'
]);

function loadEnvFiles() {
  const envFiles = ['.envsoft', '.env', '.env.local'];
  for (const filename of envFiles) {
    const fullPath = path.resolve(process.cwd(), filename);
    if (fs.existsSync(fullPath)) {
      process.loadEnvFile(fullPath);
    }
  }
}

function getArg(name) {
  const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : undefined;
}

function findLatestIRIDownload() {
  const iriDir = process.env.IRI_DIR || 'IRIDev';
  const downloadsDir = path.resolve(process.cwd(), '..', iriDir, 'artifacts', 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    throw new Error(`No --input provided and downloads directory does not exist: ${downloadsDir}`);
  }

  const candidates = fs.readdirSync(downloadsDir)
    .filter((name) => /\.xlsx$/i.test(name))
    .map((name) => {
      const fullPath = path.join(downloadsDir, name);
      const stats = fs.statSync(fullPath);
      return {
        fullPath,
        mtimeMs: stats.mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!candidates.length) {
    throw new Error(`No .xlsx files found in ${downloadsDir}. Run IRIDev download mode first.`);
  }

  return candidates[0].fullPath;
}

function resolveInputPath() {
  return getArg('input') ?? findLatestIRIDownload();
}

function toPrimitiveCellValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined && value.result !== null) {
      return value.result;
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? '').join('');
    }
    if ('hyperlink' in value && typeof value.hyperlink === 'string') {
      return value.text ?? value.hyperlink;
    }
  }

  return String(value);
}

function detectHeaderRow(rowArrays) {
  const maxScan = Math.min(rowArrays.length, 25);
  for (let i = 0; i < maxScan; i += 1) {
    const values = (rowArrays[i] || []).map((value) => String(value ?? '').toLowerCase().trim());
    if (values.includes('item') && values.includes('venue')) {
      return i;
    }
  }
  return -1;
}

function getDataWorksheets(workbook) {
  return workbook.worksheets.filter((worksheet, index) => {
    const name = String(worksheet.name ?? '').trim().toLowerCase();
    if (name === 'index') {
      return false;
    }

    // Expected layout: first tab is index, next tabs are daily tabs.
    if (index === 0 && name !== '1') {
      return false;
    }

    return true;
  });
}

function buildRowArrays(worksheet) {
  const rowArrays = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = [];
    for (let col = 1; col <= worksheet.columnCount; col += 1) {
      values.push(toPrimitiveCellValue(row.getCell(col).value));
    }
    rowArrays.push(values);
  }
  return rowArrays;
}

async function loadInputRows(inputPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);

  const reportDateBySheet = await detectReportDatesByWorksheet(inputPath);
  const dataWorksheets = getDataWorksheets(workbook);

  if (!dataWorksheets.length) {
    throw new Error('Workbook has no daily worksheets to process.');
  }

  const perSheet = [];
  for (const worksheet of dataWorksheets) {
    const rowArrays = buildRowArrays(worksheet);
    const headerRowIndex = detectHeaderRow(rowArrays);
    if (headerRowIndex < 0) {
      throw new Error(`Could not find Item/Venue header row in worksheet "${worksheet.name}".`);
    }

    const reportDate = reportDateBySheet.get(worksheet.name) ?? '';
    const headers = (rowArrays[headerRowIndex] || []).map((value) => String(value ?? '').trim());
    const bodyRows = rowArrays.slice(headerRowIndex + 1);

    const rows = bodyRows.map((row) => {
      const record = {};
      for (let i = 0; i < headers.length; i += 1) {
        const key = headers[i] || `Column_${i + 1}`;
        record[key] = row[i] ?? null;
      }
      return record;
    });

    perSheet.push({
      sheetName: worksheet.name,
      reportDate,
      rows
    });
  }

  return perSheet;
}

function resolveArtifactsDir() {
  return process.env.EXCEL_ARTIFACTS_DIR || 'artifacts';
}

function defaultOutputPath(inputPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(resolveArtifactsDir(), `${stamp}-${base}-normalized.xlsx`);
}

async function saveOutputWorkbook(records, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const outputHeaders = getOutputColumns();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Normalized');

  worksheet.addRow(outputHeaders);
  for (const record of records) {
    worksheet.addRow(outputHeaders.map((header) => record[header] ?? null));
  }

  for (let columnIndex = 0; columnIndex < outputHeaders.length; columnIndex += 1) {
    const header = outputHeaders[columnIndex];
    if (!CURRENCY_COLUMNS.has(header)) {
      continue;
    }

    const worksheetColumn = worksheet.getColumn(columnIndex + 1);
    worksheetColumn.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber === 1 || typeof cell.value !== 'number') {
        return;
      }
      cell.numFmt = '$#,##0.0000';
    });
  }

  await workbook.xlsx.writeFile(outputPath);
}

async function countNormalizedWorkbookDataRows(outputPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const worksheet = workbook.getWorksheet('Normalized');
  if (!worksheet) {
    throw new Error(`Could not find "Normalized" worksheet in output workbook: ${outputPath}`);
  }

  return Math.max(0, worksheet.rowCount - 1);
}

function prepareAirtableRows(rows) {
  return rows.map((row) => ({
    ...row,
    Date: mmddyyyyToIsoDate(row.Date)
  }));
}

function validateNormalizedRows(rows, perSheetSummaries) {
  if (!rows.length) {
    throw new Error('No warehouse rows were produced in normalized output.');
  }

  for (const summary of perSheetSummaries) {
    if (!summary.reportDate) {
      throw new Error(`Missing day-ending date from Shape 1 for worksheet "${summary.sheetName}".`);
    }

    if (summary.outputCount <= 0) {
      throw new Error(`Worksheet "${summary.sheetName}" produced zero warehouse rows.`);
    }
  }

  const missingDateCount = rows.filter((row) => !String(row.Date ?? '').trim()).length;
  if (missingDateCount > 0) {
    throw new Error(`Validation failed: ${missingDateCount} output rows are missing Date values.`);
  }
}

async function main() {
  loadEnvFiles();
  const inputPath = resolveInputPath();
  const outputPath = getArg('output') ?? defaultOutputPath(inputPath);

  const perSheetRows = await loadInputRows(inputPath);
  const perSheetSummaries = [];
  const normalizedRows = [];

  for (const sheetData of perSheetRows) {
    const transformed = transformRows(sheetData.rows, { reportDate: sheetData.reportDate });
    normalizedRows.push(...transformed);
    perSheetSummaries.push({
      sheetName: sheetData.sheetName,
      reportDate: sheetData.reportDate,
      inputCount: sheetData.rows.length,
      outputCount: transformed.length
    });
  }

  await saveOutputWorkbook(normalizedRows, outputPath);
  const outputWorkbookRowCount = await countNormalizedWorkbookDataRows(outputPath);
  validateNormalizedRows(normalizedRows, perSheetSummaries);

  const airtableConfig = getAirtableConfig();
  let airtable = { enabled: false };

  if (airtableConfig.enabled) {
    const outputColumns = getOutputColumns();
    const ensured = await ensureAirtableBaseAndTable(
      airtableConfig,
      outputColumns
    );

    const airtableRows = prepareAirtableRows(normalizedRows);
    console.log(
      `[airtable] Starting sync of ${airtableRows.length} rows to ` +
      `${airtableConfig.tableName} in base ${ensured.baseId}.`
    );
    const upsertResult = await upsertRowsToAirtable(
      { ...airtableConfig, baseId: ensured.baseId },
      airtableRows
    );

    if (airtableRows.length > 0 && upsertResult.upserted === 0 && upsertResult.rejected === 0) {
      throw new Error(
        `Airtable sync attempted ${airtableRows.length} rows but reported 0 upserted and 0 rejected rows.`
      );
    }

    if (upsertResult.rejected > 0) {
      fs.mkdirSync(path.join(resolveArtifactsDir(), 'rejects'), { recursive: true });
      const rejectPath = path.join(
        resolveArtifactsDir(),
        'rejects',
        `${new Date().toISOString().replace(/[:.]/g, '-')}-airtable-rejects.json`
      );
      fs.writeFileSync(rejectPath, JSON.stringify(upsertResult.rejects, null, 2), 'utf8');
      throw new Error(
        `Airtable upserted ${upsertResult.upserted} rows but rejected ${upsertResult.rejected} rows. ` +
        `Reject details saved to ${rejectPath}. First reject: ${upsertResult.rejects[0]?.message ?? 'unknown error'}`
      );
    }

    console.log(
      `[airtable] Row confirmation: ${upsertResult.created}/${outputWorkbookRowCount} rows uploaded ` +
      `(created ${upsertResult.created}, updated ${upsertResult.updated}, upserted ${upsertResult.upserted}).`
    );

    if (upsertResult.created !== outputWorkbookRowCount) {
      throw new Error(
        `Row confirmation failed: output workbook has ${outputWorkbookRowCount} data rows, ` +
        `but Airtable reported ${upsertResult.created} created rows. ` +
        `(updated ${upsertResult.updated}, upserted ${upsertResult.upserted})`
      );
    }

    airtable = {
      enabled: true,
      baseId: ensured.baseId,
      tableName: airtableConfig.tableName,
      outputWorkbookRowCount,
      ...ensured,
      ...upsertResult
    };
  }

  console.log(JSON.stringify({
    inputPath,
    outputPath,
    inputSheetCount: perSheetRows.length,
    outputRowCount: normalizedRows.length,
    perSheetSummaries,
    note: 'Output workbook was created before validation; Airtable sync is blocked on validation failures.',
    airtable
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
