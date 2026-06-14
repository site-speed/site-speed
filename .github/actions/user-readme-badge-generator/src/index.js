import * as core from '@actions/core';
import { graphql } from '@octokit/graphql';

// Default values
const DEFAULT_DAYS = 30;
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';
const DEFAULT_COLOR = 'blue';
const DEFAULT_LABEL_COLOR = '555';

// Tuning: batch size and delay between batches to respect rate limits
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_DELAY_MS = 1000; // 1s between batches

// Exported function for validating required inputs
export function validateRequiredInput(input, label) {
  if (!input) {
    throw new Error(`${label} is required`);
  }
  return input;
}

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Basic exponential backoff wrapper for async functions
 */
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

/**
 * Creates a GraphQL client with authentication
 * @param {string} authToken - The authentication token
 * @param {string} [baseUrl] - Optional custom GraphQL URL
 * @returns {function} The configured GraphQL client
 */
export function createGraphqlClient(authToken, baseUrl = DEFAULT_GRAPHQL_URL) {
  let client = graphql.defaults({
    headers: {
      authorization: `bearer ${authToken}`
    }
  });

  // Set baseUrl if a custom GraphQL URL is provided
  if (baseUrl && baseUrl !== DEFAULT_GRAPHQL_URL) {
    client = client.defaults({
      baseUrl: baseUrl
    });
  }

  return client;
}

/**
 * Initializes configuration from GitHub Actions inputs
 */
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
    batchSize: Number(core.getInput('batch_size') || DEFAULT_BATCH_SIZE),
    delayMs: Number(core.getInput('delay_ms') || DEFAULT_DELAY_MS)
  };
}

/**
 * Main execution function that generates badges and sets outputs
 */
export async function run(config) {
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
    cfg.delayMs
  );

  core.info('');
  const badgesMarkdown = badges.join(' ');
  core.info(`Badge markdown: ${badgesMarkdown}`);
  core.setOutput('badges', badgesMarkdown);

  return badges;
}

/**
 * Simple badge generator (shields.io)
 */
export const generateBadgeMarkdown = (text, number, badgeColor, badgeLabelColor) => {
  const encodedLabel = encodeURIComponent(text);
  const encodedMessage = encodeURIComponent(number);
  const encodedColor = encodeURIComponent(badgeColor);
  const encodedLabelColor = encodeURIComponent(badgeLabelColor);

  const badgeUrl = `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${encodedColor}?labelColor=${encodedLabelColor}`;
  return `![${text}](${badgeUrl})`;
};

/* -------------------------
   GraphQL search helpers
   ------------------------- */

/**
 * Generic GraphQL search for issues/PRs (returns issueCount)
 * Uses type ISSUE so it counts both issues and PRs where applicable.
 */
export const getSearchCount = async (client, query) => {
  try {
    const res = await withBackoff(() =>
      client(
        `query ($q: String!) {
           search(query: $q, type: ISSUE, first: 1) {
             issueCount
           }
         }`,
        { q: query }
      )
    );
    return res?.search?.issueCount || 0;
  } catch (err) {
    core.error(`Search query failed for q="${query}": ${err.message}`);
    return 0;
  }
};

/* -------------------------
   REST helpers (fetch)
   ------------------------- */

/**
 * REST fetch wrapper using global fetch (Node 18+ / 24)
 */
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
   Repository helpers (user-only)
   ------------------------- */

export const getUserData = async (username, graphqlClient) => {
  try {
    const { user } = await graphqlClient(
      `
      query ($login: String!) {
        user(login: $login) {
          repositories(first: 1) {
            totalCount
          }
        }
      }`,
      { login: username }
    );

    if (!user) {
      throw new Error(`Could not find a user with login: ${username}`);
    }
    return user;
  } catch (err) {
    throw new Error(`User lookup failed for '${username}': ${err.message}`);
  }
};

export const getRepositories = async (username, graphqlClient) => {
  let endCursor = null;
  let hasNextPage = true;
  const repositories = [];

  while (hasNextPage) {
    const response = await withBackoff(() =>
      graphqlClient(
        `
        query ($login: String!, $after: String) {
          user(login: $login) {
            repositories(first: 100, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
              nodes { name }
              pageInfo { endCursor hasNextPage }
            }
          }
        }`,
        { login: username, after: endCursor }
      )
    );

    if (!response || !response.user || !response.user.repositories) {
      throw new Error(`Failed to fetch repositories for user '${username}'`);
    }

    const repoNodes = response.user.repositories.nodes || [];
    repositories.push(...repoNodes.map((r) => r.name));

    hasNextPage = response.user.repositories.pageInfo.hasNextPage;
    endCursor = response.user.repositories.pageInfo.endCursor;
  }

  return repositories;
};

