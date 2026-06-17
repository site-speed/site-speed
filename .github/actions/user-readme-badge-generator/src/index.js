/* eslint-disable no-await-in-loop */
import * as core from '@actions/core';
import { graphql } from '@octokit/graphql';

// Defaults
const DEFAULT_DAYS = 30;
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';
const DEFAULT_COLOR = 'blue';
const DEFAULT_LABEL_COLOR = '555';
const DEFAULT_BATCH_SIZE = 5;
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

  // behavior tuning inputs
  const excludeForks = core.getInput('exclude_forks') !== 'false'; // default true
  const batchSize = Number(core.getInput('batch_size') || DEFAULT_BATCH_SIZE);
  const delayMs = Number(core.getInput('delay_ms') || DEFAULT_DELAY_MS);
  const maxCommitFallback = Number(core.getInput('max_commit_fallback') || 1000); // absolute cap per repo
  const commitFallbackThreshold = Number(core.getInput('commit_fallback_threshold') || 50); // per-repo commits <= this allow fallback

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
    excludeForks,
    batchSize,
    delayMs,
    maxCommitFallback,
    commitFallbackThreshold
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
   GraphQL search helper
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
   Repository helpers
   ------------------------- */

export const getUserData = async (username, graphqlClient) => {
  try {
    const { user } = await graphqlClient(
      `query ($login: String!) {
         user(login: $login) {
           repositories(first:1) { totalCount }
         }
       }`,
      { login: username }
    );
    if (!user) throw new Error(`Could not find a user with login: ${username}`);
    return user;
  } catch (err) {
    throw new Error(`User lookup failed for '${username}': ${err.message}`);
  }
};

export const getRepositories = async (username, graphqlClient, excludeForks = true) => {
  let endCursor = null;
  let hasNextPage = true;
  const repositories = [];

  while (hasNextPage) {
    const response = await withBackoff(() =>
      graphqlClient(
        `query ($login: String!, $after: String) {
           repositoryOwner(login: $login) {
             repositories(first: 100, after: $after, affiliations: [OWNER]) {
               nodes { 
                 nameWithOwner 
                 isFork
                 issues(states: OPEN) { totalCount }
                 pullRequests(states: OPEN) { totalCount }
               }
               pageInfo { endCursor hasNextPage }
             }
           }
         }`,
        { login: username, after: endCursor }
      )
    );
    if (!response || !response.repositoryOwner || !response.repositoryOwner.repositories) {
      throw new Error(`Failed to fetch repositories for owner '${username}'`);
    }
    const repoNodes = response.repositoryOwner.repositories.nodes || [];
    for (const r of repoNodes) {
      if (excludeForks && r.isFork) continue;
      repositories.push({
        nameWithOwner: r.nameWithOwner,
        openIssues: r.issues?.totalCount || 0,
        openPRs: r.pullRequests?.totalCount || 0
      });
    }
    hasNextPage = response.repositoryOwner.repositories.pageInfo.hasNextPage;
    endCursor = response.repositoryOwner.repositories.pageInfo.endCursor;
  }
  // Sort alphabetically by nameWithOwner
  repositories.sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner));
  return repositories;
};

