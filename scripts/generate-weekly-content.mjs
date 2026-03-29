import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import creatorsApi from "amazon-creators-api";

const { ApiClient, SearchItemsRequestContent, SearchItemsResource, SortBy, TypedDefaultApi } =
  creatorsApi;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const PATHS = {
  config: path.join(ROOT_DIR, "config", "categories.json"),
  mockProducts: path.join(ROOT_DIR, "data", "mock-products.json"),
  manualProducts: path.join(ROOT_DIR, "data", "manual-products.json"),
  latestJson: path.join(ROOT_DIR, "docs", "data", "latest.json"),
  archiveJson: path.join(ROOT_DIR, "docs", "data", "archive.json"),
  indexHtml: path.join(ROOT_DIR, "docs", "index.html"),
  sitemapXml: path.join(ROOT_DIR, "docs", "sitemap.xml"),
  robotsTxt: path.join(ROOT_DIR, "docs", "robots.txt"),
  feedXml: path.join(ROOT_DIR, "docs", "feed.xml"),
  noJekyll: path.join(ROOT_DIR, "docs", ".nojekyll"),
};

const SITE_URL = resolveSiteUrl();
const REQUIRED_ENV = ["AMAZON_CREDENTIAL_ID", "AMAZON_CREDENTIAL_SECRET", "AMAZON_CREDENTIAL_VERSION"];
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || "alyssasousa-20";
const CONTENT_SOURCE = (process.env.CONTENT_SOURCE || "auto").toLowerCase();
const QUALITY_GATES = {
  minRating: Number(process.env.MIN_RATING || 4.2),
  minSavingPercent: Number(process.env.MIN_SAVING_PERCENT || 10),
  minReviewCount: Number(process.env.MIN_REVIEW_COUNT || 100),
};

const RESOURCE_FIELDS = [
  "images.primary.large",
  "images.primary.medium",
  "itemInfo.title",
  "itemInfo.features",
  "offersV2.listings.price",
  "offersV2.listings.dealDetails",
  "offersV2.listings.availability",
  "customerReviews.starRating",
  "customerReviews.count",
  "browseNodeInfo.websiteSalesRank",
];

function resolveSiteUrl() {
  const configured = String(process.env.SITE_URL || "").trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  const inferred = inferGitHubPagesUrl();
  if (inferred) {
    return inferred;
  }
  return "https://YOUR-GITHUB-USERNAME.github.io/amazonassociates";
}

