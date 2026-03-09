"use strict";

const ZAKUPKI_BASE_URL = "https://zakupki.gov.ru";
const ZAKUPKI_SEARCH_URL = `${ZAKUPKI_BASE_URL}/epz/order/extendedsearch/results.html`;

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
  const m = String(text || "").match(/(?:\+7|8)\s*\(?\d{3}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/);
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
  const m = String(text || "").match(/(?:контактное лицо|ответственн(?:ое|ый)\s+лиц[оа]|ФИО контактного лица)\s*[:\-]?\s*([A-Za-zА-Яа-яЁё.\- ]{6,100})/i);
  return m ? String(m[1] || "").replace(/\s+/g, " ").trim() : "";
}

function toAbsUrl(href) {
  const h = String(href || "").trim();
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("/")) return `${ZAKUPKI_BASE_URL}${h}`;
  return `${ZAKUPKI_BASE_URL}/${h}`;
}

function parseMoney(raw) {
  const s = String(raw || "")
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseRuDate(raw) {
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

function buildSearchUrl(page, perPage, searchString) {
  const qs = new URLSearchParams();
  qs.set("pageNumber", String(page));
  qs.set("recordsPerPage", `_${perPage}`);
  qs.set("sortDirection", "false");
  qs.set("searchString", searchString || "поставка");
  return `${ZAKUPKI_SEARCH_URL}?${qs.toString()}`;
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = null;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
        },
        signal: ctrl.signal
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("zakupki_timeout");
      const causeCode = e && e.cause && e.cause.code ? String(e.cause.code) : "";
      const causeMsg = e && e.cause && e.cause.message ? String(e.cause.message) : "";
      const msg = String((e && e.message) ? e.message : e);
      const suffix = (causeCode || causeMsg || msg) ? `:${causeCode || causeMsg || msg}` : "";
      throw new Error(`zakupki_fetch_failed${suffix}`);
    }
    const txt = await res.text();
    if (!res.ok) throw new Error(`zakupki_http_${res.status}`);
    if (!txt || txt.trim().length < 300) throw new Error("zakupki_empty_response");
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

function extractSourceId(url, title) {
  const u = String(url || "");
  const mReg = u.match(/regNumber=(\d{8,})/i);
  if (mReg) return mReg[1];
  const mPath = u.match(/\/(\d{8,})(?:\/|$|\?)/);
  if (mPath) return mPath[1];
  const mAny = u.match(/([A-Za-z0-9-]{8,})/);
  if (mAny) return mAny[1];
  return Buffer.from(String(title || "zakupki")).toString("base64").slice(0, 16);
}

function extractContextValues(ctx) {
  const txt = stripHtml(ctx);
  const deadlineMatch = txt.match(/(\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2})?)/);
  const deadlineRaw = deadlineMatch ? deadlineMatch[1] : "";
  const budgetMatch = txt.match(/(\d[\d\s]{3,}(?:[.,]\d{1,2})?)\s*(?:руб|RUB|₽)/i);
  const budgetRaw = budgetMatch ? budgetMatch[1] : "";
  const cpvMatch = txt.match(/\b(\d{8})\b/);
  const buyerMatch = txt.match(/(?:Заказчик|Организация|Customer)\s*[:\-]?\s*([^\n\r.;]{4,160})/i);
  const procedureMatch = txt.match(/(электронный аукцион|запрос котировок|конкурс|auction|tender)/i);
  const publishedMatch = txt.match(/(?:Размещен[ао]?|опубликован[ао]?|publication)\s*[:\-]?\s*(\d{2}\.\d{2}\.\d{4})/i);
  const contactEmail = extractEmail(txt);
  const contactPhone = extractPhone(txt);
  return {
    deadlineRaw,
    deadlineIso: parseRuDate(deadlineRaw),
    budgetValue: parseMoney(budgetRaw),
    cpv: cpvMatch ? cpvMatch[1] : "",
    buyer: buyerMatch ? String(buyerMatch[1]).trim() : "",
    contactEmail,
    contactPhone,
    procedure: procedureMatch ? String(procedureMatch[1]).trim() : "",
    publishedAt: publishedMatch ? parseRuDate(publishedMatch[1]) : ""
  };
}

function parseLeadsFromHtml(html, geoBucket, maxCount) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = String(m[1] || "");
    if (!/(\/epz\/order\/notice\/|regNumber=\d{8,})/i.test(href)) continue;
    const title = stripHtml(m[2] || "");
    if (!title || title.length < 8) continue;
    const url = toAbsUrl(href);
    const sourceId = extractSourceId(url, title);
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);

    const idx = m.index || 0;
    const ctx = html.slice(Math.max(0, idx - 1200), Math.min(html.length, idx + 2200));
    const x = extractContextValues(ctx);

    out.push({
      source: "zakupki_gov_ru",
      source_id: String(sourceId),
      source_uid: `zakupki_gov_ru:${sourceId}`,
      title: title,
      buyer_name: x.buyer || "",
      contact_email: x.contactEmail || "",
      contact_phone: x.contactPhone || "",
      country: "RUS",
      region: "RUS",
      language: "ru",
      geo_bucket: geoBucket,
      deadline: x.deadlineIso || x.deadlineRaw || "",
      deadline_raw: x.deadlineRaw || "",
      cpv_main: x.cpv || "",
      cpv_codes: x.cpv ? [x.cpv] : [],
      budget_value: x.budgetValue,
      budget_currency: x.budgetValue !== null ? "RUB" : "",
      procedure: x.procedure || "",
      status: "active",
      published_at: x.publishedAt || "",
      reference_no: String(sourceId),
      url: url,
      source_file: `ZAKUPKI ${sourceId}`,
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
        warnings.push(`zakupki_detail_${cur + 1}: ${String((e && e.message) ? e.message : e)}`);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < detailConcurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return leads;
}

async function collectZakupkiGovRuLeads(options = {}) {
  const limit = clampInt(options.limit, 1, 300, 40);
  const maxPages = clampInt(options.maxPages, 1, 10, 2);
  const timeoutMs = clampInt(options.timeoutMs, 2000, 60000, 20000);
  const geoBucket = String(options.geoBucket || "RU_CIS").trim() || "RU_CIS";
  const perPage = clampInt(options.perPage, 10, 50, 20);
  const searchString = String(options.searchString || "поставка").trim() || "поставка";

  const leads = [];
  const warnings = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = buildSearchUrl(page, perPage, searchString);
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
    source: "zakupki_gov_ru",
    fetched: leads.length,
    totalNoticeCount: null,
    timedOut: false,
    leads: leads.slice(0, limit),
    warnings
  };
}

module.exports = {
  collectZakupkiGovRuLeads
};
