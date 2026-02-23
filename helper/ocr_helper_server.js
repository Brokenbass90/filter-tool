#!/usr/bin/env node
/*
  vadim-ocr-helper (local)
  - /health  -> {ok:true}
  - /ocr     -> multipart/form-data: file=<pdf|png|jpg>, optional: pages="1,2,5" lang="rus+eng"

  Works in CommonJS (Node 18+; tested for Node 22)
  Uses pdfjs-dist legacy CJS build (avoids ESM require errors)
  "Fast path": if PDF contains embedded text -> returns text w/o OCR.
*/

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const nodemailer = require("nodemailer");
const canvasMod = require("canvas");
const { createCanvas, DOMMatrix, ImageData, Path2D } = canvasMod;

// Provide DOMMatrix / ImageData / Path2D before loading pdfjs
if (typeof global.DOMMatrix === "undefined" && DOMMatrix) global.DOMMatrix = DOMMatrix;
if (typeof global.ImageData === "undefined" && ImageData) global.ImageData = ImageData;
if (typeof global.Path2D === "undefined" && Path2D) global.Path2D = Path2D;
const { createWorker } = require("tesseract.js");

// CJS legacy build (pdfjs-dist@3.x)
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

// ---- Config
const HOST = process.env.OCR_HOST || "127.0.0.1";
const PORT = Number(process.env.OCR_PORT || "17871");

const MAX_UPLOAD_MB = Number(process.env.OCR_MAX_UPLOAD_MB || "40");
const MAX_PAGES = Number(process.env.OCR_MAX_PAGES || "25");
const DEFAULT_LANG = process.env.OCR_LANG || "rus+eng";
const MIN_TEXT_CHARS_FASTPATH = Number(process.env.OCR_MIN_TEXT_CHARS_FASTPATH || "40");

const CACHE_DIR = path.join(__dirname, ".cache");
const TESSDATA_DIR = path.join(__dirname, "tessdata");
const LANG_PATH_ENV = (process.env.OCR_LANG_PATH || "").trim();
const EMAIL_RATE_STATE = path.join(CACHE_DIR, "email_rate_state.json");
const ROOT_LOGO_PATH = path.join(__dirname, "..", "logo.png");

function resolveLangPath() {
  if (LANG_PATH_ENV) return LANG_PATH_ENV;
  try {
    if (fs.existsSync(TESSDATA_DIR)) return TESSDATA_DIR;
  } catch (_) {}
  return null;
}

function stringifyErr(err) {
  try {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.stack || err.message || String(err);
    if (typeof err === "object") return JSON.stringify(err, Object.getOwnPropertyNames(err));
    return String(err);
  } catch (e) {
    try { return String(err); } catch { return "Unknown error"; }
  }
}


