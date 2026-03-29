import fs from "node:fs/promises";

const OUTPUT_PATH = new URL("../data/manual-products.json", import.meta.url);
const TRACKING_ID = process.env.AMAZON_PARTNER_TAG || "alyssasousa-20";

const BASE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
};

const BANNED_TITLE_PATTERNS =
  /(gift card|digital code|membership|subscription|controller|headset|mouse|keyboard|charger|adapter|stand|case|cable|screen protector|storage|memory card|thumb grips|joystick|skins|sticker|dock station|cooling fan|repair|sponsored ad|mount|wall bracket|antenna|remote cover)/i;

const GAME_PLATFORM_PATTERNS = /(ps5|playstation 5|xbox|nintendo switch|switch)/i;
const GAME_TITLE_PATTERNS =
  /(\bgame\b|edition|call of duty|mario|sonic|zelda|resident evil|nba 2k|wwe 2k|tekken|street fighter|yakuza|metal gear|pac-man|little nightmares|turtles)/i;

const LAPTOP_PATTERNS = /\blaptop\b|notebook/i;
const LAPTOP_SPECS_PATTERNS =
  /(i7|i9|ryzen 7|ryzen 9|ultra 7|ultra 9|rtx|4060|4070|32gb|16gb|1tb|512gb|oled|qhd|240hz|165hz|144hz|ddr5)/i;

const TV_PATTERNS = /(\btv\b|television)/i;
const TV_SPECS_PATTERNS =
  /(4k|oled|qled|mini-?led|120hz|144hz|hdr10\+|dolby vision|game mode|hdmi 2\.1)/i;

const CURATION_TARGETS = [
  {
    id: "game",
    category: "Top Video Game Deal",
    keyword: "video game deal",
    urls: [
      "https://www.amazon.com/s?k=ps5+game+deal&i=videogames",
      "https://www.amazon.com/s?k=xbox+series+x+game+deal&i=videogames",
      "https://www.amazon.com/s?k=nintendo+switch+game+deal&i=videogames",
    ],
    minPrice: 10,
    maxPrice: 120,
    minDiscount: 15,
    minRating: 4.2,
    minReviews: 100,
    requiredPatterns: [GAME_PLATFORM_PATTERNS, GAME_TITLE_PATTERNS],
    minSpecHits: 0,
  },
  {
    id: "laptop",
    category: "High-Spec Laptop Deal",
    keyword: "high spec laptop deal",
    urls: [
      "https://www.amazon.com/s?k=gaming+laptop+deal&i=electronics",
      "https://www.amazon.com/s?k=laptop+deal+16gb+1tb+i7&i=electronics",
      "https://www.amazon.com/s?k=laptop+deal+ryzen+7+16gb&i=electronics",
    ],
    minPrice: 600,
    maxPrice: 2600,
    minDiscount: 10,
    minRating: 4.2,
    minReviews: 100,
    requiredPatterns: [LAPTOP_PATTERNS, LAPTOP_SPECS_PATTERNS],
    minSpecHits: 2,
  },
  {
    id: "tv",
    category: "Premium TV Deal",
    keyword: "premium tv deal",
    urls: [
      "https://www.amazon.com/s?k=4k+tv+deal&i=electronics",
      "https://www.amazon.com/s?k=oled+tv+deal&i=electronics",
      "https://www.amazon.com/s?k=mini+led+tv+deal&i=electronics",
    ],
    minPrice: 300,
    maxPrice: 3200,
    minDiscount: 10,
    minRating: 4.2,
    minReviews: 100,
    requiredPatterns: [TV_PATTERNS, TV_SPECS_PATTERNS],
    minSpecHits: 2,
  },
];

function sanitizeToAscii(value) {
  return String(value)
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0]/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseMoney(value) {
  const amount = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function parseReviewCount(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/,/g, "");
  if (!normalized) {
    return 0;
  }
  if (normalized.endsWith("K")) {
    return Math.round(Number(normalized.slice(0, -1)) * 1000);
  }
  return Number(normalized) || 0;
}

function withPartnerTag(urlLike) {
  try {
    const full = urlLike.startsWith("http") ? urlLike : `https://www.amazon.com${urlLike}`;
    const url = new URL(full);
    url.searchParams.set("tag", TRACKING_ID);
    return url.toString();
  } catch {
    return urlLike;
  }
}

function buildCanonicalAffiliateLink(asin) {
  return withPartnerTag(`https://www.amazon.com/dp/${asin}`);
}

