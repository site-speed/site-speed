# User README Badge Generator

This GitHub Action aggregates metrics across all repositories owned by a user (excluding forks by default) and generates a set of markdown badges.

## Features
- **High Performance:** Consolidates metrics into optimized GraphQL queries to avoid rate limits.
- **Aggregated Stats:** PRs, Issues, Commits, and Lines added/deleted across the whole account.
- **Customizable:** Adjust the time window (default 30 days) and badge aesthetics.

## Permissions
Because this action accesses data from multiple repositories, it requires elevated permissions:
1. **GitHub App (Recommended):** Install a GitHub App on your account with access to "All repositories" and use `actions/create-github-app-token` to provide a token.
2. **Personal Access Token (PAT):** Alternatively, use a PAT with `repo` scope.

*Note: The standard `GITHUB_TOKEN` will only see the repository where the action is running and will result in incomplete metrics.*

## Usage

```yaml
jobs:
  generate-badges:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.APP_CLIENT_ID }}
          private-key: ${{ secrets.PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}

      - name: Generate Badges
        uses: site-speed/site-speed/.github/actions/user-readme-badge-generator@main
        with:
          username: site-speed
          token: ${{ steps.app-token.outputs.token }}
          days: '30'
```

## Inputs
- `username`: (Required) The GitHub username/owner.
- `token`: (Required) The GitHub token (App or PAT).
- `days`: (Default: 30) Time window for metrics.
- `exclude_forks`: (Default: true) Whether to skip forked repositories.
- `color`: (Default: blue) Badge color.
- `label_color`: (Default: 555) Badge label color.