function inferGitHubPagesUrl() {
  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
    if (!match) {
      return null;
    }
    const owner = match[1];
    const repo = path.basename(ROOT_DIR);
    return `https://${owner}.github.io/${repo}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function main() {
  const categoryConfig = await readJson(PATHS.config);
  if (!Array.isArray(categoryConfig) || categoryConfig.length === 0) {
    throw new Error("config/categories.json must contain at least one category.");
  }

  const now = new Date();
  const publicationDate = now.toISOString().slice(0, 10);
  const slug = `${publicationDate}-amazon-weekly-finds`;
  const hasCredentials = REQUIRED_ENV.every((key) => Boolean(process.env[key]));
  const manualProducts = normalizeManualProducts(await readJson(PATHS.manualProducts, []));
  const mockProducts = await readJson(PATHS.mockProducts, []);

  const { products, source } = await resolveProducts({
    hasCredentials,
    categoryConfig: categoryConfig,
    manualProducts,
    mockProducts,
  });
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error("No products were returned. Check credentials, category settings, and API quota.");
  }

  const article = buildArticle({
    slug,
    publicationDate,
    products,
    categoryConfig: categoryConfig,
    source,
  });

  const nextArchive = [toArchiveEntry(article)];

  await writeJson(PATHS.latestJson, article);
  await writeJson(PATHS.archiveJson, nextArchive);
  await pruneArticlePages(new Set(nextArchive.map((entry) => entry.slug)));
  await writeFile(PATHS.indexHtml, renderHomePage(article, nextArchive));
  await writeFile(path.join(ROOT_DIR, "docs", "articles", `${slug}.html`), renderArticlePage(article));
  await writeFile(PATHS.sitemapXml, renderSitemap(nextArchive, slug));
  await writeFile(PATHS.robotsTxt, renderRobotsTxt());
  await writeFile(PATHS.feedXml, renderFeed(nextArchive));
  await writeFile(PATHS.noJekyll, "");

  console.log(`Generated weekly content (${article.source}).`);
  console.log(`Products selected: ${article.productCount}`);
  console.log(`New article: /articles/${article.slug}.html`);
}

async function fetchLiveProducts(categories) {
  const apiClient = new ApiClient();
  apiClient.credentialId = process.env.AMAZON_CREDENTIAL_ID;
  apiClient.credentialSecret = process.env.AMAZON_CREDENTIAL_SECRET;
  apiClient.version = process.env.AMAZON_CREDENTIAL_VERSION;
  const api = new TypedDefaultApi(apiClient);
  const products = [];

  for (const category of categories) {
    const keywords = Array.isArray(category.keywords) ? category.keywords : [];
    for (const keyword of keywords) {
        const requestPayload = {
        partnerTag: PARTNER_TAG,
        itemCount: category.itemCount ?? 10,
        keywords,
        searchIndex: category.searchIndex || "All",
        minSavingPercent: category.minSavingPercent ?? 0,
        minReviewsRating: category.minReviewsRating ?? 0,
        sortBy: SortBy.constructFromObject("Featured"),
        resources: RESOURCE_FIELDS.map((field) => SearchItemsResource.constructFromObject(field)),
      };
      requestPayload.keywords = keyword;
      const request = SearchItemsRequestContent.constructFromObject(requestPayload);

      try {
        const response = await api.searchItems(MARKETPLACE, request);
        const items = response?.searchResult?.items ?? [];
        for (const item of items) {
          const parsed = parseApiItem(item, category.name, keyword, PARTNER_TAG);
          if (parsed) {
            products.push(parsed);
          }
        }
      } catch (error) {
        console.warn(`Creators API error for "${category.name}" / "${keyword}": ${formatError(error)}`);
      }
      await sleep(350);
    }
  }
  return products;
}

async function resolveProducts({ hasCredentials, categoryConfig, manualProducts, mockProducts }) {
  if (CONTENT_SOURCE === "manual") {
    return { products: manualProducts, source: "manual" };
  }
  if (CONTENT_SOURCE === "mock") {
    return { products: mockProducts, source: "mock" };
  }
  if (CONTENT_SOURCE === "live") {
    if (!hasCredentials) {
      throw new Error("CONTENT_SOURCE=live but API credentials are missing.");
    }
    return { products: await fetchLiveProducts(categoryConfig), source: "live" };
  }

  if (hasCredentials) {
    const liveProducts = await fetchLiveProducts(categoryConfig);
    if (liveProducts.length) {
      return { products: liveProducts, source: "live" };
    }
    if (manualProducts.length) {
      return { products: manualProducts, source: "manual-fallback" };
    }
    return { products: mockProducts, source: "mock-fallback" };
  }

  if (manualProducts.length) {
    return { products: manualProducts, source: "manual" };
  }

  return { products: mockProducts, source: "mock" };
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function parseApiItem(item, category, keyword, partnerTag) {
  const listing = item?.offersV2?.listings?.[0];
  const money = listing?.price?.money;
  const title = item?.itemInfo?.title?.displayValue;
  const detailPageUrl = item?.detailPageURL;

  if (!item?.asin || !title || !detailPageUrl || !money?.amount) {
    return null;
  }

  const savingsPercent = Number(listing?.price?.savings?.percentage ?? 0);
  const savingsAmount = Number(listing?.price?.savings?.money?.amount ?? 0);
  const imageUrl =
    item?.images?.primary?.large?.url || item?.images?.primary?.medium?.url || item?.images?.primary?.small?.url;

  return {
    asin: item.asin,
    title,
    detailPageUrl: withPartnerTag(detailPageUrl, partnerTag),
    imageUrl,
    priceAmount: Number(money.amount),
    priceDisplay: money.displayAmount || `$${Number(money.amount).toFixed(2)}`,
    savingsAmount,
    savingsPercent,
    rating: Number(item?.customerReviews?.starRating?.value ?? 0),
    reviewCount: Number(item?.customerReviews?.count ?? 0),
    salesRank: Number(item?.browseNodeInfo?.websiteSalesRank?.salesRank ?? 0),
    isDeal: Boolean(listing?.dealDetails?.badge),
    category,
    keyword,
    featureBullets: item?.itemInfo?.features?.displayValues ?? [],
    sourceTag: "live",
  };
}

function normalizeManualProducts(products) {
  if (!Array.isArray(products)) {
    return [];
  }
  return products
    .filter((product) => product && product.asin && product.title && product.detailPageUrl)
    .map((product) => ({
      asin: String(product.asin),
      title: String(product.title),
      detailPageUrl: withPartnerTag(String(product.detailPageUrl), PARTNER_TAG),
      imageUrl: product.imageUrl ? String(product.imageUrl) : "",
      priceAmount: Number(product.priceAmount || 0),
      priceDisplay: product.priceDisplay ? String(product.priceDisplay) : "$--",
      savingsAmount: Number(product.savingsAmount || 0),
      savingsPercent: Number(product.savingsPercent || 0),
      rating: Number(product.rating || 0),
      reviewCount: Number(product.reviewCount || 0),
      salesRank: Number(product.salesRank || 0),
      isDeal: Boolean(product.isDeal ?? true),
      category: String(product.category || "Manual Picks"),
      keyword: String(product.keyword || "manual pick"),
      featureBullets: Array.isArray(product.featureBullets) ? product.featureBullets : [],
      manualSummary: product.summary ? String(product.summary) : "",
      sourceTag: "manual",
    }));
}

function buildArticle({ slug, publicationDate, products, categoryConfig, source }) {
  const normalized = products.map((product) => ({
    ...product,
    detailPageUrl: withPartnerTag(product.detailPageUrl, PARTNER_TAG),
  }));
  const deduped = dedupeProducts(normalized).filter(passesQualityGate);
  if (!deduped.length) {
    throw new Error(
      "No products passed quality gates. Relax MIN_RATING / MIN_SAVING_PERCENT / MIN_REVIEW_COUNT or broaden category keywords.",
    );
  }
  const scored = deduped
    .map((product) => ({
      ...product,
      score: scoreProduct(product),
      reasons: buildReasons(product),
      readableSummary: buildReadableSummary(product),
    }))
    .sort((a, b) => b.score - a.score);

  const sections = [];
  const selectedAsins = new Set();
  for (const category of categoryConfig) {
    const categoryProducts = scored
      .filter((product) => product.category === category.name && !selectedAsins.has(product.asin))
      .slice(0, 4);
    if (categoryProducts.length) {
      categoryProducts.forEach((product) => selectedAsins.add(product.asin));
      sections.push({
        name: category.name,
        intro: category.intro || "Strong picks based on discount signals and shopper demand.",
        products: categoryProducts,
      });
    }
  }

  const fallbackProducts = scored.filter((product) => !selectedAsins.has(product.asin)).slice(0, 12);
  if (fallbackProducts.length) {
    sections.push({
      name: "Bonus High-Momentum Finds",
      intro: "Extra products that scored well this week.",
      products: fallbackProducts,
    });
  }

  const flatProducts = sections.flatMap((section) => section.products).slice(0, 16);
  const totalSavings = flatProducts.reduce((sum, product) => sum + (product.savingsAmount || 0), 0);
  const articleHash = crypto
    .createHash("sha1")
    .update(`${slug}:${flatProducts.map((product) => product.asin).join(",")}`)
    .digest("hex")
    .slice(0, 10);

  const weekLabel = new Date(`${publicationDate}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return {
    id: articleHash,
    slug,
    title: `Best Amazon Weekly Deals (${weekLabel}) - Top Products Worth Watching`,
    description:
      "Fresh weekly Amazon picks selected from high-demand categories using discount, review, and rank signals. Updated every week.",
    publishedAt: `${publicationDate}T00:00:00.000Z`,
    weekLabel,
    source,
    productCount: flatProducts.length,
    totalSavings: Number(totalSavings.toFixed(2)),
    sections,
  };
}

