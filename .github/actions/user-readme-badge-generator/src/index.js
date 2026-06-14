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
 */
export function createGraphqlClient(authToken, baseUrl = DEFAULT_GRAPHQL_URL) {
  let client = graphql.defaults({
    headers: {
      authorization: `bearer ${authToken}`
    }
  });

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

  // new input: exclude forks (default true). Set to 'false' explicitly to include forks.
  const excludeForks = core.getInput('exclude_forks') !== 'false';

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
    delayMs: Number(core.getInput('delay_ms') || DEFAULT_DELAY_MS),
    excludeForks
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
    cfg.delayMs,
    cfg.excludeForks
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

/**
 * Fetch repositories for a user and optionally exclude forks
 */
export const getRepositories = async (username, graphqlClient, excludeForks = true) => {
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
              nodes {
                name
                isFork
              }
              pageInfo {
                endCursor
                hasNextPage
              }
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
    const filtered = excludeForks ? repoNodes.filter((r) => !r.isFork) : repoNodes;
    repositories.push(...filtered.map((r) => r.name));

    hasNextPage = response.user.repositories.pageInfo.hasNextPage;
    endCursor = response.user.repositories.pageInfo.endCursor;
  }

  return repositories;
};

/* -------------------------
   New metrics implementations
   ------------------------- */

/* PRs (created / merged) using GraphQL search */
export const getPRsCreatedForRepo = async (client, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = `repo:${owner}/${repo} is:pr created:>=${dateOnly}`;
  return getSearchCount(client, q);
};

export const getPRsMergedForRepo = async (client, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = `repo:${owner}/${repo} is:pr is:merged merged:>=${dateOnly}`;
  return getSearchCount(client, q);
};

export const getOpenPRsForRepo = async (client, owner, repo) => {
  const q = `repo:${owner}/${repo} is:pr is:open`;
  return getSearchCount(client, q);
};

/* Issues (opened/closed) */
export const getIssuesOpenedForRepo = async (client, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = `repo:${owner}/${repo} is:issue created:>=${dateOnly}`;
  return getSearchCount(client, q);
};

export const getIssuesClosedForRepo = async (client, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = `repo:${owner}/${repo} is:issue closed:>=${dateOnly}`;
  return getSearchCount(client, q);
};

export const getOpenIssuesForRepo = async (client, owner, repo) => {
  const q = `repo:${owner}/${repo} is:issue is:open`;
  return getSearchCount(client, q);
};

/* Contributors: exact unique contributors across all repos */

/**
 * Fetch contributors list for a single repo (returns array of identifiers)
 * Uses /repos/{owner}/{repo}/contributors?anon=true
 * Each contributor: use login if present, otherwise fallback to name/email id
 */
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
      // small delay between pages
      await sleep(200);
    }
  } catch (err) {
    core.error(`Failed to fetch contributors list for ${owner}/${repo}: ${err.message}`);
  }
  return contributors;
};

/**
 * Active contributors for a repo (returns array of identifiers) using commit search
 * This returns author logins/emails from commit search (pages limited)
 */
export const getContributorsActiveListForRepo = async (token, owner, repo, sinceIso, maxPages = 10) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = encodeURIComponent(`repo:${owner}/${repo} author-date:>=${dateOnly}`);
  const baseUrl = `https://api.github.com/search/commits?q=${q}&per_page=100`;
  const list = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}&page=${page}`;
    try {
      const { json } = await withBackoff(() => restFetch(url, token, { accept: 'application/vnd.github.cloak-preview' }));
      const items = json.items || [];
      for (const item of items) {
        const authorLogin = item.author?.login;
        if (authorLogin) {
          if (!seen.has(authorLogin)) {
            seen.add(authorLogin);
            list.push(authorLogin);
          }
        } else {
          const email = item.commit?.author?.email || item.commit?.committer?.email;
          if (email && !seen.has(email)) {
            seen.add(email);
            list.push(email);
          }
        }
      }
      if (!json.items || json.items.length === 0) break;
      const totalCount = json.total_count || 0;
      if (seen.size >= totalCount) break;
      await sleep(300);
    } catch (err) {
      core.error(`Commit search failed for ${owner}/${repo} page ${page}: ${err.message}`);
      break;
    }
  }
  return list;
};

/* Commits (count) using commit search (REST) */
export const getCommitsCountForRepo = async (token, owner, repo, sinceIso) => {
  const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
  const q = encodeURIComponent(`repo:${owner}/${repo} committer-date:>=${dateOnly}`);
  const url = `https://api.github.com/search/commits?q=${q}&per_page=1`;
  try {
    const { json } = await withBackoff(() => restFetch(url, token, { accept: 'application/vnd.github.cloak-preview' }));
    return json.total_count || 0;
  } catch (err) {
    core.error(`Commit count search failed for ${owner}/${repo}: ${err.message}`);
    return 0;
  }
};

