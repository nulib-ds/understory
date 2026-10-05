# Implement staging and production stacks

## Context

Understory has only run as per-developer dev stacks, each deployed from a hand-edited,
gitignored `app/aws/samconfig.toml` that holds a GitHub token in plain text. We now add
two persistent, shared stacks, which several developers may deploy:

- `staging-understory`, in the same AWS account as the dev stacks;
- `production-understory`, in a separate account.

Dev stacks stay as they are: per person, as many as needed, disposable.

Per-stack deploy values move into one Secrets Manager secret per stack, which a
developer creates and maintains by hand. A new deploy script reads the secret and runs
the build and deploy. This document is the plan, and it deliberately contains no secret
values, account IDs, ARNs, zone IDs, domain names or endpoints. Those exist only in each
account's secrets.

## Decisions (Mat, 2026-10-05)

1. **One secret per stack, `understory/<stack-name>`,** a JSON object whose keys are the
   template's own parameter names (`BaseDomainName`, `CertificateArn`, …). A developer
   creates it, and the deploy script only reads it. It lives in the same account as its
   stack.
2. **Branches:**

   | Stack | Amplify builds from |
   |---|---|
   | `production-understory` | `main` |
   | `staging-understory` | `staging` |
   | `<owner>-dev-understory` | the developer's current branch |

3. **No git checks on deploy.** Amplify rebuilds a stack's UI on every push to its
   branch. The backend changes only when a developer runs the deploy script.
4. **Safeguards for staging and production:**
   - termination protection;
   - user-pool protection (the mechanism changed; see Template changes);
   - the changeset is always confirmed by a person.

## Why a script, and why it validates

- **Dynamic references (`{{resolve:secretsmanager:…}}`) cannot drive this template.**
  `HasCustomDomain` and `ManageDns` (`template.yml` Conditions) compare literal
  parameter values. A `{{resolve:…}}` string is never empty, so both conditions would
  always be true.
- **`sam deploy` checks nothing.** Read in SAM CLI 1.157.1:
  - `merge_parameters` in `samcli/commands/deploy/deploy_context.py` drops an override
    for a parameter the template does not declare. This was seen live on 2026-10-05.
  - The same function gives every declared parameter without an override its previous
    value.
  - In `samcli/cli/types.py`, an empty unquoted value is lost: `B=` inside a joined
    string is dropped, and `B=` on its own is an error. Only `B=""` passes an empty
    string.
- **A misspelled key (`baseDomain`) would therefore deploy a stack without its custom
  domain.** `IIIF_BASE_URL`, which becomes part of every manifest id, would fall back to
  the generated CloudFront name. A key deleted from a secret would change nothing.

## Design

### The secret

A JSON object of strings. Shape only, no real values:

```json
{
  "GitHubOAuthToken": "<token>",
  "BaseDomainName": "<base domain>",
  "CertificateArn": "<wildcard certificate ARN, us-east-1>",
  "HostedZoneId": "<hosted zone id, or empty if DNS is managed elsewhere>"
}
```

- **A dev stack's secret is usually just the token.** It also takes `ImageApiForceHost`
  only if the developer wants to pin it.
- **`GitHubBranch` is never in a secret.** The script sets it from the branch table,
  using `git rev-parse --abbrev-ref HEAD` for dev, and refuses a detached HEAD.
- **Each account holds only its own stacks' secrets.** A missing secret therefore stops
  `production-understory` being created in the staging account. That matters because its
  retained buckets would take production's bucket names, which are unique across all of
  AWS.

### The deploy script: `npm run deploy -- <stack-name> [--no-confirm-changeset]`

New `app/aws/deploy/`, CommonJS, no dependencies, shelling out to `aws` and `sam`:

