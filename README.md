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
- **Roles.** Administrators manage everything. Editors manage the collections granted to them.

## How it fits together

```
Admin UI (Next.js) ──▶ API (API Gateway and Lambda, behind Cognito)
                        ├─ S3: draft and published IIIF documents
                        ├─ serverless-iiif: IIIF Image API 3.0
                        ├─ MediaConvert: HLS audio and video
                        └─ OpenSearch Serverless: a search index per published collection

Canopy IIIF site ◀── published documents, images, streams, and search, through CloudFront
```

Understory runs on AWS and deploys as one [SAM](https://aws.amazon.com/serverless/sam/) stack: S3, CloudFront, Lambda, Step Functions, API Gateway, Cognito, MediaConvert, OpenSearch Serverless, and Amplify Hosting for the admin UI. Each stack creates its own search collection, which scales to zero when nobody is publishing or searching.

## Getting started

You need an AWS account, the [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Docker, and Node 22.

1. Copy `samconfig.yaml.example` at the repo root to `samconfig.<you>.yaml` beside it and set a stack name such as `<you>-dev-understory`.
2. Deploy with `cd app/aws && sam build --use-container && sam deploy --config-file ../../samconfig.<you>.yaml`.
3. Copy the `ImagesDistributionHost` output into the `ImageApiForceHost` parameter, and deploy again.
4. Create your user in the stack's Cognito pool and add it to the `admin` group.
5. Fill in `ui/.env.local` from the stack outputs, following `ui/.env.local.example`, then run `npm install && npm run dev` in `ui/`.

[AGENTS.md](AGENTS.md) covers each step in detail, along with the design and the reasons behind it.

## Repository

| Path | Contents |
|---|---|
| `app/aws/template.yml` | The whole stack |
| `app/aws/lambdas/` | The API, the publish and import workers, and the image and A/V converters |
| `app/shared/` | Logic the Lambdas share, with its unit tests |
| `ui/` | The admin app |

Run the tests with `npm test` at the root. Lint the admin app with `npm run lint` in `ui/`.

---

Developed by [@kdid](https://github.com/kdid) and [@mathewjordan](https://github.com/mathewjordan) in Academic Innovation at Northwestern University Libraries.