function parseDataUrlImage(dataUrl) {
  try {
    const s = String(dataUrl || '').trim();
    const m = s.match(/^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    const ext = mime.includes('png') ? 'png' : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg' : mime.includes('gif') ? 'gif' : 'webp';
    const b64 = m[3].replace(/\s+/g, '');
    const content = Buffer.from(b64, 'base64');
    if (!content || !content.length) return null;
    return { mime, ext, content };
  } catch (_) {
    return null;
  }
}

function loadDefaultLogoImage() {
  try {
    if (!fs.existsSync(ROOT_LOGO_PATH)) return null;
    const content = fs.readFileSync(ROOT_LOGO_PATH);
    if (!content || !content.length) return null;
    return { mime: "image/png", ext: "png", content };
  } catch (_) {
    return null;
  }
}

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

function nowMs(){ return Date.now(); }

// ---- Multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

// ---- App & CORS for file:// HTML
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.url}`);
  next();
});


app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => res.json({ ok: true, version: "12.0.0" }));

function dayKeyUtc() {
  return new Date().toISOString().slice(0, 10);
}

function readRateState() {
  try {
    const x = JSON.parse(fs.readFileSync(EMAIL_RATE_STATE, "utf8"));
    if (x && typeof x === "object") return x;
  } catch (_) {}
  return { day: dayKeyUtc(), sent: 0 };
}

function writeRateState(state) {
  try {
    fs.writeFileSync(EMAIL_RATE_STATE, JSON.stringify(state, null, 2), "utf8");
  } catch (_) {}
}

function getCurrentSentCount() {
  const st = readRateState();
  const today = dayKeyUtc();
  if (st.day !== today) {
    const next = { day: today, sent: 0 };
    writeRateState(next);
    return 0;
  }
  return Number(st.sent || 0);
}

function increaseSentCount(by) {
  const st = readRateState();
  const today = dayKeyUtc();
  const base = st.day === today ? Number(st.sent || 0) : 0;
  const next = { day: today, sent: base + Math.max(0, Number(by || 0)) };
  writeRateState(next);
  return next.sent;
}

function parsePositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

app.post("/email/check-limit", (req, res) => {
  const body = req.body || {};
  const requested = parsePositiveInt(body.requested, 0);
  const dailyLimit = parsePositiveInt(body.dailyLimit, 300);
  const sentToday = getCurrentSentCount();
  const remaining = Math.max(0, dailyLimit - sentToday);
  return res.json({
    ok: true,
    sentToday,
    dailyLimit,
    remaining,
    requested,
    canSend: requested <= remaining
  });
});

app.post("/email/send-batch", async (req, res) => {
  const t0 = nowMs();
  try {
    const body = req.body || {};
    const smtp = body.smtp || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const dailyLimit = parsePositiveInt(body.dailyLimit, 300);
    const delayMs = parsePositiveInt(body.delayMs, 1200);
    const logoDataUrl = String(body.logoDataUrl || '').trim();
    const logoImage = parseDataUrlImage(logoDataUrl) || loadDefaultLogoImage();

    const user = String(smtp.user || "").trim();
    const pass = String(smtp.pass || "").trim();
    const fromName = String(smtp.fromName || "").trim();
    const secure = String(smtp.secure || "tls").trim().toLowerCase();
    const host = String(smtp.host || "").trim() || "smtp.gmail.com";
    const port = parsePositiveInt(smtp.port, secure === "ssl" ? 465 : 587);

    if (!user || !pass) {
      return res.status(400).json({ ok: false, error: "smtp_user_pass_required" });
    }
    if (!messages.length) {
      return res.status(400).json({ ok: false, error: "empty_messages" });
    }

    const sentToday = getCurrentSentCount();
    const remaining = Math.max(0, dailyLimit - sentToday);
    if (remaining <= 0) {
      return res.status(429).json({ ok: false, error: "daily_limit_reached", sentToday, dailyLimit, remaining: 0 });
    }

    const toSend = messages.slice(0, remaining);
    const skipped = messages.length - toSend.length;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: secure === "ssl",
      auth: { user, pass }
    });

    const from = fromName ? `"${fromName.replace(/"/g, "'")}" <${user}>` : user;
    const results = [];
    let sent = 0;

    for (let i = 0; i < toSend.length; i++) {
      const m = toSend[i] || {};
      const to = String(m.to || "").trim();
      const subject = String(m.subject || "").trim();
      const text = String(m.text || "");
      const html = String(m.html || "");
      if (!to || !subject || (!text && !html)) {
        results.push({ ok: false, to, error: "invalid_message_fields" });
      } else {
        try {
          const mail = { from, to, subject, text: text || undefined, html: html || undefined };
          if (logoImage && html && html.includes('cid:')) {
            const cid = html.includes('cid:brandlogo@sb') ? 'brandlogo@sb' : 'brandlogo';
            mail.attachments = [{
              filename: `logo.${logoImage.ext}`,
              content: logoImage.content,
              contentType: logoImage.mime,
              cid,
              contentDisposition: 'inline',
              headers: { 'X-Attachment-Id': cid }
            }];
          }
          await transporter.sendMail(mail);
          sent += 1;
          results.push({ ok: true, to });
        } catch (e) {
          results.push({ ok: false, to, error: stringifyErr(e) });
        }
      }
      if (i < toSend.length - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const sentAfter = sent > 0 ? increaseSentCount(sent) : sentToday;
    const ms = nowMs() - t0;
    return res.json({
      ok: true,
      sent,
      failed: results.filter(r => !r.ok).length,
      skippedByLimit: skipped,
      sentToday: sentAfter,
      dailyLimit,
      remaining: Math.max(0, dailyLimit - sentAfter),
      results,
      meta: { ms }
    });
  } catch (e) {
    const ms = nowMs() - t0;
    return res.status(500).json({ ok: false, error: stringifyErr(e), meta: { ms } });
  }
});

