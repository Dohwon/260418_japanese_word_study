const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const STORAGE_DIR = process.env.STATE_STORAGE_DIR || path.join(ROOT, ".data");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const SESSION_COOKIE = "jlpt_auth";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const SEMANTIC_MODEL_ID = process.env.SEMANTIC_MODEL_ID || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const MAX_JSON_BODY_BYTES = 1024 * 1024;

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
    const requestPath = request.url?.split("?")[0] || "/";

    try {
      if (request.method === "GET" && requestPath === "/api/auth/config") {
        writeJson(response, { clientId: GOOGLE_CLIENT_ID });
        return;
      }

      if (request.method === "GET" && requestPath === "/api/session") {
        await handleSession(request, response);
        return;
      }

      if (request.method === "POST" && requestPath === "/api/auth/google") {
        await handleGoogleLogin(request, response);
        return;
      }

      if (request.method === "POST" && requestPath === "/api/logout") {
        clearAuthCookie(request, response);
        writeJson(response, { ok: true });
        return;
      }

      if (request.method === "PUT" && requestPath === "/api/state") {
        await handleStateSave(request, response);
        return;
      }

      if (request.method === "POST" && requestPath === "/api/meaning-match") {
        await handleMeaningMatch(request, response);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405);
        response.end("Method not allowed");
        return;
      }

      await serveStatic(request, response, requestPath);
    } catch (error) {
      if (error?.code === "BODY_TOO_LARGE") {
        response.writeHead(413, { "Content-Type": MIME_TYPES[".json"] });
        response.end(JSON.stringify({ error: "body_too_large" }));
        return;
      }
      console.error(error);
      response.writeHead(500, { "Content-Type": MIME_TYPES[".json"] });
      response.end(JSON.stringify({ error: "server_error" }));
    }
  })
  .listen(PORT, () => {
    console.log(`JLPT study app listening on ${PORT}`);
  });

async function handleSession(request, response) {
  const user = getAuthenticatedUser(request);

  if (!user) {
    writeJson(response, {
      authenticated: false,
      user: null,
      state: null,
    });
    return;
  }

  const state = await readUserState(user.sub);
  writeJson(response, {
    authenticated: true,
    user,
    state,
  });
}

async function handleGoogleLogin(request, response) {
  if (!GOOGLE_CLIENT_ID) {
    response.writeHead(503, { "Content-Type": MIME_TYPES[".json"] });
    response.end(JSON.stringify({ error: "google_client_id_missing" }));
    return;
  }

  const body = await readJsonBody(request);
  const credential = String(body?.credential || "").trim();
  if (!credential) {
    response.writeHead(400, { "Content-Type": MIME_TYPES[".json"] });
    response.end(JSON.stringify({ error: "missing_credential" }));
    return;
  }

  const googleProfile = await verifyGoogleCredential(credential);
  const user = {
    sub: googleProfile.sub,
    email: googleProfile.email || "",
    name: googleProfile.name || googleProfile.email || "Google 사용자",
    picture: googleProfile.picture || "",
  };

  setAuthCookie(request, response, user);

  const state = await readUserState(user.sub);
  writeJson(response, {
    ok: true,
    user,
    state,
  });
}