function dedupeProducts(products) {
  const deduped = new Map();
  for (const product of products) {
    if (!product?.asin) {
      continue;
    }
    const current = deduped.get(product.asin);
    if (!current || Number(product.savingsPercent) > Number(current.savingsPercent)) {
      deduped.set(product.asin, product);
    }
  }
  return [...deduped.values()];
}

function scoreProduct(product) {
  const discountScore = Math.min(product.savingsPercent || 0, 80) * 1.6;
  const reviewScore = Math.min(product.reviewCount || 0, 12000) / 180 + (product.rating || 0) * 7;
  const rankScore =
    product.salesRank && product.salesRank > 0
      ? Math.max(0, 120 - Math.log10(product.salesRank + 1) * 40)
      : 12;
  const dealBonus = product.isDeal ? 14 : 0;
  const valueBonus = product.priceAmount > 20 && product.priceAmount < 350 ? 6 : 0;
  return Number((discountScore + reviewScore + rankScore + dealBonus + valueBonus).toFixed(2));
}

function passesQualityGate(product) {
  if (String(product.sourceTag || "").startsWith("manual")) {
    return Number(product.savingsPercent || 0) >= QUALITY_GATES.minSavingPercent;
  }
  return (
    Number(product.savingsPercent || 0) >= QUALITY_GATES.minSavingPercent &&
    Number(product.rating || 0) >= QUALITY_GATES.minRating &&
    Number(product.reviewCount || 0) >= QUALITY_GATES.minReviewCount
  );
}

