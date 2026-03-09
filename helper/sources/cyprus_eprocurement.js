"use strict";

const EPROC_BASE_URL = "https://www.eprocurement.gov.cy";
const EPROC_OPENED_TENDERS_URL = `${EPROC_BASE_URL}/epps/common/viewOpenedTenders.do`;

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
    .replace(/&quot;/g, '"')
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
  const m = String(text || "").match(/(?:\+357|\+?\d[\d ()-]{8,}\d)/);
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
  const m = String(text || "").match(/(?:contact person|contact point|responsible officer|υπεύθυνος επικοινωνίας)\s*[:\-]?\s*([A-Za-zΑ-Ωα-ωΆ-ώ.\- ]{6,100})/i);
  return m ? String(m[1] || "").replace(/\s+/g, " ").trim() : "";
}

function detectLangByText(text) {
  const t = String(text || "");
  if (!t) return "en";
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  return "en";
}

function parseEetDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(EET|EEST)\s+(\d{4})$/);
  if (!m) {
    const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m2) return "";
    const dd = Number(m2[1]);
    const mm = Number(m2[2]);
    const yyyy = Number(m2[3]);
    const hh = Number(m2[4] || 0);
    const mi = Number(m2[5] || 0);
    const ss = Number(m2[6] || 0);
    if (![dd, mm, yyyy, hh, mi, ss].every(Number.isFinite)) return "";
    const pad = (x) => String(x).padStart(2, "0");
    return `${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(ss)}+02:00`;
  }

  const monthName = String(m[1] || "").toLowerCase();
  const monthMap = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  const mm = monthMap[monthName];
  if (!mm) return "";

  const dd = Number(m[2]);
  const hh = Number(m[3]);
  const mi = Number(m[4]);
  const ss = Number(m[5]);
  const tz = String(m[6] || "EET").toUpperCase();
  const yyyy = Number(m[7]);

  if (![dd, hh, mi, ss, yyyy].every(Number.isFinite)) return "";
  const offset = tz === "EEST" ? "+03:00" : "+02:00";
  const pad = (x) => String(x).padStart(2, "0");
  return `${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(ss)}${offset}`;
}

function parseRowsFromTable(html) {
  const m = String(html || "").match(/<table[^>]*id=["']T01["'][^>]*>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
  if (!m) return [];
  const tbody = m[1] || "";
  const rows = [];

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(tbody)) !== null) {
    const trHtml = trMatch[1] || "";
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(trHtml)) !== null) {
      cells.push(tdMatch[1] || "");
    }
    if (cells.length < 6) continue;

    const titleCell = cells[1] || "";
    const title = stripHtml(titleCell);
    const resourceMatch = titleCell.match(/resourceId=(\d+)/i);
    const resourceId = resourceMatch ? String(resourceMatch[1]) : "";

    const detailsCell = cells[6] || "";
    const detailsHrefMatch = detailsCell.match(/href=["']([^"']+)["']/i);
    const detailsHref = detailsHrefMatch ? String(detailsHrefMatch[1]) : "";

    rows.push({
      seq: stripHtml(cells[0] || ""),
      title,
      resourceId,
      uniqueNo: stripHtml(cells[2] || ""),
      authority: stripHtml(cells[3] || ""),
      deadlineRaw: stripHtml(cells[4] || ""),
      procedure: stripHtml(cells[5] || ""),
      detailsHref,
      awardDateRaw: stripHtml(cells[7] || ""),
      status: stripHtml(cells[8] || "")
    });
  }

  return rows;
}

function extractPagerKey(html) {
  const m = String(html || "").match(/\?((d-\d+)-p=\d+)/i);
  if (!m) return "";
  return String(m[2] || "").trim();
}

function toAbsoluteUrl(href) {
  const h = String(href || "").trim();
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("/")) return `${EPROC_BASE_URL}${h}`;
  return `${EPROC_BASE_URL}/${h}`;
}

