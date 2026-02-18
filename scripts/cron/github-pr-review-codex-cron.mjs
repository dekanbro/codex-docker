#!/usr/bin/env node

/**
 * GitHub PR + CodeRabbit monitor for Codex cron.
 *
 * Outputs JSON with:
 * - urgent: failing checks/deploy statuses
 * - actionable: PRs with unresolved CodeRabbit threads (Codex runs)
 * - ready: PRs with threads resolved and head commit newer than latest CodeRabbit activity
 *
 * State:
 * - /workspace/.codex/cron/github-pr-review-state.json
 *   {
 *     lastEventId,
 *     notified: { "<prNumber>": { sha, latestCR, notifiedAt } }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = process.env.GITHUB_REPO || 'raid-guild/cohort-portal-spike';
const API = 'https://api.github.com';
const EVENTS_URL = `${API}/repos/${REPO}/events?per_page=100`;
const STATE_PATH = process.env.GITHUB_PR_REVIEW_STATE_PATH || '/workspace/.codex/cron/github-pr-review-state.json';
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_REVIEW_BASE_PROMPT = process.env.CODEX_REVIEW_BASE_PROMPT || [
  'You are an autonomous coding agent running in cron mode.',
  'Address unresolved CodeRabbit review threads on the PR and push fixes.',
  'Keep changes minimal and scoped to review feedback.',
  'Run relevant checks before pushing.'
].join(' ');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function compactTitle(s, max = 80) {
  if (!s) return '';
  const oneLine = String(s).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 3)}...`;
}

function prNumFromPayload(payload) {
  if (payload?.pull_request?.number) return payload.pull_request.number;
  if (payload?.issue?.number && payload?.issue?.pull_request) return payload.issue.number;
  const prs = payload?.check_run?.pull_requests;
  if (Array.isArray(prs) && prs[0]?.number) return prs[0].number;
  const prs2 = payload?.check_suite?.pull_requests;
  if (Array.isArray(prs2) && prs2[0]?.number) return prs2[0].number;
  return null;
}

function getToken() {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set in environment');
  return token;
}

async function ghGetJson(url, extraHeaders = {}) {
  const token = getToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
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

async function ghGraphql(query, variables) {
  const token = getToken();
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codex-cron',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const msg = json?.errors?.[0]?.message || 'GraphQL error';
    throw new Error(`GitHub GraphQL error: ${msg}`);
  }
  return json.data;
}

function extractRepoParts(repo) {
  const [owner, name] = String(repo).split('/');
  return { owner, name };
}

function isCodeRabbitLogin(login) {
  return /coderabbit/i.test(String(login || ''));
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

async function getLatestCodeRabbitActivityIso(prNumber) {
  const base = `${API}/repos/${REPO}`;
  const [reviews, issueComments, reviewComments] = await Promise.all([
    ghGetJson(`${base}/pulls/${prNumber}/reviews?per_page=100`),
    ghGetJson(`${base}/issues/${prNumber}/comments?per_page=100`),
    ghGetJson(`${base}/pulls/${prNumber}/comments?per_page=100`),
  ]);

  let latest = null;

  for (const r of reviews || []) {
    if (isCodeRabbitLogin(r?.user?.login)) latest = maxIso(latest, r?.submitted_at);
  }
  for (const c of issueComments || []) {
    if (isCodeRabbitLogin(c?.user?.login)) latest = maxIso(latest, c?.created_at);
  }
  for (const c of reviewComments || []) {
    if (isCodeRabbitLogin(c?.user?.login)) latest = maxIso(latest, c?.created_at);
  }

  return latest;
}

async function getHeadCommitIso(sha) {
  const base = `${API}/repos/${REPO}`;
  const commit = await ghGetJson(`${base}/commits/${sha}`);
  return commit?.commit?.committer?.date || commit?.commit?.author?.date || null;
}

async function getCodeRabbitUnresolvedThreadCount(prNumber) {
  const { owner, name } = extractRepoParts(REPO);
  const query = `
    query($owner:String!, $name:String!, $number:Int!, $after:String) {
      repository(owner:$owner, name:$name) {
        pullRequest(number:$number) {
          reviewThreads(first:100, after:$after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved
              isOutdated
              comments(first:50) { nodes { author { login } } }
            }
          }
        }
      }
    }
  `;

  let after = null;
  let unresolved = 0;

  for (let i = 0; i < 5; i += 1) {
    const data = await ghGraphql(query, { owner, name, number: prNumber, after });
    const threads = data?.repository?.pullRequest?.reviewThreads;
    const nodes = threads?.nodes || [];

    for (const t of nodes) {
      if (t?.isResolved || t?.isOutdated) continue;
      const authors = (t?.comments?.nodes || []).map((n) => n?.author?.login).filter(Boolean);
      if (authors.some((a) => isCodeRabbitLogin(a))) unresolved += 1;
    }

    if (!threads?.pageInfo?.hasNextPage) break;
    after = threads.pageInfo.endCursor;
  }

  return unresolved;
}

function lineForCheckRunEvent(ev) {
  const p = ev?.payload;
  const cr = p?.check_run;
  if (!cr) return null;

  const prNum = prNumFromPayload(p) ?? '?';
  const name = cr?.name || cr?.external_id || 'check';
  const status = (cr?.status || '').toUpperCase() || 'STATUS';
  const conclusion = (cr?.conclusion || '').toUpperCase();
  const interestingConclusions = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const isInteresting = conclusion ? interestingConclusions.has(conclusion) : status !== 'COMPLETED';
  if (!isInteresting) return null;

  const app = cr?.app?.slug || cr?.app?.name || 'checks';
  const url = cr?.html_url || cr?.details_url || null;
  const state = conclusion ? `${status}/${conclusion}` : status;
  return `PR #${prNum} - CHECK ${name} (${app}) - ${state} - ${url || ''}`.trim();
}

function lineForCheckSuiteEvent(ev) {
  const p = ev?.payload;
  const cs = p?.check_suite;
  if (!cs) return null;

  const prNum = prNumFromPayload(p) ?? '?';
  const status = (cs?.status || '').toUpperCase() || 'STATUS';
  const conclusion = (cs?.conclusion || '').toUpperCase();
  const interestingConclusions = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const isInteresting = conclusion ? interestingConclusions.has(conclusion) : status !== 'COMPLETED';
  if (!isInteresting) return null;

  const app = cs?.app?.slug || cs?.app?.name || 'checks';
  const url = cs?.html_url || null;
  const state = conclusion ? `${status}/${conclusion}` : status;
  return `PR #${prNum} - CHECK SUITE (${app}) - ${state} - ${url || ''}`.trim();
}

function lineForDeploymentStatusEvent(ev) {
  const p = ev?.payload;
  const ds = p?.deployment_status;
  if (!ds) return null;

  const state = (ds?.state || '').toUpperCase();
  const interesting = new Set(['ERROR', 'FAILURE', 'INACTIVE']);
  if (!interesting.has(state)) return null;

  const prNum = prNumFromPayload(p) ?? '?';
  const env = ds?.environment || 'deployment';
  const url = ds?.target_url || ds?.environment_url || ds?.url || null;
  return `PR #${prNum} - DEPLOYMENT ${env} - ${state} - ${url || ''}`.trim();
}

async function listCandidateOpenPRs(limit = 20) {
  const base = `${API}/repos/${REPO}`;
  const prs = await ghGetJson(`${base}/pulls?state=open&per_page=${limit}&sort=updated&direction=desc`).catch(() => []);
  return Array.isArray(prs) ? prs : [];
}

function buildCodexPrompt(item) {
  return [
    CODEX_REVIEW_BASE_PROMPT,
    '',
    `Repository: ${REPO}`,
    `Pull Request: #${item.number} - ${item.title}`,
    `URL: ${item.url}`,
    `Head SHA: ${item.headSha}`,
    `Unresolved CodeRabbit threads: ${item.unresolved}`,
    `CodeRabbit latest activity: ${item.coderabbitLast}`,
    '',
    'Execution requirements:',
    '- Resolve the unresolved CodeRabbit review feedback on this PR.',
    '- Push fixes to the PR branch.',
    '- Do not open a new PR for this task.',
    '- Post concise review-response comments if needed.',
    '- Before running lint/tests, install dependencies for this repository if they are not installed.',
    '- If a specific tool is missing (for example eslint) and cannot be installed in this run, continue with best-effort validation and document the limitation.'
  ].join('\n');
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      stdio: opts.stdio || 'pipe',
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('exit', (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null, stdout, stderr });
    });
  });
}

async function prepareRepoForPR(prNumber) {
  const token = getToken();
  const tempDir = fs.mkdtempSync('/tmp/codex-pr-review-');
  const encodedToken = encodeURIComponent(token);
  const repoUrl = `https://x-access-token:${encodedToken}@github.com/${REPO}.git`;

  let result = await runCommand('git', ['clone', '--no-tags', '--depth', '50', repoUrl, tempDir]);
  if (result.code !== 0) {
    throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
  }

  const branchName = `pr-${prNumber}`;
  result = await runCommand('git', ['fetch', '--depth', '50', 'origin', `pull/${prNumber}/head:${branchName}`], { cwd: tempDir });
  if (result.code !== 0) {
    throw new Error(`git fetch PR failed: ${result.stderr || result.stdout}`);
  }

  result = await runCommand('git', ['checkout', branchName], { cwd: tempDir });
  if (result.code !== 0) {
    throw new Error(`git checkout PR branch failed: ${result.stderr || result.stdout}`);
  }

  return tempDir;
}

function runCodex(prompt, repoDir) {
  return new Promise((resolve) => {
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox'];
    if (CODEX_MODEL) args.push('--model', CODEX_MODEL);
    args.push(prompt);

    const codexEnv = { ...process.env };
    if (OPENAI_API_KEY.trim()) {
      codexEnv.OPENAI_API_KEY = OPENAI_API_KEY.trim();
    } else {
      delete codexEnv.OPENAI_API_KEY;
    }

    const child = spawn('codex', args, {
      stdio: 'inherit',
      cwd: repoDir,
      env: codexEnv,
    });

    child.on('exit', (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

async function main() {
  const state = readJson(STATE_PATH) || {};
  const lastEventId = state.lastEventId;
  const notified = state.notified || {};

  const events = await ghGetJson(EVENTS_URL);
  const newestEventId = events?.[0]?.id ? String(events[0].id) : null;

  const out = {
    repo: REPO,
    statePath: STATE_PATH,
    newestEventId,
    initialized: false,
    reset: false,
    urgent: [],
    actionable: [],
    ready: [],
    codexRuns: [],
  };

  if (!newestEventId || !Array.isArray(events) || events.length === 0) {
    console.log(JSON.stringify(out));
    return;
  }

  if (!lastEventId) {
    writeJsonAtomic(STATE_PATH, { lastEventId: newestEventId, notified, ts: new Date().toISOString() });
    out.initialized = true;
    console.log(JSON.stringify(out));
    return;
  }

  const idx = events.findIndex((e) => String(e.id) === String(lastEventId));
  if (idx === -1) {
    writeJsonAtomic(STATE_PATH, { lastEventId: newestEventId, notified, ts: new Date().toISOString(), reset: true });
    out.reset = true;
    console.log(JSON.stringify(out));
    return;
  }

  const newer = events.slice(0, idx).reverse();
  writeJsonAtomic(STATE_PATH, { lastEventId: newestEventId, notified, ts: new Date().toISOString() });

  const prsToEvaluate = new Set();
  for (const ev of newer) {
    const t = ev?.type;
    const p = ev?.payload;

    if (t === 'CheckRunEvent') {
      const line = lineForCheckRunEvent(ev);
      if (line) out.urgent.push(line);
      continue;
    }
    if (t === 'CheckSuiteEvent') {
      const line = lineForCheckSuiteEvent(ev);
      if (line) out.urgent.push(line);
      continue;
    }
    if (t === 'DeploymentStatusEvent') {
      const line = lineForDeploymentStatusEvent(ev);
      if (line) out.urgent.push(line);
      continue;
    }
    if (
      t === 'PullRequestReviewEvent' ||
      t === 'PullRequestReviewCommentEvent' ||
      (t === 'IssueCommentEvent' && p?.issue?.pull_request)
    ) {
      const prNum = prNumFromPayload(p);
      if (prNum) prsToEvaluate.add(prNum);
    }
  }

  if (prsToEvaluate.size === 0) {
    const open = await listCandidateOpenPRs(25);
    for (const pr of open) {
      if (pr?.number) prsToEvaluate.add(pr.number);
    }
  }

  for (const prNum of Array.from(prsToEvaluate)) {
    const latestCR = await getLatestCodeRabbitActivityIso(prNum).catch(() => null);
    if (!latestCR) continue;

    const prData = await ghGetJson(`${API}/repos/${REPO}/pulls/${prNum}`).catch(() => null);
    if (!prData?.head?.sha) continue;

    const item = {
      number: prNum,
      title: compactTitle(prData.title, 80),
      url: prData.html_url,
      headSha: prData.head.sha,
      coderabbitLast: latestCR,
      unresolved: 0,
    };

    const unresolved = await getCodeRabbitUnresolvedThreadCount(prNum).catch(() => null);
    const headCommitIso = await getHeadCommitIso(item.headSha).catch(() => null);
    if (unresolved == null || !headCommitIso) continue;

    item.unresolved = unresolved;
    const crMs = new Date(latestCR).getTime();
    const headMs = new Date(headCommitIso).getTime();
    const prKey = String(prNum);
    const lastNotified = notified[prKey] || {};

    if (unresolved > 0) {
      out.actionable.push(item);
      continue;
    }

    if (headMs > crMs) {
      if (!(lastNotified.sha === item.headSha && lastNotified.latestCR === latestCR)) {
        out.ready.push({
          number: item.number,
          title: item.title,
          url: item.url,
          headSha: item.headSha,
          coderabbitLast: latestCR,
        });
        notified[prKey] = { sha: item.headSha, latestCR, notifiedAt: new Date().toISOString() };
      }
    }
  }

  writeJsonAtomic(STATE_PATH, { lastEventId: newestEventId, notified, ts: new Date().toISOString() });

  for (const item of out.actionable) {
    const prompt = buildCodexPrompt(item);
    let repoDir = null;
    try {
      repoDir = await prepareRepoForPR(item.number);
      const run = await runCodex(prompt, repoDir);
      out.codexRuns.push({ pr: item.number, exitCode: run.code, signal: run.signal });
    } catch (err) {
      out.codexRuns.push({ pr: item.number, exitCode: 1, signal: null, error: String(err) });
    } finally {
      if (repoDir) {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    }
  }

  console.log(JSON.stringify(out));

  const failedRun = out.codexRuns.find((r) => r.exitCode !== 0);
  if (failedRun) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err?.stack || err) }));
  process.exit(1);
});