function buildReasons(product) {
  const reasons = [];
  if (product.savingsPercent > 0) {
    reasons.push(`${product.savingsPercent}% discount signal`);
  }
  if (product.salesRank > 0) {
    reasons.push(`Sales rank #${product.salesRank.toLocaleString()}`);
  }
  if (product.rating > 0 && product.reviewCount > 0) {
    reasons.push(`${product.rating.toFixed(1)} stars from ${product.reviewCount.toLocaleString()} reviews`);
  } else if (String(product.sourceTag || "").startsWith("manual")) {
    reasons.push("Rating details vary by listing; verify latest rating on Amazon");
  }
  if (!reasons.length) {
        reasons.push("High relevance in this week's search pull");
  }
  return reasons.slice(0, 3);
}

function buildReadableSummary(product) {
  if (product.manualSummary) {
    return product.manualSummary;
  }
  const featureText = Array.isArray(product.featureBullets) && product.featureBullets.length
    ? product.featureBullets.slice(0, 2).join(" ")
    : "";
  const ratingText =
    product.rating > 0 && product.reviewCount > 0
      ? `${product.rating.toFixed(1)} stars from ${product.reviewCount.toLocaleString()} reviews`
      : "strong shopper interest";
  const baseline =
    `${product.title} is a strong ${product.keyword} pick with ${ratingText} and a current ` +
    `${product.savingsPercent}% discount signal.`;
  const ending = featureText
    ? ` Highlights: ${featureText}`
    : ` It scored well this week for value, shopper feedback, and demand momentum.`;
  return `${baseline}${ending}`;
}

function withPartnerTag(detailPageUrl, partnerTag) {
  try {
    const url = new URL(detailPageUrl);
    if (partnerTag) {
      url.searchParams.set("tag", partnerTag);
    }
    return url.toString();
  } catch {
    return detailPageUrl;
  }
}