function parseSearchResults(html, sourceUrl) {
  const items = [];
  const blockRegex =
    /<div role="listitem"\s+data-asin="([A-Z0-9]{10})"[\s\S]*?(?=<div role="listitem"\s+data-asin="|<div data-asin="" data-index=|$)/g;

  let match;
  while ((match = blockRegex.exec(html)) !== null) {
    const asin = match[1];
    const block = match[0];

    const title = decodeHtml((block.match(/<h2[^>]*aria-label="([^"]+)"/i)?.[1] || "").trim());
    if (!title) {
      continue;
    }

    const href = decodeHtml(
      block.match(new RegExp(`href="([^"]*\\/dp\\/${asin}[^"]*)"`, "i"))?.[1] || "",
    );
    if (!href || !href.includes(`/dp/${asin}`)) {
      continue;
    }

    const imageUrl = decodeHtml(
      block.match(/<img[^>]*class="[^"]*s-image[^"]*"[^>]*src="([^"]+)"/i)?.[1] || "",
    );

    const offscreenPrices = [...block.matchAll(/<span class="a-offscreen">\$([0-9,]+(?:\.[0-9]{2})?)<\/span>/g)].map(
      (priceMatch) => parseMoney(priceMatch[1]),
    );
    const priceAmount = offscreenPrices[0] || 0;
    const listAmount =
      parseMoney(
        block.match(
          /(?:List|Typical):\s*<\/span><span class="a-price[^>]*><span class="a-offscreen">\$([0-9,]+(?:\.[0-9]{2})?)<\/span>/i,
        )?.[1] ||
          block.match(/<span class="a-offscreen">(?:List|Typical):\s*\$([0-9,]+(?:\.[0-9]{2})?)<\/span>/i)?.[1],
      ) || 0;

    const rating = Number(block.match(/aria-label="([0-9.]+) out of 5 stars/i)?.[1] || 0);
    const reviewCount = parseReviewCount(block.match(/aria-label="([0-9.,Kk]+) ratings/i)?.[1] || "");
    const savingsPercent = priceAmount && listAmount && listAmount > priceAmount
      ? Math.round(((listAmount - priceAmount) / listAmount) * 100)
      : 0;
    const savingsAmount = listAmount > priceAmount ? Number((listAmount - priceAmount).toFixed(2)) : 0;

    items.push({
      asin,
      title,
      detailPageUrl: buildCanonicalAffiliateLink(asin),
      imageUrl,
      priceAmount,
      priceDisplay: priceAmount ? `$${priceAmount.toFixed(2)}` : "$--",
      listAmount,
      savingsAmount,
      savingsPercent,
      rating,
      reviewCount,
      sourceUrl,
    });
  }

  return items;
}

function collectSpecHighlights(title, targetId) {
  const patternsByTarget = {
    game: /(PS5|PlayStation 5|Xbox Series X|Xbox|Nintendo Switch|Switch|Deluxe Edition|Cross-Gen|Collector's Edition)/gi,
    laptop: /(Intel[^,]*|Core i7[^,]*|Core i9[^,]*|Ryzen 7[^,]*|Ryzen 9[^,]*|Ultra 7[^,]*|Ultra 9[^,]*|RTX [0-9]{4}|16GB|32GB|1TB|512GB|DDR5|QHD|2\.5K|240Hz|165Hz|144Hz|OLED)/gi,
    tv: /(\d{2,3}[- ]?Inch|4K|OLED|QLED|Mini-LED|120Hz|144Hz|HDR10\+|Dolby Vision|Game Mode|HDMI 2\.1|Dolby Atmos)/gi,
  };

  const matches = title.match(patternsByTarget[targetId] || /$^/g) || [];
  const unique = [];
  for (const entry of matches.map(sanitizeToAscii)) {
    if (!unique.includes(entry)) {
      unique.push(entry);
    }
  }
  return unique.slice(0, 4);
}

function isEligible(product, target) {
  if (!product.title || !product.detailPageUrl || !product.priceAmount) {
    return false;
  }
  if (BANNED_TITLE_PATTERNS.test(product.title)) {
    return false;
  }
  if (product.priceAmount < target.minPrice || product.priceAmount > target.maxPrice) {
    return false;
  }
  if (product.savingsPercent < target.minDiscount) {
    return false;
  }
  if (product.rating < target.minRating || product.reviewCount < target.minReviews) {
    return false;
  }
  if (!target.requiredPatterns.every((regex) => regex.test(product.title))) {
    return false;
  }

  const specHits = collectSpecHighlights(product.title, target.id).length;
  if (specHits < target.minSpecHits) {
    return false;
  }

  return true;
}

function scoreProduct(product, target) {
  const discountScore = product.savingsPercent * 3;
  const ratingScore = product.rating * 10;
  const reviewScore = Math.log10(product.reviewCount + 1) * 10;
  const specScore = collectSpecHighlights(product.title, target.id).length * 8;
  const premiumPriceScore =
    target.id === "laptop" ? Math.min(product.priceAmount / 150, 15) : target.id === "tv" ? Math.min(product.priceAmount / 220, 15) : 0;
  return Number((discountScore + ratingScore + reviewScore + specScore + premiumPriceScore).toFixed(2));
}

function dedupeByAsinAndTitle(products) {
  const byAsin = new Map();
  const byTitle = new Map();

  for (const product of products) {
    const existing = byAsin.get(product.asin);
    if (!existing || product.savingsPercent > existing.savingsPercent) {
      byAsin.set(product.asin, product);
    }
  }

  for (const product of byAsin.values()) {
    const key = sanitizeToAscii(product.title).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const existing = byTitle.get(key);
    if (!existing || product.savingsPercent > existing.savingsPercent) {
      byTitle.set(key, product);
    }
  }

  return [...byTitle.values()];
}

function buildEntry(product, target) {
  const highlights = collectSpecHighlights(product.title, target.id);
  const highlightsText = highlights.length ? ` Key specs: ${highlights.join(", ")}.` : "";
  const summary =
    `${product.title} is currently listed at ${product.priceDisplay} with about ${product.savingsPercent}% off versus list price. ` +
    `It has ${product.rating.toFixed(1)} stars across ${product.reviewCount.toLocaleString()} reviews.` +
    highlightsText;

  return {
    asin: product.asin,
    title: sanitizeToAscii(product.title),
    detailPageUrl: product.detailPageUrl,
    imageUrl: product.imageUrl,
    priceAmount: product.priceAmount,
    priceDisplay: product.priceDisplay,
    savingsAmount: product.savingsAmount,
    savingsPercent: product.savingsPercent,
    isDeal: true,
    sourceUrl: product.sourceUrl,
    gamingScore: Math.round(scoreProduct(product, target)),
    rating: product.rating,
    reviewCount: product.reviewCount,
    salesRank: 0,
    category: target.category,
    keyword: target.keyword,
    featureBullets: [
      sanitizeToAscii(`Verified discount signal: about ${product.savingsPercent}% off list price.`),
      sanitizeToAscii(`Shopper confidence signal: ${product.rating.toFixed(1)} stars and ${product.reviewCount.toLocaleString()} reviews.`),
      ...(highlights.length ? [sanitizeToAscii(`Specs highlight: ${highlights.join(", ")}.`)] : []),
    ],
    summary: sanitizeToAscii(summary),
  };
}

async function createSessionHeaders() {
  const seed = await fetch("https://www.amazon.com/gp/goldbox", { headers: BASE_HEADERS });
  const cookieHeader = (seed.headers.getSetCookie?.() || []).map((cookie) => cookie.split(";")[0]).join("; ");
  return {
    ...BASE_HEADERS,
    referer: "https://www.amazon.com/gp/goldbox",
    cookie: cookieHeader,
  };
}

async function fetchCandidatesForTarget(target, headers) {
  const collected = [];
  for (const url of target.urls) {
    const response = await fetch(url, { headers });
    const html = await response.text();
    const parsed = parseSearchResults(html, url);
    collected.push(...parsed);
  }
  return dedupeByAsinAndTitle(collected);
}

async function main() {
  try {
    const headers = await createSessionHeaders();
    const selected = [];
    const usedAsins = new Set();

    for (const target of CURATION_TARGETS) {
      const candidates = await fetchCandidatesForTarget(target, headers);
      const eligible = candidates
        .filter((product) => isEligible(product, target))
        .sort((a, b) => scoreProduct(b, target) - scoreProduct(a, target));

      const picked = eligible.find((product) => !usedAsins.has(product.asin));
      if (!picked) {
        console.warn(`No qualifying product found for ${target.category}.`);
        continue;
      }

      usedAsins.add(picked.asin);
      selected.push(buildEntry(picked, target));
    }

    if (!selected.length) {
      console.warn("No curated products selected. Keeping existing manual-products.json.");
      return;
    }

    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(selected, null, 2)}\n`, "utf8");
    console.log(`Updated manual-products.json with ${selected.length} curated mixed products.`);
  } catch (error) {
    console.warn(`Manual refresh failed: ${error?.message || error}`);
    console.warn("Keeping existing manual-products.json.");
  }
}

await main();

