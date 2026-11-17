<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/understory-wordmark-dark.png">
  <img src="docs/images/understory-wordmark-light.png" alt="Understory" width="320">
</picture>

Understory is a lightweight, IIIF-focused platform for hosting the media and metadata of digital scholarship projects.

Users of Understory upload images, audio, and video, describe them, and arrange them into collections. Understory stores every work as a [IIIF](https://iiif.io) Presentation 3.0 manifest, serves its images through the IIIF Image API, and streams its audio and video. When a collection is ready, a user publishes it, and Understory writes a published copy of the collection and builds its search index.

Use Understory as the backend of a [Canopy IIIF](https://nulib-ds.github.io/canopy/) site: Understory holds and serves the collection, and Canopy builds the site that presents it.

## What it does

- **Images.** Understory converts uploaded and imported images to tiled TIFFs, and [serverless-iiif](https://github.com/samvera/serverless-iiif) serves them through IIIF Image API 3.0.
- **Audio and video.** AWS Elemental MediaConvert turns uploads into adaptive HLS streams. Understory copies imported streams as they are.
- **Import.** Paste the URL of a IIIF manifest or collection, and Understory copies its works and their images. A single imported work keeps its audio and video too. Understory copies only what an anonymous visitor could already fetch.
- **Editing.** Users edit labels, summaries, metadata, and canvas order, and preview each work in [Clover IIIF](https://samvera-labs.github.io/clover-iiif/).
- **Publishing.** Users publish a collection in two steps, its IIIF documents first and its search index second, so a site and its search change together. Drafts stay editable throughout.
- **Roles.** Administrators manage everything, and invite users from the Users screen. Editors manage the collections granted to them.
- **Branding.** Each instance brings its own look: a stylesheet, a header, a footer and sign-in text, in a folder of its own.

## How it fits together

```
Admin UI (Next.js, through CloudFront) ──▶ API (API Gateway and Lambda, behind Cognito)
                        ├─ S3: draft and published IIIF documents
                        ├─ serverless-iiif: IIIF Image API 3.0
                        ├─ MediaConvert: HLS audio and video
                        └─ OpenSearch Serverless: a search index per published collection

Canopy IIIF site ◀── published documents, images, streams, and search, through CloudFront
```

Understory runs on AWS and deploys as one [SAM](https://aws.amazon.com/serverless/sam/) stack: S3, CloudFront, Lambda, Step Functions, API Gateway, Cognito, MediaConvert and OpenSearch Serverless. The stack serves its own admin UI. Each stack creates its own search collection, which scales to zero when nobody is publishing or searching.

## Running an instance

An instance is one Understory stack, run from a repo of its own that holds no source code: its configuration, its branding, and the release it runs. Start from [`instance-template/`](instance-template/README.md).

| In the instance repo | What it is |
|---|---|
| `samconfig.yaml` | The stack's name, region and every parameter |
| `understory.yml` | One published release, copied in by `scripts/upgrade`; never edited |
| `branding/` | The instance's stylesheet, header, footer and sign-in text |

`sam deploy` in that repo is the whole deploy: no build, no Docker, no Node. An upgrade is `scripts/upgrade <version>` and a deploy, and its diff is exactly the infrastructure that changes.

Every release comes from one place, the release bucket `understory-releases-<region>`. Each instance's code is copied from it on every create, update and rollback, so nothing in it is ever deleted or overwritten. It is readable by NU's own accounts for now. [RELEASING.md](RELEASING.md) explains why it matters, and what each version number promises.

## Releases

Branches flow from a feature branch to `staging` to `main`.

- **Merging to `staging`** deploys `staging-understory` from source, with the tracked `samconfig.staging.yaml`.
- **Merging `staging` into `main`** publishes a release: the version is the root `package.json`'s, its notes are its `CHANGELOG.md` section, and it is tagged `v<version>`. It deploys nothing.
- **Each instance** takes the release when it chooses, with `scripts/upgrade`.

## Developing

Developing Understory itself needs an AWS account, the SAM CLI, Docker, and Node 22. A personal dev stack runs your working tree; no branch is needed.

1. Copy `samconfig.yaml.example` at the repo root to `samconfig.<you>.yaml` beside it, set a stack name such as `<you>-dev-understory`, and set `AdminEmail` to your address.
2. Build with `scripts/build.sh`, then deploy with `cd app/aws && sam deploy --config-file ../../samconfig.<you>.yaml`.
3. Sign in at the stack's `AdminUrl` output with the temporary password Cognito emails you.
4. For UI work, run `npm run config -- <your-stack>` and then `npm run dev` in `ui/`.

[AGENTS.md](AGENTS.md) covers each step in detail, along with the design and the reasons behind it.

## Repository

| Path | Contents |
|---|---|
| `app/aws/template.yml` | The whole stack |
| `app/aws/lambdas/` | The API, the publish and import workers, and the image and A/V converters |
| `app/shared/` | Logic the Lambdas share, with its unit tests |
| `ui/` | The admin app |
| `instance-template/` | The starting point for an instance's own repo |
| `scripts/` | The build (`build.sh`) and the release (`release.py`) |
| `app/aws/release-bucket.yml` | The release bucket, one per region |
| `samconfig.staging.yaml` | Staging's configuration |
| `.github/workflows/` | Staging's deploy, and the release |
| `RELEASING.md`, `CHANGELOG.md` | How a release is cut, and what each one changed |

Run the tests with `npm test` at the root. Lint the admin app with `npm run lint` in `ui/`.

---

Developed by [@kdid](https://github.com/kdid) and [@mathewjordan](https://github.com/mathewjordan) in Academic Innovation at Northwestern University Libraries.
