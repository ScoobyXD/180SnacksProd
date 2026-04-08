const OUTPUT_COLUMNS = [
  'Item',
  'Region',
  'Venue',
  'Date',
  'Dollar Sales',
  'Unit Sales',
  'Inventory On Hand',
  'Average Price per Unit'
];

const METRIC_COLUMNS = [
  'Dollar Sales',
  'Unit Sales',
  'Inventory On Hand',
  'Average Price per Unit'
];

function asCleanString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function asMaybeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  let text = String(value).trim();
  if (!text || /^[-–—]+$/.test(text) || /^(n\/a|na|null)$/i.test(text)) {
    return null;
  }

  text = text.replace(/\(([^)]+)\)/g, '-$1');
  text = text.replace(/[$,%\s]/g, '');
  text = text.replace(/[^\d.-]/g, '');

  if (!text || text === '-' || text === '.' || text === '-.') {
    return null;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTotalRow(venueRaw) {
  const venue = asCleanString(venueRaw).toLowerCase();
  return venue.includes('total us by region') || venue.startsWith('total ');
}

function isWarehouseRow(venueRaw) {
  return /\bwarehouse\b/i.test(asCleanString(venueRaw));
}

function isRegionRow(venueRaw) {
  const venue = asCleanString(venueRaw);
  if (!venue) {
    return false;
  }
  if (isWarehouseRow(venue) || isTotalRow(venue)) {
    return false;
  }
  return true;
}

export function transformRows(inputRows, { reportDate = '' } = {}) {
  const output = [];
  let currentItem = '';
  let currentRegion = '';

  for (const row of inputRows) {
    const itemValue = asCleanString(row.Item);
    const venueValue = row.Venue;

    if (itemValue) {
      currentItem = itemValue;
    }

    if (isTotalRow(venueValue)) {
      continue;
    }

    if (isRegionRow(venueValue)) {
      currentRegion = asCleanString(venueValue);
      continue;
    }

    if (!isWarehouseRow(venueValue)) {
      continue;
    }

    const normalized = {
      Item: currentItem,
      Region: currentRegion,
      Venue: asCleanString(venueValue),
      Date: reportDate,
      'Dollar Sales': null,
      'Unit Sales': null,
      'Inventory On Hand': null,
      'Average Price per Unit': null
    };

    for (const metricColumn of METRIC_COLUMNS) {
      normalized[metricColumn] = asMaybeNumber(row[metricColumn]);
    }

    output.push(normalized);
  }

  return output;
}

export function getOutputColumns() {
  return [...OUTPUT_COLUMNS];
}