function toArchiveEntry(article) {
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    description: article.description,
    publishedAt: article.publishedAt,
    weekLabel: article.weekLabel,
    productCount: article.productCount,
  };
}

function renderHomePage(article, archive) {
  const headlineProducts = article.sections.flatMap((section) => section.products).slice(0, 8);
  const topDeals = headlineProducts.slice(0, 3);
  const avgDiscount = headlineProducts.length
    ? Math.round(
      headlineProducts.reduce((sum, product) => sum + Number(product.savingsPercent || 0), 0) /
          headlineProducts.length,
    )
    : 0;
  const highRatingCount = headlineProducts.filter((product) => Number(product.rating || 0) >= 4.3).length;
  const homeJsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          name: "Weekly Amazon Deal Radar",
          url: `${SITE_URL}/index.html`,
        },
        {
          "@type": "CollectionPage",
          name: article.title,
          description: article.description,
          datePublished: article.publishedAt,
          dateModified: article.publishedAt,
          url: `${SITE_URL}/index.html`,
        },
        {
          "@type": "ItemList",
          name: `${article.weekLabel} Deal Highlights`,
          itemListElement: headlineProducts.map((product, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: product.title,
            url: product.detailPageUrl,
          })),
        },
      ],
    },
    null,
    2,
  );

  const content = `
    <section class="hero hero-news">
      <p class="live-label">FEATURED DEAL ARTICLE</p>
      <h1>${escapeHtml(article.title)}</h1>
      <p>
        ${escapeHtml(article.description)} This article focuses on video games, gaming hardware, and home entertainment deals with active discounts.
      </p>
      <div class="meta-row">
        <span class="chip">Updated ${escapeHtml(article.weekLabel)}</span>
        <span class="chip">${article.productCount} curated products</span>
        <span class="chip">${avgDiscount}% average discount signal</span>
        <span class="chip">${highRatingCount} highly-rated picks</span>
        <span class="chip">Source: ${article.source}</span>
      </div>
      <div class="notice">
        As an Amazon Associate, this site earns from qualifying purchases. Prices and discount levels can change at any time.
      </div>
    </section>

    <section class="story-wrap">
      <h2 class="section-title">This Week's Best Deals Worth Shopping</h2>
      <p class="section-subtitle">
        This page gives quick highlights and links to the full written article for deeper analysis.
      </p>
      <p class="article-paragraph">
        We prioritize products with meaningful discounts, high review quality, and strong current shopper demand. Availability and pricing can change quickly, so each section links directly to the latest listing.
      </p>
      <p class="article-paragraph">
        Below are the three featured picks for this week, followed by deeper notes on each category.
      </p>
      <div class="products-grid products-grid-wide">${renderProductCards(topDeals)}</div>
    </section>

    <h2 class="section-title">Read The Full Story Page</h2>
    <p class="section-subtitle">
      Open the dedicated story page for this week's complete write-up.
      <a class="article-link" href="./articles/${article.slug}.html">Open latest article</a>
    </p>
  `;

  return renderLayout({
    title: article.title,
    description: article.description,
    canonicalPath: "/index.html",
    content,
    extraHead: `<script type="application/ld+json">${homeJsonLd}</script>`,
  });
}