/* -------------------------
   New metrics implementations
   ------------------------- */

/**
 * Open PRs (current open PR count) across a repo
 */
export const getOpenPRsForRepo = async (client, owner, repo) => {
  const q = `repo:${owner}/${repo} is:pr is:open`;
  return getSearchCount(client, q);
};

/**
 * Issues opened in last N days
 */
export const getIssuesOpenedForRepo = async (client, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = `repo:${owner}/${repo} is:issue created:>=${dateOnly}`;
  return getSearchCount(client, q);
};

/**
 * Issues closed in last N days
 */
export const getIssuesClosedForRepo = async (client, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = `repo:${owner}/${repo} is:issue closed:>=${dateOnly}`;
  return getSearchCount(client, q);
};

/**
 * Open issues (current)
 */
export const getOpenIssuesForRepo = async (client, owner, repo) => {
  const q = `repo:${owner}/${repo} is:issue is:open`;
  return getSearchCount(client, q);
};

/**
 * Contributors total (REST) - paginates /repos/{owner}/{repo}/contributors
 * Note: requires repo read permission. This returns unique contributor count.
 */
export const getContributorsTotalForRepo = async (token, owner, repo, perPage = 100) => {
  let page = 1;
  let total = 0;
  const seen = new Set();

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=${perPage}&page=${page}&anon=true`;
    try {
      const { json, response } = await withBackoff(() => restFetch(url, token));
      if (!Array.isArray(json) || json.length === 0) break;
      for (const c of json) {
        // use login if available else fallback to name/email
        const id = c.login || `${c.name || ''}-${c.email || ''}`;
        seen.add(id);
      }
      // check Link header for 'next'
      const link = response.headers.get('link') || '';
      if (!link.includes('rel="next"')) break;
      page++;
      // small delay to avoid hammering
      await sleep(200);
    } catch (err) {
      core.error(`Failed to fetch contributors for ${owner}/${repo}: ${err.message}`);
      break;
    }
  }
  return seen.size;
};

/**
 * Active contributors in last N days - approximate using commit search (REST) and collecting unique authors
 * To limit cost we cap the pages fetched.
 */
export const getContributorsActiveForRepo = async (token, owner, repo, sinceIso, maxPages = 10) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = encodeURIComponent(`repo:${owner}/${repo} author-date:>=${dateOnly}`);
  const baseUrl = `https://api.github.com/search/commits?q=${q}&per_page=100`;
  const headers = { Accept: 'application/vnd.github.cloak-preview' }; // commit search preview
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}&page=${page}`;
    try {
      const { json } = await withBackoff(() =>
        restFetch(url, token, { accept: 'application/vnd.github.cloak-preview' })
      );
      const items = json.items || [];
      for (const item of items) {
        // item.author can be null for unknown authors; fallback to commit author email / name
        const authorLogin = item.author?.login;
        if (authorLogin) {
          seen.add(authorLogin);
        } else {
          const email = item.commit?.author?.email || item.commit?.committer?.email;
          if (email) seen.add(email);
        }
      }
      if (!json.items || json.items.length === 0) break;
      // if total_count is small and we've seen them all, break early
      const totalCount = json.total_count || 0;
      if (seen.size >= totalCount) break;
      // small delay between pages
      await sleep(300);
    } catch (err) {
      core.error(`Commit search failed for ${owner}/${repo} page ${page}: ${err.message}`);
      break;
    }
  }
  return seen.size;
};

/**
 * Commits in last N days (REST search commits)
 */
export const getCommitsCountForRepo = async (token, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = encodeURIComponent(`repo:${owner}/${repo} committer-date:>=${dateOnly}`);
  const url = `https://api.github.com/search/commits?q=${q}&per_page=1`;
  try {
    const { json } = await withBackoff(() =>
      restFetch(url, token, { accept: 'application/vnd.github.cloak-preview' })
    );
    return json.total_count || 0;
  } catch (err) {
    core.error(`Commit count search failed for ${owner}/${repo}: ${err.message}`);
    return 0;
  }
};

/**
 * Lines added / deleted (code_frequency) - returns { additions, deletions }
 * Uses REST /repos/{owner}/{repo}/stats/code_frequency
 * Note: may return 202 while GitHub computes - we retry with backoff.
 */
