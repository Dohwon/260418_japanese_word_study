const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const vm = require("vm");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const SEMANTIC_MODEL_ID = process.env.SEMANTIC_MODEL_ID || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};
const NO_CACHE_EXTENSIONS = new Set([".html", ".js", ".css", ".json"]);

const semanticState = {
  extractorPromise: null,
  embeddingCache: new Map(),
  decisionCache: new Map(),
  warmupStarted: false,
};

const meaningCorpus = loadMeaningCorpus();

http
  .createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/api/meaning-match") {
        await handleMeaningMatch(request, response);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405);
        response.end("Method not allowed");
        return;
      }

      await serveStatic(request, response);
    } catch (error) {
      console.error(error);
      response.writeHead(500, { "Content-Type": MIME_TYPES[".json"] });
      response.end(JSON.stringify({ error: "server_error" }));
    }
  })
  .listen(PORT, () => {
    console.log(`JLPT study app listening on ${PORT}`);
  });

async function handleMeaningMatch(request, response) {
  const body = await readJsonBody(request);
  const answer = String(body?.answer || "").trim();
  const meaning = String(body?.meaning || "").trim();

  if (!answer || !meaning) {
    response.writeHead(400, { "Content-Type": MIME_TYPES[".json"] });
    response.end(JSON.stringify({ error: "missing_answer_or_meaning" }));
    return;
  }

  const decisionKey = `${compactMeaningText(answer)}::${compactMeaningText(meaning)}`;
  const cached = semanticState.decisionCache.get(decisionKey);
  if (cached) {
    writeJson(response, cached);
    return;
  }

  try {
    const result = await evaluateSemanticMeaning(answer, meaning);
    semanticState.decisionCache.set(decisionKey, result);
    writeJson(response, result);
  } catch (error) {
    console.error("semantic meaning match failed:", error);
    writeJson(response, {
      isCorrect: false,
      mode: "semantic_unavailable",
      score: 0,
      threshold: 1,
    });
  }
}

async function evaluateSemanticMeaning(answer, meaning) {
  const answerVector = await getEmbedding(answer);
  const candidates = buildMeaningCandidates(meaning);

  let best = {
    score: -1,
    candidate: meaning,
    threshold: getSemanticThreshold(answer, meaning),
  };

  for (const candidate of candidates) {
    const candidateVector = await getEmbedding(candidate);
    const score = cosineSimilarity(answerVector, candidateVector);
    const threshold = getSemanticThreshold(answer, candidate);
    if (score > best.score) {
      best = { score, candidate, threshold };
    }
  }

  return {
    isCorrect: best.score >= best.threshold,
    mode: "semantic",
    score: Number(best.score.toFixed(4)),
    threshold: best.threshold,
    candidate: best.candidate,
  };
}

async function getEmbedding(text) {
  const cacheKey = compactMeaningText(text);
  if (semanticState.embeddingCache.has(cacheKey)) {
    return semanticState.embeddingCache.get(cacheKey);
  }

  const embeddingPromise = (async () => {
    const extractor = await getExtractor();
    const output = await extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    return outputToVector(output);
  })();

  semanticState.embeddingCache.set(cacheKey, embeddingPromise);

  try {
    const vector = await embeddingPromise;
    semanticState.embeddingCache.set(cacheKey, vector);
    return vector;
  } catch (error) {
    semanticState.embeddingCache.delete(cacheKey);
    throw error;
  }
}

async function getExtractor() {
  if (!semanticState.extractorPromise) {
    semanticState.extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      const extractor = await pipeline("feature-extraction", SEMANTIC_MODEL_ID, {
        dtype: "q8",
      });

      if (!semanticState.warmupStarted) {
        semanticState.warmupStarted = true;
        warmMeaningEmbeddings().catch((error) => {
          console.error("meaning embedding warmup failed:", error);
        });
      }

      return extractor;
    })();
  }

  return semanticState.extractorPromise;
}

async function warmMeaningEmbeddings() {
  await getExtractor();
  for (const text of meaningCorpus) {
    await getEmbedding(text);
  }
}

function buildMeaningCandidates(meaning) {
  const normalized = normalizeMeaningText(meaning)
    .replace(/[()]/g, " ")
    .replace(/[\u00b7/|]/g, ",");

  const pieces = normalized
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean);

  return [...new Set([meaning, ...pieces])];
}

function normalizeMeaningText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[~!@#$%^&*_+=?:;"'`[\]{}<>\\.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactMeaningText(value) {
  return normalizeMeaningText(value).replace(/\s+/g, "");
}

function getSemanticThreshold(answer, candidate) {
  const minLength = Math.min(compactMeaningText(answer).length, compactMeaningText(candidate).length);
  if (minLength <= 2) {
    return 0.86;
  }
  if (minLength <= 4) {
    return 0.8;
  }
  return 0.76;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function outputToVector(output) {
  if (output && typeof output.tolist === "function") {
    return flattenVector(output.tolist());
  }
  if (output?.data) {
    return Array.from(output.data, Number);
  }
  if (Array.isArray(output)) {
    return flattenVector(output);
  }
  throw new Error("Unknown embedding output shape");
}

function flattenVector(value) {
  let current = value;
  while (Array.isArray(current) && Array.isArray(current[0])) {
    current = current[0];
  }
  return current.map(Number);
}

async function serveStatic(request, response) {
  const urlPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await fsp.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    };
    if (NO_CACHE_EXTENSIONS.has(extension)) {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
      headers.Pragma = "no-cache";
      headers.Expires = "0";
    }
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    const fallbackContent = await fsp.readFile(path.join(ROOT, "index.html"));
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[".html"],
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    response.end(request.method === "HEAD" ? undefined : fallbackContent);
  }
}

function writeJson(response, payload) {
  response.writeHead(200, { "Content-Type": MIME_TYPES[".json"] });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 64) {
        reject(new Error("Body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function loadMeaningCorpus() {
  const datasets = [
    ["WORDS_DATA", path.join(ROOT, "app", "words-data.js")],
    ["N4_VOCAB_DATA", path.join(ROOT, "app", "n4-data.js")],
    ["N3_VOCAB_DATA", path.join(ROOT, "app", "n3-data.js")],
  ];

  const meanings = new Set();

  for (const [variableName, filePath] of datasets) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const source = fs.readFileSync(filePath, "utf8");
    const context = { globalThis: {} };
    vm.createContext(context);
    vm.runInContext(`${source}\nglobalThis.__exported = ${variableName};`, context);
    const items = context.globalThis.__exported || [];
    for (const item of items) {
      if (item?.meaning) {
        for (const candidate of buildMeaningCandidates(item.meaning)) {
          meanings.add(candidate);
        }
      }
    }
  }

  return [...meanings];
}
