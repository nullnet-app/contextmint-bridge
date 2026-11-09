# Releasing ContextMint Bridge

A release is a merged release-please PR. Its `vX.Y.Z` tag starts everything
below; nothing after the merge is manual except **releasing the approved App
Store versions**, which stays the owner's call.

## What happens on a tag

| Workflow                | Job                                      | What it does                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-please.yml`    | `attach-extension`                       | Builds Chrome and Safari from the tag and attaches `contextmint-bridge-{chrome,safari}-X.Y.Z.zip` and a `.sha256` of each to the GitHub Release. Never overwrites an asset.                                          |
| `release-please.yml`    | `chrome-web-store`                       | Downloads the Release's Chrome zip, checks it against its `.sha256`, uploads it to the Chrome Web Store and submits it for review. It publishes when Google approves it. Skips green until it is configured (below). |
| `deploy-safari-app.yml` | `testflight (iOS)`, `testflight (macOS)` | Archives `apple/`, uploads each build to TestFlight, waits for processing, then submits that build for App Review (below).                                                                                           |

The jobs are independent. A green tag does not mean every store has the
release: read each job's notices and warnings.

## Chrome Web Store

The job uses the [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/api)
(`chromewebstore.googleapis.com`):

1. `fetchStatus`, to find out what the store already has.
2. `upload`, the Release's own zip. It never uploads a rebuild. While the store
   reports `IN_PROGRESS`, the job polls `fetchStatus`.
3. `publish` with `publishType: DEFAULT_PUBLISH`. This submits the package for
   review, and the store publishes it as soon as it is approved. `skipReview`
   and staged publishing are not used.

It authenticates as a Google Cloud **service account** that is linked to the
Chrome Web Store publisher
([service accounts](https://developer.chrome.com/docs/webstore/service-accounts)).
The job gets that account's access token through **Workload Identity
Federation** (`google-github-actions/auth`). GitHub's OIDC token is exchanged
for a token that lives at most 30 minutes, and its only scope is
`https://www.googleapis.com/auth/chromewebstore`. There is no JSON key and no
OAuth refresh token to store, rotate or leak.

| State in the store                                       | What the job does                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| This version already published, or a newer one published | `::notice::`. Uploads nothing.                                                         |
| This version already `PENDING_REVIEW` or `STAGED`        | `::notice::`. Uploads nothing, so a re-run does nothing.                               |
| Another version `PENDING_REVIEW` or `STAGED`             | `::warning::` that names it. Uploads nothing and never cancels anything. See Recovery. |
| Otherwise                                                | Uploads, waits for the upload to finish, then publishes (submits for review).          |
| Any API error                                            | The job fails with Google's error message.                                             |

### One-time setup (owner)

All four values are identifiers, not secrets, so they are **repository
variables**. Until all four are set, the job prints a notice that names the
ones that are missing, and it stays green.

1. **A Google Cloud project, with the APIs enabled.** Use an existing project
   or create one:

   ```sh
   PROJECT_ID=contextmint-bridge-release   # any id
   gcloud projects create "$PROJECT_ID"
   gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com --project="$PROJECT_ID"
   ```

2. **A service account with no roles.** The Chrome Web Store grants its
   access, not IAM:

   ```sh
   gcloud iam service-accounts create cws-publisher --project="$PROJECT_ID" \
     --display-name="ContextMint Bridge Chrome Web Store publisher"
   SA="cws-publisher@${PROJECT_ID}.iam.gserviceaccount.com"
   ```

3. **A Workload Identity pool and provider** that admit only this repo's
   `main`. Both the release and a `republish_tag` dispatch run on
   `refs/heads/main`:

   ```sh
   gcloud iam workload-identity-pools create github --project="$PROJECT_ID" \
     --location=global --display-name="GitHub Actions"
   gcloud iam workload-identity-pools providers create-oidc contextmint-bridge \
     --project="$PROJECT_ID" --location=global --workload-identity-pool=github \
     --issuer-uri="https://token.actions.githubusercontent.com" \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
     --attribute-condition="assertion.repository == 'nullnet-app/contextmint-bridge' && assertion.ref == 'refs/heads/main'"
   POOL=$(gcloud iam workload-identity-pools describe github --project="$PROJECT_ID" \
     --location=global --format='value(name)')
   gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$PROJECT_ID" \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/${POOL}/attribute.repository/nullnet-app/contextmint-bridge"
   gcloud iam workload-identity-pools providers describe contextmint-bridge --project="$PROJECT_ID" \
     --location=global --workload-identity-pool=github --format='value(name)'
   # → projects/<number>/locations/global/workloadIdentityPools/github/providers/contextmint-bridge
   ```