- **`config.js`,** pure and unit-tested:
  - **`parseTemplateParameters(text)`** reads the template's `Parameters:` block line by
    line, because the root has no YAML dependency. It returns each parameter's name,
    `Default` (absent is different from `""`) and `NoEcho`.
    - Names are anchored at two spaces: `^  ([A-Za-z][A-Za-z0-9]*):\s*$`. Only
      `Default:` and `NoEcho:` are read, at four spaces.
    - One pair of matching quotes is stripped.
    - The block ends at the next column-0 key.
    - It throws on block scalars, duplicate names, or no parameters at all.
  - **`environmentForStack(name)`:** `<owner>-dev-understory` → `dev`;
    `staging-understory` → `staging`; `production-understory` → `production`. It refuses
    any other name, and any name over 27 characters, the cap from the Naming section of
    AGENTS.md.
  - **`resolveParameters({ parameters, secret, environment, branch, live })`** returns a
    value for every template parameter, or a list of errors:
    - It refuses any secret key that is not a template parameter, and refuses
      `GitHubBranch` in a secret.
    - Every parameter gets the secret's value, otherwise the template `Default`. It is an
      error if a parameter has neither; today that is only the token.
    - It refuses `BaseDomainName` and `CertificateArn` unless both are set or both are
      empty. `HasCustomDomain` needs both and would otherwise quietly drop the domain.
    - **On staging and production,** `BaseDomainName` and `CertificateArn` must be set,
      and the `HostedZoneId` key must be present. It may be empty, when the zone is
      outside the account.
    - **Whenever a custom domain is set, `ImageApiForceHost` must be empty.** It takes
      precedence over the custom domain (`IiifServer` `ForceHost`).
    - **On a dev stack with no custom domain,** `ImageApiForceHost` is the secret's
      value, otherwise the stack's own `ImagesDistributionHost` output, once the stack
      exists. This replaces the "copy the output, deploy again" step in AGENTS.md: after
      creating a dev stack, the script says to run it once more.
    - **A dev stack may set a custom domain only with a `ProjectName` other than
      `understory`.** The hostnames are `<prefix>-<ProjectName>.<base>`, so it can never
      take staging's or production's names.
    - **On an existing staging or production stack, it refuses any change to
      `BaseDomainName` or `ProjectName`.** Together they make `IIIF_BASE_URL`, which is
      part of every published manifest id.
    - It refuses values containing whitespace, quotes or backslashes.
  - **`overrideArgs(values)`** builds one argv element per parameter, writing an empty
    value as `Key=""`.
- **`index.js`:**
  1. **Who and where.** Run `aws sts get-caller-identity` and print the account and
     role. Every `aws` and `sam` call passes `--region us-east-1`.
  2. **Inputs.** Read `understory/<stack>` with `aws secretsmanager get-secret-value`.
     Print the secret's key names only. Read the live stack, if any, with
     `describe-stacks`.
  3. **Resolve.** Run `resolveParameters`, then print the changes from the live stack's
     parameters, leaving out NoEcho parameters, before anything else runs.
  4. **Build.** `sam build --use-container`, from `app/aws`.
  5. **Deploy.** `sam deploy` with `--stack-name`,
     `--capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND`, `--resolve-s3`,
     `--s3-prefix <stack>`, `--no-fail-on-empty-changeset` and `--parameter-overrides`.
     - `sam` runs with inherited stdio, so the changeset prompt reaches the terminal.
     - Staging and production always confirm the changeset. `--no-confirm-changeset` is
       accepted for dev only.
     - Both `sam` commands take `--config-file app/aws/deploy/samconfig.empty.toml`, a
       committed file containing only `version = 0.1`. SAM refuses a `--config-file`
       that does not exist, and loads nothing from a file with no matching section. So a
       developer's personal `samconfig.toml` cannot add a role, tags, rollback settings
       or old overrides to a shared stack.
  6. **Afterwards.** Exit code 0 can mean executed, empty, or declined, so read
     `describe-stacks` again:
     - **A staging or production stack in a `*_COMPLETE` state** gets termination
       protection enabled. This is idempotent.
     - **A stack that was just created, or whose branch changed,** gets an Amplify build
       with `aws amplify start-job`, provided the branch exists on origin
       (`git ls-remote`). Otherwise the script says to push it. CloudFormation never
       starts a build itself (AGENTS.md, Amplify deployment), and a branch change
       replaces `AmplifyBranch`, because `BranchName` is create-only in the CloudFormation
       registry schema.
     - The script prints the `UIEndpoint`, `IIIFEndpoint`, `ImagesEndpoint` and
       `PublicSearchUrl` outputs.

