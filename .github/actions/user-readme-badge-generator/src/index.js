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
           user(login: $login) {
             repositories(first: 100, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
               nodes { nameWithOwner isFork }
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
    const filtered = excludeForks ? repoNodes.filter((r) => !r.isFork) : repoNodes;
    repositories.push(...filtered.map((r) => r.nameWithOwner));
    hasNextPage = response.user.repositories.pageInfo.hasNextPage;
    endCursor = response.user.repositories.pageInfo.endCursor;
  }
  return repositories;
};

/* -------------------------
   PR / Issue metric helpers
   ------------------------- */

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

/* -------------------------
   Commits counting (GraphQL preferred, REST fallback)
   ------------------------- */

export const getCommitsCountForRepo = async (token, owner, repo, sinceIso, client) => {
  // Try GraphQL default branch commit history totalCount (preferred)
  if (client) {
    try {
      const gqlRes = await withBackoff(() =>
        client(
          `query ($owner: String!, $name: String!, $since: GitTimestamp!) {
             repository(owner: $owner, name: $name) {
               defaultBranchRef {
                 target {
                   ... on Commit {
                     history(since: $since) {
                       totalCount
                     }
                   }
                 }
               }
             }
           }`,
          { owner, name: repo, since: sinceIso }
        )
      );
      const count = gqlRes?.repository?.defaultBranchRef?.target?.history?.totalCount;
      if (typeof count === 'number') {
        core.debug(`GraphQL commit history for ${owner}/${repo} since ${sinceIso}: ${count}`);
        return count;
      }
      core.debug(`GraphQL commit totalCount not available for ${owner}/${repo}; falling back to REST search`);
    } catch (err) {
      core.debug(`GraphQL commit count failed for ${owner}/${repo}: ${err.message}`);
      // fall through to REST fallback
    }
  }

  // REST fallback: search/commits (preview header)
  try {
    const dateOnly = new Date(sinceIso).toISOString().split('T')[0];
    const q = encodeURIComponent(`repo:${owner}/${repo} committer-date:>=${dateOnly}`);
    const url = `https://api.github.com/search/commits?q=${q}&per_page=1`;
    const { json } = await withBackoff(() => restFetch(url, token, { accept: 'application/vnd.github.cloak-preview' }));
    return json.total_count || 0;
  } catch (err) {
    core.error(`Commit count search failed for ${owner}/${repo}: ${err.message}`);
    return 0;
  }
};

/* -------------------------
   Code frequency & commit stats fallback
   ------------------------- */

/**
 * Per-commit aggregation fallback (accurate but heavy). Bounded by maxCommits.
 * This version restricts commit listing to the repository's default branch by querying
 * the default branch name via GraphQL and passing sha=<defaultBranch> to the commits list.
 *
 * Parameters:
 *   token - repo token
 *   owner, repo
 *   daysWindow - integer days
 *   maxCommits - cap on commits processed
 *   client - GraphQL client (to fetch default branch)
 */
