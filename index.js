import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { BlobServiceClient } from "@azure/storage-blob";
import fetch from "node-fetch";
import crypto from "crypto";

dotenv.config();

// Required environment variables
const required = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_BLOB_CONNECTION_STRING",
  "SEARCH_SERVICE",
  "SEARCH_API_KEY",
  "SEARCH_INDEX"
];
required.forEach(k => { if (!process.env[k]) console.error(`❌ Missing env: ${k}`); });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// Middleware
app.use(cors({ origin: "*", methods: ["GET","POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());
app.use(express.static(__dirname));

// File upload
const upload = multer({ storage: multer.memoryStorage() });

// Azure OpenAI client
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
  defaultQuery: { "api-version": "2024-02-15-preview" }
});

// Azure Blob storage
const blobService = BlobServiceClient.fromConnectionString(process.env.AZURE_BLOB_CONNECTION_STRING);
const CONTAINER = "container-rag";
const containerClient = blobService.getContainerClient(CONTAINER);

async function ensureContainer() {
  try {
    const created = await containerClient.createIfNotExists();
    if (created.succeeded) {
      console.log(`✅ Blob container created: ${CONTAINER} (private access)`);
    } else {
      console.log(`✅ Blob container exists: ${CONTAINER}`);
    }
  } catch (err) {
    console.error("❌ ensureContainer error:", err.message);
  }
}

async function uploadToBlob(file) {
  if (!file?.buffer) throw new Error("Invalid file upload.");
  
  const blobName = file.originalname;
  const blob = containerClient.getBlockBlobClient(blobName);

  await blob.uploadData(file.buffer, {
    blobHTTPHeaders: { blobContentType: file.mimetype || "application/pdf" }
  });

  console.log(`✅ Uploaded blob: ${blob.url}`); // URL is private
  return blob.url;
}

// Trigger Azure Search Indexer
async function runIndexer() {
  const indexerName = process.env.SEARCH_INDEXER || "rag-indexer";
  const url = `https://${process.env.SEARCH_SERVICE}.search.windows.net/indexers/${indexerName}/run?api-version=2025-09-01`;
  const resp = await fetch(url, { method: "POST", headers: { "api-key": process.env.SEARCH_API_KEY } });
  if (!resp.ok) {
    const text = await resp.text();
    console.error("❌ Indexer run failed:", resp.status, text);
  } else {
    console.log("✅ Indexer triggered:", indexerName);
  }
}

// RAG search
async function searchDocuments(query) {
  const base = `https://${process.env.SEARCH_SERVICE}.search.windows.net`;
  const index = encodeURIComponent(process.env.SEARCH_INDEX);
  const apiVersion = "2025-09-01";

  const semanticConfig = process.env.SEMANTIC_CONFIGURATION;
  if (semanticConfig) {
    try {
      const resp = await fetch(`${base}/indexes/${index}/docs/search?api-version=${apiVersion}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": process.env.SEARCH_API_KEY },
        body: JSON.stringify({
          search: query,
          top: 5,
          queryType: "semantic",
          semanticConfiguration: semanticConfig,
          select: "id,content"
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.value) && data.value.length) {
          const ctx = data.value.map(v => v.content).filter(Boolean).join("\n\n");
          console.log("✅ Semantic context length:", ctx.length);
          return ctx;
        }
      }
    } catch (e) {
      console.warn("⚠️ Semantic search exception:", e.message);
    }
  }

  // Full-text fallback
  try {
    const resp = await fetch(`${base}/indexes/${index}/docs?api-version=${apiVersion}&search=${encodeURIComponent(query)}&queryType=full&searchFields=content&select=id,content&top=5`, {
      headers: { "api-key": process.env.SEARCH_API_KEY }
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    if (!Array.isArray(data.value)) return "";
    const ctx = data.value.map(v => v.content).filter(Boolean).join("\n\n");
    console.log("✅ Full-text context length:", ctx.length);
    return ctx;
  } catch (err) {
    console.error("❌ Full-text search exception:", err.message);
    return "";
  }
}

// Session memory
const sessions = {};

// Build messages with clear structured instructions
function buildMessages(sessionHistory, context, question) {
  const trimmedContext = (context || "").slice(0, 12000);

  const turnContent = `
You are a professional assistant. Answer clearly and concisely.

- Use the PDF content if relevant.
- Output structured markdown.
- When listing advantages, features, or items:
  - Start with a bold title (e.g., "**Advantages of Docker:**") on its own line.
  - REQUIRED: Put every single bullet point on a BRAND NEW LINE.
  - Use this exact format for bullets: "- **Keyword:** Description".
  - Do not bunch list items into a paragraph.

${trimmedContext ? "PDF content:\n```\n" + trimmedContext + "\n```" : ""}

Question: ${question}
`;

  return [...sessionHistory, { role: "user", content: turnContent }];
}

// Call OpenAI
async function callLLM(messages) {
  try {
    const resp = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      messages,
      temperature: 0,  // deterministic
      max_tokens: 700
    });
    return resp.choices?.[0]?.message?.content || "No reply.";
  } catch (err) {
    console.error("❌ OpenAI Bad Request:", err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

// Generate sessionId
function ensureSessionId(idFromClient) {
  return idFromClient && typeof idFromClient === "string" ? idFromClient : crypto.randomUUID();
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  const { sessionId: clientSessionId, message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "message is required" });

  const sessionId = ensureSessionId(clientSessionId);
  if (!sessions[sessionId]) sessions[sessionId] = [];

  try {
    const context = await searchDocuments(message);
    const messages = buildMessages(sessions[sessionId], context, message);
    const reply = await callLLM(messages);

    sessions[sessionId].push({ role: "user", content: message });
    sessions[sessionId].push({ role: "assistant", content: reply });

    res.json({ reply, sessionId });
  } catch (err) {
    res.status(500).json({ error: "Chat failed.", detail: err.message });
  }
});

// Chat with file upload
app.post("/chat/upload", upload.single("file"), async (req, res) => {
  const { sessionId: clientSessionId, message } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: "File is required." });

  const sessionId = ensureSessionId(clientSessionId);
  if (!sessions[sessionId]) sessions[sessionId] = [];

  try {
    await ensureContainer();
    await uploadToBlob(file);
    await runIndexer();

    const question = message?.trim() || "Please summarize the uploaded PDF.";
    const context = await searchDocuments(question);
    const messages = buildMessages(sessions[sessionId], context, question);
    const reply = await callLLM(messages);

    sessions[sessionId].push({ role: "user", content: question });
    sessions[sessionId].push({ role: "assistant", content: reply });

    res.json({ reply, sessionId });
  } catch (err) {
    res.status(500).json({ error: "Upload chat failed.", detail: err.message });
  }
});

// Health check
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 RAG Server running on http://127.0.0.1:${PORT}`));
