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
 * Attempts to fetch data for a user or organization
 * First tries as a user, then falls back to organization
 */
export const getUserOrOrgData = async (username, graphqlClient) => {
  try {
    // Try querying as a user first
    const { user } = await graphqlClient(
      `
      query ($login: String!) {
        user (login: $login) {
          repositories(first: 1) {
            totalCount
          }
        }
      }
    `,
      { login: username }
    );
    if (user) {
      return { type: 'user', data: user };
    }
  } catch (err) {
    core.debug(`User query failed: ${err.message}`);
  }

  try {
    // Fall back to organization
    const { organization } = await graphqlClient(
      `
      query ($login: String!) {
        organization (login: $login) {
          repositories(first: 1) {
            totalCount
          }
        }
      }
    `,
      { login: username }
    );
    if (organization) {
      return { type: 'organization', data: organization };
    }
  } catch (err) {
    core.debug(`Organization query failed: ${err.message}`);
  }

  throw new Error(`Could not find user or organization with login: ${username}`);
};

export const getRepositoryCount = async (username, graphqlClient) => {
  const result = await getUserOrOrgData(username, graphqlClient);
  return result.data.repositories.totalCount;
};

export const getRepositories = async (username, graphqlClient) => {
  const result = await getUserOrOrgData(username, graphqlClient);
  const accountType = result.type;
  
  let endCursor;
  let hasNextPage = true;
  const repositories = [];

  while (hasNextPage) {
    const query = accountType === 'user'
      ? `
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
      `
      : `
        query ($login: String!, $after: String) {
          organization (login: $login) {
            repositories(first: 100, after: $after) {
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
      `;

    const response = accountType === 'user'
      ? await graphqlClient(query, { login: username, after: endCursor })
      : await graphqlClient(query, { login: username, after: endCursor });

    const accountData = accountType === 'user' ? response.user : response.organization;
    repositories.push(...accountData.repositories.nodes.map(repo => repo.name));

    hasNextPage = accountData.repositories.pageInfo.hasNextPage;
    endCursor = accountData.repositories.pageInfo.endCursor;
  }

  return repositories;
};


export const getPullRequestsCount = async (username, repo, prFilterDate, graphqlClient) => {
  let endCursor;
  let hasNextPage = true;
  let total = 0;
  let merged = 0;

  while (hasNextPage) {
    const { repository } = await graphqlClient(
      `
      query ($owner: String!, $repo: String!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(first: 100, after: $after) {
            nodes {
              createdAt
              mergedAt
              state
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    `,
      { owner: username, repo, after: endCursor }
    );

    const pullRequests = repository.pullRequests.nodes;
    core.debug(`repo=${repo} pagePullRequests=${pullRequests.length}`);

    // PRs created after the filter date
    const openAfterFilter = pullRequests.filter(pr => new Date(pr.createdAt) >= new Date(prFilterDate));
    core.debug(`repo=${repo} openAfterFilter=${openAfterFilter.length} (filterDate=${prFilterDate})`);
    total += openAfterFilter.length;

    // Merged PRs after the filter date (guard mergedAt)
    const mergedPRs = pullRequests.filter(
      pr => pr.state === 'MERGED' && pr.mergedAt && new Date(pr.mergedAt) >= new Date(prFilterDate)
    );
    core.debug(`repo=${repo} mergedAfterFilter=${mergedPRs.length}`);
    merged += mergedPRs.length;

    hasNextPage = repository.pullRequests.pageInfo.hasNextPage;
    endCursor = repository.pullRequests.pageInfo.endCursor;
  }

  return {
    total,
    merged
  };
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

    // Aggregate results from the batch
    for (const { total, merged } of results) {
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

  // Diagnostic: print who the GraphQL client authenticates as and confirm target account exists
  try {
    const viewerResp = await client(`query { viewer { login } }`);
    core.info(`GraphQL viewer login: ${viewerResp.viewer?.login || '(no viewer)'}`);
  } catch (e) {
    core.error(`Viewer query failed: ${e.message}`);
  }

  try {
    // Use the function-scoped `username` variable (not `cfg`)
    const lookup = await client(
      `query ($login: String!) {
         user(login: $login) { repositories(first:1) { totalCount } }
         organization(login: $login) { repositories(first:1) { totalCount } }
       }`,
      { login: username }
    );
    core.info(`Lookup for ${username}: userRepoCount=${lookup.user?.repositories?.totalCount || 'NA'} organizationRepoCount=${lookup.organization?.repositories?.totalCount || 'NA'}`);
  } catch (e) {
    core.error(`Lookup query failed: ${e.message}`);
  }

  try {
    // repo count
    const repos = await getRepositories(username, client);
    core.debug(`Fetched ${repos.length} repositories: ${repos.slice(0,20).join(', ')}`);
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