Root `package.json` gains `"deploy": "node app/aws/deploy/index.js"`.

### Template changes (`app/aws/template.yml`)

- **Buckets: `DeletionPolicy: Retain` becomes `RetainExceptOnCreate`.** Today a failed
  first create leaves both buckets behind, and the retry fails because the names are
  taken. After a successful create, it behaves exactly like `Retain`.
- **User pool and the `admin` and `editor` groups: add `DeletionPolicy:
  RetainExceptOnCreate` and `UpdateReplacePolicy: Retain`.** This is how decision 4's
  user-pool protection is delivered. It deliberately does not use Cognito's
  `DeletionProtection` property:
  - The property would need an environment parameter, and adding it would send a full
    `UpdateUserPool` to every existing pool.
  - With it active, a failed first create cannot roll back, because the pool cannot be
    deleted. The first staging create, which waits on the Amplify domain, is the deploy
    most likely to fail.
  - Retention policies are resource attributes, so no pool is updated.
  - **Consequence:** an attribute cannot vary by environment, so dev stacks also keep
    their pool on deletion, as they already keep their buckets.
  - Termination protection remains the guard against deleting a shared stack. A
    replacement still shows in the changeset that a person confirms.
- **`GitHubRepo` gets the default `https://github.com/nulib-ds/understory`,** so a dev
  secret needs only the token.
- **New output `AmplifyAppId` (`!GetAtt AmplifyApp.AppId`),** for `start-job`.
- **No new parameters.** The environment is the script's concern only.

### Docs

- **AGENTS.md:**
  - **A new "Stacks and deploying" section** covering:
    - the three environments and the branch table;
    - the secret: its shape, that a developer maintains it by hand, and that it lives
      in its stack's account;
    - the script's rules, and the SAM behaviours above that make them necessary;
    - the safeguards;
    - a runbook for staging and production:
      1. create the `staging` branch;
      2. create the secret in that account;
      3. check the wildcard certificate and the zone;
      4. in a new account, check that the Lambda concurrency quota leaves room for
         `PublicSearchFunction`'s reservation of 10;
      5. check `aws serverlessrepo get-application` from the production account;
      6. run the first deploy;
      7. wait for `AmplifyDomain`;
      8. seed the first admin;
    - handling the token: it should be a fine-grained token limited to
      `nulib-ds/understory`, because every admin in the shared account can read
      staging's secret. Its permissions get documented once verified.
  - **Rewrite** "Local Development › 2" and the commands list around `npm run deploy`.
    Keep the warning about a bare `sam build`.
  - **Naming:** correct "only one stack per base domain" to one per `ProjectName` and
    base domain.
  - **"Moving a stack off the shared domain", step 1:** `sam deploy` ignores parameters
    the template no longer declares, so removing them is only tidying.
  - **Project Structure:** list `app/aws/deploy/`. `samconfig.toml` becomes optional, only
    for `sam sync`, and holds no secrets.
  - **The test count** in Testing Guidelines.
  - **"Commit & Pull Request Guidelines":** add that only a human developer commits,
    pushes or opens a pull request, and that an agent leaves its changes uncommitted.
- **README "Getting started":** secret, then `npm run deploy`. Drop the stale "OpenSearch
  domain" prerequisite.
- **`samconfig.toml.example`:** the stack name only, for `sam sync`. No
  `parameter_overrides` and no token.

## Not in this change

- S3 versioning (not chosen).
- Git checks on deploy (not wanted).
- Cost-allocation tags.
- CI-driven deploys.
- Moving Amplify from `OauthToken` to the GitHub App (`AccessToken`), which AWS
  recommends and which needs an org admin to install the app.