// Fallback commit-by-commit aggregation (accurate but heavier)
// Limits processed commits to avoid runaway API usage (tune maxCommits if needed)
export const getCodeStatsFromCommits = async (token, owner, repo, daysWindow = 30, maxCommits = 1000) => {
  const sinceIso = new Date(Date.now() - daysWindow * 24 * 60 * 60 * 1000).toISOString();
  const perPage = 100;
  let page = 1;
  let processed = 0;
  let additions = 0;
  let deletions = 0;

  core.info(`Falling back to per-commit aggregation for ${owner}/${repo} since ${sinceIso} (max ${maxCommits} commits)`);

  outer: while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?since=${encodeURIComponent(sinceIso)}&per_page=${perPage}&page=${page}`;
    let commitsPage;
    try {
      const { json } = await withBackoff(() => restFetch(url, token));
      commitsPage = json;
    } catch (err) {
      core.error(`Failed to list commits for ${owner}/${repo}: ${err.message}`);
      break;
    }

    if (!Array.isArray(commitsPage) || commitsPage.length === 0) break;

    for (const c of commitsPage) {
      if (processed >= maxCommits) {
        core.warn(`Reached maxCommits (${maxCommits}) for ${owner}/${repo}; stopping per-commit aggregation`);
        break outer;
      }
      const sha = c.sha;
      if (!sha) continue;
      try {
        const { json: commitData } = await withBackoff(() => restFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, token));
        const stats = commitData.stats || {};
        additions += Number(stats.additions || 0);
        deletions += Number(stats.deletions || 0);
      } catch (err) {
        core.debug(`Failed to fetch commit ${sha} for ${owner}/${repo}: ${err.message}`);
      }
      processed++;
      // small pause to reduce burst pressure
      await sleep(50);
    }

    if (commitsPage.length < perPage) break;
    page++;
  }

  core.info(`Per-commit aggregated ${processed} commits for ${owner}/${repo}: +${additions} / -${deletions}`);
  return { additions, deletions };
};

/**
 * Robust code_frequency with 202-handling and fallback to commit aggregation.
 * Replaces the previous getCodeFrequencyForRepo.
 */
export const getCodeFrequencyForRepo = async (token, owner, repo, daysWindow = 30) => {
  const url = `https://api.github.com/repos/${owner}/${repo}/stats/code_frequency`;
  const headers = {
    Authorization: `bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'site-speed-readme-badge-generator'
  };

  const maxAttempts = 6; // tune if needed
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { headers, method: 'GET' });
      // If GitHub is computing, it returns 202 Accepted: retry with exponential backoff
      if (res.status === 202) {
        const delay = Math.min(60000, 2000 * Math.pow(2, attempt - 1));
        core.debug(`code_frequency for ${owner}/${repo} returned 202 (computing). attempt=${attempt}, retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        core.error(`code_frequency HTTP ${res.status} ${res.statusText} for ${owner}/${repo}: ${text}`);
        // treat as no data
        return { additions: 0, deletions: 0 };
      }

      // Try to parse JSON
      const json = await res.json();
      // If not an array, return zeros
      if (!Array.isArray(json)) {
        core.debug(`code_frequency response not array for ${owner}/${repo}: ${JSON.stringify(json).slice(0, 500)}`);
        return { additions: 0, deletions: 0 };
      }

      // Sum weeks that are within the window
      const cutoff = Date.now() - daysWindow * 24 * 60 * 60 * 1000;
      let additions = 0;
      let deletions = 0;
      for (const weekRow of json) {
        const weekUnix = (weekRow[0] || 0) * 1000;
        const add = Number(weekRow[1] || 0);
        const del = Math.abs(Number(weekRow[2] || 0));
        if (weekUnix >= cutoff) {
          additions += add;
          deletions += del;
        }
      }
      core.debug(`code_frequency for ${owner}/${repo}: additions=${additions}, deletions=${deletions}`);
      return { additions, deletions };
    } catch (err) {
      core.debug(`code_frequency attempt ${attempt} failed for ${owner}/${repo}: ${err.message}`);
      // small jitter before next attempt
      await sleep(500 * attempt);
    }
  }

  // Still not available: fallback to per-commit aggregation
  core.info(`code_frequency unavailable after retries for ${owner}/${repo}; falling back to commit aggregation`);
  return getCodeStatsFromCommits(token, owner, repo, daysWindow, 1000);
};

