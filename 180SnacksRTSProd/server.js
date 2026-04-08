import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/u);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2] ?? '';

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.resolve(process.cwd(), '.envsoft'));
loadDotEnv(path.resolve(process.cwd(), '.env'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 4010);
const iriProjectDir = process.env.IRI_DIR;
const excelProjectDir = process.env.EXCEL_DIR;

const runs = new Map();

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sanitizeRun(run) {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    steps: run.steps,
    cleanup: run.cleanup,
    logs: run.logs
  };
}

function createRun() {
  const id = crypto.randomUUID();
  const run = {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    steps: [
      {
        id: 'iridev-extract',
        label: 'IRIDev extraction',
        command: 'npm run run -- --mode=download',
        cwd: path.resolve(__dirname, '..', iriProjectDir),
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        exitCode: null
      },
      {
        id: 'excel-to-airtable',
        label: 'ExcelToAirtable sync',
        command: 'npm run run',
        cwd: path.resolve(__dirname, '..', excelProjectDir),
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        exitCode: null
      }
    ],
    cleanup: {
      enabled: true,
      keepLatestDownloads: 1,
      keepLatestOutputs: 1,
      removed: []
    },
    logs: []
  };

  runs.set(id, run);
  return run;
}

function appendLog(run, stepId, level, message) {
  run.logs.push({
    at: new Date().toISOString(),
    stepId,
    level,
    message
  });

  if (run.logs.length > 800) {
    run.logs = run.logs.slice(-800);
  }
}

function runStep(run, step) {
  return new Promise((resolve, reject) => {
    step.status = 'running';
    step.startedAt = new Date().toISOString();
    appendLog(run, step.id, 'info', `Starting: ${step.command}`);

    const child = spawn(step.command, {
      cwd: step.cwd,
      shell: true,
      env: process.env
    });

    child.stdout.on('data', (chunk) => {
      appendLog(run, step.id, 'stdout', String(chunk).trimEnd());
    });

    child.stderr.on('data', (chunk) => {
      appendLog(run, step.id, 'stderr', String(chunk).trimEnd());
    });

    child.on('error', (error) => {
      step.status = 'failed';
      step.finishedAt = new Date().toISOString();
      step.exitCode = -1;
      appendLog(run, step.id, 'error', `Spawn error: ${error.message}`);
      reject(error);
    });

    child.on('close', (code) => {
      step.finishedAt = new Date().toISOString();
      step.exitCode = code;

      if (code === 0) {
        step.status = 'completed';
        appendLog(run, step.id, 'info', `Completed with exit code ${code}.`);
        resolve();
        return;
      }

      step.status = 'failed';
      appendLog(run, step.id, 'error', `Failed with exit code ${code}.`);
      reject(new Error(`Step ${step.id} failed with exit code ${code}`));
    });
  });
}

function cleanupOldFiles(directoryPath, matcher, keepLatest) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const candidates = fs.readdirSync(directoryPath)
    .filter((name) => matcher.test(name))
    .filter((name) => !name.startsWith('~$'))
    .map((name) => {
      const fullPath = path.join(directoryPath, name);
      const stats = fs.statSync(fullPath);
      return { fullPath, name, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  const toDelete = candidates.slice(Math.max(0, keepLatest));
  for (const file of toDelete) {
    try {
      fs.unlinkSync(file.fullPath);
      removed.push(file.fullPath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EBUSY') {
        continue;
      }
      throw error;
    }
  }

  return removed;
}

function cleanupArtifacts(run) {
  if (!run.cleanup.enabled) {
    return;
  }
  if (run.status === 'failed') {
    appendLog(run, 'cleanup', 'info', 'Cleanup skipped because run failed (preserving artifacts for debugging).');
    return;
  }

  const downloadsDir = path.resolve(__dirname, '..', iriProjectDir, 'artifacts', 'downloads');
  const outputDir = path.resolve(__dirname, '..', excelProjectDir, 'artifacts');

  let removedDownloads = [];
  let removedOutputs = [];
  try {
    removedDownloads = cleanupOldFiles(downloadsDir, /\.xlsx$/i, run.cleanup.keepLatestDownloads);
    removedOutputs = cleanupOldFiles(outputDir, /\.xlsx$/i, run.cleanup.keepLatestOutputs);
  } catch (error) {
    appendLog(
      run,
      'cleanup',
      'warn',
      `Cleanup encountered an error but run output is preserved: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  run.cleanup.removed = [...removedDownloads, ...removedOutputs];
  appendLog(run, 'cleanup', 'info', `Cleanup removed ${run.cleanup.removed.length} old .xlsx files.`);
}

async function runPipeline(run) {
  run.status = 'running';
  run.startedAt = new Date().toISOString();

  for (const step of run.steps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runStep(run, step);
    } catch (error) {
      run.status = 'failed';
      appendLog(run, step.id, 'error', error instanceof Error ? error.message : String(error));
      break;
    }
  }

  cleanupArtifacts(run);
  if (run.status === 'running') {
    run.status = 'completed';
  }
  run.finishedAt = new Date().toISOString();
}

function tryServeStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url;
  const resolved = path.resolve(publicDir, `.${requestPath}`);

  if (!resolved.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return false;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (req.method === 'POST' && req.url === '/api/runs') {
    const activeRun = Array.from(runs.values()).find((run) => run.status === 'queued' || run.status === 'running');
    if (activeRun) {
      json(res, 409, {
        error: 'A pipeline run is already active.',
        activeRun: sanitizeRun(activeRun)
      });
      return;
    }

    const run = createRun();
    json(res, 202, sanitizeRun(run));
    runPipeline(run);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runs') {
    const list = Array.from(runs.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 20)
      .map(sanitizeRun);
    json(res, 200, { runs: list });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/runs/')) {
    const id = req.url.split('/').pop();
    const run = id ? runs.get(id) : null;
    if (!run) {
      json(res, 404, { error: 'Run not found' });
      return;
    }
    json(res, 200, sanitizeRun(run));
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    json(res, 200, { ok: true, service: '180SnacksRTS' });
    return;
  }

  if (tryServeStatic(req, res)) {
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(port, () => {
  console.log(`180SnacksRTS running at http://localhost:${port}`);
});