function inferCpvFromTitle(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return "";
  if (/(construction|κατασκευ|строит|εργασ)/.test(t)) return "45000000";
  if (/(software|λογισμ|програм|it|πληροφορ)/.test(t)) return "48000000";
  if (/(medical|νοσηλ|υγεί|ιατρ|медиц)/.test(t)) return "33000000";
  if (/(catering|τροφοδοσ|еда|питани)/.test(t)) return "55520000";
  if (/(clean|καθαρισ|уборк)/.test(t)) return "90910000";
  if (/(equipment|εξοπλισμ|оборуд)/.test(t)) return "39000000";
  if (/(supply|προμηθ|поставк)/.test(t)) return "34000000";
  return "";
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
    if (!res.ok) throw new Error(`cy_eproc_http_${res.status}`);
    if (!txt || txt.trim().length < 100) throw new Error("cy_eproc_empty_response");
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

function enrichLeadFromDetailHtml(lead, html) {
  const txt = stripHtml(html);
  if (!txt) return lead;
  return {
    ...lead,
    contact_email: lead.contact_email || extractEmail(txt),
    contact_phone: lead.contact_phone || extractPhone(txt),
    contact_telegram: lead.contact_telegram || extractTelegram(txt),
    contact_name: lead.contact_name || extractContactName(txt)
  };
}

async function enrichLeadsWithDetails(leads, options = {}, warnings = []) {
  const deepParse = options.deepParse !== false;
  if (!deepParse) return leads;
  const detailTimeoutMs = clampInt(options.detailTimeoutMs, 1500, 60000, 8000);
  const detailProbeCount = clampInt(options.detailProbeCount, 0, 80, Math.min(10, leads.length));
  const detailConcurrency = clampInt(options.detailConcurrency, 1, 6, 2);
  const targets = (Array.isArray(leads) ? leads : [])
    .filter((x) => x && (x.raw && x.raw.details_url))
    .filter((x) => !(x.contact_email || x.contact_phone || x.contact_telegram))
    .slice(0, detailProbeCount);
  if (!targets.length) return leads;

  let idx = 0;
  async function worker() {
    while (true) {
      const cur = idx++;
      if (cur >= targets.length) break;
      const lead = targets[cur];
      const detailUrl = String((lead.raw && lead.raw.details_url) || lead.url || "").trim();
      if (!detailUrl) continue;
      try {
        const html = await fetchText(detailUrl, detailTimeoutMs);
        const next = enrichLeadFromDetailHtml(lead, html);
        Object.assign(lead, next);
      } catch (e) {
        warnings.push(`cy_detail_${cur + 1}: ${String((e && e.message) ? e.message : e)}`);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < detailConcurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return leads;
}

function mapRowToLead(row, geoBucket) {
  const sourceId = row.resourceId || row.uniqueNo || `${row.seq}-${Buffer.from(row.title).toString("base64").slice(0, 12)}`;
  const cftHref = row.resourceId
    ? `/epps/cft/prepareViewCfTWS.do?resourceId=${encodeURIComponent(row.resourceId)}`
    : "";
  const url = toAbsoluteUrl(cftHref || row.detailsHref || EPROC_OPENED_TENDERS_URL);
  const detailsUrl = toAbsoluteUrl(row.detailsHref || "");
  const deadlineIso = parseEetDate(row.deadlineRaw);
  const awardIso = parseEetDate(row.awardDateRaw);
  const cpv = inferCpvFromTitle(row.title);

  return {
    source: "cyprus_eprocurement",
    source_id: String(sourceId),
    source_uid: `cyprus_eprocurement:${sourceId}`,
    title: row.title || String(sourceId),
    buyer_name: row.authority || "",
    country: "CY",
    region: "CY",
    language: detectLangByText(row.title || row.authority),
    geo_bucket: geoBucket,
    deadline: deadlineIso || row.deadlineRaw || "",
    deadline_raw: row.deadlineRaw || "",
    cpv_main: cpv,
    cpv_codes: cpv ? [cpv] : [],
    budget_value: null,
    budget_currency: "",
    procedure: row.procedure || "",
    status: row.status || "",
    published_at: awardIso || "",
    reference_no: row.uniqueNo || "",
    url,
    source_file: `CY_EPROC ${sourceId}`,
    raw: {
      award_date_raw: row.awardDateRaw || "",
      details_url: detailsUrl,
      unique_no: row.uniqueNo || ""
    }
  };
}

async function collectCyprusEprocLeads(options = {}) {
  const limit = clampInt(options.limit, 1, 300, 40);
  const maxPages = clampInt(options.maxPages, 1, 25, 5);
  const timeoutMs = clampInt(options.timeoutMs, 2000, 60000, 20000);
  const geoBucket = String(options.geoBucket || "CYPRUS_EN").trim() || "CYPRUS_EN";

  let pagerKey = "";
  const leads = [];
  const warnings = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1
      ? EPROC_OPENED_TENDERS_URL
      : (pagerKey ? `${EPROC_OPENED_TENDERS_URL}?${pagerKey}-p=${page}` : "");

    if (!url) break;

    let html = "";
    try {
      html = await fetchText(url, timeoutMs);
    } catch (e) {
      warnings.push(`page_${page}: ${String((e && e.message) ? e.message : e)}`);
      break;
    }

    if (page === 1) {
      pagerKey = extractPagerKey(html);
      if (!pagerKey) warnings.push("pager_key_not_found_using_first_page_only");
    }

    const rows = parseRowsFromTable(html);
    if (!rows.length) {
      warnings.push(`page_${page}: no_rows`);
      break;
    }

    for (const row of rows) {
      leads.push(mapRowToLead(row, geoBucket));
      if (leads.length >= limit) break;
    }
    if (leads.length >= limit) break;

    if (!pagerKey) break;
  }
  await enrichLeadsWithDetails(leads, options, warnings);

  return {
    source: "cyprus_eprocurement",
    fetched: leads.length,
    totalNoticeCount: null,
    timedOut: false,
    leads,
    warnings
  };
}

module.exports = {
  collectCyprusEprocLeads
};
