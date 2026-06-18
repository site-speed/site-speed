/* eslint-disable no-await-in-loop */
import * as core from '@actions/core';
import { graphql } from '@octokit/graphql';

// Defaults
const DEFAULT_DAYS = 30;
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';
const DEFAULT_COLOR = 'blue';
const DEFAULT_LABEL_COLOR = '555';
const DEFAULT_DELAY_MS = 1000; // ms

/* -------------------------
   Helpers
   ------------------------- */

export function validateRequiredInput(input, label) {
  if (!input) throw new Error(`${label} is required`);
  return input;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function withBackoff(fn, { retries = 4, baseDelay = 500 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      core.debug(`Transient error: ${err.message}. Retrying in ${delay}ms (attempt ${attempt}/${retries})`);
      await sleep(delay);
    }
  }
}

/* -------------------------
   GraphQL / REST clients
   ------------------------- */

export function createGraphqlClient(authToken, baseUrl = DEFAULT_GRAPHQL_URL) {
  let client = graphql.defaults({
    headers: {
      authorization: `bearer ${authToken}`
    }
  });

  if (baseUrl && baseUrl !== DEFAULT_GRAPHQL_URL) {
    client = client.defaults({ baseUrl });
  }

  return client;
}

const restFetch = async (url, token, opts = {}) => {
  const headers = Object.assign(
    {
      Authorization: `bearer ${token}`,
      Accept: opts.accept || 'application/vnd.github.v3+json',
      'User-Agent': 'site-speed-readme-badge-generator'
    },
    opts.headers || {}
  );

  const response = await fetch(url, { headers, method: opts.method || 'GET' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${response.statusText} - ${text}`);
  }
  const json = await response.json();
  return { json, response };
};

/* -------------------------
   Inputs / init
   ------------------------- */

export function initializeConfig() {
  const username = core.getInput('username');
  const tkn = core.getInput('token');
  const daysInput = core.getInput('days');
  let numDays = DEFAULT_DAYS;
  if (daysInput) {
    const parsedDays = Number(daysInput);
    if (!Number.isInteger(parsedDays) || parsedDays <= 0) {
      throw new Error(`Invalid 'days' input: must be a positive integer`);
    }
    numDays = parsedDays;
  }

  const gqlUrl = core.getInput('graphql_url') || DEFAULT_GRAPHQL_URL;
  const badgeColor = core.getInput('color') || DEFAULT_COLOR;
  const badgeLabelColor = core.getInput('label_color') || DEFAULT_LABEL_COLOR;
  const delayMs = Number(core.getInput('delay_ms') || DEFAULT_DELAY_MS);

  validateRequiredInput(username, 'username');
  validateRequiredInput(tkn, 'token');

  const client = createGraphqlClient(tkn, gqlUrl);

  return {
    username,
    token: tkn,
    days: numDays,
    graphqlUrl: gqlUrl,
    color: badgeColor,
    labelColor: badgeLabelColor,
    graphqlClient: client,
    delayMs
  };
}

/* -------------------------
   Badge helper
   ------------------------- */

export const generateBadgeMarkdown = (text, number, badgeColor, badgeLabelColor) => {
  const encodedLabel = encodeURIComponent(text);
  const encodedMessage = encodeURIComponent(String(number));
  const encodedColor = encodeURIComponent(badgeColor || DEFAULT_COLOR);
  const encodedLabelColor = encodeURIComponent(badgeLabelColor || DEFAULT_LABEL_COLOR);
  const badgeUrl = `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${encodedColor}?labelColor=${encodedLabelColor}`;
  return `![${text}](${badgeUrl})`;
};

/* -------------------------
   Search helper
   ------------------------- */

export const getSearchCount = async (client, query, token) => {
  try {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=1`;
    const { json } = await withBackoff(() => restFetch(url, token));
    return json.total_count || 0;
  } catch (err) {
    core.error(`Search query failed for q="${query}": ${err.message}`);
    return 0;
  }
};

/* -------------------------
   Contributors helper
   ------------------------- */

export const getContributorsListForRepo = async (token, owner, repo, perPage = 100) => {
  let page = 1;
  const contributors = [];
  try {
    while (true) {
      const url = `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=${perPage}&page=${page}&anon=true`;
      const { json, response } = await withBackoff(() => restFetch(url, token));
      if (!Array.isArray(json) || json.length === 0) break;
      for (const c of json) {
        const id = c.login || `${c.name || ''}-${c.email || ''}`;
        contributors.push(id);
      }
      const link = response.headers.get('link') || '';
      if (!link.includes('rel="next"')) break;
      page++;
      await sleep(200);
    }
  } catch (err) {
    core.error(`Failed to fetch contributors list for ${owner}/${repo}: ${err.message}`);
  }
  return contributors;
};

/* -------------------------
   Main orchestration
   ------------------------- */

export const generateBadges = async (
  username,
  tokenParam,
  numDays,
  graphqlClient,
  badgeColor,
  badgeLabelColor,
  graphqlUrl = DEFAULT_GRAPHQL_URL,
  delayMs = DEFAULT_DELAY_MS
) => {
  const msgColor = badgeColor || DEFAULT_COLOR;
  const lblColor = badgeLabelColor || DEFAULT_LABEL_COLOR;
  const daysCount = numDays || DEFAULT_DAYS;
  let client = graphqlClient;
  if (!client && tokenParam) client = createGraphqlClient(tokenParam, graphqlUrl);

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY env var not found');
  const [owner, name] = repository.split('/');

  try {
    // date window
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysCount);
    const filterDate = date.toISOString();
    const dateOnly = filterDate.split('T')[0];

    core.info(`Gathering metrics for repository: ${repository}...`);

    // --- Direct GraphQL counts for open items ---
    const openRes = await withBackoff(() =>
      client(
        `query ($owner: String!, $name: String!) {
           repository(owner: $owner, name: $name) {
             issues(states: OPEN) { totalCount }
             pullRequests(states: OPEN) { totalCount }
           }
         }`,
        { owner, name }
      )
    );
    const totalOpenIssues = openRes?.repository?.issues?.totalCount || 0;
    const totalOpenPRs = openRes?.repository?.pullRequests?.totalCount || 0;

    // --- Issue / PR windowed counts (REST Search) ---
    const totalPRsCreated = await getSearchCount(null, `repo:${repository} is:pr created:>=${dateOnly}`, tokenParam);
    const totalPRsClosed = await getSearchCount(null, `repo:${repository} is:pr is:closed closed:>=${dateOnly}`, tokenParam);

    // --- Commit stats & Active Contributors (GraphQL) ---
    let totalCommits = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;
    let totalActiveContributorsExact = 0;

    const gqlRes = await withBackoff(() =>
      client(
        `query ($owner: String!, $name: String!, $sinceDateTime: DateTime!, $sinceGit: GitTimestamp!) {
           repository(owner: $owner, name: $name) {
             # Issues windowed (uses DateTime)
             openedIssues: issues(filterBy: {since: $sinceDateTime}) { totalCount }
             closedIssues: issues(filterBy: {since: $sinceDateTime, states: CLOSED}) { totalCount }

             defaultBranchRef {
               target {
                 ... on Commit {
                   # Commits windowed (uses GitTimestamp)
                   history(since: $sinceGit, first: 100) {
                     totalCount
                     nodes {
                       additions
                       deletions
                       author {
                         user { login }
                         email
                       }
                     }
                   }
                 }
               }
             }
           }
         }`,
        { owner, name, sinceDateTime: filterDate, sinceGit: filterDate }
      )
    );

    const repoObj = gqlRes?.repository;
    const history = repoObj?.defaultBranchRef?.target?.history;

    // Use GraphQL for Issues (more reliable)
    const totalIssuesOpened = repoObj?.openedIssues?.totalCount || 0;
    const totalIssuesClosed = repoObj?.closedIssues?.totalCount || 0;

    if (history) {
      totalCommits = history.totalCount || 0;
      const seenActive = new Set();
      for (const c of history.nodes || []) {
        totalAdditions += c.additions || 0;
        totalDeletions += c.deletions || 0;
        const login = c.author?.user?.login || c.author?.email;
        if (login) seenActive.add(login);
      }
      totalActiveContributorsExact = seenActive.size;
    }

    // --- All-time contributors (REST) ---
    const contribs = await getContributorsListForRepo(tokenParam, owner, name, 100);
    const totalContributorsExact = contribs.length;

    // Build badges in requested order
    const prBadges = [
      generateBadgeMarkdown(`PRs opened in last ${daysCount} days`, totalPRsCreated, 'green', lblColor),
      generateBadgeMarkdown(`PRs closed in last ${daysCount} days`, totalPRsClosed, 'red', lblColor),
      generateBadgeMarkdown(`Open PRs`, totalOpenPRs, msgColor, lblColor)
    ];

    const issueBadges = [
      generateBadgeMarkdown(`Issues opened in last ${daysCount} days`, totalIssuesOpened, 'green', lblColor),
      generateBadgeMarkdown(`Issues closed in last ${daysCount} days`, totalIssuesClosed, 'red', lblColor),
      generateBadgeMarkdown(`Open issues`, totalOpenIssues, msgColor, lblColor)
    ];

    const commitBadges = [
      generateBadgeMarkdown(`Lines added (last ${daysCount} days)`, totalAdditions, 'green', lblColor),
      generateBadgeMarkdown(`Lines deleted (last ${daysCount} days)`, totalDeletions, 'red', lblColor),
      generateBadgeMarkdown(`Commits in last ${daysCount} days`, totalCommits, msgColor, lblColor)
    ];

    const contributorBadges = [
      generateBadgeMarkdown(`Contributors (unique)`, totalContributorsExact, msgColor, lblColor),
      generateBadgeMarkdown(`Active contributors (last ${daysCount}d)`, totalActiveContributorsExact, msgColor, lblColor)
    ];

    const badges = [
      prBadges.join(' '),
      issueBadges.join(' '),
      commitBadges.join(' '),
      contributorBadges.join(' ')
    ];

    // Diagnostics
    core.info(`Repository: ${repository}`);
    core.info(`PRs opened in last ${daysCount} days: ${totalPRsCreated}`);
    core.info(`PRs closed in last ${daysCount} days: ${totalPRsClosed}`);
    core.info(`Open PRs: ${totalOpenPRs}`);
    core.info(`Issues opened in last ${daysCount} days: ${totalIssuesOpened}`);
    core.info(`Issues closed in last ${daysCount} days: ${totalIssuesClosed}`);
    core.info(`Open Issues: ${totalOpenIssues}`);
    core.info(`Contributors (unique): ${totalContributorsExact}`);
    core.info(`Active contributors (last ${daysCount}d): ${totalActiveContributorsExact}`);
    core.info(`Total commits in last ${daysCount} days: ${totalCommits}`);
    core.info(`Total lines added in last ${daysCount} days: ${totalAdditions}`);
    core.info(`Total lines deleted in last ${daysCount} days: ${totalDeletions}`);

    return badges;
  } catch (error) {
    core.error(error.stack);
    process.exit(1);
  }
};

/* -------------------------
   CLI entry (run when executed)
   ------------------------- */

export async function runAction(config) {
  const cfg = config || initializeConfig();
  const badges = await generateBadges(
    cfg.username,
    cfg.token,
    cfg.days,
    cfg.graphqlClient,
    cfg.color,
    cfg.labelColor,
    cfg.graphqlUrl,
    cfg.delayMs
  );
  core.info('');
  const badgesMarkdown = badges.join('\n');
  core.info(`Badge markdown: ${badgesMarkdown}`);
  core.setOutput('badges', badgesMarkdown);
  return badges;
}

if (process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      await runAction();
    } catch (error) {
      core.error(`Failed to generate badges: ${error.message}`);
      core.error(error.stack);
      process.exit(1);
    }
  })();
}