export const getCodeStatsFromCommits = async (token, owner, repo, daysWindow = 30, maxCommits = 1000, client = null) => {
  // find default branch name (fallback to 'HEAD' if not available)
  let defaultBranch = null;
  if (client) {
    try {
      const gql = await withBackoff(() =>
        client(
          `query ($owner: String!, $name: String!) {
             repository(owner: $owner, name: $name) {
               defaultBranchRef { name }
             }
           }`,
          { owner, name: repo }
        )
      );
      defaultBranch = gql?.repository?.defaultBranchRef?.name || null;
    } catch (err) {
      core.debug(`Failed to fetch default branch for ${owner}/${repo}: ${err.message}`);
    }
  }
  const shaParam = defaultBranch ? `&sha=${encodeURIComponent(defaultBranch)}` : '';

  const sinceIso = new Date(Date.now() - daysWindow * 24 * 60 * 60 * 1000).toISOString();
  const perPage = 100;
  let page = 1;
  let processed = 0;
  let additions = 0;
  let deletions = 0;

  core.info(`Per-commit aggregation for ${owner}/${repo} on ${defaultBranch || 'default branch'} since ${sinceIso} (max ${maxCommits} commits)`);

  outer: while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?since=${encodeURIComponent(sinceIso)}${shaParam}&per_page=${perPage}&page=${page}`;
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
      await sleep(50);
    }

    if (commitsPage.length < perPage) break;
    page++;
  }

  core.info(`Per-commit aggregated ${processed} commits for ${owner}/${repo}: +${additions} / -${deletions}`);
  return { additions, deletions };
};

/* -------------------------
   Batch processing utilities
   ------------------------- */

const processReposInBatches = async (repos, owner, token, client, metricFn, batchSize = DEFAULT_BATCH_SIZE, delayMs = DEFAULT_DELAY_MS) => {
  const results = {};
  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);
    core.debug(`Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} repos)`);
    const promises = batch.map((r) => {
      const [actualOwner, repoName] = r.split('/');
      return metricFn(actualOwner, repoName, token, client);
    });
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
   Adapter wrappers
   ------------------------- */

const adapterPRsCreated = async (owner, repo, token, client, sinceIso) => getPRsCreatedForRepo(client, owner, repo, sinceIso);
const adapterPRsMerged = async (owner, repo, token, client, sinceIso) => getPRsMergedForRepo(client, owner, repo, sinceIso);
const adapterOpenPRs = async (owner, repo, token, client) => getOpenPRsForRepo(client, owner, repo);
const adapterIssuesOpened = async (owner, repo, token, client, sinceIso) => getIssuesOpenedForRepo(client, owner, repo, sinceIso);
const adapterIssuesClosed = async (owner, repo, token, client, sinceIso) => getIssuesClosedForRepo(client, owner, repo, sinceIso);
const adapterOpenIssues = async (owner, repo, token, client) => getOpenIssuesForRepo(client, owner, repo);
const adapterContributorsList = async (owner, repo, token) => getContributorsListForRepo(token, owner, repo);
const adapterContributorsActiveList = async (owner, repo, token, client, sinceIso) => getContributorsActiveListForRepo(token, owner, repo, sinceIso);
const adapterCommits = async (owner, repo, token, client, sinceIso) => getCommitsCountForRepo(token, owner, repo, sinceIso, client);
const adapterCodeFreq = async (owner, repo, token, client, sinceIso) => getCodeFrequencyForRepo(token, owner, repo, Math.ceil((Date.now() - new Date(sinceIso)) / (7 * 24 * 60 * 60 * 1000)));

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

    // Repositories (filtered)
    const repos = await getRepositories(username, client, excludeForks);
    core.info(`Timestamp: repos fetched at ${new Date().toISOString()}`);
    core.info(`Fetched ${repos.length} repositories (excludeForks=${excludeForks}): ${repos.slice(0, 20).join(', ')}`);
    const repoCount = repos.length;

    // date window
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysCount);
    const filterDate = date.toISOString();
    core.debug(`Filtering metrics for last ${daysCount} days since ${filterDate}`);
    const dateOnly = filterDate.split('T')[0];

    // --- Aggregate metrics (use chunked searches by repo to avoid many per-repo calls) ---
    // This reduces the number of Search API calls while still using the filtered repo list (excludeForks=true).
    const SEARCH_REPO_CHUNK_SIZE = 1;
    const SEARCH_DELAY_MS = delayMs || DEFAULT_DELAY_MS;

    async function chunkedRepoSearchCount(client, owner, repoList, querySuffix, token, chunkSize = SEARCH_REPO_CHUNK_SIZE, delay = SEARCH_DELAY_MS) {
      let total = 0;
      for (let i = 0; i < repoList.length; i += chunkSize) {
        const chunk = repoList.slice(i, i + chunkSize);
        const repoQuery = chunk.map((r) => `repo:${r}`).join(' OR ');
        const fullQuery = `(${repoQuery}) ${querySuffix}`;
        core.info(`Searching chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(repoList.length / chunkSize)}: ${fullQuery}`);
        
        try {
          const cnt = await getSearchCount(client, fullQuery, token);
          core.info(`Chunk result: ${cnt}`);
          total += Number(cnt || 0);
        } catch (err) {
          if (err.message.includes('Validation Failed') || err.message.includes('422')) {
            core.warn(`Chunked search failed with validation error; falling back to per-repo search for this chunk.`);
            for (const repo of chunk) {
              const singleQuery = `repo:${repo} ${querySuffix}`;
              const singleCnt = await getSearchCount(client, singleQuery, token);
              total += Number(singleCnt || 0);
              await sleep(100);
            }
          } else {
            throw err;
          }
        }

        if (i + chunkSize < repoList.length) await sleep(delay);
      }
      return total;
    }

    // PRs created in window
    const totalPRsCreated = await chunkedRepoSearchCount(client, username, repos, `is:pr created:>=${dateOnly}`, tokenParam, SEARCH_REPO_CHUNK_SIZE, delayMs);

    // PRs merged in window
    const totalPRsMerged = await chunkedRepoSearchCount(client, username, repos, `is:pr is:merged merged:>=${dateOnly}`, tokenParam, SEARCH_REPO_CHUNK_SIZE, delayMs);

    // Open PRs
    const totalOpenPRs = await chunkedRepoSearchCount(client, username, repos, `is:pr is:open`, tokenParam, SEARCH_REPO_CHUNK_SIZE, delayMs);

    // Issues opened in window
    const totalIssuesOpened = await chunkedRepoSearchCount(client, username, repos, `is:issue created:>=${dateOnly}`, tokenParam, SEARCH_REPO_CHUNK_SIZE, delayMs);

    // Issues closed in window
    const totalIssuesClosed = await chunkedRepoSearchCount(client, username, repos, `is:issue closed:>=${dateOnly}`, tokenParam, SEARCH_REPO_CHUNK_SIZE, delayMs);

    // Open issues
    const totalOpenIssues = await chunkedRepoSearchCount(client, username, repos, `is:issue is:open`, tokenParam, SEARCH_REPO_CHUNK_SIZE, delayMs);

    // Contributors exact unique:
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
      for (const id of arr) if (id) uniqueContributors.add(id);
    }
    const totalContributorsExact = uniqueContributors.size;

    async function getRateLimit(token) {
      try {
        const { json } = await withBackoff(() => restFetch('https://api.github.com/rate_limit', token));
        return json.rate?.core || json.rate || null;
      } catch (err) {
        core.debug(`rate_limit check failed: ${err.message}`);
        return null;
      }
    }

    // use the filtered 'repos' array (excludeForks=true)
    const repoList = repos || [];

    // chunk size and delay tuned for your runs; adjust if needed
    const ACTIVE_CONTRIB_CHUNK_SIZE = 1;
    const ACTIVE_CONTRIB_DELAY_MS = Math.max(1500, delayMs || 1500);
    const ACTIVE_CONTRIB_MAX_PAGES = 5;

    async function fetchCommitsForQuery(token, query, maxPages, seenSet) {
      for (let page = 1; page <= maxPages; page++) {
        const url = `https://api.github.com/search/commits?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
        const { json } = await withBackoff(() => restFetch(url, token, { accept: 'application/vnd.github.cloak-preview' }));
        const items = json.items || [];
        for (const item of items) {
          const login = item.author?.login;
          if (login) seenSet.add(login);
          else {
            const email = item.commit?.author?.email || item.commit?.committer?.email;
            if (email) seenSet.add(email);
          }
        }
        core.info(`Found ${items.length} items in page ${page}. Current total unique: ${seenSet.size}`);
        if (!Array.isArray(items) || items.length < 100) break;
        await sleep(200);
      }
    }

    async function chunkedActiveContributors(token, owner, repoList, sinceIso, chunkSize = ACTIVE_CONTRIB_CHUNK_SIZE, delay = ACTIVE_CONTRIB_DELAY_MS, maxPagesPerChunk = ACTIVE_CONTRIB_MAX_PAGES) {
      const seen = new Set();
      const dateOnlyLocal = new Date(sinceIso).toISOString().split('T')[0];

      for (let i = 0; i < repoList.length; i += chunkSize) {
        // rate-limit safety...
        const rl = await getRateLimit(token);
        if (rl && typeof rl.remaining === 'number' && rl.remaining < 10) {
          const waitMs = Math.max((rl.reset * 1000) - Date.now(), 5000);
          core.info(`Low rate-limit remaining (${rl.remaining}), sleeping ${Math.ceil(waitMs/1000)}s until reset`);
          await sleep(waitMs);
        }

        const chunk = repoList.slice(i, i + chunkSize);
        const repoQuery = chunk.map((r) => `repo:${r}`).join(' OR ');
        const qBase = `(${repoQuery}) author-date:>=${dateOnlyLocal}`;
        core.info(`Commit-search chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(repoList.length / chunkSize)}: ${qBase}`);

        try {
          await fetchCommitsForQuery(token, qBase, maxPagesPerChunk, seen);
        } catch (err) {
          if (err.message.includes('Validation Failed') || err.message.includes('422')) {
            core.warn(`Chunked commit search failed with validation error; falling back to per-repo search for this chunk.`);
            for (const repo of chunk) {
              const singleQuery = `repo:${repo} author-date:>=${dateOnlyLocal}`;
              try {
                await fetchCommitsForQuery(token, singleQuery, maxPagesPerChunk, seen);
              } catch (innerErr) {
                core.error(`Failed to fetch commits for single repo ${repo}: ${innerErr.message}`);
              }
              await sleep(300);
            }
          } else {
            core.error(`Chunk commit search failed for ${owner} chunk starting ${chunk[0]} page 1: ${err.message}`);
          }
        }

        if (i + chunkSize < repoList.length) await sleep(delay);
      }

      return Array.from(seen);
    }

    const activeContribs = await chunkedActiveContributors(
      tokenParam,
      username,
      repoList,
      filterDate,
      ACTIVE_CONTRIB_CHUNK_SIZE,
      ACTIVE_CONTRIB_DELAY_MS,
      ACTIVE_CONTRIB_MAX_PAGES
    );

    const totalActiveContributorsExact = new Set(activeContribs).size;
    core.info(`Active contributors (unique across repo chunks, last ${daysCount}d): ${totalActiveContributorsExact}`);

    // ------- Commits (preferred GraphQL) -------
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

    // ------- Lines added/deleted: only per-commit fallback (code_frequency disabled)
    const codeFreqPerRepo = {};
    const MAX_COMMIT_FALLBACK = maxCommitFallback || 1000;
    const COMMIT_FALLBACK_THRESHOLD = commitFallbackThreshold || 50;

    for (const repoFullName of repos) {
      core.info(`Timestamp: start processing ${repoFullName} at ${new Date().toISOString()}`);
      try {
        const repoCommitCount = Number(commitsPerRepo[repoFullName] || 0);
        core.info(`Commit count for ${repoFullName}: ${repoCommitCount}`);

        const [actualOwner, repoName] = repoFullName.split('/');

        if (repoCommitCount === 0) {
          codeFreqPerRepo[repoFullName] = { additions: 0, deletions: 0 };
          core.info(`Skipping per-repo stats for ${repoFullName} (0 commits in window).`);
          continue;
        }

        if (repoCommitCount > COMMIT_FALLBACK_THRESHOLD || repoCommitCount > MAX_COMMIT_FALLBACK) {
          core.info(`Skipping per-commit fallback for ${repoFullName} due to high commit count (${repoCommitCount}). Adjust INPUT_COMMIT_FALLBACK_THRESHOLD / INPUT_MAX_COMMIT_FALLBACK to change.`);
          codeFreqPerRepo[repoFullName] = { additions: 0, deletions: 0 };
          continue;
        }

        core.info(`Timestamp: start per-commit fallback for ${repoFullName} at ${new Date().toISOString()}`);
        const fallback = await getCodeStatsFromCommits(tokenParam, actualOwner, repoName, daysCount, MAX_COMMIT_FALLBACK, client);
        core.info(`Timestamp: done per-commit fallback for ${repoFullName} at ${new Date().toISOString()}`);
        codeFreqPerRepo[repoFullName] = fallback || { additions: 0, deletions: 0 };
        core.info(`Per-commit fallback for ${repoFullName}: +${codeFreqPerRepo[repoFullName].additions} / -${codeFreqPerRepo[repoFullName].deletions} (commits=${repoCommitCount})`);
      } catch (err) {
        core.error(`Code stats processing failed for ${repoFullName}: ${err.message}`);
        codeFreqPerRepo[repoFullName] = { additions: 0, deletions: 0 };
      }
    }

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const val of Object.values(codeFreqPerRepo)) {
      if (!val) continue;
      totalAdditions += Number(val.additions || 0);
      totalDeletions += Number(val.deletions || 0);
    }

    // Diagnostics
    core.info(`Total repositories: ${repoCount}`);
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
      generateBadgeMarkdown(`Total repositories`, repoCount, msgColor, lblColor),
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
