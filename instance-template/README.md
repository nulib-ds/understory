# Understory instance

One Understory instance: its configuration, its branding, and the release it
runs. There is no source code here. The code is
[nulib-ds/understory](https://github.com/nulib-ds/understory), and
`understory.yml` is one of its published releases.

| File | What it is |
|---|---|
| `samconfig.yaml` | The stack's name, region and every parameter. |
| `understory.yml` | The Understory release this instance runs: a packaged CloudFormation template. Never edit it; `scripts/upgrade` replaces it. |
| `understory.yml.sha256` | Its published checksum. |
| `branding/` | This instance's look. See `branding/README.md`. |
| `scripts/upgrade`, `scripts/verify` | Take a release, and check the one you have. |
| `.github/workflows/deploy.yml`, `github-deploy-role.yml` | Optional: deploy on every push to `main`. |

## Where releases come from

Every release is published to one place, `understory-releases-<region>`, and
`scripts/upgrade` reads it for this instance's region. `sam deploy` then has
CloudFormation and Lambda copy that release's code from it into your own
functions. Your running instance never reads it again until its next deploy,
but every update and every rollback does, which is why NU never deletes or
overwrites anything there.

Until a release bucket is public, an account it was shared with reads it with
its own credentials:
`UNDERSTORY_RELEASES='s3://understory-releases-{region}' scripts/upgrade <version>`.

## What you need

- An AWS account, and credentials for it in your shell (`aws sts get-caller-identity` answers).
- The [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).
- Nothing else: no Docker, no Node, no build.

## First deploy

1. Edit `samconfig.yaml`: `stack_name` (yours: it names buckets, which S3
   needs unique across all of AWS; past 27 characters it also needs
   `SearchCollectionName`), `s3_prefix`,
   `region`, `AdminEmail` and `InstitutionName`.
2. Decide on a custom domain now, if you want one. Every IIIF id embeds its
   host, so a domain added later changes every published URL. Without one,
   the stack uses generated `*.cloudfront.net` names.
3. Take a release: `scripts/upgrade <version>`.
4. Deploy: `sam deploy`. It takes 20 to 30 minutes, mostly CloudFront.
5. `AdminEmail` receives a temporary password. Sign in at the `AdminUrl`
   output and choose your own. Invite everyone else from the Users screen.

## Upgrading

1. Read the release's notes. A section headed **Upgrading** is a step of your own.
2. `scripts/upgrade <version>`.
3. Review the diff of `understory.yml`: it is the infrastructure that will change.
4. Commit and deploy. CloudFormation rolls back a failed update, including the
   admin UI.

## Branding

Edit `branding/` and deploy. Everything in it ships with the deploy, through
CloudFormation, so a branding change is reviewed and rolled back like any
other.
