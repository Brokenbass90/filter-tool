"use strict";

const ICETRADE_BASE_URL = "https://www.icetrade.by";
const ICETRADE_LIST_URL = `${ICETRADE_BASE_URL}/tenders/all`;

function clampInt(v, min, max, defVal) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defVal;
  const m = Math.floor(n);
  if (m < min) return min;
  if (m > max) return max;
  return m;
}

function decodeHtmlEntities(s) {
  const txt = String(s || "");
  return txt
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) ? String.fromCharCode(c) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const c = Number.parseInt(h, 16);
      return Number.isFinite(c) ? String.fromCharCode(c) : _;
    });
}

function stripHtml(s) {
  const cleaned = String(s || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decodeHtmlEntities(cleaned.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmail(text) {
  const m = String(text || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? String(m[0] || "").trim().toLowerCase() : "";
}

function extractPhone(text) {
  const m = String(text || "").match(/(?:\+375|375|80)\s*\(?\d{2}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/);
  return m ? String(m[0] || "").replace(/\s+/g, " ").trim() : "";
}

function extractPhoneAny(text) {
  const m = String(text || "").match(/(?:\+?\d[\d ()-]{8,}\d)/);
  return m ? String(m[0] || "").replace(/\s+/g, " ").trim() : "";
}

function extractTelegram(text) {
  const s = String(text || "");
  const m2 = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})/i);
  if (m2 && m2[1]) return m2[1];
  const m1 = s.match(/(?:^|[\s,(])@([A-Za-z0-9_]{5,32})(?:\b|$)/);
  if (m1 && m1[1]) return m1[1];
  return "";
}

function extractContactName(text) {
  const m = String(text || "").match(/(?:контактное лицо|контакты|responsible person|contact person)\s*[:\-]?\s*([A-Za-zА-Яа-яЁё.\- ]{6,100})/i);
  return m ? String(m[1] || "").replace(/\s+/g, " ").trim() : "";
}

function toAbsUrl(href) {
  const h = String(href || "").trim();
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("/")) return `${ICETRADE_BASE_URL}${h}`;
  return `${ICETRADE_BASE_URL}/${h}`;
}

function parseMoney(raw) {
  const s = String(raw || "")
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseByDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!m) return "";
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = Number(m[4] || 0);
  const mi = Number(m[5] || 0);
  if (![dd, mm, yyyy, hh, mi].every(Number.isFinite)) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return `${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:00+03:00`;
}

function buildListUrl(page) {
  const p = clampInt(page, 1, 200, 1);
  if (p <= 1) return ICETRADE_LIST_URL;
  const qs = new URLSearchParams();
  qs.set("page", String(p));
  return `${ICETRADE_LIST_URL}?${qs.toString()}`;
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
      },
      signal: ctrl.signal
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`icetrade_http_${res.status}`);
    if (!txt || txt.trim().length < 200) throw new Error("icetrade_empty_response");
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

function parseLeadsFromHtml(html, geoBucket, maxCount) {
  const out = [];
  const seen = new Set();

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    const trHtml = trMatch[1] || "";
    const aMatch = trHtml.match(/<a[^>]+href=["']([^"']*\/tenders[^"']*\/view\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const href = String(aMatch[1] || "");
    const sourceId = String(aMatch[2] || "");
    const title = stripHtml(aMatch[3] || "");
    if (!sourceId || !title || title.length < 6) continue;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const rowTxt = stripHtml(trHtml);
    const deadlineMatch = rowTxt.match(/(\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2})?)/);
    const deadlineRaw = deadlineMatch ? deadlineMatch[1] : "";
    const budgetMatch = rowTxt.match(/(\d[\d\s]{3,}(?:[.,]\d{1,2})?)\s*(?:BYN|бел\.?\s*руб|руб)/i);
    const cpvMatch = rowTxt.match(/\b(\d{8})\b/);
    const contactEmail = extractEmail(rowTxt);
    const contactPhone = extractPhone(rowTxt);

    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(trHtml)) !== null) {
      cells.push(stripHtml(tdMatch[1] || ""));
    }
    const buyer = cells.find((x) => x && x.length > 5 && x !== title && !/\d{2}\.\d{2}\.\d{4}/.test(x)) || "";

    out.push({
      source: "icetrade_by",
      source_id: sourceId,
      source_uid: `icetrade_by:${sourceId}`,
      title: title,
      buyer_name: buyer,
      contact_email: contactEmail || "",
      contact_phone: contactPhone || "",
      country: "BLR",
      region: "BLR",
      language: "ru",
      geo_bucket: geoBucket,
      deadline: parseByDate(deadlineRaw) || deadlineRaw || "",
      deadline_raw: deadlineRaw || "",
      cpv_main: cpvMatch ? cpvMatch[1] : "",
      cpv_codes: cpvMatch ? [cpvMatch[1]] : [],
      budget_value: budgetMatch ? parseMoney(budgetMatch[1]) : null,
      budget_currency: budgetMatch ? "BYN" : "",
      procedure: "",
      status: "active",
      published_at: "",
      reference_no: sourceId,
      url: toAbsUrl(href),
      source_file: `ICETRADE ${sourceId}`,
      raw: {}
    });
    if (out.length >= maxCount) break;
  }

  return out;
}