export const getCodeFrequencyForRepo = async (token, owner, repo, daysWindow = 30) => {
  const url = `https://api.github.com/repos/${owner}/${repo}/stats/code_frequency`;
  try {
    // code_frequency returns weekly arrays [weekUnix, additions, deletions]
    const { json, response } = await withBackoff(() => restFetch(url, token));
    // if GitHub returns 202 it would have been caught above as non-ok; restFetch throws for non-ok.
    if (!Array.isArray(json)) {
      core.debug(`Unexpected code_frequency response for ${owner}/${repo}: ${JSON.stringify(json)}`);
      return { additions: 0, deletions: 0 };
    }

    // Sum the weeks that fall into the last daysWindow
    const cutoff = Date.now() - daysWindow * 24 * 60 * 60 * 1000;
    let additions = 0;
    let deletions = 0;
    for (const weekRow of json) {
      const weekUnix = weekRow[0] * 1000;
      const add = weekRow[1] || 0;
      const del = Math.abs(weekRow[2] || 0);
      if (weekUnix >= cutoff) {
        additions += add;
        deletions += del;
      }
    }
    return { additions, deletions };
  } catch (err) {
    core.error(`Code frequency failed for ${owner}/${repo}: ${err.message}`);
    return { additions: 0, deletions: 0 };
  }
};

/* -------------------------
   Batch processing utilities
   ------------------------- */

/**
 * Processes per-repo metric function in batches with delays to respect rate limits
 * metricFn is async (owner, repo) => number or object
 */
const processReposInBatches = async (repos, owner, token, client, metricFn, batchSize = DEFAULT_BATCH_SIZE, delayMs = DEFAULT_DELAY_MS) => {
  const results = {};
  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);
    core.debug(`Processing batch ${i / batchSize + 1} (${batch.length} repos)`);
    const promises = batch.map((r) => metricFn(owner, r, token, client));
    const resolved = await Promise.all(promises);
    for (let j = 0; j < batch.length; j++) {
      results[batch[j]] = resolved[j];
    }
    if (i + batchSize < repos.length) {
      core.debug(`Sleeping ${delayMs}ms before next batch`);
      await sleep(delayMs);
    }
  }
  return results;
};

/* -------------------------
   Metric adapter wrappers for processReposInBatches
   Each adapter returns a number or an object depending on metric
   ------------------------- */

const adapterOpenPRs = async (owner, repo, token, client) => {
  return getOpenPRsForRepo(client, owner, repo);
};

const adapterIssuesOpened = async (owner, repo, token, client, sinceIso) => {
  return getIssuesOpenedForRepo(client, owner, repo, sinceIso);
};

const adapterIssuesClosed = async (owner, repo, token, client, sinceIso) => {
  return getIssuesClosedForRepo(client, owner, repo, sinceIso);
};

const adapterOpenIssues = async (owner, repo, token, client) => {
  return getOpenIssuesForRepo(client, owner, repo);
};

const adapterContributorsTotals = async (owner, repo, token) => {
  return getContributorsTotalForRepo(token, owner, repo);
};

const adapterContributorsActive = async (owner, repo, token, client, sinceIso) => {
  return getContributorsActiveForRepo(token, owner, repo, sinceIso);
};

const adapterCommits = async (owner, repo, token, client, sinceIso) => {
  return getCommitsCountForRepo(token, owner, repo, sinceIso);
};

const adapterCodeFreq = async (owner, repo, token, client, sinceIso) => {
  return getCodeFrequencyForRepo(token, owner, repo, Math.ceil((Date.now() - new Date(sinceIso)) / (7 * 24 * 60 * 60 * 1000)));
};