async function handleStateSave(request, response) {
  const user = getAuthenticatedUser(request);
  if (!user) {
    response.writeHead(401, { "Content-Type": MIME_TYPES[".json"] });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const body = await readJsonBody(request);
  const snapshot = sanitizeStateSnapshot(body?.state || {});
  await writeUserState(user.sub, snapshot);
  writeJson(response, { ok: true, updatedAt: snapshot.meta.updatedAt });
}

async function verifyGoogleCredential(idToken) {
  const url = `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`tokeninfo ${response.status}`);
  }

  const payload = await response.json();
  const issuerOk = payload.iss === "accounts.google.com" || payload.iss === "https://accounts.google.com";
  const expMs = Number(payload.exp || 0) * 1000;

  if (!issuerOk) {
    throw new Error("invalid_google_issuer");
  }
  if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
    throw new Error("google_audience_mismatch");
  }
  if (!payload.sub || !payload.email) {
    throw new Error("google_profile_incomplete");
  }
  if (Number.isNaN(expMs) || expMs <= Date.now()) {
    throw new Error("google_token_expired");
  }

  return payload;
}

function getAuthenticatedUser(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) {
    return null;
  }

  const session = verifySignedSession(token);
  if (!session) {
    return null;
  }

  return {
    sub: session.sub,
    email: session.email,
    name: session.name,
    picture: session.picture || "",
  };
}

function setAuthCookie(request, response, user) {
  const token = signSession({
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture || "",
    exp: Date.now() + SESSION_MAX_AGE_SEC * 1000,
  });

  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(request)) {
    parts.push("Secure");
  }
  response.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(request, response) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (isSecureRequest(request)) {
    parts.push("Secure");
  }
  response.setHeader("Set-Cookie", parts.join("; "));
}

function isSecureRequest(request) {
  return request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
}

function signSession(payload) {
  const serialized = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(serialized).digest("base64url");
  return `${serialized}.${signature}`;
}

function verifySignedSession(token) {
  const [serialized, signature] = String(token || "").split(".");
  if (!serialized || !signature) {
    return null;
  }

  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(serialized).digest("base64url");
  if (!safeEqual(signature, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(serialized, "base64url").toString("utf8"));
    if (!payload?.sub || !payload?.exp || Number(payload.exp) <= Date.now()) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(rawCookie) {
  return rawCookie
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((accumulator, chunk) => {
      const separatorIndex = chunk.indexOf("=");
      if (separatorIndex <= 0) {
        return accumulator;
      }
      const key = chunk.slice(0, separatorIndex).trim();
      const value = chunk.slice(separatorIndex + 1).trim();
      accumulator[key] = value;
      return accumulator;
    }, {});
}

async function readUserState(userSub) {
  await ensureStorageDir();

  try {
    const raw = await fsp.readFile(getUserStatePath(userSub), "utf8");
    return sanitizeStateSnapshot(raw ? JSON.parse(raw) : {});
  } catch (error) {
    if (error.code === "ENOENT") {
      return sanitizeStateSnapshot({});
    }
    throw error;
  }
}

async function writeUserState(userSub, state) {
  await ensureStorageDir();
  const safeState = sanitizeStateSnapshot(state);
  const filePath = getUserStatePath(userSub);
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(safeState), "utf8");
  await fsp.rename(tempPath, filePath);
}

async function ensureStorageDir() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
}

function getUserStatePath(userSub) {
  const safeName = String(userSub || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STORAGE_DIR, `${safeName}.json`);
}

function sanitizeStateSnapshot(snapshot = {}) {
  const sanitizedProgress = {};
  const progress = snapshot.progress && typeof snapshot.progress === "object" ? snapshot.progress : {};

  for (const [key, value] of Object.entries(progress)) {
    sanitizedProgress[key] = {
      stage: clampNumber(value?.stage, 0, 4, 0),
      studyCount: toNonNegativeNumber(value?.studyCount),
      correctHits: toNonNegativeNumber(value?.correctHits),
      wrongHits: toNonNegativeNumber(value?.wrongHits),
      nextReviewAt: toNonNegativeNumber(value?.nextReviewAt),
      lastStudiedAt: toNonNegativeNumber(value?.lastStudiedAt),
      lastStudiedDay: typeof value?.lastStudiedDay === "string" ? value.lastStudiedDay : "",
    };
  }

  return {
    meta: {
      updatedAt: toNonNegativeNumber(snapshot.meta?.updatedAt),
    },
    settings: {
      randomOrder: Boolean(snapshot.settings?.randomOrder),
      randomLevel: Boolean(snapshot.settings?.randomLevel),
    },
    archiveRuns: Array.isArray(snapshot.archiveRuns)
      ? snapshot.archiveRuns
          .map((item) => ({
            date: typeof item?.date === "string" ? item.date : "",
            elapsedMs: toNonNegativeNumber(item?.elapsedMs),
          }))
          .filter((item) => item.date)
          .slice(0, 25)
      : [],
    progress: sanitizedProgress,
  };
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function toNonNegativeNumber(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric) || numeric < 0) {
    return 0;
  }
  return numeric;
}

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

async function serveStatic(request, response, requestPath) {
  const urlPath = requestPath === "/" ? "/index.html" : requestPath;
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
    let rejected = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }
      raw += chunk;
      if (raw.length > MAX_JSON_BODY_BYTES) {
        rejected = true;
        const error = new Error("Body too large");
        error.code = "BODY_TOO_LARGE";
        reject(error);
      }
    });
    request.on("end", () => {
      if (rejected) {
        return;
      }
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
