// import { AIPageAnalysis, PageContext, UserIntent } from "../types";

// const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
// const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// export async function analyzePageWithAI(
//   pageContext: PageContext,
//   intent: UserIntent
// ): Promise<AIPageAnalysis | null> {
//   if (!OPENAI_API_KEY) {
//     return null;
//   }

//   const prompt = buildAnalysisPrompt(pageContext, intent);

//   try {
//     const controller = new AbortController();
//     const timeout = setTimeout(() => controller.abort(), 15000);

//     const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
//       method: "POST",
//       signal: controller.signal,
//       headers: {
//         "Content-Type": "application/json",
//         Authorization: `Bearer ${OPENAI_API_KEY}`,
//       },
//       body: JSON.stringify({
//         model: OPENAI_MODEL,
//         messages: [
//           {
//             role: "system",
//             content: `You are a web page analyzer for a media download tool. You analyze pages to determine what content they contain and which links are relevant to the user's goal. You MUST respond with valid JSON only. No markdown, no explanation, just the JSON object.`,
//           },
//           {
//             role: "user",
//             content: prompt,
//           },
//         ],
//         temperature: 0.1,
//         max_tokens: 1000,
//       }),
//     });

//     clearTimeout(timeout);

//     if (!response.ok) return null;

//     const data = await response.json();
//     const content = data.choices?.[0]?.message?.content;
//     if (!content) return null;

//     const parsed = JSON.parse(content) as AIPageAnalysis;
//     if (!parsed.pageType || !parsed.target) return null;
//     return parsed;
//   } catch {
//     return null;
//   }
// }

// function buildAnalysisPrompt(pageContext: PageContext, intent: UserIntent): string {
//   const targetDesc = intent.requestedTitle
//     ? `User is looking for: "${intent.requestedTitle}"${intent.requestedSeason ? `, Season ${intent.requestedSeason}` : ""}`
//     : `User entered URL: ${intent.sourceUrl}`;

//   const linksJson = pageContext.links.slice(0, 50).map((l) => ({
//     href: l.href,
//     text: l.text.substring(0, 100),
//   }));

//   return `${targetDesc}

// PAGE URL: ${pageContext.url}
// PAGE TITLE: ${pageContext.title || "none"}
// META DESCRIPTION: ${pageContext.metaDescription || "none"}
// HEADINGS: ${pageContext.headings.slice(0, 10).join(" | ")}
// BREADCRUMBS: ${pageContext.breadcrumbs.join(" > ")}

// LINKS ON PAGE (${linksJson.length}):
// ${JSON.stringify(linksJson, null, 0)}

// Determine:
// 1. What does this page represent? (detail/collection/tag/category/episode/resource/unknown)
// 2. What is the target title and season?
// 3. Which links are likely relevant to finding the user's target content?
// 4. Which links are unrelated?

// Respond with JSON:
// {
//   "pageType": "detail|collection|tag|category|episode|resource|unknown",
//   "target": {
//     "title": "string or null",
//     "season": number or null,
//     "episodeRange": [number, number] or null
//   },
//   "relevantLinks": [{"url": "href", "reason": "why", "confidence": 0.0-1.0}],
//   "irrelevantLinks": [{"url": "href", "reason": "why", "confidence": 0.0-1.0}],
//   "collectionName": "string or null",
//   "description": "string or null",
//   "confidence": 0.0-1.0
// }`;
// }
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { AIPageAnalysis, PageContext, UserIntent } from "../types";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function getAiClient(): GoogleGenAI | null {
  if (!GEMINI_API_KEY) return null;
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

export async function analyzePageWithAI(
  pageContext: PageContext,
  intent: UserIntent,
): Promise<AIPageAnalysis | null> {
  const ai = getAiClient();
  if (!ai) {
    return null;
  }

  const prompt = buildAnalysisPrompt(pageContext, intent);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await ai.models.generateContent(
      {
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction:
            "You are a web page analyzer for a media download tool. You analyze pages to determine what content they contain and which links are relevant to the user's goal.",
          temperature: 0.1,
          maxOutputTokens: 1000,
          responseMimeType: "application/json",
          responseSchema: analysisSchema,
        },
      },
    );

    clearTimeout(timeout);

    const content = response.text;
    if (!content) return null;

    const parsed = JSON.parse(content) as AIPageAnalysis;
    if (!parsed.pageType || !parsed.target) return null;
    return parsed;
  } catch (e) {
    console.error("AI analysis error:", e instanceof Error ? e.message : "unknown");
    return null;
  }
}

// Define the Gemini schema constraints to enforce object matching AIPageAnalysis
const analysisSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    pageType: {
      type: Type.STRING,
      enum: [
        "detail",
        "collection",
        "tag",
        "category",
        "episode",
        "resource",
        "unknown",
      ],
    },
    target: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        season: { type: Type.INTEGER },
        episodeRange: { type: Type.ARRAY, items: { type: Type.INTEGER } },
      },
    },
    relevantLinks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          url: { type: Type.STRING },
          reason: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: ["url", "reason", "confidence"],
      },
    },
    irrelevantLinks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          url: { type: Type.STRING },
          reason: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
        },
        required: ["url", "reason", "confidence"],
      },
    },
    collectionName: { type: Type.STRING },
    description: { type: Type.STRING },
    confidence: { type: Type.NUMBER },
  },
  required: [
    "pageType",
    "target",
    "relevantLinks",
    "irrelevantLinks",
    "confidence",
  ],
};

function buildAnalysisPrompt(
  pageContext: PageContext,
  intent: UserIntent,
): string {
  const targetDesc = intent.requestedTitle
    ? `User is looking for: "${intent.requestedTitle}"${intent.requestedSeason ? `, Season ${intent.requestedSeason}` : ""}`
    : `User entered URL: ${intent.sourceUrl}`;

  const linksJson = pageContext.links.slice(0, 50).map((l) => ({
    href: l.href,
    text: l.text.substring(0, 100),
  }));

  // Cleaned up prompt since the schema configuration handles the JSON structure formatting automatically
  return `${targetDesc}

PAGE URL: ${pageContext.url}
PAGE TITLE: ${pageContext.title || "none"}
META DESCRIPTION: ${pageContext.metaDescription || "none"}
HEADINGS: ${pageContext.headings.slice(0, 10).join(" | ")}
BREADCRUMBS: ${pageContext.breadcrumbs.join(" > ")}

LINKS ON PAGE (${linksJson.length}):
${JSON.stringify(linksJson, null, 0)}

Determine:
1. What does this page represent?
2. What is the target title and season?
3. Which links are likely relevant to finding the user's target content?
4. Which links are unrelated?`;
}
