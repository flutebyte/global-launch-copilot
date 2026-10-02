import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import indianStandards from "@/data/indian-standards.json";
import scaleData from "@/data/scale-requirements.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Standard = {
  isNumber: string;
  title: string;
  productCategory: string;
  keywords?: string[];
  scope?: string;
  requirements?: string[];
  evidenceNeeded?: string[];
  authority?: string;
  certificationStatus?: string;
  qcoStatus?: string;
  mandatory?: boolean;
  scheme?: string;
  general?: boolean;
  notes?: string;
  sourceType?: string;
  sourceUrl?: string;
};

type MatchedStandard = Standard & {
  score: number;
};

type ScaleKey = "small" | "medium" | "large";

type ScaleRequirement = {
  title: string;
  detail: string;
  authority: string;
  sourceUrl: string;
  scales: string[];
  categories: string[];
};

type ScaleInfo = {
  scale: ScaleKey;
  label: string;
  summary: string;
  requirements: ScaleRequirement[];
};

const standards = indianStandards as Standard[];

const MAX_SPECIFIC_STANDARDS = 6;
const MAX_GENERAL_STANDARDS = 3;

/*
  A standard needs at least this much product evidence
  (name, keyword or description match) to be shown.
  Category alone is never enough.
*/
const MIN_PRODUCT_SCORE = 10;

/* =========================================================
   TEXT NORMALIZATION
   ========================================================= */

const STOP_WORDS = new Set([
  "and",
  "for",
  "the",
  "with",
  "from",
  "made",
  "use",
  "used",
  "our",
  "new",
  "product",
  "products",
  "type",
  "good",
  "quality",
]);

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/*
  Very small stemmer so "biscuits" matches "biscuit"
  and "batteries" matches "battery".
*/
function stem(word: string) {
  if (word.length > 4 && word.endsWith("ies")) {
    return word.slice(0, -3) + "y";
  }

  if (
    word.length > 3 &&
    word.endsWith("s") &&
    !word.endsWith("ss")
  ) {
    return word.slice(0, -1);
  }

  return word;
}

function tokens(value: string) {
  return normalize(value)
    .split(" ")
    .filter(Boolean)
    .map(stem);
}

