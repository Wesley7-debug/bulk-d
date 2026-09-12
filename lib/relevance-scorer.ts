import { RelevanceScore, UserIntent, PageContext } from "../types";

const RELEVANCE_THRESHOLD = 0.35;

export function scoreLinkRelevance(
  href: string,
  anchorText: string,
  intent: UserIntent,
  pageContext: PageContext | null
): RelevanceScore {
  const normalizedHref = href.toLowerCase();
  const normalizedAnchor = anchorText.toLowerCase().trim();
  const targetTitle = (intent.requestedTitle || intent.derivedTitle || "").toLowerCase();

  let semantic = 0;
  let titleMatch = 0;
  let seasonMatch = 0;
  let anchorMatch = 0;
  let structural = 0;

  if (targetTitle) {
    titleMatch = computeTitleMatch(normalizedHref, normalizedAnchor, targetTitle);
  }

  if (intent.requestedSeason) {
    seasonMatch = computeSeasonMatch(normalizedHref, normalizedAnchor, intent.requestedSeason);
  }

  semantic = computeSemanticScore(normalizedHref, normalizedAnchor, targetTitle);

  anchorMatch = computeAnchorScore(normalizedAnchor, targetTitle);

  structural = computeStructuralScore(normalizedHref, pageContext);

  const total =
    0.35 * semantic +
    0.30 * titleMatch +
    0.15 * seasonMatch +
    0.10 * anchorMatch +
    0.10 * structural;

  const decision: RelevanceScore["decision"] =
    total >= RELEVANCE_THRESHOLD ? "QUEUE" : "SKIP";

  let reason = "";
  if (decision === "SKIP") {
    if (titleMatch < 0.1 && seasonMatch < 0.1) {
      reason = "no title or season relevance";
    } else {
      reason = `low relevance score (${total.toFixed(2)})`;
    }
  } else {
    const parts: string[] = [];
    if (titleMatch > 0.5) parts.push("strong title match");
    else if (titleMatch > 0.2) parts.push("title similarity");
    if (seasonMatch > 0.5) parts.push("season match");
    if (semantic > 0.5) parts.push("semantic relevance");
    if (structural > 0.5) parts.push("structural match");
    reason = parts.length > 0 ? parts.join(", ") : "above threshold";
  }

  return {
    url: href,
    total,
    semantic,
    titleMatch,
    seasonMatch,
    anchorMatch,
    structural,
    decision,
    reason,
  };
}

function computeTitleMatch(href: string, anchor: string, targetTitle: string): number {
  if (!targetTitle) return 0;
  const titleTokens = tokenize(targetTitle);
  if (titleTokens.length === 0) return 0;

  let matchCount = 0;
  for (const token of titleTokens) {
    if (href.includes(token) || anchor.includes(token)) {
      matchCount++;
    }
  }

  const ratio = matchCount / titleTokens.length;
  if (ratio >= 0.8) return 1.0;
  if (ratio >= 0.5) return 0.7;
  if (ratio >= 0.3) return 0.4;
  if (ratio > 0) return 0.2;
  return 0;
}

function computeSeasonMatch(href: string, anchor: string, season: string): number {
  const seasonNum = parseInt(season);
  const seasonPatterns = [
    new RegExp(`season[\\s._-]*${seasonNum}`, "i"),
    new RegExp(`s0*${seasonNum}\\b`, "i"),
    new RegExp(`\\bs0*${seasonNum}e\\d+`, "i"),
  ];

  const combined = `${href} ${anchor}`;
  for (const pattern of seasonPatterns) {
    if (pattern.test(combined)) return 1.0;
  }

  if (combined.includes(`season ${season}`) || combined.includes(`s${season}`)) {
    return 0.8;
  }

  return 0;
}

function computeSemanticScore(href: string, anchor: string, _targetTitle: string): number {
  const mediaKeywords = [
    "episode", "ep", "watch", "stream", "video", "series",
    "season", "download", "play", "part", "trailer", "clip",
  ];

  const nonMediaKeywords = [
    "category", "tag", "author", "blog", "news", "about",
    "contact", "privacy", "terms", "login", "register", "signup",
    "forum", "comment", "review", "rating", "share", "social",
  ];

  let score = 0;
  const combined = `${href} ${anchor}`;

  for (const keyword of mediaKeywords) {
    if (combined.includes(keyword)) score += 0.1;
  }

  for (const keyword of nonMediaKeywords) {
    if (combined.includes(keyword)) score -= 0.15;
  }

  const pathSegments = href.split("/").filter(Boolean);
  if (pathSegments.length >= 2) score += 0.1;

  if (/\.(mp4|webm|mkv|avi|mov|mp3|wav|pdf|zip)/i.test(href)) {
    score += 0.3;
  }

  return Math.max(0, Math.min(1, score));
}

function computeAnchorScore(anchor: string, targetTitle: string): number {
  if (!anchor || anchor.length < 2) return 0;
  if (anchor.length > 200) return 0;

  const isNavigation = /^(home|back|next|prev|previous|menu|close|open|click here)$/i.test(anchor);
  if (isNavigation) return 0;

  if (targetTitle) {
    const targetTokens = tokenize(targetTitle);
    const anchorTokens = tokenize(anchor);
    let matches = 0;
    for (const t of targetTokens) {
      if (anchorTokens.some((a) => a.includes(t) || t.includes(a))) matches++;
    }
    if (targetTokens.length > 0) {
      const ratio = matches / targetTokens.length;
      if (ratio >= 0.5) return 0.8;
      if (ratio > 0) return 0.3;
    }
  }

  return 0.2;
}

function computeStructuralScore(href: string, pageContext: PageContext | null): number {
  let score = 0;

  if (/\b\d+\b/.test(href)) score += 0.15;

  if (/\/(ep|episode|watch|stream|video|play)\b/i.test(href)) score += 0.2;

  if (/\b(s\d+e\d+|season\d+|part\d+)\b/i.test(href)) score += 0.25;

  if (pageContext?.breadcrumbs && pageContext.breadcrumbs.length > 0) {
    const lastBreadcrumb = pageContext.breadcrumbs[pageContext.breadcrumbs.length - 1]?.toLowerCase() || "";
    if (lastBreadcrumb.includes("episode") || lastBreadcrumb.includes("series")) {
      score += 0.1;
    }
  }

  const depth = href.split("/").filter(Boolean).length;
  if (depth >= 2 && depth <= 5) score += 0.05;

  return Math.min(1, score);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function rankLinks(
  links: Array<{ href: string; text: string }>,
  intent: UserIntent,
  pageContext: PageContext | null
): RelevanceScore[] {
  const scored = links.map((link) =>
    scoreLinkRelevance(link.href, link.text, intent, pageContext)
  );

  scored.sort((a, b) => b.total - a.total);
  return scored;
}
