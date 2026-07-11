# Kindling

Churn-aware job board that scores employers against BLS JOLTS turnover data.

## Hosting

`index.html` is the browser app. Host it from GitHub Pages, `claudemcp.uk`, or another static host. The browser calls the deployed `cf0` Worker for keyed job sources.

The Worker source is `kindling-worker.js`. `wrangler.toml` makes `cf0` the deployment target, and `.github/workflows/deploy-worker.yml` deploys it automatically when Worker files land on `main`.

Add these GitHub Actions secrets before merging Worker changes:

- `CLOUDFLARE_API_TOKEN`: token with Workers edit permission
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID that owns `cf0`

API keys entered in the app's Settings are not stored in this repository.
