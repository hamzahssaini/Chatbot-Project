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

// Variables requises
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

app.use(cors({ origin: "*", methods: ["GET","POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
  defaultQuery: { "api-version": "2024-02-15-preview" }
});

const blobService = BlobServiceClient.fromConnectionString(process.env.AZURE_BLOB_CONNECTION_STRING);
const CONTAINER = "container-rag";
const containerClient = blobService.getContainerClient(CONTAINER);

// 🧠 MÉMOIRE DE SESSION AMÉLIORÉE (Objet au lieu d'Array)
const sessions = {}; 

async function ensureContainer() {
  try {
    await containerClient.createIfNotExists();
  } catch (err) {
    console.error("❌ ensureContainer error:", err.message);
  }
}

async function uploadToBlob(file) {
  const blobName = file.originalname;
  const blob = containerClient.getBlockBlobClient(blobName);
  await blob.uploadData(file.buffer, {
    blobHTTPHeaders: { blobContentType: file.mimetype || "application/pdf" }
  });
  return blob.url;
}

async function runIndexer() {
  const indexerName = process.env.SEARCH_INDEXER || "rag-indexer";
  const url = `https://${process.env.SEARCH_SERVICE}.search.windows.net/indexers/${indexerName}/run?api-version=2024-07-01`;
  await fetch(url, { method: "POST", headers: { "api-key": process.env.SEARCH_API_KEY } });
}

// Recherche avec Filtre Strict
async function searchDocuments(query, filename = null) {
  const base = `https://${process.env.SEARCH_SERVICE}.search.windows.net`;
  const index = encodeURIComponent(process.env.SEARCH_INDEX);
  const apiVersion = "2024-07-01"; 

  // Filtre OData strict sur le nom du fichier
  const filter = filename ? `&$filter=metadata_storage_name eq '${encodeURIComponent(filename)}'` : "";

  console.log(`🔍 Searching: "${query}" | File Filter: ${filename || "NONE"}`);
  console.log("✅ Context found length:", ctx.length);
  console.log("📜 PREVIEW DU CONTENU TROUVÉ :\n", ctx.slice(0, 500)); // Affiche les 500 premiers caractères
  try {
    const url = `${base}/indexes/${index}/docs?api-version=${apiVersion}&search=${encodeURIComponent(query)}&queryType=full&searchFields=content&select=content&top=5${filter}`;
    
    const resp = await fetch(url, { headers: { "api-key": process.env.SEARCH_API_KEY } });
    const data = await resp.json();
    
    if (!Array.isArray(data.value)) return "";

    return data.value.map(v => v.content).filter(Boolean).join("\n\n");
  } catch (err) {
    console.error("❌ Search exception:", err.message);
    return "";
  }
}

// Construction du prompt avec Historique
function buildMessages(history, context, question) {
    const systemPrompt = `
You are a helpful assistant using the provided PDF content.
- If the answer is in the PDF context, use it.
- If the context is empty, rely on conversation history.
- If you don't know, say "I cannot find that in the document".
`;

    const userContent = `
Context from PDF:
"""
${context}
"""

Question: ${question}
`;

    // On renvoie : System + Historique + Nouvelle Question (avec contexte)
    return [
        { role: "system", content: systemPrompt },
        ...history, 
        { role: "user", content: userContent }
    ];
}

async function callLLM(messages) {
  const resp = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages,
    temperature: 0.3,
    max_tokens: 800
  });
  return resp.choices?.[0]?.message?.content || "No reply.";
}

function ensureSessionId(id) {
  return id && typeof id === "string" ? id : crypto.randomUUID();
}

// --- ROUTES ---

// 1. Route Upload (Nouvelle conversation sur un NOUVEAU fichier)
app.post("/chat/upload", upload.single("file"), async (req, res) => {
  const { sessionId: clientSessionId, message } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: "File required" });

  const sessionId = ensureSessionId(clientSessionId);

  try {
    // 🛑 RESET TOTAL DE LA SESSION : Nouvelle Upload = On oublie tout l'avant
    sessions[sessionId] = {
        currentFile: file.originalname,
        history: []
    };

    await ensureContainer();
    await uploadToBlob(file);
    await runIndexer();
    
    // Petite pause pour laisser l'indexer finir (2s)
    await new Promise(r => setTimeout(r, 2000));

    const question = message?.trim() || "Summarize this document.";
    
    // Recherche AVEC le nom du fichier
    const context = await searchDocuments(question, sessions[sessionId].currentFile);
    
    const messages = buildMessages(sessions[sessionId].history, context, question);
    const reply = await callLLM(messages);

    // Sauvegarde dans l'historique
    sessions[sessionId].history.push({ role: "user", content: question });
    sessions[sessionId].history.push({ role: "assistant", content: reply });

    res.json({ reply, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Route Chat (Question suivante sur le MÊME fichier)
app.post("/chat", async (req, res) => {
  const { sessionId: clientSessionId, message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  const sessionId = ensureSessionId(clientSessionId);

  // Si la session n'existe pas (ex: redémarrage serveur), on initie vide
  if (!sessions[sessionId]) {
      sessions[sessionId] = { currentFile: null, history: [] };
  }

  try {
    const activeFile = sessions[sessionId].currentFile;
    
    // Recherche (utilisant le fichier mémorisé)
    const context = await searchDocuments(message, activeFile);
    
    const messages = buildMessages(sessions[sessionId].history, context, message);
    const reply = await callLLM(messages);

    // Sauvegarde
    sessions[sessionId].history.push({ role: "user", content: message });
    sessions[sessionId].history.push({ role: "assistant", content: reply });

    res.json({ reply, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 RAG Server running on port ${PORT}`));