/*
  Whole-phrase match on stemmed tokens, so "water"
  does not match "water heater" unless the keyword is
  exactly "water heater", and "shirt" does not match
  "t-shirt".
*/
function containsPhrase(
  haystack: string[],
  phrase: string[]
) {
  if (phrase.length === 0) {
    return false;
  }

  for (
    let i = 0;
    i + phrase.length <= haystack.length;
    i++
  ) {
    let ok = true;

    for (let j = 0; j < phrase.length; j++) {
      if (haystack[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }

    if (ok) {
      return true;
    }
  }

  return false;
}

/* =========================================================
   INDIAN STANDARDS RETRIEVAL ENGINE
   ========================================================= */

function retrieveStandards(
  product: string,
  category: string,
  description: string
): {
  specific: MatchedStandard[];
  general: MatchedStandard[];
} {
  const productTokens = tokens(product);
  const descriptionTokens = tokens(description);
  const categoryText = normalize(category);

  const productWords = productTokens.filter(
    (word) =>
      word.length >= 3 &&
      !STOP_WORDS.has(word)
  );

  const specific: MatchedStandard[] = [];
  const general: MatchedStandard[] = [];

  for (const standard of standards) {
    const standardCategory = normalize(
      standard.productCategory || ""
    );

    const sameCategory =
      Boolean(categoryText) &&
      standardCategory === categoryText;

    const titleTokens = tokens(
      standard.title || ""
    );

    const keywordTokens = (
      standard.keywords || []
    ).map(tokens);

    let productScore = 0;

    /* ---------------------------------------------
       KEYWORD MATCH (strongest signal)
       --------------------------------------------- */

    for (const keyword of keywordTokens) {
      if (containsPhrase(productTokens, keyword)) {
        // Longer phrases are more specific.
        productScore += 25 + 5 * (keyword.length - 1);
      } else if (
        containsPhrase(descriptionTokens, keyword)
      ) {
        productScore += 8;
      }
    }

    /* ---------------------------------------------
       PRODUCT WORD IN TITLE
       --------------------------------------------- */

    for (const word of productWords) {
      if (titleTokens.includes(word)) {
        productScore += 6;
      }
    }

    /* ---------------------------------------------
       GENERAL / CATEGORY-WIDE REQUIREMENTS
       A general standard that also matches the product
       (e.g. toy safety for "soft toy") counts as specific.
       --------------------------------------------- */

    if (
      standard.general &&
      productScore < MIN_PRODUCT_SCORE
    ) {
      if (
        sameCategory ||
        standardCategory === "all"
      ) {
        general.push({
          ...standard,
          score: productScore + (sameCategory ? 10 : 0),
        });
        continue;
      }
    }

    /* ---------------------------------------------
       KEEP RELEVANT STANDARDS
       Category is only a booster, never enough alone.
       --------------------------------------------- */

    if (productScore >= MIN_PRODUCT_SCORE) {
      specific.push({
        ...standard,
        score: productScore + (sameCategory ? 10 : 0),
      });
    }
  }

  specific.sort((a, b) => b.score - a.score);
  general.sort((a, b) => b.score - a.score);

  const specificIds = new Set(
    specific.map((standard) => standard.isNumber)
  );

  return {
    specific: specific.slice(
      0,
      MAX_SPECIFIC_STANDARDS
    ),
    general: general
      .filter(
        (standard) =>
          !specificIds.has(standard.isNumber)
      )
      .slice(0, MAX_GENERAL_STANDARDS),
  };
}

/* =========================================================
   SCALE (SMALL / MEDIUM / LARGE) REQUIREMENTS
   ========================================================= */

function getScaleRequirements(
  manufacturerType: string,
  category: string
): ScaleInfo {
  const scale = ((
    scaleData.manufacturerTypeToScale as Record<
      string,
      string
    >
  )[manufacturerType] || "small") as ScaleKey;

  const scaleMeta = scaleData.scales[scale];

  const requirements = (
    scaleData.requirements as ScaleRequirement[]
  ).filter(
    (requirement) =>
      requirement.scales.includes(scale) &&
      (requirement.categories.includes("*") ||
        requirement.categories.includes(category))
  );

  // Category-specific items first, then the general ones.
  requirements.sort(
    (a, b) =>
      Number(a.categories.includes("*")) -
      Number(b.categories.includes("*"))
  );

  return {
    scale,
    label: scaleMeta.label,
    summary: scaleMeta.summary,
    requirements,
  };
}

/* =========================================================
   FALLBACK ANALYSIS
   ========================================================= */

function formatStandardLine(
  standard: MatchedStandard
) {
  return `- **${standard.isNumber}** — ${standard.title}
  - Why it may be relevant: ${
    standard.scope ||
    "Product applicability should be verified."
  }
  - Status: ${
    standard.certificationStatus ||
    "Verification Required"
  }`;
}

function formatScaleSection(scaleInfo: ScaleInfo) {
  const lines = scaleInfo.requirements
    .map(
      (requirement) =>
        `- **${requirement.title}**: ${requirement.detail}`
    )
    .join("\n");

  return `## Requirements for Your Scale (${scaleInfo.label})

${scaleInfo.summary}

${lines}`;
}

function createFallbackAnalysis(
  product: string,
  specificStandards: MatchedStandard[],
  generalStandards: MatchedStandard[],
  scaleInfo: ScaleInfo
) {
  const scaleSection =
    formatScaleSection(scaleInfo);

  /* ---------------------------------------------
     NO PRODUCT-SPECIFIC MATCH
     --------------------------------------------- */

  if (specificStandards.length === 0) {
    const generalLines =
      generalStandards.length > 0
        ? `\n\nGeneral requirements that usually apply to this category:\n\n${generalStandards
            .map(formatStandardLine)
            .join("\n")}`
        : "";

    return `## Product Understanding

The product "${product}" could not be matched with a product-specific standard in the current Indian Standards knowledge base.

## Relevant Standards

No product-specific Indian Standard was retrieved. Search the official BIS "Know Your Standards" portal and the list of products under compulsory certification.${generalLines}

${scaleSection}

## Verification Required

- Verify the product category.
- Search the official BIS Standards portal for applicable standards.
- Check whether a Quality Control Order (Section 16, BIS Act 2016) covers the product.

## Next Steps

1. Confirm the exact product classification.
2. Verify applicable Indian Standards with BIS.
3. Complete the registrations listed for your scale.
4. Prepare relevant technical and testing evidence.

AI-generated preliminary guidance. Verify applicable requirements with the relevant official authority.`;
  }

  /* ---------------------------------------------
     MATCHED STANDARDS
     --------------------------------------------- */

  const mandatory = specificStandards.filter(
    (standard) => standard.mandatory
  );

  const mandatoryNote =
    mandatory.length > 0
      ? `\n\n**Compulsory certification:** ${mandatory
          .map((standard) => standard.isNumber)
          .join(", ")} ${
          mandatory.length === 1 ? "is" : "are"
        } listed in this knowledge base as compulsory (QCO under Section 16 of the BIS Act, 2016 or CRS). Verify the current order before launch.`
      : "";

  const generalLines =
    generalStandards.length > 0
      ? `\n\n## General Requirements for This Category\n\n${generalStandards
          .map(formatStandardLine)
          .join("\n")}`
      : "";

  return `## Product Understanding

The product "${product}" was matched against the current Indian Standards knowledge base.

## Relevant Standards

${specificStandards
  .map(formatStandardLine)
  .join("\n")}${mandatoryNote}${generalLines}

${scaleSection}

## Verification Required

- Confirm that each retrieved standard applies to the exact product.
- Verify the latest edition and amendments.
- Verify whether certification is mandatory or voluntary.
- Check whether any applicable Quality Control Order exists.

## Evidence Needed

- Product specification
- Material or composition information
- Product test reports
- Manufacturer information
- Labelling and marking information
- Existing certificates, if available

## Next Steps

1. Review the retrieved standards.
2. Verify applicability with the official BIS source.
3. Complete the registrations listed for your scale.
4. Identify the testing and documentation evidence required.
5. Maintain the verified evidence in the Compliance Passport.

AI-generated preliminary guidance. Verify applicable requirements with the relevant official authority.`;
}

/* =========================================================
   AI REASONING — GEMINI (online) OR OLLAMA (local dev)
   ========================================================= */

function buildPrompt(
  product: string,
  category: string,
  description: string,
  intendedUse: string,
  manufacturerType: string,
  matchedStandards: MatchedStandard[],
  scaleInfo: ScaleInfo
) {
  const evidence = matchedStandards
    .map(
      (standard) =>
        `IS: ${standard.isNumber}
Title: ${standard.title}
Category: ${standard.productCategory}
Scope: ${standard.scope || "Verification Required"}
Certification: ${
          standard.certificationStatus ||
          "Verification Required"
        }
QCO: ${
          standard.qcoStatus ||
          "Verification Required"
        }`
    )
    .join("\n\n");

  const scaleEvidence = scaleInfo.requirements
    .map(
      (requirement) =>
        `- ${requirement.title}: ${requirement.detail}`
    )
    .join("\n");

  return `
You are the compliance reasoning engine inside Global Launch Copilot.

Your task is to produce a clean final answer for the website.

IMPORTANT:
- Output ONLY the final compliance analysis.
- Do NOT explain your instructions or repeat the user prompt.
- Use ONLY the supplied Indian Standards evidence and scale requirements.
- Never invent an IS number, standard or BIS requirement.
- Never claim certification is mandatory unless the supplied evidence explicitly says so.
- If something cannot be confirmed, write "Verification Required".

PRODUCT:
${product}

CATEGORY:
${category}

DESCRIPTION:
${description}

INTENDED USE:
${intendedUse}

MANUFACTURER TYPE:
${manufacturerType} (${scaleInfo.label})

INDIAN STANDARDS EVIDENCE:
${evidence || "No product-specific standard was retrieved."}

SCALE REQUIREMENTS EVIDENCE:
${scaleInfo.summary}
${scaleEvidence}

Use exactly this format:

## Product Understanding
Write one short factual sentence.

## Relevant Standards
For each standard:
- **IS number:** ...
- **Title:** ...
- **Why relevant:** ...
- **Status:** ...

## Requirements for Your Scale (${scaleInfo.label})
- ...
- ...

## Verification Required
- ...

## Evidence Needed
- ...

## Next Steps
1. ...
2. ...
3. ...

End with this exact sentence:

AI-generated preliminary guidance. Verify applicable requirements with the relevant official authority.
`;
}

async function askGemini(prompt: string) {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error("Gemini API key is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model:
      process.env.GEMINI_MODEL ||
      "gemini-3.8-flash",
    contents: [{ text: prompt }],
  });

  const answer = response.text || "";

  if (!answer.trim()) {
    throw new Error("Gemini returned an empty AI response.");
  }

  return answer.trim();
}

async function askLocalAI(prompt: string) {
  const ollamaUrl =
    process.env.OLLAMA_URL ||
    "http://localhost:11434";

  console.log(
    "Sending compact evidence to local Qwen..."
  );

  const response = await fetch(
    `${ollamaUrl}/api/chat`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model:
          process.env.OLLAMA_MODEL ||
          "qwen3:4b",

        /*
          Disable Qwen thinking mode.
        */
        think: false,

        /*
          Keep model loaded.
        */
        keep_alive: "10m",

        messages: [
          {
            role: "system",
            content:
              "You are a concise compliance reasoning assistant. Use only the supplied evidence. Never invent regulatory information.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],

        stream: false,

        options: {
          temperature: 0.1,
          num_predict: 700,
          num_ctx: 4096,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Ollama request failed (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();

  const answer =
    data?.message?.content;

  if (
    !answer ||
    typeof answer !== "string" ||
    !answer.trim()
  ) {
    throw new Error(
      "Ollama returned an empty AI response."
    );
  }

  return answer.trim();
}

/*
  Gemini is used when a key is configured (works on Vercel).
  Ollama is only tried in local development or when OLLAMA_URL
  is set, because localhost does not exist on Vercel.
*/
async function askAI(prompt: string): Promise<{
  answer: string;
  model: string;
}> {
  if (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY
  ) {
    return {
      answer: await askGemini(prompt),
      model:
        process.env.GEMINI_MODEL ||
        "gemini-3.8-flash",
    };
  }

  if (
    process.env.OLLAMA_URL ||
    process.env.NODE_ENV !== "production"
  ) {
    return {
      answer: await askLocalAI(prompt),
      model:
        process.env.OLLAMA_MODEL ||
        "qwen3:4b",
    };
  }

  throw new Error(
    "No AI provider configured. Set GEMINI_API_KEY or OLLAMA_URL."
  );
}

/* =========================================================
   GET — SERVICE STATUS
   ========================================================= */

export async function GET() {
  return NextResponse.json({
    success: true,

    service:
      "Global Launch Copilot",

    engine:
      "Indian Standards Retrieval + AI Reasoning",

    standardsInKnowledgeBase:
      standards.length,

    status: "ready",
  });
}

/* =========================================================
   POST — MAIN ANALYSIS
   ========================================================= */

export async function POST(
  request: NextRequest
) {
  try {
    const body =
      await request.json();

    const product =
      String(
        body?.product || ""
      ).trim();

    const category =
      String(
        body?.category || ""
      ).trim();

    const description =
      String(
        body?.description || ""
      ).trim();

    const intendedUse =
      String(
        body?.intendedUse || ""
      ).trim();

    const manufacturerType =
      String(
        body?.manufacturerType || ""
      ).trim();

    console.log("Analyze request:", {
      product,
      category,
      intendedUse,
      manufacturerType,
    });

    /* =====================================================
       VALIDATION
       ===================================================== */

    if (!product || !category) {
      return NextResponse.json(
        {
          success: false,

          error:
            "Product name and category are required.",
        },
        {
          status: 400,
        }
      );
    }

    /* =====================================================
       STEP 1 — RETRIEVE STANDARDS + SCALE REQUIREMENTS
       ===================================================== */

    const {
      specific: specificStandards,
      general: generalStandards,
    } = retrieveStandards(
      product,
      category,
      description
    );

    const scaleInfo = getScaleRequirements(
      manufacturerType,
      category
    );

    const matchedStandards = [
      ...specificStandards,
      ...generalStandards,
    ];

    console.log(
      "Retrieved standards:",
      specificStandards.map((s) => s.isNumber),
      "general:",
      generalStandards.map((s) => s.isNumber),
      "scale:",
      scaleInfo.scale
    );

    /* =====================================================
       STEP 2 — AI REASONING (only when something matched)
       ===================================================== */

    let analysis = "";

    let aiGenerated = false;

    let aiError = false;

    let aiModel = "";

    if (specificStandards.length > 0) {
      try {
        const result = await askAI(
          buildPrompt(
            product,
            category,
            description,
            intendedUse,
            manufacturerType,
            matchedStandards,
            scaleInfo
          )
        );

        analysis = result.answer;
        aiModel = result.model;
        aiGenerated = true;
      } catch (error) {
        aiError = true;

        console.error(
          "AI ERROR:",
          error
        );
      }
    }

    /*
      If AI is unavailable, the user still receives the
      retrieved Indian Standards and scale requirements.
    */
    if (!analysis) {
      analysis = createFallbackAnalysis(
        product,
        specificStandards,
        generalStandards,
        scaleInfo
      );
    }

    /* =====================================================
       STEP 3 — RESPONSE
       ===================================================== */

    return NextResponse.json({
      success: true,

      product,

      category,

      description,

      intendedUse,

      manufacturerType,

      standards:
        matchedStandards,

      matchedStandards:
        matchedStandards,

      standardsCount:
        specificStandards.length,

      generalCount:
        generalStandards.length,

      scale: scaleInfo,

      analysis,

      aiGenerated,

      aiError,

      engine: {
        retrieval:
          "Indian Standards Knowledge Engine",

        reasoning: aiGenerated
          ? aiModel
          : "Rule-based fallback",
      },

      message:
        specificStandards.length === 0
          ? "No product-specific standard was found in the current knowledge base. General category and scale requirements are shown."
          : undefined,

      disclaimer:
        "AI-generated preliminary guidance. Verify applicable requirements with the relevant official authority.",
    });
  } catch (error) {
    console.error(
      "ANALYZE ROUTE ERROR:",
      error
    );

    return NextResponse.json(
      {
        success: false,

        error:
          "The analysis service could not process the request.",

        details:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      {
        status: 500,
      }
    );
  }
}