function renderArticlePage(article) {
  const sectionsMarkup = article.sections
    .map((section, index) => renderEditorialSection(section, index + 1))
    .join("");

  const jsonLd = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: article.title,
      datePublished: article.publishedAt,
      dateModified: article.publishedAt,
      description: article.description,
      author: { "@type": "Person", name: "Amazon Weekly Picks Bot" },
      mainEntityOfPage: `${SITE_URL}/articles/${article.slug}.html`,
      about: article.sections.map((section) => section.name),
    },
    null,
    2,
  );

  const content = `
    <section class="hero">
      <h1>${escapeHtml(article.title)}</h1>
      <p>${escapeHtml(article.description)}</p>
      <div class="meta-row">
        <span class="chip">Published ${escapeHtml(article.weekLabel)}</span>
        <span class="chip">${article.productCount} products</span>
        <span class="chip">$${article.totalSavings.toFixed(2)} savings signals</span>
      </div>
      <div class="notice">
        Affiliate disclosure: As an Amazon Associate, this site earns from qualifying purchases.
      </div>
    </section>
    <section class="story-wrap">
      <p class="article-paragraph">
        This weekly article is written for readers who want a fast, practical breakdown before clicking through to a listing. We balance discount depth, review quality, and product relevance.
      </p>
      <p class="article-paragraph">
        For this issue, we selected one video game, one higher-spec laptop, and one premium TV so different budgets and use cases are covered in one read.
      </p>
      <p class="article-paragraph">
        Deals and stock can move quickly. Always verify final pricing, availability, and compatibility on Amazon before purchase.
      </p>
    </section>
    ${sectionsMarkup}
  `;

  return renderLayout({
    title: article.title,
    description: article.description,
    canonicalPath: `/articles/${article.slug}.html`,
    content,
    extraHead: `<script type="application/ld+json">${jsonLd}</script>`,
    homePrefix: "..",
  });
}

function renderProductCards(products) {
  return renderProductCardsWithOptions(products, { showSummary: true, showReasons: true });
}

