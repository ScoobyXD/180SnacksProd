import process from 'node:process';

const BATCH_SIZE = 10;
const UPSERT_MERGE_FIELDS = ['Item', 'Venue', 'Date'];
const CURRENCY_FIELDS = new Set([
  'Dollar Sales',
  'Average Price per Unit'
]);

function getEnv(name, { required = false } = {}) {
  const value = process.env[name];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toBoolean(value) {
  return String(value ?? '').toLowerCase() === 'true';
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function airtableRequest(url, { method = 'GET', body, token }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Airtable API request failed (${response.status} ${response.statusText}): ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function inferField(name) {
  if (name === 'Date') {
    return {
      name,
      type: 'date',
      options: {
        dateFormat: {
          name: 'iso'
        }
      }
    };
  }

  if (CURRENCY_FIELDS.has(name)) {
    return {
      name,
      type: 'currency',
      options: {
        precision: 4,
        symbol: '$'
      }
    };
  }

  if (name.includes('Sales') || name.includes('Units') || name.includes('Price') || name.includes('Inventory')) {
    return { name, type: 'number', options: { precision: 4 } };
  }

  return { name, type: 'singleLineText' };
}

async function listWorkspaceBases(config) {
  const workspaceUrl = `https://api.airtable.com/v0/meta/workspaces/${config.workspaceId}/bases`;
  const payload = await airtableRequest(workspaceUrl, { token: config.token });
  return payload.bases ?? [];
}

async function createBase(config, fieldNames) {
  const workspaceUrl = `https://api.airtable.com/v0/meta/workspaces/${config.workspaceId}/bases`;
  const payload = await airtableRequest(workspaceUrl, {
    method: 'POST',
    token: config.token,
    body: {
      name: config.baseName,
      tables: [
        {
          name: config.tableName,
          fields: fieldNames.map(inferField)
        }
      ]
    }
  });

  return {
    baseId: payload.id,
    created: true,
    createdBase: true,
    createdTable: true,
    tableId: payload.tables?.[0]?.id ?? null
  };
}

export function getAirtableConfig() {
  const enabled = toBoolean(process.env.AIRTABLE_SYNC_ENABLED);
  if (!enabled) {
    return { enabled: false };
  }

  const baseId = process.env.AIRTABLE_BASE_ID;
  const workspaceId = process.env.AIRTABLE_WORKSPACE_ID;
  const baseName = process.env.AIRTABLE_BASE_NAME;

  if (!baseId && (!workspaceId || !baseName)) {
    throw new Error(
      'Set AIRTABLE_BASE_ID, or provide AIRTABLE_WORKSPACE_ID + AIRTABLE_BASE_NAME so the script can find/create the base.'
    );
  }

  return {
    enabled: true,
    token: getEnv('AIRTABLE_TOKEN', { required: true }),
    baseId,
    workspaceId,
    baseName,
    tableName: getEnv('AIRTABLE_TABLE_NAME', { required: true }),
    createBaseIfMissing: toBoolean(process.env.AIRTABLE_CREATE_BASE_IF_MISSING),
    createTableIfMissing: toBoolean(process.env.AIRTABLE_CREATE_TABLE_IF_MISSING)
  };
}

export async function ensureAirtableBaseAndTable(config, fieldNames) {
  if (config.baseId) {
    const tableInfo = await ensureAirtableTable({ ...config, baseId: config.baseId }, fieldNames);
    return {
      baseId: config.baseId,
      createdBase: false,
      ...tableInfo
    };
  }

  const existingBases = await listWorkspaceBases(config);
  const existingBase = existingBases.find((base) => base.name === config.baseName);

  if (existingBase) {
    const tableInfo = await ensureAirtableTable({ ...config, baseId: existingBase.id }, fieldNames);
    return {
      baseId: existingBase.id,
      createdBase: false,
      ...tableInfo
    };
  }

  if (!config.createBaseIfMissing) {
    throw new Error(
      `Airtable base "${config.baseName}" not found in workspace ${config.workspaceId}. Set AIRTABLE_CREATE_BASE_IF_MISSING=true to create it automatically.`
    );
  }

  return createBase(config, fieldNames);
}

export async function ensureAirtableTable(config, fieldNames) {
  const baseUrl = `https://api.airtable.com/v0/meta/bases/${config.baseId}/tables`;
  const meta = await airtableRequest(baseUrl, { token: config.token });

  const existing = meta.tables?.find((table) => table.name === config.tableName);
  if (existing) {
    return { createdTable: false, tableId: existing.id };
  }

  if (!config.createTableIfMissing) {
    throw new Error(
      `Airtable table "${config.tableName}" not found in base ${config.baseId}. Set AIRTABLE_CREATE_TABLE_IF_MISSING=true to allow automatic creation.`
    );
  }

  const created = await airtableRequest(baseUrl, {
    method: 'POST',
    token: config.token,
    body: {
      name: config.tableName,
      fields: fieldNames.map(inferField)
    }
  });

  return { createdTable: true, tableId: created.id };
}

function formatRejectError(error, rowIndex, row) {
  return {
    rowIndex,
    message: error instanceof Error ? error.message : String(error),
    row
  };
}

function toRecordPayload(row) {
  const payload = { ...row };
  if (payload.Date && typeof payload.Date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.Date)) {
    return payload;
  }
  return payload;
}

async function upsertBatch(config, rows) {
  const url = `https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(config.tableName)}`;
  return airtableRequest(url, {
    method: 'PATCH',
    token: config.token,
    body: {
      records: rows.map((row) => ({ fields: toRecordPayload(row) })),
      performUpsert: {
        fieldsToMergeOn: UPSERT_MERGE_FIELDS
      },
      typecast: true
    }
  });
}

export async function upsertRowsToAirtable(config, rows) {
  if (!rows.length) {
    return {
      upserted: 0,
      created: 0,
      updated: 0,
      batches: 0,
      rejected: 0,
      rejects: []
    };
  }

  const batches = chunk(rows, BATCH_SIZE);
  const rejects = [];
  let created = 0;
  let updated = 0;
  let syncedRows = 0;
  let nextProgressLogAt = 500;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const rowStart = batchIndex * BATCH_SIZE + 1;
    const rowEnd = rowStart + batch.length - 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await upsertBatch(config, batch);
      const createdInBatch = result.createdRecords?.length ?? 0;
      const updatedInBatch = result.updatedRecords?.length ?? 0;
      created += createdInBatch;
      updated += updatedInBatch;
      syncedRows = created + updated;

      if (syncedRows >= nextProgressLogAt || syncedRows === rows.length) {
        console.log(
          `[airtable] Progress: ${syncedRows}/${rows.length} rows synced ` +
          `(created ${created}, updated ${updated}).`
        );
        while (syncedRows >= nextProgressLogAt) {
          nextProgressLogAt += 500;
        }
      }
    } catch (error) {
      console.error(
        `[airtable] Failed rows ${rowStart}-${rowEnd}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
      for (let offset = 0; offset < batch.length; offset += 1) {
        const row = batch[offset];
        const rowIndex = batchIndex * BATCH_SIZE + offset;
        rejects.push(formatRejectError(error, rowIndex, row));
      }
    }
  }

  return {
    upserted: created + updated,
    created,
    updated,
    batches: batches.length,
    rejected: rejects.length,
    rejects
  };
}