function enrichLeadFromDetailHtml(lead, html) {
  const txt = stripHtml(html);
  if (!txt) return lead;
  return {
    ...lead,
    contact_email: lead.contact_email || extractEmail(txt),
    contact_phone: lead.contact_phone || extractPhone(txt) || extractPhoneAny(txt),
    contact_telegram: lead.contact_telegram || extractTelegram(txt),
    contact_name: lead.contact_name || extractContactName(txt)
  };
}

async function enrichLeadsWithDetails(leads, options = {}, warnings = []) {
  const deepParse = options.deepParse !== false;
  if (!deepParse) return leads;
  const detailTimeoutMs = clampInt(options.detailTimeoutMs, 1500, 60000, 9000);
  const detailProbeCount = clampInt(options.detailProbeCount, 0, 100, Math.min(12, leads.length));
  const detailConcurrency = clampInt(options.detailConcurrency, 1, 6, 3);
  const targets = (Array.isArray(leads) ? leads : [])
    .filter((x) => x && x.url)
    .filter((x) => !(x.contact_email || x.contact_phone || x.contact_telegram))
    .slice(0, detailProbeCount);
  if (!targets.length) return leads;

  let idx = 0;
  async function worker() {
    while (true) {
      const cur = idx++;
      if (cur >= targets.length) break;
      const lead = targets[cur];
      try {
        const html = await fetchText(String(lead.url || ""), detailTimeoutMs);
        const next = enrichLeadFromDetailHtml(lead, html);
        Object.assign(lead, next);
      } catch (e) {
        warnings.push(`icetrade_detail_${cur + 1}: ${String((e && e.message) ? e.message : e)}`);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < detailConcurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return leads;
}

async function collectIcetradeByLeads(options = {}) {
  const limit = clampInt(options.limit, 1, 300, 40);
  const maxPages = clampInt(options.maxPages, 1, 10, 2);
  const timeoutMs = clampInt(options.timeoutMs, 2000, 60000, 20000);
  const geoBucket = String(options.geoBucket || "RU_CIS").trim() || "RU_CIS";

  const leads = [];
  const warnings = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = buildListUrl(page);
    let html = "";
    try {
      html = await fetchText(url, timeoutMs);
    } catch (e) {
      warnings.push(`page_${page}: ${String((e && e.message) ? e.message : e)}`);
      break;
    }
    const pageLeads = parseLeadsFromHtml(html, geoBucket, Math.max(0, limit - leads.length));
    if (!pageLeads.length) {
      warnings.push(`page_${page}: no_parsed_leads`);
      break;
    }
    leads.push(...pageLeads);
    if (leads.length >= limit) break;
  }
  await enrichLeadsWithDetails(leads, options, warnings);

  return {
    source: "icetrade_by",
    fetched: leads.length,
    totalNoticeCount: null,
    timedOut: false,
    leads: leads.slice(0, limit),
    warnings
  };
}

module.exports = {
  collectIcetradeByLeads
};