/* -------------------------
   Batch processing utilities
   ------------------------- */

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
   Metric adapter wrappers
   ------------------------- */

const adapterPRsCreated = async (owner, repo, token, client, sinceIso) => {
  return getPRsCreatedForRepo(client, owner, repo, sinceIso);
};

const adapterPRsMerged = async (owner, repo, token, client, sinceIso) => {
  return getPRsMergedForRepo(client, owner, repo, sinceIso);
};

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

const adapterContributorsList = async (owner, repo, token) => {
  return getContributorsListForRepo(token, owner, repo);
};

const adapterContributorsActiveList = async (owner, repo, token, client, sinceIso) => {
  return getContributorsActiveListForRepo(token, owner, repo, sinceIso);
};

const adapterCommits = async (owner, repo, token, client, sinceIso) => {
  return getCommitsCountForRepo(token, owner, repo, sinceIso);
};

const adapterCodeFreq = async (owner, repo, token, client, sinceIso) => {
  const weeks = Math.ceil((Date.now() - new Date(sinceIso)) / (7 * 24 * 60 * 60 * 1000));
  return getCodeFrequencyForRepo(token, owner, repo, Math.max(1, weeks));
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
  delayMs = DEFAULT_DELAY_MS,
  excludeForks = true
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

    // repo list (respect excludeForks)
    const repos = await getRepositories(username, client, excludeForks);
    core.info(`Fetched ${repos.length} repositories (excludeForks=${excludeForks}): ${repos.slice(0, 20).join(', ')}`);
    const repoCount = repos.length;
    core.info(`My repositories: ${repoCount}`);

    // date window
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysCount);
    const filterDate = date.toISOString();
    core.debug(`Filtering metrics for last ${daysCount} days since ${filterDate}`);

    // --- ORIGINAL METRICS: My repos, PRs created, Merged PRs (first) ---

    // PRs created in last N days
    const prCreatedPerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterPRsCreated(owner, repo, tokenParam, client, filterDate),
      batchSize,
      delayMs
    );
    const totalPRsCreated = Object.values(prCreatedPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // PRs merged in last N days
    const prMergedPerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterPRsMerged(owner, repo, tokenParam, client, filterDate),
      batchSize,
      delayMs
    );
    const totalPRsMerged = Object.values(prMergedPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // --- OTHER METRICS ---

    // 1) Open PRs
    const openPRsPerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterOpenPRs(owner, repo, tokenParam, client),
      batchSize,
      delayMs
    );
    const totalOpenPRs = Object.values(openPRsPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 2) Issues opened (last N days)
    const issuesOpenedPerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterIssuesOpened(owner, repo, tokenParam, client, filterDate),
      batchSize,
      delayMs
    );
    const totalIssuesOpened = Object.values(issuesOpenedPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 3) Issues closed (last N days)
    const issuesClosedPerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterIssuesClosed(owner, repo, tokenParam, client, filterDate),
      batchSize,
      delayMs
    );
    const totalIssuesClosed = Object.values(issuesClosedPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 4) Open Issues (current)
    const openIssuesPerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterOpenIssues(owner, repo, tokenParam, client),
      batchSize,
      delayMs
    );
    const totalOpenIssues = Object.values(openIssuesPerRepo).reduce((s, v) => s + Number(v || 0), 0);

    // 5) Contributors (exact unique across repos)
    // Fetch per-repo contributor lists (array of identifiers) and dedupe across repos
    const contributorsListPerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterContributorsList(owner, repo, tokenParam),
      batchSize,
      delayMs
    );

    const uniqueContributors = new Set();
    for (const arr of Object.values(contributorsListPerRepo)) {
      if (!Array.isArray(arr)) continue;
      for (const id of arr) {
        if (id) uniqueContributors.add(id);
      }
    }
    const totalContributorsExact = uniqueContributors.size;

    // Active contributors: fetch per-repo active contributor lists (from commits) and dedupe across repos
    const contributorsActivePerRepo = await processReposInBatches(
      repos,
      username,
      tokenParam,
      client,
      async (owner, repo) => adapterContributorsActiveList(owner, repo, tokenParam, client, filterDate),
      batchSize,
      delayMs
    );

    const uniqueActive = new Set();
    for (const arr of Object.values(contributorsActivePerRepo)) {
      if (!Array.isArray(arr)) continue;
      for (const id of arr) {
        if (id) uniqueActive.add(id);
      }
    }
    const totalActiveContributorsExact = uniqueActive.size;

