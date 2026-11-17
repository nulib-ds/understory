# Changelog

Every release has a section, headed `## <version>`, which becomes its GitHub
Release notes. A major version's section says what an instance must do under
**Upgrading**. See RELEASING.md.

## 1.0.0

The first release. Understory is now deployed as a versioned release, from an
instance repo of configuration and branding, instead of from this repo's
branches.

- The admin UI is a static export served by the stack itself, through a new
  CloudFront distribution (`AdminUrl`). Amplify Hosting is gone, and with it
  the GitHub token, the hosted-UI branch and the separate UI build.
- The UI reads its settings from `/config.json` at run time, so one build
  serves every instance.
- Branding comes from the instance's `branding/` folder: `theme.css`,
  `header.html`, `footer.html`, `sign-in.html` and a favicon.
- New parameters: `AdminEmail` (the first administrator, invited on deploy),
  `InstitutionName` and `AccentColor`.
- Admins can invite users from the Users screen.
- A stack with no custom domain deploys once: the Image API learns its
  hostname from the request (`ImagesHostFunction`), and `ImageApiForceHost`
  is gone.
- A collection's and a work's pages are `/collection?slug=…` and
  `/collection/work?slug=…&id=…`. The old paths redirect.
- The image converter and the A/V transcoder skip work that is already done,
  so copying a backup into a stack converts nothing again.
- `SearchCollectionName` names the search collection and its policies, so a
  stack name may be longer than 27 characters.

### Upgrading

From a stack deployed from source before this release:

1. Remove `GitHubRepo`, `GitHubBranch`, `GitHubOAuthToken`, `UIAutoBuild`,
   `ImageApiForceHost` and `ServerlessIiifVersion` from the stack's
   `parameter_overrides`, and add `AdminEmail`, `InstitutionName` and
   `AccentColor`.
2. With a custom domain, Amplify holds `admin-<project>.<base>`, and CloudFront
   refuses to give a second distribution that name. Deploy the old template
   once with `GitHubBranch=""`, which deletes the Amplify app, then this
   release. The admin UI is down between the two deploys; the IIIF documents,
   images and search are not.
