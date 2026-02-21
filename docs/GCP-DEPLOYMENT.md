# GCP Deployment (GitHub Actions)

This service deploys to **Google Cloud Run** on push to `main` via GitHub Actions.

## Deployed URL

**Production:** https://l2r-linkedin-api-service-lsprjluhtq-as.a.run.app

- **Health (no auth):** `GET /health`
- **Profile (Bearer token):** `GET /api/v2/profile/:vanityName`

## One-time GCP setup (already done for this project)

1. **Workload Identity:** Repo `metafest/l2r-linkedin-api-service` was added to the service account binding in project `resume-builder-467117`.
2. **Secret Manager API** was enabled.
3. **Secrets created:** `api-token`, `linkedin-credentials-json` (in project `resume-builder-467117`).

To add a new repo to the same project, run (replace repo name):

```bash
gcloud iam service-accounts add-iam-policy-binding github-actions-deployer@resume-builder-467117.iam.gserviceaccount.com \
  --project=resume-builder-467117 \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/188294918674/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/metafest/YOUR_REPO_NAME"
```

## Updating secrets

- **API token:** In GCP Console → Secret Manager → `api-token` → New version (or use `gcloud secrets versions add`).
- **LinkedIn credentials:** Update `linkedin-credentials-json` with a new version when cookies/CSRF are refreshed.

After updating, redeploy (push to `main` or run the `deploy` workflow manually) so Cloud Run picks up new secret versions.