/* -------------------------
   Contributors helpers (exact)
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
  batchSize = DEFAULT_BATCH_SIZE,
  delayMs = DEFAULT_DELAY_MS,
  excludeForks = true,
  maxCommitFallback = 1000,
  commitFallbackThreshold = 50
) => {
  const msgColor = badgeColor || DEFAULT_COLOR;
  const lblColor = badgeLabelColor || DEFAULT_LABEL_COLOR;
  const daysCount = numDays || DEFAULT_DAYS;
  let client = graphqlClient;
  if (!client && tokenParam) client = createGraphqlClient(tokenParam, graphqlUrl);

  try {
    // Diagnostic viewer
    try {
      const viewerResp = await client(`query { viewer { login } }`);
      core.info(`GraphQL viewer login: ${viewerResp?.viewer?.login || '(no viewer)'}`);
    } catch (e) {
      core.error(`Viewer query failed: ${e.message}`);
    }

    // Ensure username resolvable
    try {
      const userResp = await client(
        `query ($login: String!) { user(login: $login) { repositories(first:1) { totalCount } } }`,
        { login: username }
      );
      const userRepoCount = userResp?.user?.repositories?.totalCount ?? null;
      core.info(`User lookup for ${username}: repoCount=${userRepoCount}`);
      if (userRepoCount === null) {
        core.error(`Unable to resolve '${username}' as a user or token lacks permission.`);
        throw new Error(`Insufficient token scope or installation to list '${username}' repositories — aborting.`);
      }
    } catch (e) {
      core.error(`User lookup failed: ${e.message}`);
      throw e;
    }

    // Repositories (sorted)
    const repoNodes = await getRepositories(username, client, excludeForks);
    const repoCount = repoNodes.length;
    core.info(`Fetched ${repoCount} repositories (excludeForks=${excludeForks}).`);

    // date window
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysCount);
    const filterDate = date.toISOString();
    core.debug(`Filtering metrics for last ${daysCount} days since ${filterDate}`);
    const dateOnly = filterDate.split('T')[0];

    const repoMetrics = [];
    const uniqueAllTimeContributors = new Set();
    const uniqueActiveContributors = new Set();

    core.info(`Processing ${repoCount} repositories in alphabetical order...`);

    for (const node of repoNodes) {
      const repoFullName = node.nameWithOwner;
      const [owner, name] = repoFullName.split('/');
      core.info(`[${repoFullName}] Gathering metrics...`);

      const metrics = {
        name: repoFullName,
        openIssues: node.openIssues,
        openPRs: node.openPRs,
        prsCreated: 0,
        prsMerged: 0,
        issuesOpened: 0,
        issuesClosed: 0,
        commits: 0,
        additions: 0,
        deletions: 0,
        activeContribs: 0,
        allTimeContribs: 0
      };

      try {
        // --- Issue / PR windowed counts (REST Search) ---
        metrics.prsCreated = await getSearchCount(null, `repo:${repoFullName} is:pr created:>=${dateOnly}`, tokenParam);
        metrics.prsMerged = await getSearchCount(null, `repo:${repoFullName} is:pr is:merged merged:>=${dateOnly}`, tokenParam);
        metrics.issuesOpened = await getSearchCount(null, `repo:${repoFullName} is:issue created:>=${dateOnly}`, tokenParam);
        metrics.issuesClosed = await getSearchCount(null, `repo:${repoFullName} is:issue closed:>=${dateOnly}`, tokenParam);

        // --- Commit stats & Active Contributors (GraphQL) ---
        const gqlRes = await withBackoff(() =>
          client(
            `query ($owner: String!, $name: String!, $since: GitTimestamp!) {
               repository(owner: $owner, name: $name) {
                 defaultBranchRef {
                   target {
                     ... on Commit {
                       history(since: $since, first: 100) {
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
            { owner, name, since: filterDate }
          )
        );

        const history = gqlRes?.repository?.defaultBranchRef?.target?.history;
        if (history) {
          metrics.commits = history.totalCount || 0;
          const activeRepoUsers = new Set();
          for (const c of history.nodes || []) {
            metrics.additions += c.additions || 0;
            metrics.deletions += c.deletions || 0;
            const login = c.author?.user?.login || c.author?.email;
            if (login) {
              activeRepoUsers.add(login);
              uniqueActiveContributors.add(login);
            }
          }
          metrics.activeContribs = activeRepoUsers.size;
        }

        // --- All-time contributors (REST) ---
        const contribs = await getContributorsListForRepo(tokenParam, owner, name, 100);
        metrics.allTimeContribs = contribs.length;
        for (const c of contribs) uniqueAllTimeContributors.add(c);

      } catch (err) {
        core.error(`Failed to process ${repoFullName}: ${err.message}`);
      }

      repoMetrics.push(metrics);
      core.info(`[${repoFullName}] Done. (Commits: ${metrics.commits}, Issues: +${metrics.issuesOpened}/-${metrics.issuesClosed}, PRs: +${metrics.prsCreated}/-${metrics.prsMerged})`);
      await sleep(delayMs || DEFAULT_DELAY_MS);
    }

    // Print Summary Table
    core.info('\n' + '='.repeat(80));
    core.info('PER-REPOSITORY METRICS SUMMARY');
    core.info('='.repeat(80));
    const header = `${'Repository'.padEnd(30)} | ${'Commits'.padStart(7)} | ${'Issues (O/C)'.padStart(12)} | ${'PRs (C/M)'.padStart(10)} | ${'Lines (+/-)'.padStart(15)}`;
    core.info(header);
    core.info('-'.repeat(80));
    for (const m of repoMetrics) {
      const line = `${m.name.substring(0, 30).padEnd(30)} | ${String(m.commits).padStart(7)} | ${String(m.issuesOpened + '/' + m.issuesClosed).padStart(12)} | ${String(m.prsCreated + '/' + m.prsMerged).padStart(10)} | ${String('+' + m.additions + '/-' + m.deletions).padStart(15)}`;
      core.info(line);
    }
    core.info('='.repeat(80) + '\n');

    // Calculate totals
    const totalPRsCreated = repoMetrics.reduce((s, m) => s + m.prsCreated, 0);
    const totalPRsMerged = repoMetrics.reduce((s, m) => s + m.prsMerged, 0);
    const totalOpenPRs = repoMetrics.reduce((s, m) => s + m.openPRs, 0);
    const totalIssuesOpened = repoMetrics.reduce((s, m) => s + m.issuesOpened, 0);
    const totalIssuesClosed = repoMetrics.reduce((s, m) => s + m.issuesClosed, 0);
    const totalOpenIssues = repoMetrics.reduce((s, m) => s + m.openIssues, 0);
    const totalContributorsExact = uniqueAllTimeContributors.size;
    const totalActiveContributorsExact = uniqueActiveContributors.size;
    const totalCommits = repoMetrics.reduce((s, m) => s + m.commits, 0);
    const totalAdditions = repoMetrics.reduce((s, m) => s + m.additions, 0);
    const totalDeletions = repoMetrics.reduce((s, m) => s + m.deletions, 0);

    // Diagnostics
    core.info(`My repositories: ${repoCount}`);
    core.info(`Total PRs created in last ${daysCount} days: ${totalPRsCreated}`);
    core.info(`Total PRs merged in last ${daysCount} days: ${totalPRsMerged}`);
    core.info(`Total Open PRs: ${totalOpenPRs}`);
    core.info(`Total Issues opened in last ${daysCount} days: ${totalIssuesOpened}`);
    core.info(`Total Issues closed in last ${daysCount} days: ${totalIssuesClosed}`);
    core.info(`Total Open Issues: ${totalOpenIssues}`);
    core.info(`Contributors (unique across repos): total=${totalContributorsExact}`);
    core.info(`Active contributors (unique across repos, last ${daysCount}d): ${totalActiveContributorsExact}`);
    core.info(`Total commits in last ${daysCount} days: ${totalCommits}`);
    core.info(`Total lines added in last ${daysCount} days: ${totalAdditions}`);
    core.info(`Total lines deleted in last ${daysCount} days: ${totalDeletions}`);

    // Build badges in requested order
    const badges = [
      generateBadgeMarkdown(`My Repositories`, repoCount, msgColor, lblColor),
      generateBadgeMarkdown(`PRs created in last ${daysCount} days`, totalPRsCreated, msgColor, lblColor),
      generateBadgeMarkdown(`Merged PRs in last ${daysCount} days`, totalPRsMerged, msgColor, lblColor),
      generateBadgeMarkdown(`Open PRs`, totalOpenPRs, msgColor, lblColor),
      generateBadgeMarkdown(`Issues opened in last ${daysCount} days`, totalIssuesOpened, msgColor, lblColor),
      generateBadgeMarkdown(`Issues closed in last ${daysCount} days`, totalIssuesClosed, msgColor, lblColor),
      generateBadgeMarkdown(`Open issues`, totalOpenIssues, msgColor, lblColor),
      generateBadgeMarkdown(`Contributors (unique)`, totalContributorsExact, msgColor, lblColor),
      generateBadgeMarkdown(`Active contributors (last ${daysCount}d)`, totalActiveContributorsExact, msgColor, lblColor),
      generateBadgeMarkdown(`Commits in last ${daysCount} days`, totalCommits, msgColor, lblColor),
      generateBadgeMarkdown(`Lines added (last ${daysCount} days)`, totalAdditions, msgColor, lblColor),
      generateBadgeMarkdown(`Lines deleted (last ${daysCount} days)`, totalDeletions, msgColor, lblColor)
    ];

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
    cfg.batchSize,
    cfg.delayMs,
    cfg.excludeForks,
    cfg.maxCommitFallback,
    cfg.commitFallbackThreshold
  );
  core.info('');
  const badgesMarkdown = badges.join(' ');
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
