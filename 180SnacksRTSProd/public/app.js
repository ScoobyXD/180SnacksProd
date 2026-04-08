const runButton = document.getElementById('runButton');
const statusText = document.getElementById('statusText');
const uploadCheckText = document.getElementById('uploadCheckText');
const stepsList = document.getElementById('steps');
const logsEl = document.getElementById('logs');
const copyLogsButton = document.getElementById('copyLogsButton');
const clockEl = document.getElementById('clock');
const branchTree = document.getElementById('branchTree');
const pipelineGroup = document.getElementById('pipelineGroup');
const canvas = document.getElementById('canvas');
const world = document.getElementById('world');

let currentRunId = null;
let pollTimer = null;
let widgetDragPointerId = null;
let latestRenderedLogsText = '';

const pan = {
  x: -4900,
  y: -4400,
  scale: 1,
  dragging: false,
  startMouseX: 0,
  startMouseY: 0,
  startX: 0,
  startY: 0
};

const groupDrag = {
  dragging: false,
  startMouseX: 0,
  startMouseY: 0,
  startLeft: 0,
  startTop: 0
};

function applyPan() {
  world.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${pan.scale})`;
}

function setStatus(text) {
  statusText.textContent = text;
}

function setUploadCheck({ text, tone = 'neutral' }) {
  uploadCheckText.classList.remove('hidden');
  uploadCheckText.textContent = text;
  uploadCheckText.classList.remove('neutral', 'success', 'danger');
  uploadCheckText.classList.add(tone);
}

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString();
}

function showRuntimeWidgets() {
  branchTree.classList.remove('hidden');
}

function renderSteps(steps = []) {
  stepsList.innerHTML = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = 'step';

    const label = document.createElement('span');
    label.textContent = step.label;

    const badge = document.createElement('span');
    badge.className = `badge ${step.status}`;
    badge.textContent = step.status;

    li.append(label, badge);
    stepsList.appendChild(li);
  }
}

function renderLogs(logs = []) {
  if (!logs.length) {
    latestRenderedLogsText = 'No logs yet.';
    logsEl.textContent = latestRenderedLogsText;
    return;
  }

  latestRenderedLogsText = logs
    .slice(-250)
    .map((entry) => `[${entry.at}] [${entry.stepId}] [${entry.level}] ${entry.message}`)
    .join('\n');
  logsEl.textContent = latestRenderedLogsText;

  logsEl.scrollTop = logsEl.scrollHeight;
}

function readUploadCheckFromLogs(logs = []) {
  const pattern = /Row confirmation:\s*(\d+)\/(\d+)\s+rows uploaded\s*\(created\s+(\d+),\s+updated\s+(\d+),\s+upserted\s+(\d+)\)\./i;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const message = String(logs[i]?.message ?? '');
    const match = message.match(pattern);
    if (!match) {
      continue;
    }

    return {
      uploaded: Number(match[1]),
      expected: Number(match[2]),
      created: Number(match[3]),
      updated: Number(match[4]),
      upserted: Number(match[5])
    };
  }

  return null;
}

async function copyLogsToClipboard() {
  const text = latestRenderedLogsText || logsEl.textContent || '';
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    const previous = copyLogsButton.textContent;
    copyLogsButton.textContent = 'Copied';
    copyLogsButton.disabled = true;
    setTimeout(() => {
      copyLogsButton.textContent = previous;
      copyLogsButton.disabled = false;
    }, 1200);
  } catch (error) {
    setStatus(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed');
  }
}

async function fetchRun(runId) {
  const response = await fetch(`/api/runs/${runId}`);
  if (!response.ok) {
    throw new Error('Could not load run status');
  }
  return response.json();
}

async function refreshRun() {
  if (!currentRunId) {
    return;
  }

  try {
    const run = await fetchRun(currentRunId);
    showRuntimeWidgets();
    setStatus(`Run ${run.id} is ${run.status}.`);
    renderSteps(run.steps);
    renderLogs(run.logs);
    const uploadCheck = readUploadCheckFromLogs(run.logs);
    if (uploadCheck) {
      const isMatch = uploadCheck.uploaded === uploadCheck.expected;
      setUploadCheck({
        text: `${uploadCheck.uploaded}/${uploadCheck.expected} rows uploaded ` +
          `(updated: ${uploadCheck.updated})`,
        tone: isMatch ? 'success' : 'danger'
      });
    } else {
      setUploadCheck({ text: 'Rows uploaded: --/--', tone: 'neutral' });
    }

    const finished = run.status === 'completed' || run.status === 'failed';
    runButton.disabled = !finished;

    if (finished && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function startRun() {
  runButton.disabled = true;
  setStatus('Starting pipeline run...');
  setUploadCheck({ text: 'Rows uploaded: --/--', tone: 'neutral' });

  try {
    const response = await fetch('/api/runs', { method: 'POST' });
    const payload = await response.json();

    if (!response.ok) {
      const message = payload?.error || 'Could not start run';
      throw new Error(message);
    }

    currentRunId = payload.id;
    showRuntimeWidgets();
    renderSteps(payload.steps);
    renderLogs(payload.logs);
    setStatus(`Run ${payload.id} started.`);

    if (pollTimer) {
      clearInterval(pollTimer);
    }

    pollTimer = setInterval(refreshRun, 1500);
    await refreshRun();
  } catch (error) {
    runButton.disabled = false;
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

canvas.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('#pipelineGroup .widget')) {
    if (target.closest('button, input, textarea, select, a, pre')) {
      return;
    }

    groupDrag.dragging = true;
    groupDrag.startMouseX = event.clientX;
    groupDrag.startMouseY = event.clientY;
    groupDrag.startLeft = Number.parseFloat(pipelineGroup.style.left || '0');
    groupDrag.startTop = Number.parseFloat(pipelineGroup.style.top || '0');
    widgetDragPointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  pan.dragging = true;
  pan.startMouseX = event.clientX;
  pan.startMouseY = event.clientY;
  pan.startX = pan.x;
  pan.startY = pan.y;
  canvas.classList.add('panning');
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (groupDrag.dragging) {
    const dx = (event.clientX - groupDrag.startMouseX) / pan.scale;
    const dy = (event.clientY - groupDrag.startMouseY) / pan.scale;
    pipelineGroup.style.left = `${groupDrag.startLeft + dx}px`;
    pipelineGroup.style.top = `${groupDrag.startTop + dy}px`;
    return;
  }

  if (!pan.dragging) {
    return;
  }

  pan.x = pan.startX + (event.clientX - pan.startMouseX);
  pan.y = pan.startY + (event.clientY - pan.startMouseY);
  applyPan();
});

function stopPan(event) {
  if (groupDrag.dragging && widgetDragPointerId === event.pointerId) {
    groupDrag.dragging = false;
    widgetDragPointerId = null;
    canvas.releasePointerCapture(event.pointerId);
    return;
  }

  if (!pan.dragging) {
    return;
  }

  pan.dragging = false;
  canvas.classList.remove('panning');
  canvas.releasePointerCapture(event.pointerId);
}

canvas.addEventListener('pointerup', stopPan);
canvas.addEventListener('pointercancel', stopPan);

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();

  const rect = canvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const zoomOut = event.deltaY > 0;
  const factor = zoomOut ? 0.9 : 1.1;
  const nextScale = Math.min(2.5, Math.max(0.35, pan.scale * factor));

  if (nextScale === pan.scale) {
    return;
  }

  const worldX = (pointerX - pan.x) / pan.scale;
  const worldY = (pointerY - pan.y) / pan.scale;
  pan.scale = nextScale;
  pan.x = pointerX - worldX * pan.scale;
  pan.y = pointerY - worldY * pan.scale;
  applyPan();
}, { passive: false });

runButton.addEventListener('click', startRun);
copyLogsButton.addEventListener('click', copyLogsToClipboard);
setInterval(tickClock, 1000);
applyPan();
tickClock();