4. **Link the service account to the publisher.** In the
   [Developer Dashboard](https://chrome.google.com/webstore/devconsole), go to
   **Account**, then the service account section, and add the `$SA` email. A
   publisher can link only one service account. Copy the **publisher ID** from
   **Publisher → Settings**, and the item ID (the extension's 32-letter ID) from
   the item's page.

5. **Set the variables:**

   ```sh
   R=nullnet-app/contextmint-bridge
   gh variable set CWS_PUBLISHER_ID --repo "$R" --body "<publisher id>"
   gh variable set CWS_ITEM_ID --repo "$R" --body "<item id>"
   gh variable set CWS_WORKLOAD_IDENTITY_PROVIDER --repo "$R" --body "projects/<number>/locations/global/workloadIdentityPools/github/providers/contextmint-bridge"
   gh variable set CWS_SERVICE_ACCOUNT --repo "$R" --body "$SA"
   ```

The API publishes with the visibility the dashboard already has. If you change
the visibility in the dashboard, publish once by hand with the new visibility
before the API can publish again.

## App Review (App Store, macOS and iOS)

After its TestFlight upload, each platform's job runs **Submit for App
Review**. The decisions are made in `apple/tools/app-review.ts`; the step only
runs `asc`.

- **The build.** The job resolves the build it just uploaded by version, build
  number and platform (`asc builds info`). It refuses to continue if that build
  is not the one `asc publish testflight` reported. It never submits "latest",
  and `asc review submit --wait` waits until the build is `VALID`.
- **The version.** The job submits the platform's editable version. If that
  version has an older version string, the job renames it (`asc versions update
--version`). If no version is editable, the job creates one (`asc versions
create --release-type MANUAL`, copying the live version's description,
  keywords and URLs, but not its What's New).
- **What's New** comes from this release's section of `CHANGELOG.md`, as plain
  text, and only for English locales. Nothing is added to it. On a platform
  where the app has never been released, App Store Connect accepts no What's
  New, so the field is left empty. Other locales keep what they already have.
- **The release stays MANUAL.** The job never releases a version, never changes
  an existing version's release type, never cancels a submission and never
  deletes anything. When Apple approves a version, release it in App Store
  Connect.

| State of this platform's versions                                                                                                                  | Action                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| This version is `WAITING_FOR_REVIEW`, `IN_REVIEW`, `PENDING_DEVELOPER_RELEASE` (or another state where Apple holds it)                             | `::notice::`. Already submitted, so nothing changes and a re-run does nothing.                                    |
| This version is live (`READY_FOR_DISTRIBUTION`, …)                                                                                                 | `::notice::`. Nothing changes.                                                                                    |
| Another version is with Apple (in review, approved and waiting for you, or a state the tool does not know)                                         | `::warning::` that names the version and the remedy. Nothing is cancelled or submitted.                           |
| An editable version exists (`PREPARE_FOR_SUBMISSION`, `READY_FOR_REVIEW`, `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`) | Renamed to this version if its string differs, given What's New, and this run's build submitted.                  |
| Nothing is editable                                                                                                                                | A version is created (MANUAL, metadata copied from the live version), given What's New, and this build submitted. |
| An `asc` call fails                                                                                                                                | The job fails, and the error names the manual `asc review submit` command.                                        |

**Turning it off.** Set the repository variable `APP_REVIEW_SUBMIT` to
`false`. Builds then go to TestFlight only, with a notice. Delete the variable,
or set it to `true`, to submit again. Any other value is treated as off and
produces a warning. Submission is never on by accident.

```sh
gh variable set APP_REVIEW_SUBMIT --repo nullnet-app/contextmint-bridge --body false
gh variable delete APP_REVIEW_SUBMIT --repo nullnet-app/contextmint-bridge
```

## Recovery

- **Assets missing, or the Chrome Web Store upload failed:** dispatch
  `release-please.yml` from `main` with `republish_tag=vX.Y.Z`. The
  attach job leaves any asset that is already there alone. The store job checks
  the store first, so a version that is already uploaded or submitted is not
  sent again. Do the same after the variables are set for the first time, to
  submit a release that was skipped.
- **The Chrome Web Store skipped because another version is in review:** wait
  until that version is published, or rejected or cancelled in the dashboard.
  Then dispatch with `republish_tag`.
- **App Review skipped because another version is with Apple:** wait for
  Apple's decision on that version, or release it if it is approved. Then
  re-run the `testflight` job, which uploads a new build and submits it.
  Alternatively, submit the build from the warning by hand with `asc review
submit`.
- **App Review failed after the TestFlight upload:** re-run the failed job. The
  build is already on TestFlight, so you can also finish by hand with the
  `asc review submit` command in the error.
- **A green tag is not a green store.** Check with `asc versions list --app
6819349214` and the Chrome Web Store dashboard.
