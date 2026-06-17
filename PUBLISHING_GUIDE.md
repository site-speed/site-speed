# GitHub Actions Marketplace Publishing Guide

This guide explains how to publish the badge generator actions found in this repository to the GitHub Actions Marketplace.

## Prerequisites
- The repository (`site-speed/site-speed`) must be **Public**.
- Each action must have a valid `action.yml` file with a `branding` section (already added).
- The code must be bundled into `dist/index.js` (already handled by the `npm run build` scripts).

## Publishing Steps

### 1. Draft a New Release
1. Go to the **Releases** section on the right sidebar of the repository homepage.
2. Click **Draft a new release**.
3. Create a new tag (e.g., `v1.0.0`).

### 2. Marketplace Integration
1. At the top of the release page, look for the checkbox: **"Publish this Action to the GitHub Marketplace"**.
2. Check the box.
3. Review the branding preview (Icon and Color).
4. Select a **Category** (e.g., *Utilities* or *Reporting*).

### 3. Finalize
1. Give the release a title and description.
2. Click **Publish release**.

---

## Important Considerations for this Repository

### Multiple Actions in One Repo
GitHub typically allows only **one** action per repository to be officially listed in the Marketplace. 

- **Current Setup:** Both actions are in subdirectories of this repository.
- **Official Listing:** If you follow the steps above, GitHub will usually list the one it finds first or ask you to choose. 
- **Recommendation:** If you decide to professionally publish both as distinct Marketplace entries, you should move them into their own dedicated repositories (e.g., `site-speed/user-badge-action`).

### Using Actions Without Marketplace
Even if you do **not** publish to the Marketplace, these actions are fully functional and can be used by any public or private repository (that you have access to) using the following syntax:

#### Multi-Repo Action
```yaml
- uses: site-speed/site-speed/.github/actions/user-readme-badge-generator@main
```

#### Single-Repo Action
```yaml
- uses: site-speed/site-speed/.github/actions/readme-badge-generator@main
```
