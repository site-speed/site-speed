# Repository README Badge Generator

This GitHub Action generates markdown badges for a single GitHub repository. It is designed to be easily reused across any repository without complex setup.

## Features
- **Plug-and-Play:** Uses the standard `GITHUB_TOKEN` for permissions.
- **Fast:** Efficiently fetches metrics via GraphQL.
- **Zero Config:** Just provide your username and the token.

## Permissions
This action only needs access to the current repository. You must set `contents: write` permissions if you want the action to update your `README.md`.

## Usage

```yaml
permissions:
  contents: write

jobs:
  generate-badges:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate Badges
        id: badges
        uses: site-speed/site-speed/.github/actions/readme-badge-generator@main
        with:
          username: ${{ github.repository_owner }}
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Write to Summary
        run: echo "${{ steps.badges.outputs.badges }}" >> $GITHUB_STEP_SUMMARY
```

## Inputs
- `username`: (Required) The GitHub username/owner.
- `token`: (Required) The GitHub token (Standard `GITHUB_TOKEN` is sufficient).
- `days`: (Default: 30) Time window for metrics.
- `color`: (Default: blue) Badge color.
- `label_color`: (Default: 555) Badge label color.
