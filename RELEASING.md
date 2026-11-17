# Releasing Understory

An Understory release is one version of the whole product: the stack, its
functions and the admin UI, built together and published together. An
instance (NU's production included) runs exactly one release, named by the
`understory.yml` in its instance repo.

Every release lives in one place: the **release buckets**. Read that section
before touching them.

## The release buckets

> **`understory-releases-<region>`, in NU's staging AWS account, is the single
> source of truth for every Understory release. Every instance, at NU and
> anywhere else, deploys its code from it, and rolls back from it. Nothing in
> it is ever deleted or overwritten.**

| | |
|---|---|
| Bucket | `understory-releases-us-east-1` (one per region; only `us-east-1` exists today) |
| Account | NU's staging account, the one that holds `staging-understory` and the dev stacks |
| Stack | `understory-releases`, from `app/aws/release-bucket.yml`, deployed by hand |
| Written by | `scripts/release.py`, run by `.github/workflows/release.yml` on every merge to `main`, as `understory-github-actions-release` |
| Read by | every instance's `scripts/upgrade` and `scripts/verify`, and CloudFormation and Lambda in that instance's account, on every create, update and rollback |
| Readable by | this account, plus any account in `ReaderAccountIds`; anyone, once `Public=true` |
| Created | 2026-11-17, private, empty. The release role the same day. |

### What is in it

One folder per version, written once:

```
v1.2.0/understory.yml          the packaged template an instance repo copies in
v1.2.0/understory.yml.sha256   its checksum
v1.2.0/<content hash>          every function's code, and the admin UI layer
```

A version's template names each of its code objects by key. When an instance
deploys `v1.2.0`, CloudFormation creates its functions and layers from those
keys, and Lambda copies the bytes into each function. The instance's own data
(its documents, images and search index) is never here; that lives in the
instance's own buckets.

### Why it matters

- **Every instance depends on it.** An instance reads its version's objects
  when it is created, every time it is updated, and every time CloudFormation
  rolls a failed update back. A running stack does not need the bucket
  between deploys, because Lambda keeps its own copy of the code. But an
  instance whose objects are gone can never deploy, update or roll back
  again.
- **Its contents are trusted.** An instance runs whatever bytes are at its
  version's keys at deploy time. `scripts/verify` checks the template against
  its published checksum, but the code objects are only named by hash. So
  whoever can write to this bucket decides what every instance runs.
- **It cannot be replaced quietly.** The name is part of every instance's
  scripts. If the bucket were deleted, anyone in any AWS account could create
  a bucket with the same name.
- **There is exactly one.** No test bucket, no mirror, no copy attached to a
  GitHub Release. A second copy could drift from this one, and then two
  instances on "the same" version would not be running the same thing.

### The rules

1. **Never delete anything in it, and never the bucket.** The bucket policy
   (`NeverDeleteARelease`, `NeverDeleteTheBucketOrItsHistory`) refuses every
   delete, from everyone, administrators included, and refuses lifecycle rules
   and suspending versioning. The stack retains the bucket if the stack itself
   is deleted. This was checked on 2026-11-17: as an administrator, deleting an
   object and deleting the bucket were both refused with "explicit deny in a
   resource-based policy".
2. **Never overwrite a version.** `scripts/release.py` refuses a version whose
   `understory.yml` exists in any region, and `release.yml` refuses a version
   whose git tag exists. Versioning is on, so a mistaken overwrite keeps the
   released bytes as an earlier version, from which they can be restored. A
   failed run can leave objects under a version that was never announced:
   bump the version and run again, never reuse it.
3. **Only `release.yml` writes to it.** Its role, `understory-github-actions-release`
   (`app/aws/deploy-role.yml`, stack of the same name), may read and write
   objects under `v*/` in this account's `understory-releases-*` buckets, and
   read serverless-iiif's template, which `sam build` needs. It can do nothing
   else, which IAM's policy simulator confirmed on 2026-11-17. Only a job in
   the `release` environment of `nulib-ds/understory` can assume it. Administrators of the staging
   account can still write here, so don't, except to publish a pre-release by
   hand (see **Testing a release**).
4. **Pre-releases go here too.** A release candidate is published as its own
   version (`1.2.0-rc.1`) to the same buckets. It is never reused for the
   release itself, and no instance takes it unless someone runs
   `scripts/upgrade 1.2.0-rc.1`.
5. **Change the stack only on purpose, by hand.** Name both parameters on every
   deploy (see the command at the top of `release-bucket.yml`). The workflows
   never deploy it.

### Who can read it

The bucket starts private. Readers are added in two steps, both on the
`understory-releases` stack:

- **`ReaderAccountIds`**: NU's own accounts, such as production's, while the
  bucket is private. An instance in one of them reads releases with its own
  credentials: `UNDERSTORY_RELEASES='s3://understory-releases-{region}' scripts/upgrade <version>`
  (the same bucket, read with the AWS CLI).
- **`Public=true`**: anyone, which is what other institutions need. Only objects
  under `v*/` become readable; listing the bucket stays private. Nothing in a
  release is secret, since it is all built from the public repo, but making a
  bucket public is the staging account owner's decision.

### Adding a region

Lambda reads code only from a bucket in its own region, so an instance in a new
region needs a release bucket there:

1. Deploy `release-bucket.yml` as `understory-releases` in that region, with the
   same parameters as `us-east-1`.
2. Add the region to the `RELEASE_REGIONS` repository variable (space-separated).

Releases from then on are published there too. Earlier versions are not copied
back: an instance in the new region starts at the next release.

### If something goes wrong

- **An object was overwritten.** Restore the earlier version (`aws s3api
  list-object-versions`, then copy that version back over the key). Then work
  out how it happened: only the release role should write here.
- **The bucket policy was changed or removed.** Redeploy the stack. If
  CloudFormation sees no change to make, put the policy back by hand from
  `release-bucket.yml`.
- **The bucket is gone.** Every instance can still run, but none can deploy or
  roll back. Recreate it from `release-bucket.yml` at once, before someone else
  takes the name, and republish each version from its git tag
  (`scripts/build.sh`, then `scripts/release.py`). The rebuilt code will not be
  byte-identical, and nothing proves it matches what instances originally
  deployed; say so in the CHANGELOG.

## Cutting a release

1. In the PR from `staging` to `main`, set `version` in the root
   `package.json` and add its section to `CHANGELOG.md`, headed `## <version>`.
2. Merge. `release.yml` tests, builds, publishes to the release buckets, tags
   `v<version>` and creates a GitHub Release with that version's notes. It
   attaches no files, because the buckets hold the release, and it deploys
   nothing.
3. Each instance takes it with `scripts/upgrade <version>` in its own repo.

## Versions

Semantic versioning, judged from an instance's side: what does someone who
runs `scripts/upgrade` have to do?

| Bump | When |
|---|---|
| Patch | Fixes. No new parameter, no change to anything listed under "The contract". |
| Minor | New features. A new parameter always has a default. Existing data stays valid, with nothing to run. |
| Major | Anything that needs more than `scripts/upgrade` and a deploy: a removed or renamed parameter, a manual step (reindex, republish, a two-pass deploy), a stateful resource replaced, or a breaking change to the contract below. Its `CHANGELOG.md` section says what to do, under **Upgrading**. |

Removing a parameter is major even when nothing uses it any more: an
instance's `samconfig.yaml` still names it, and CloudFormation refuses an
override for a parameter the template does not declare.

Upgrade one major version at a time. Within a major, any version can follow
any other, but a downgrade is safe only if no data format changed in between.

## The contract

What instances and consuming sites rely on, and so what semver covers:

- **The stack's parameters and outputs** (`app/aws/template.yml`).
- **The branding slots** (`ui/src/lib/branding.js`): `theme.css`,
  `header.html`, `footer.html`, `sign-in.html`, `favicon.*`, the `/branding/`
  path, the snippet whitelist, and the documented CSS tokens: `--accent-1` to
  `--accent-12`, `--gray-1` to `--gray-12`, `--brand-bar-bg`, `--brand-bar-fg`,
  `--brand-mark-height`. The app's own class names are not covered.
- **What consuming sites read:** the IIIF documents' shapes and URLs, the
  public search response (see "Public search route" in AGENTS.md), and the
  extension terms under `https://nulib-ds.github.io/understory/ns#`.
- **The instance repo's shape** (`instance-template/`): `samconfig.yaml`,
  `understory.yml`, `branding/`, and the two scripts.
- **The release buckets' names and layout**: `understory-releases-<region>`,
  `v<version>/understory.yml` and its `.sha256`.

## Testing a release

A release candidate is tested as itself, from the release buckets, never from
a bucket of its own. From a clean checkout of what is about to be released,
with credentials for the staging account:

```bash
scripts/build.sh
scripts/release.py --version 1.2.0-rc.1
```

Then, in an instance repo in the staging account (a throwaway copy of
`instance-template/` is enough):

```bash
UNDERSTORY_RELEASES='s3://understory-releases-{region}' scripts/upgrade 1.2.0-rc.1
sam deploy
```

Delete the throwaway instance's stack, and its two retained data buckets,
afterwards. The candidate's objects stay in the release bucket, like every
other version's.