- Generating `ui/.env.local`.

## Execution order

**Only a human developer commits, pushes or opens a pull request.** The agent
implementing this plan never runs `git commit`, `git push` or `gh pr create`. It leaves
every change in the working tree for a developer to review and commit.

1. **Write the plan.** Switch to a new local branch, `implement-staging-production`
   (`git switch -c`, no commit), and write this plan to
   `docs/implement-staging-production.md`, with no sensitive material.
2. **Add the commit rule above to AGENTS.md,** at the top of "Commit & Pull Request
   Guidelines".
3. **Make the template changes,** then the script and its tests, then the docs.
4. **Run the offline checks** (see Verification), then the live steps. Those need Mat to
   create the secrets, push branches and confirm shared-stack changesets.

## Verification

1. **`npm test`.** New tests in `app/aws/deploy/__tests__/config.test.js`:
   - The parser, against the real `template.yml`, pins the ordered list of names,
     defaults and NoEcho:
     - `ServerlessIiifVersion` has no quotes left;
     - `SearchMaxOcu` is `"2"`;
     - the empty defaults are `""`, not absent;
     - `GitHubRepo` has the new default;
     - only the token is NoEcho.
   - The parser throws on a block scalar and on a duplicate name.
   - Stack name → environment, including the refusals.
   - Unknown key, misspelled key, missing token, and `GitHubBranch` in a secret.
   - Exactly one of `BaseDomainName` and `CertificateArn` set.
   - A persistent stack without a domain or certificate, or without the `HostedZoneId`
     key.
   - `ImageApiForceHost` alongside a custom domain.
   - A dev stack with a custom domain under `ProjectName` `understory`.
   - A change to the IIIF base on an existing persistent stack.
   - `ImageApiForceHost` derivation.
   - Whitespace or quotes in a value.
   - `overrideArgs` writes an empty value as `Key=""`.
2. **Template checks:** `cd app/aws && sam validate`, and
   `uvx cfn-lint@latest app/aws/template.yml`.
3. **Your own dev stack:**
   - Mat creates `understory/<owner>-dev-understory` holding only the token, and removes
     the token from the personal `samconfig.toml`.
   - Run `npm run deploy -- <owner>-dev-understory`.
   - The printed parameter changes should show only `GitHubBranch` when deploying from a
     branch other than `main`.
   - The changeset should change only retention attributes, the new output, and the
     Amplify branch if it moved.
   - Check that `ImageApiForceHost` keeps its live value and that images still load
     through the CDN.
4. **Negative checks.** Each must fail before any `sam` call:
   - a secret key misspelled as `baseDomain`;
   - `staging-understory` before its secret exists;
   - the stack name `test-understory`.
5. **Rehearsal (recommended), on a throwaway dev stack:**
   - use staging's base domain, certificate and zone, with `ProjectName` set to
     `understory-<owner>`;
   - this exercises, before staging, the custom-certificate Amplify domain, Amplify
     writing its own record, the two DNS records, and the token's permissions.
6. **Staging. Mat runs it and confirms the changeset:**
   - create and push the `staging` branch, create the secret, then run
     `npm run deploy -- staging-understory`;
   - check that `AmplifyDomain` reaches AVAILABLE, the three hostnames resolve,
     termination protection is on and the build ran;
   - seed an admin, publish and flip one collection, and query `PublicSearchUrl`.
7. **Production:** the same runbook, with production credentials, run by Mat.

## Unverified, to settle during implementation

- **The token's minimal fine-grained permissions.** Settle on the rehearsal, before
  documenting them.
- **Whether a later update to the Amplify app needs a valid token.** Until known, keep
  each secret's token valid.
- **Whether the serverless-iiif application can be deployed from the production
  account.** Checked as part of its runbook.
- **The UI address for a dev branch name containing `/`,** compared with the
  `UIEndpoint` output, which is built from the raw branch name.