/* -------------------------
   Main badge generation orchestration
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
  delayMs = DEFAULT_DELAY_MS
) => {
  const msgColor = badgeColor || DEFAULT_COLOR;
  const lblColor = badgeLabelColor || DEFAULT_LABEL_COLOR;
  const daysCount = numDays || DEFAULT_DAYS;
  let client = graphqlClient;
  if (!client && tokenParam) {
    client = createGraphqlClient(tokenParam, graphqlUrl);
  }

  try {
    // Diagnostic: who does the token represent?
    try {
      const viewerResp = await client(`query { viewer { login } }`);
      core.info(`GraphQL viewer login: ${viewerResp?.viewer?.login || '(no viewer)'}`);
    } catch (e) {
      core.error(`Viewer query failed: ${e.message}`);
    }

    // Ensure the target username resolves as a user and is accessible
    try {
      const userResp = await client(
        `query ($login: String!) {
           user(login: $login) { repositories(first:1) { totalCount } }
         }`,
        { login: username }
      );
      const userRepoCount = userResp?.user?.repositories?.totalCount ?? null;
      core.info(`User lookup for ${username}: repoCount=${userRepoCount}`);
      if (userRepoCount === null) {
        core.error(`Unable to resolve '${username}' as a user or token lacks permission.`);
        core.error('Provide a token that can read the user repositories (PAT or properly-installed app).');
        throw new Error(`Insufficient token scope or installation to list '${username}' repositories — aborting.`);
      }
    } catch (e) {
      core.error(`User lookup failed: ${e.message}`);
      throw e;
    }

    // repo list
    const repos = await getRepositories(username, client);
    core.info(`Fetched ${repos.length} repositories: ${repos.slice(0, 20).join(', ')}`);
    const repoCount = repos.length;
    core.info(`Total repositories: ${repoCount}`);

    // date window
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysCount);
    const prFilterDate = date.toISOString();
    core.debug(`Filtering metrics for last ${daysCount} days since ${prFilterDate}`);

    // 1) Open PRs (aggregate)
    const openPRsPerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterOpenPRs(owner, repo, tokenParam, client);
    }, batchSize, delayMs);

    const totalOpenPRs = Object.values(openPRsPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 2) Issues opened (last N days)
    const issuesOpenedPerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterIssuesOpened(owner, repo, tokenParam, client, prFilterDate);
    }, batchSize, delayMs);
    const totalIssuesOpened = Object.values(issuesOpenedPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 3) Issues closed (last N days)
    const issuesClosedPerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterIssuesClosed(owner, repo, tokenParam, client, prFilterDate);
    }, batchSize, delayMs);
    const totalIssuesClosed = Object.values(issuesClosedPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 4) Open Issues (current)
    const openIssuesPerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterOpenIssues(owner, repo, tokenParam, client);
    }, batchSize, delayMs);
    const totalOpenIssues = Object.values(openIssuesPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 5) Contributors (total and active in last N days)
    const contributorsTotalPerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterContributorsTotals(owner, repo, tokenParam);
    }, batchSize, delayMs);

    const contributorsActivePerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterContributorsActive(owner, repo, tokenParam, client, prFilterDate);
    }, batchSize, delayMs);

    const totalContributorsSet = new Set();
    const totalActiveContributorsSet = new Set();
    // contributorsTotalPerRepo gives counts per repo; for aggregate unique contributors you'd need to fetch and dedupe per-repo contributor lists.
    // Here we approximate aggregate totals by summing per-repo unique contributor counts (may double-count across repos).
    let totalContributorsApprox = 0;
    for (const v of Object.values(contributorsTotalPerRepo)) {
      totalContributorsApprox += Number(v || 0);
    }
    let totalActiveContributorsApprox = 0;
    for (const v of Object.values(contributorsActivePerRepo)) {
      totalActiveContributorsApprox += Number(v || 0);
    }

    // 6) Commits in last N days
    const commitsPerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterCommits(owner, repo, tokenParam, client, prFilterDate);
    }, batchSize, delayMs);
    const totalCommits = Object.values(commitsPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 7 & 8) Lines added & deleted in last N days (aggregate)
    const codeFreqPerRepo = await processReposInBatches(repos, username, tokenParam, client, async (owner, repo) => {
      return adapterCodeFreq(owner, repo, tokenParam, client, prFilterDate);
    }, batchSize, delayMs);

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const val of Object.values(codeFreqPerRepo)) {
      if (!val) continue;
      totalAdditions += Number(val.additions || 0);
      totalDeletions += Number(val.deletions || 0);
    }

    // Log some per-repo diagnostics for visibility
    core.info(`Total Open PRs: ${totalOpenPRs}`);
    core.info(`Total Issues opened in last ${daysCount} days: ${totalIssuesOpened}`);
    core.info(`Total Issues closed in last ${daysCount} days: ${totalIssuesClosed}`);
    core.info(`Total Open Issues: ${totalOpenIssues}`);
    core.info(`Contributors (approx sum per-repo): total=${totalContributorsApprox}, active(last ${daysCount}d)=${totalActiveContributorsApprox}`);
    core.info(`Total commits in last ${daysCount} days: ${totalCommits}`);
    core.info(`Total lines added in last ${daysCount} days (approx): ${totalAdditions}`);
    core.info(`Total lines deleted in last ${daysCount} days (approx): ${totalDeletions}`);

    // Build badges in requested order:
    const badges = [
      generateBadgeMarkdown(`Open PRs`, totalOpenPRs, msgColor, lblColor),
      generateBadgeMarkdown(`Issues opened in last ${daysCount} days`, totalIssuesOpened, msgColor, lblColor),
      generateBadgeMarkdown(`Issues closed in last ${daysCount} days`, totalIssuesClosed, msgColor, lblColor),
      generateBadgeMarkdown(`Open issues`, totalOpenIssues, msgColor, lblColor),
      generateBadgeMarkdown(`Contributors (approx total)`, totalContributorsApprox, msgColor, lblColor),
      generateBadgeMarkdown(`Active contributors (last ${daysCount}d)`, totalActiveContributorsApprox, msgColor, lblColor),
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

// Only run when executed directly (not when imported for tests)
if (process.env.NODE_ENV !== 'test') {
  (async () => {
    try {
      await run();
    } catch (error) {
      core.error(`Failed to generate badges: ${error.message}`);
      core.error(error.stack);
      process.exit(1);
    }
  })();
}
