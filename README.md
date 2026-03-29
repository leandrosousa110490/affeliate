# Weekly Amazon Deal Radar (GitHub Pages)

A static affiliate-content app that publishes a new SEO-friendly article every week using Amazon Creators API data.

Current focus: new video games, gaming systems, and gaming accessories.

## Your tracking ID

- Default partner tag in this project is now: `alyssasousa-20`
- It is prefilled in `.env.example` and used as fallback in the generator.

## What this project does

- Pulls Amazon products from selected categories (from `config/categories.json`)
- Scores products using discount + review + rank signals
- Generates:
  - `docs/index.html` (latest issue)
  - `docs/articles/*.html` (weekly article pages)
  - `docs/sitemap.xml`, `docs/robots.txt`, `docs/feed.xml`
- Runs weekly in GitHub Actions and auto-commits updates

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill values.
3. Run the generator:
   ```bash
   npm run build-content
   ```
4. Preview locally:
   ```bash
   npm run start
   ```
   Then open `http://localhost:4173`.

If credentials are missing, the script uses `data/mock-products.json` so you can still preview the site.

## Use SiteStripe right now (no API access needed)

If your API is blocked (`AssociateNotEligible`), you can publish now with manual curation:

1. Run auto-pick (recommended):
   ```bash
   npm run refresh-manual
   ```
   This pulls current discounted products from Amazon Deals into `data/manual-products.json`.
2. (Optional) Edit `data/manual-products.json` yourself for custom picks.
3. Set:
   ```bash
   CONTENT_SOURCE=manual
   ```
4. Run:
   ```bash
   npm run build-content
   ```

In manual mode, the generator enforces discount quality gates and adds readable product summaries automatically.

## What you still need and where to get it

1. `AMAZON_CREDENTIAL_ID`
   - Where: Amazon Associates -> Creators API -> Manage credentials
   - Looks like: `amzn1.application-oa2-client....`
2. `AMAZON_CREDENTIAL_SECRET`
   - Where: same credential modal (save it immediately)
   - Looks like: `amzn1.oa2-cs.v1....`
3. `AMAZON_CREDENTIAL_VERSION`
   - Where: same credential modal
   - For your setup: `3.1`
4. `SITE_URL`
   - Where: your GitHub Pages URL after enabling Pages
   - Example: `https://YOUR-USERNAME.github.io/amazonassociates`
5. `AMAZON_MARKETPLACE`
   - Use `www.amazon.com` for US

## Required secrets (GitHub Actions)

Add these in repo settings -> `Secrets and variables` -> `Actions`:

- `AMAZON_CREDENTIAL_ID`
- `AMAZON_CREDENTIAL_SECRET`
- `AMAZON_CREDENTIAL_VERSION` (example: `3.1`)
- `AMAZON_PARTNER_TAG` (set to `alyssasousa-20`)
- `AMAZON_MARKETPLACE` (example: `www.amazon.com`)
- `SITE_URL` (example: `https://YOUR-USERNAME.github.io/amazonassociates`)
- Optional quality controls:
  - `MIN_RATING` (default `4.2`)
  - `MIN_SAVING_PERCENT` (default `10`)
  - `MIN_REVIEW_COUNT` (default `100`)
  - `CONTENT_SOURCE` (`auto`, `live`, `manual`, `mock`; default `auto`)

## GitHub Pages deployment

1. Push this repo to GitHub.
2. In GitHub repo settings -> Pages:
   - Source: `Deploy from a branch`
   - Branch: `main` (or your default branch)
   - Folder: `/docs`
3. Run the workflow once manually from the Actions tab (`Weekly Affiliate Content Refresh`).

## Customize categories

Edit `config/categories.json`:

- `name`: category section title
- `intro`: section summary
- `keywords`: product query list
- `minSavingPercent`, `minReviewsRating`, `itemCount`: query tuning

## Product quality rules now enforced

The generator now excludes products unless they pass all of these gates:

- Discounted by at least `MIN_SAVING_PERCENT` (default `10%`)
- Rating at or above `MIN_RATING` (default `4.2`)
- Review count at or above `MIN_REVIEW_COUNT` (default `100`)

It also writes a readable summary paragraph for each product on the generated pages.

## Why API is failing now and how to resolve

If you see `AccessDeniedException` with `AssociateNotEligible`, your account is not yet eligible for API access.

Resolve checklist:

1. Make sure your Associates account is fully approved (not pending).
2. In Amazon Associates Help, the account dormancy guidance says new accounts must drive qualifying sales in the first 180 days.
3. Verify your store/site is listed in Associates account settings and is compliant with Operating Agreement/policies.
4. After account approval/eligibility updates, retry with:
   ```bash
   CONTENT_SOURCE=live
   npm run build-content
   ```

## Important

- This project cannot guarantee revenue.
- Follow Amazon Associates Program policies and disclosures.
- Prices and deals change frequently, so the site should be refreshed regularly.