function toUint8Array(x) {
  if (!x) return new Uint8Array();
  // IMPORTANT: In Node.js, Buffer is a subclass of Uint8Array.
  // PDF.js (и иногда Tesseract) может ругаться на Buffer и требовать "чистый" Uint8Array.
  // Поэтому Buffer проверяем ПЕРВЫМ и конвертируем.
  if (Buffer.isBuffer(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return new Uint8Array();
}


// ---- Tesseract worker singleton
let workerPromise = null;
let workerLang = null;

async function getWorker(lang) {
  const wanted = (lang && String(lang).trim()) ? String(lang).trim() : DEFAULT_LANG;

  // Create (uninitialized) worker lazily
  if (!workerPromise) {
    workerPromise = (async () => {
      const langPath = resolveLangPath();
      ensureLangFiles(langPath, wanted);
      const opts = { cachePath: CACHE_DIR };
      if (langPath) opts.langPath = langPath;
      const w = await createWorker(opts);
      return w;
    })();
  }

  // If requested language changed - recreate worker (most robust across tesseract.js versions)
  if (workerLang !== null && workerLang !== wanted) {
    try {
      const old = await workerPromise;
      try { await old.terminate(); } catch (_) {}
    } catch (_) {}
    workerPromise = null;
    workerLang = null;
  }

  const w = await workerPromise;

  if (workerLang === null) {
    await w.loadLanguage(wanted);
    await w.initialize(wanted);
    workerLang = wanted;
  }

  return w;
}

function parsePages(pagesStr, numPages) {
  if (!pagesStr) return null;
  const s = String(pagesStr).trim();
  if (!s) return null;

  // supports: "last" or "last:2"
  if (/^last(:\d+)?$/i.test(s)) {
    const m = s.match(/last(?::(\d+))?/i);
    const n = m && m[1] ? Math.max(1, Number(m[1])) : 1;
    const take = Math.min(numPages, n, MAX_PAGES);
    const start = Math.max(1, numPages - take + 1);
    const arr = [];
    for (let i = start; i <= numPages; i++) arr.push(i);
    return arr;
  }

  // supports: "1,2,5" or "1-3,7"
  const out = new Set();
  for (const part0 of s.split(",")) {
    const part = part0.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [a,b] = part.split("-").map(x => Number(String(x).trim()));
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const start = Math.max(1, Math.min(a,b));
      const end = Math.min(numPages, Math.max(a,b));
      for (let i=start; i<=end; i++) out.add(i);
    } else {
      const n = Number(part);
      if (Number.isFinite(n) && n>=1 && n<=numPages) out.add(n);
    }
  }
  const arr = Array.from(out).sort((x,y)=>x-y);
  if (!arr.length) return null;
  return arr.slice(0, MAX_PAGES);
}

function normalizeNewlines(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function ensureLangFiles(langPath, langSpec) {
  if (!langPath) return;
  const langs = String(langSpec || "").split("+").map(s => s.trim()).filter(Boolean);
  if (!langs.length) return;
  const missing = [];
  for (const l of langs) {
    const p1 = path.join(langPath, `${l}.traineddata`);
    const p2 = path.join(langPath, `${l}.traineddata.gz`);
    if (!fs.existsSync(p1) && !fs.existsSync(p2)) missing.push(l);
  }
  if (missing.length) {
    throw new Error(`missing_lang_data: ${missing.join(", ")} (expected in ${langPath})`);
  }
}

async function extractEmbeddedText(pdf, pages) {
  let text = "";
  const pageNums = pages || Array.from({ length: pdf.numPages }, (_,i)=>i+1).slice(0, MAX_PAGES);

  for (const pno of pageNums) {
    const page = await pdf.getPage(pno);
    const tc = await page.getTextContent({ disableCombineTextItems: false });
    const pageText = (tc.items || []).map(it => (it && it.str) ? String(it.str) : "").join(" ");
    const cleaned = normalizeNewlines(pageText).replace(/\s+/g, " ").trim();
    if (cleaned) {
      text += cleaned + "\n";
      if (text.length >= MIN_TEXT_CHARS_FASTPATH) break;
    }
  }
  return text.trim();
}

async function renderPageToPng(pdf, pno, scale=2.0) {
  const page = await pdf.getPage(pno);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");

  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer("image/png");
}

async function ocrImageBuffer(buf, lang) {
  const w = await getWorker(lang);
  // tesseract.js expects Uint8Array; Buffer may be rejected in newer versions
  const res = await w.recognize(toUint8Array(buf));
  const text = res && res.data && res.data.text ? res.data.text : "";
  return normalizeNewlines(text).trim();
}

async function handlePdf(buf, pagesStr, lang, scale) {
  const pdfData = toUint8Array(buf);
  const loadingTask = pdfjsLib.getDocument({ data: pdfData, disableWorker: true });
  const pdf = await loadingTask.promise;

  const pages = parsePages(pagesStr, pdf.numPages) || Array.from({ length: pdf.numPages }, (_,i)=>i+1).slice(0, MAX_PAGES);

  // Fast path: try embedded text
  const embeddedText = await extractEmbeddedText(pdf, pages);
  if (embeddedText && embeddedText.length >= MIN_TEXT_CHARS_FASTPATH) {
    return { mode: "text", text: embeddedText, numPages: pdf.numPages, pages };
  }

  // OCR path
  let out = "";
  const s = Number.isFinite(scale) ? scale : 2.0;
  const clamped = Math.max(1.0, Math.min(3.5, s));
  for (const pno of pages) {
    const png = await renderPageToPng(pdf, pno, clamped);
    const pageText = await ocrImageBuffer(png, lang);
    if (pageText) out += pageText + "\n";
  }
  out = out.trim();
  return { mode: "ocr", text: out, numPages: pdf.numPages, pages };
}

app.post("/ocr", upload.single("file"), async (req, res) => {
  const t0 = nowMs();
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        error: { code: "no_file", message: "file is required (multipart field: file)" }
      });
    }

    try {
      const size = req.file.buffer.length;
      const head = req.file.buffer.slice(0, 8);
      const headHex = Array.from(head).map(b => b.toString(16).padStart(2, "0")).join(" ");
      console.log(`[OCR] file="${req.file.originalname || ""}" type="${req.file.mimetype || ""}" size=${size} head=${headHex}`);
    } catch (_) {}

    const mimetype = (req.file.mimetype || "").toLowerCase();
    const filename = (req.file.originalname || "").toLowerCase();
    const pagesStr = req.body && (req.body.pages || req.body.page || "");
    const lang = req.body && (req.body.lang || "");
    const scaleRaw = req.body && (req.body.scale || req.body.ocr_scale || "");
    const scale = scaleRaw ? Number(scaleRaw) : undefined;

    const isPdf = mimetype.includes("pdf") || filename.endsWith(".pdf");
    const isImage = mimetype.startsWith("image/") || /\.(png|jpe?g|bmp|webp)$/i.test(filename);

    let text = "";
    let meta = {};

    if (isPdf) {
      const out = await handlePdf(req.file.buffer, pagesStr, lang, scale);
      text = out.text || "";
      meta = { mode: out.mode, pages: out.pages, numPages: out.numPages };
    } else if (isImage) {
      text = await ocrImageBuffer(req.file.buffer, lang);
      meta = { mode: "ocr", pages: [1], numPages: 1 };
    } else {
      return res.status(400).json({
        ok: false,
        error: { code: "unsupported", message: `Unsupported file type: ${req.file.mimetype || req.file.originalname}` }
      });
    }

    const ms = nowMs() - t0;
    return res.json({ ok: true, text, meta: { ...meta, ms } });
  
} catch (e) {
  const ms = nowMs() - t0;
  const errText = stringifyErr(e);
  console.error("[OCR ERROR]", errText);
  try {
    console.error("[OCR ERROR META]", {
      name: e && e.name,
      message: e && e.message,
      code: e && e.code,
      details: e && e.details
    });
  } catch (_) {}
  return res.status(500).json({ ok: false, error: errText, meta: { ms } });
}
});
app.listen(PORT, HOST, () => {
  console.log(`[vadim-ocr-helper] listening on http://${HOST}:${PORT}`);
});
