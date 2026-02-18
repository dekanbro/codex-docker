#!/usr/bin/env node

/**
 * Poll GitHub repo events for module-spec issues and trigger Codex for actionable items.
 *
 * Required env vars:
 * - GH_TOKEN
 *
 * Optional env vars:
 * - GITHUB_REPO (default: raid-guild/cohort-portal-spike)
 * - MODULE_SPEC_LABEL (default: module-spec)
 * - GITHUB_ISSUE_SPEC_STATE_PATH (default: /workspace/.codex/cron/github-issue-spec-state.json)
 * - CODEX_MODEL (optional)
 * - CODEX_BASE_PROMPT (optional)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = process.env.GITHUB_REPO || 'raid-guild/cohort-portal-spike';
const GH_TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com';
const EVENTS_URL = `${API}/repos/${REPO}/events?per_page=100`;
const STATE_PATH = process.env.GITHUB_ISSUE_SPEC_STATE_PATH || '/workspace/.codex/cron/github-issue-spec-state.json';
const SPEC_LABEL = (process.env.MODULE_SPEC_LABEL || 'module-spec').toLowerCase();
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_BASE_PROMPT = process.env.CODEX_BASE_PROMPT || [
  'You are an autonomous coding agent running in cron mode.',
  'Read the linked GitHub issue and implement the requested module spec.',
  'Open a PR back to the same repository.',
  'If a PR cannot be created, explain precisely what is missing and exit non-zero.'
].join(' ');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

if (!GH_TOKEN) {
  console.error(JSON.stringify({ error: 'GH_TOKEN missing' }));
  process.exit(2);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

async function ghGet(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codex-cron',
      ...extraHeaders,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} for ${url}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

async function hasOpenPRForIssue(issueNumber) {
  const q = `repo:${REPO} type:pr state:open "Fixes #${issueNumber}" in:body`;
  const url = `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=1`;
  const data = await ghGet(url);
  return (data?.total_count || 0) > 0;
}

function hasModuleSpecLabel(issue) {
  const labels = (issue.labels || [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter(Boolean);
  return labels.some((l) => String(l).toLowerCase() === SPEC_LABEL);
}

function checkboxChecked(issueBody) {
  if (!issueBody) {
    return false;
  }
  const lines = issueBody.split(/\r?\n/);
  return lines.some((l) => /^\s*-\s*\[x\]\s+/i.test(l) && /auto-?generate/i.test(l) && /\bpr\b/i.test(l));
}

function buildCodexPrompt(item) {
  const labels = (item.labels || []).join(', ');
  return [
    CODEX_BASE_PROMPT,
    '',
    `Repository: ${REPO}`,
    `Issue: #${item.number} - ${item.title}`,
    `URL: ${item.url}`,
    `Action: ${item.action || 'unknown'}`,
    `Labels: ${labels}`,
    '',
    'Execution requirements:',
    `- Ensure PR body includes: Fixes #${item.number}`,
    '- Keep changes minimal and focused to the issue request.',
    '- Run relevant tests or checks before opening PR.'
  ].join('\n');
}

function runCodex(prompt) {
  return new Promise((resolve) => {
    const args = ['exec', '--skip-git-repo-check'];
    if (CODEX_MODEL) {
      args.push('--model', CODEX_MODEL);
    }
    args.push(prompt);

    const child = spawn('codex', args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        OPENAI_API_KEY: OPENAI_API_KEY.trim(),
      },
    });

    child.on('exit', (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

async function collectActionableEvents() {
  const state = readState();
  const lastEventId = state?.lastEventId || null;

  const events = await ghGet(EVENTS_URL);
  const newestEventId = events?.[0]?.id || null;

  if (!newestEventId) {
    return { newestEventId: null, initialized: false, reset: false, matched: [], actionable: [] };
  }

  if (!lastEventId) {
    writeState({ lastEventId: newestEventId, ts: new Date().toISOString() });
    return { newestEventId, initialized: true, reset: false, matched: [], actionable: [] };
  }

  if (String(lastEventId) === String(newestEventId)) {
    return { newestEventId, initialized: false, reset: false, matched: [], actionable: [] };
  }

  const newOnes = [];
  for (const ev of events) {
    if (String(ev.id) === String(lastEventId)) {
      break;
    }
    newOnes.push(ev);
  }

  if (newOnes.length === events.length) {
    writeState({ lastEventId: newestEventId, ts: new Date().toISOString(), reset: true });
    return { newestEventId, initialized: false, reset: true, matched: [], actionable: [] };
  }

  newOnes.reverse();

  const matched = [];
  const actionable = [];

  for (const ev of newOnes) {
    if (ev.type !== 'IssuesEvent') {
      continue;
    }

    const issue = ev.payload?.issue;
    if (!issue) {
      continue;
    }

    if (!hasModuleSpecLabel(issue)) {
      continue;
    }

    const checked = checkboxChecked(issue.body || '');

    const item = {
      id: ev.id,
      action: ev.payload?.action || null,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      user: issue.user?.login,
      checked,
      updated_at: issue.updated_at,
      labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    };

    matched.push(item);

    const canActOnAction = (
      ev.payload?.action === 'opened' ||
      ev.payload?.action === 'edited' ||
      ev.payload?.action === 'labeled' ||
      ev.payload?.action === 'reopened'
    );

    if (checked && canActOnAction) {
      let prAlreadyOpen = false;
      try {
        prAlreadyOpen = await hasOpenPRForIssue(issue.number);
      } catch {
        prAlreadyOpen = false;
      }
      actionable.push({ ...item, prAlreadyOpen });
    }
  }

  const filteredActionable = actionable.filter((a) => !a.prAlreadyOpen);

  writeState({ lastEventId: newestEventId, ts: new Date().toISOString() });

  return {
    newestEventId,
    initialized: false,
    reset: false,
    matched,
    actionable: filteredActionable,
  };
}

(async () => {
  const result = await collectActionableEvents();

  const summary = {
    statePath: STATE_PATH,
    newestEventId: result.newestEventId,
    initialized: result.initialized,
    reset: result.reset,
    events: result.matched,
    actionable: result.actionable,
    codexRuns: [],
  };

  if (summary.actionable.length > 0 && !OPENAI_API_KEY.trim()) {
    summary.error = 'OPENAI_API_KEY missing; cannot run codex exec for actionable issues';
    console.log(JSON.stringify(summary));
    process.exit(2);
  }

  for (const item of result.actionable) {
    const prompt = buildCodexPrompt(item);
    const run = await runCodex(prompt);
    summary.codexRuns.push({
      issue: item.number,
      exitCode: run.code,
      signal: run.signal,
    });
  }

  console.log(JSON.stringify(summary));

  const failedRun = summary.codexRuns.find((r) => r.exitCode !== 0);
  if (failedRun) {
    process.exit(1);
  }
})().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
