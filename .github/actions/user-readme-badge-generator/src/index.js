import * as core from '@actions/core';
import { graphql } from '@octokit/graphql';

// Default values
const DEFAULT_DAYS = 30;
const DEFAULT_GRAPHQL_URL = 'https://api.github.com/graphql';
const DEFAULT_COLOR = 'blue';
const DEFAULT_LABEL_COLOR = '555';

// Exported function for validating required inputs
export function validateRequiredInput(input, label) {
  if (!input) {
    throw new Error(`${label} is required`);
  }
  return input;
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
 * @returns {{username: string, token: string, days: number, graphqlUrl: string, color: string, labelColor: string, graphqlClient: function}} Configuration object
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
    username: username,
    token: tkn,
    days: numDays,
    graphqlUrl: gqlUrl,
    color: badgeColor,
    labelColor: badgeLabelColor,
    graphqlClient: client
  };
}

/**
 * Main execution function that generates badges and sets outputs
 * @param {object} [config] - Optional configuration object (uses initializeConfig if not provided)
 * @returns {Promise<string[]>} Array of badge markdown strings
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
    cfg.graphqlUrl
  );
  core.info('');
  const badgesMarkdown = badges.join(' ');
  core.info(`Badge markdown: ${badgesMarkdown}`);
  core.setOutput('badges', badgesMarkdown);

  return badges;
}

export const generateBadgeMarkdown = (text, number, badgeColor, badgeLabelColor) => {
  // Use shields.io for GitHub-compatible badge rendering
  const encodedLabel = encodeURIComponent(text);
  const encodedMessage = encodeURIComponent(number);
  const encodedColor = encodeURIComponent(badgeColor);
  const encodedLabelColor = encodeURIComponent(badgeLabelColor);

  const badgeUrl = `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${encodedColor}?labelColor=${encodedLabelColor}`;
  const markdownImage = `![${text}](${badgeUrl})`;
  return markdownImage;
};

/**
 * Fetches user data for a login (user-only).
 * Throws if the login cannot be resolved as a user or the token lacks permission.
 */
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
      }
    `,
      { login: username }
    );

    if (!user) {
      throw new Error(`Could not find a user with login: ${username}`);
    }

    return user;
  } catch (err) {
    // Bubble up with a clearer message
    throw new Error(`User lookup failed for '${username}': ${err.message}`);
  }
};

export const getRepositoryCount = async (username, graphqlClient) => {
  const user = await getUserData(username, graphqlClient);
  return user.repositories.totalCount;
};

export const getRepositories = async (username, graphqlClient) => {
  // Only support personal user account repositories
  let endCursor = null;
  let hasNextPage = true;
  const repositories = [];

  while (hasNextPage) {
    const response = await graphqlClient(
      `
      query ($login: String!, $after: String) {
        user (login: $login) {
          repositories(first: 100, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
            nodes {
              name
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    `,
      { login: username, after: endCursor }
    );

    if (!response || !response.user || !response.user.repositories) {
      throw new Error(`Failed to fetch repositories for user '${username}'`);
    }

    const repoNodes = response.user.repositories.nodes || [];
    repositories.push(...repoNodes.map(r => r.name));

    hasNextPage = response.user.repositories.pageInfo.hasNextPage;
    endCursor = response.user.repositories.pageInfo.endCursor;
  }

  return repositories;
};

/**
 * Uses the GraphQL search API to count PRs created/merged after a date.
 * This avoids pagination and filters by using search qualifiers.
 */
export const getPullRequestsCount = async (username, repo, prFilterDate, graphqlClient) => {
  // prFilterDate is an ISO string; convert to YYYY-MM-DD for GitHub search qualifiers
  const dateOnly = new Date(prFilterDate).toISOString().split('T')[0];

  // Query for PRs created after date
  const createdQuery = `repo:${username}/${repo} is:pr created:>=${dateOnly}`;
  const mergedQuery = `repo:${username}/${repo} is:pr is:merged merged:>=${dateOnly}`;

  try {
    const createdRes = await graphqlClient(
      `query ($q: String!) {
         search(query: $q, type: ISSUE, first: 1) {
           issueCount
         }
       }`,
      { q: createdQuery }
    );

    const mergedRes = await graphqlClient(
      `query ($q: String!) {
         search(query: $q, type: ISSUE, first: 1) {
           issueCount
         }
       }`,
      { q: mergedQuery }
    );

    const total = createdRes?.search?.issueCount || 0;
    const merged = mergedRes?.search?.issueCount || 0;

    core.debug(`repo=${repo} searchCreated='${createdQuery}' createdCount=${total}`);
    core.debug(`repo=${repo} searchMerged='${mergedQuery}' mergedCount=${merged}`);

    return { total, merged };
  } catch (e) {
    core.error(`getPullRequestsCount search query failed for ${username}/${repo}: ${e.message}`);
    // If you prefer the action to fail loudly on search errors, rethrow here.
    // For now return zeros so a single repo error won't abort the entire run.
    return { total: 0, merged: 0 };
  }
};

/**
 * Processes pull request counts for multiple repositories in batches with limited concurrency
 * @param {string} username - The username or organization name
 * @param {string[]} repos - Array of repository names to process
 * @param {string} prFilterDate - ISO date string to filter PRs created after this date
 * @param {function} client - GraphQL client for API calls
 * @param {number} [batchSize=10] - Number of repositories to process concurrently per batch
 * @returns {Promise<{totalOpenPRs: number, totalMergedPRs: number}>} The aggregated PR counts
 */
export const processPullRequestsInBatches = async (username, repos, prFilterDate, client, batchSize = 10) => {
  let totalOpenPRs = 0;
  let totalMergedPRs = 0;

  // Process repositories in batches
  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);

    // Process each batch concurrently
    const results = await Promise.all(batch.map(repo => getPullRequestsCount(username, repo, prFilterDate, client)));

    // Aggregate results from the batch, logging per-repo counts for diagnostics
    for (let idx = 0; idx < batch.length; idx++) {
      const repoName = batch[idx];
      const { total, merged } = results[idx];
      core.info(`Repo ${repoName}: created=${total}, merged=${merged}`);
      totalOpenPRs += total;
      totalMergedPRs += merged;
    }
  }

  return {
    totalOpenPRs,
    totalMergedPRs
  };
};

export const generateBadges = async (
  username,
  tokenParam,
  numDays,
  graphqlClient,
  badgeColor,
  badgeLabelColor,
  graphqlUrl = DEFAULT_GRAPHQL_URL
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

    // repo count
    const repos = await getRepositories(username, client);
    core.debug(`Fetched ${repos.length} repositories: ${repos.slice(0, 20).join(', ')}`);
    const repoCount = repos.length;
    core.info(`Total repositories: ${repoCount}`);

    // pull requests
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysCount);
    const prFilterDate = date.toISOString();
    core.debug(`Filtering PRs created after ${prFilterDate}`);

    const { totalOpenPRs, totalMergedPRs } = await processPullRequestsInBatches(username, repos, prFilterDate, client);

    core.info(`Total pull requests created in last ${daysCount} days for ${username}: ${totalOpenPRs}`);
    core.info(`Total merged pull requests in last ${daysCount} days for ${username}: ${totalMergedPRs}`);

    const badges = [
      generateBadgeMarkdown(`Total repositories`, repoCount, msgColor, lblColor),
      generateBadgeMarkdown(`PRs created in last ${daysCount} days`, totalOpenPRs, msgColor, lblColor),
      generateBadgeMarkdown(`Merged PRs in last ${daysCount} days`, totalMergedPRs, msgColor, lblColor)
    ];

    return badges;
  } catch (error) {
    core.error(error.stack);
    // Fail loudly so users can act on permission issues
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