function renderProductCardsWithOptions(products, options) {
  const { showSummary, showReasons } = options;
  return products
    .map((product) => {
      const reasonItems = product.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
      return `
        <article class="product-card">
          <img src="${escapeAttribute(product.imageUrl || "https://picsum.photos/seed/fallback/640/640")}" alt="${escapeAttribute(product.title)}" loading="lazy" />
          <div class="product-body">
            <h3 class="product-title">${escapeHtml(product.title)}</h3>
            <div class="product-price">
              <span class="price-main">${escapeHtml(product.priceDisplay || "$--")}</span>
              ${
                product.savingsPercent > 0
                  ? `<span class="price-save">-${product.savingsPercent}%</span>`
                  : ""
              }
            </div>
            <div class="insights">
              ${
                product.rating && product.reviewCount
                  ? `${product.rating.toFixed(1)} stars | ${product.reviewCount.toLocaleString()} reviews`
                  : "Rating info unavailable in manual mode"
              }
            </div>
            ${showSummary ? `<p class="product-summary">${escapeHtml(product.readableSummary || "")}</p>` : ""}
            ${showReasons ? `<ul class="reason-list">${reasonItems}</ul>` : ""}
            <div class="cta">
              <a href="${escapeAttribute(product.detailPageUrl)}" rel="nofollow sponsored noopener" target="_blank">
                Check Current Price
              </a>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderEditorialSection(section, orderNumber) {
  if (!section.products.length) {
    return "";
  }
  const lead = section.products[0];
  const ratingLine =
    lead.rating && lead.reviewCount
      ? `${lead.rating.toFixed(1)} stars from ${lead.reviewCount.toLocaleString()} reviews`
      : "active shopper engagement";
  const discountLine =
    lead.savingsPercent > 0 ? `${lead.savingsPercent}% off` : "a current discount";
  const highlights = Array.isArray(lead.featureBullets)
    ? lead.featureBullets
        .map((entry) => String(entry).replace(/\.$/, ""))
        .filter(Boolean)
        .slice(0, 2)
    : [];
  const highlightLine = highlights.length ? `${highlights.join(". ")}.` : "";

  const audienceLine = buildAudienceLine(section.name);
  const firstParagraph =
    `${section.name} leads this week at ${lead.priceDisplay} with ${discountLine} and ${ratingLine}. ` +
    `${lead.title} stands out as a value-forward pick in this category.`;
  const secondParagraph =
    `${audienceLine} ${highlightLine}`.trim() ||
    "This pick balances price, quality signals, and broad reader relevance.";

  return `
    <section class="story-section">
      <h2 class="section-title">${orderNumber}. ${escapeHtml(section.name)}</h2>
      <p class="section-subtitle">${escapeHtml(section.intro)}</p>
      <p class="article-paragraph">${escapeHtml(firstParagraph)}</p>
      <p class="article-paragraph">${escapeHtml(secondParagraph)}</p>
      <div class="products-grid products-grid-tight">
        ${renderProductCardsWithOptions(section.products, { showSummary: false, showReasons: false })}
      </div>
    </section>
  `;
}

function buildAudienceLine(sectionName) {
  const key = String(sectionName || "").toLowerCase();
  if (key.includes("game")) {
    return "For players, the main attraction is strong replay value at a lower entry price.";
  }
  if (key.includes("laptop")) {
    return "For shoppers who need performance, this option targets gaming and multitasking without crossing ultra-premium pricing.";
  }
  if (key.includes("tv")) {
    return "For living-room upgrades, this choice emphasizes modern display tech and strong feature value for the price tier.";
  }
  return "For most shoppers, this recommendation aims to balance quality, practical specs, and deal strength.";
}

function renderLayout({ title, description, canonicalPath, content, extraHead = "", homePrefix = "." }) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeAttribute(description)}" />
    <link rel="canonical" href="${escapeAttribute(canonicalUrl)}" />
    <meta property="og:title" content="${escapeAttribute(title)}" />
    <meta property="og:description" content="${escapeAttribute(description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${escapeAttribute(canonicalUrl)}" />
    <meta property="og:site_name" content="Weekly Amazon Deal Radar" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="alternate" type="application/rss+xml" title="Weekly Amazon Deal Radar RSS" href="${homePrefix}/feed.xml" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;700&family=Source+Sans+3:wght@400;600;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="${homePrefix}/assets/styles.css" />
    ${extraHead}
  </head>
  <body>
    <main class="site-shell">
      <header class="topbar">
        <a class="logo" href="${homePrefix}/index.html">Weekly Amazon Deal Radar</a>
      </header>
      ${content}
      <footer class="footer">
        <p>
          This site is updated weekly via automation. Always verify listing details directly on Amazon before purchase.
        </p>
      </footer>
    </main>
  </body>
</html>`;
}

function renderSitemap(archiveEntries, latestSlug) {
  const urls = [
    `${SITE_URL}/index.html`,
    `${SITE_URL}/articles/${latestSlug}.html`,
    ...archiveEntries.map((entry) => `${SITE_URL}/articles/${entry.slug}.html`),
  ];
  const uniqueUrls = [...new Set(urls)];
  const body = uniqueUrls
    .map(
      (url) => `
  <url>
    <loc>${escapeHtml(url)}</loc>
    <changefreq>weekly</changefreq>
  </url>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}
</urlset>`;
}

function renderRobotsTxt() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

function renderFeed(archiveEntries) {
  const top = archiveEntries.slice(0, 20);
  const items = top
    .map(
      (entry) => `
    <item>
      <title><![CDATA[${entry.title}]]></title>
      <link>${SITE_URL}/articles/${entry.slug}.html</link>
      <guid>${SITE_URL}/articles/${entry.slug}.html</guid>
      <pubDate>${new Date(entry.publishedAt).toUTCString()}</pubDate>
      <description><![CDATA[${entry.description}]]></description>
    </item>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Weekly Amazon Deal Radar</title>
    <link>${SITE_URL}/index.html</link>
    <description>Weekly Amazon product picks with discount and demand signals.</description>
    ${items}
  </channel>
</rss>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function pruneArticlePages(keepSlugs) {
  const articlesDir = path.join(ROOT_DIR, "docs", "articles");
  try {
    const entries = await fs.readdir(articlesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".html")) {
        continue;
      }
      const slug = entry.name.slice(0, -5);
      if (!keepSlugs.has(slug)) {
        await fs.unlink(path.join(articlesDir, entry.name));
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readJson(filePath, fallback = null) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) {
      return fallback;
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();


