---

### GitHub Actions for README Badges

This repository contains two reusable GitHub Actions for generating markdown badges:

1. **[User README Badge Generator](.github/actions/user-readme-badge-generator)**: Aggregates metrics across **all** your repositories. Best for your profile README.
2. **[Repository README Badge Generator](.github/actions/readme-badge-generator)**: Generates metrics for a **single** repository. Best for project-specific READMEs.

#### Quick Start (Standalone Repo)
To add badges to any repository, copy [**repo-badges-template.yml**](.github/workflows/repo-badges-template.yml) to your `.github/workflows` folder and ensure your `README.md` contains these markers:
```html
<!-- start user badges -->
<!-- end user badges -->
```