// CONFIG: max commits to allow per-commit fallback (tunable via input)
const MAX_COMMIT_FALLBACK = Number(core.getInput('max_commit_fallback') || 1000); // overall cap per-repo
const COMMIT_FALLBACK_THRESHOLD = Number(core.getInput('commit_fallback_threshold') || 50); // per-repo commits <= this will allow fallback

// --- 6) Commits in last N days (cheap search) ---
// compute commitsPerRepo first (so we can decide whether to run heavy fallback)
const commitsPerRepo = await processReposInBatches(
  repos,
  username,
  tokenParam,
  client,
  async (owner, repo) => adapterCommits(owner, repo, tokenParam, client, filterDate),
  batchSize,
  delayMs
);
const totalCommits = Object.values(commitsPerRepo).reduce((s, v) => s + Number(v || 0), 0);

// 7 & 8) Lines added & deleted: try code_frequency for each repo, but only fallback to per-commit when commit count > 0 and below threshold
const codeFreqPerRepo = {};
for (const repoName of repos) {
  try {
    // attempt code_frequency
    const freq = await getCodeFrequencyForRepo(tokenParam, username, repoName, daysCount);
    // getCodeFrequencyForRepo now may return { additions, deletions } or fall back itself.
    // But to avoid per-repo double work, if it returned zeros and code_frequency was unavailable,
    // rely on commit counts to decide explicit fallback.
    if (freq && (freq.additions || freq.deletions)) {
      codeFreqPerRepo[repoName] = freq;
      core.debug(`code_frequency for ${repoName}: +${freq.additions} / -${freq.deletions}`);
      continue;
    }

    // if freq shows zeros, consult commitsPerRepo to decide fallback
    const repoCommitCount = Number(commitsPerRepo[repoName] || 0);
    if (repoCommitCount === 0) {
      // nothing to do; skip heavy per-commit aggregation
      codeFreqPerRepo[repoName] = { additions: 0, deletions: 0 };
      core.debug(`Skipping per-commit fallback for ${repoName} (0 commits in window).`);
      continue;
    }

    // If commits are small enough, do fallback; otherwise skip to avoid heavy work
    if (repoCommitCount > COMMIT_FALLBACK_THRESHOLD || repoCommitCount > MAX_COMMIT_FALLBACK) {
      core.info(`Skipping per-commit fallback for ${repoName} due to high commit count (${repoCommitCount}). Set INPUT_COMMIT_FALLBACK_THRESHOLD or INPUT_MAX_COMMIT_FALLBACK if you want to enable.`);
      codeFreqPerRepo[repoName] = { additions: 0, deletions: 0 };
      continue;
    }

    // Do per-commit fallback (bounded by MAX_COMMIT_FALLBACK inside helper)
    const fallback = await getCodeStatsFromCommits(tokenParam, username, repoName, daysCount, MAX_COMMIT_FALLBACK);
    codeFreqPerRepo[repoName] = fallback;
    core.info(`Per-commit fallback for ${repoName}: +${fallback.additions} / -${fallback.deletions} (commits=${repoCommitCount})`);
  } catch (err) {
    core.error(`Code frequency processing failed for ${username}/${repoName}: ${err.message}`);
    codeFreqPerRepo[repoName] = { additions: 0, deletions: 0 };
  }
}

// Aggregate totals
let totalAdditions = 0;
let totalDeletions = 0;
for (const val of Object.values(codeFreqPerRepo)) {
  if (!val) continue;
  totalAdditions += Number(val.additions || 0);
  totalDeletions += Number(val.deletions || 0);
}

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const val of Object.values(codeFreqPerRepo)) {
      if (!val) continue;
      totalAdditions += Number(val.additions || 0);
      totalDeletions += Number(val.deletions || 0);
    }

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

    // Build badges in requested order:
    const badges = [
      generateBadgeMarkdown(`My repositories`, repoCount, msgColor, lblColor),
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
