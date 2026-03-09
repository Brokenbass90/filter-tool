"use strict";

const TED_API_URL = "https://tedweb.api.ted.europa.eu/v3/notices/search";

const DEFAULT_FIELDS = [
  "notice-title",
  "title-proc",
  "title-lot",
  "buyer-name",
  "buyer-country",
  "publication-date",
  "dispatch-date",
  "deadline",
  "main-classification-proc",
  "main-classification-lot",
  "estimated-value-proc",
  "estimated-value-cur-proc",
  "estimated-value-lot",
  "estimated-value-cur-lot",
  "notice-type",
  "notice-subtype",
  "links"
];

function defaultTedQueryByGeo(geoBucket) {
  const g = String(geoBucket || "").trim().toUpperCase();
  if (g === "RU_CIS") {
    return "((buyer-country in (RUS)) OR (buyer-country in (KAZ)) OR (buyer-country in (UZB)) OR (buyer-country in (KGZ)) OR (buyer-country in (ARM)) OR (buyer-country in (AZE)) OR (buyer-country in (TJK)) OR (buyer-country in (TKM)) OR (buyer-country in (MDA)) OR (buyer-country in (BLR)))";
  }
  return "(buyer-country in (CYP))";
}

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
  const all = String(text || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig) || [];
  for (const e0 of all) {
    const e = String(e0 || "").trim().toLowerCase();
    const local = e.split("@")[0] || "";
    if (!e) continue;
    if (/(^default$|^test$|^example$|noreply|no-reply)/i.test(local)) continue;
    return e;
  }
  return "";
}

function extractPhone(text) {
  const all = String(text || "").match(/(?:\+?\d[\d ()-]{8,}\d)/g) || [];
  for (const p0 of all) {
    const p = String(p0 || "").replace(/\s+/g, " ").trim();
    const digits = p.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    if (/^00800/.test(digits)) continue;
    if (/^\d{6,}-\d{4,}$/.test(p.replace(/\s+/g, ""))) continue;
    if (!/[+\s()]/.test(p)) continue;
    return p;
  }
  return "";
}

function extractTelegram(text) {
  const s = String(text || "");
  const m2 = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})/i);
  if (m2 && m2[1]) return m2[1];
  return "";
}

function extractContactName(text) {
  const m = String(text || "").match(/(?:contact person|contact point|контактное лицо|ответственн(?:ое|ый)\s+лиц[оа])\s*[:\-]?\s*([A-Za-zА-Яа-яЁё.\- ]{6,100})/i);
  return m ? String(m[1] || "").replace(/\s+/g, " ").trim() : "";
}

function parseNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return parseNumber(v[0]);
  const n = Number(String(v).replace(/\s+/g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

function pickFromArray(arr) {
  if (!Array.isArray(arr)) return "";
  for (const x of arr) {
    const s = String(x || "").trim();
    if (s) return s;
  }
  return "";
}

function firstObjectValue(obj) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      const s = pickFromArray(v);
      if (s) return s;
    }
    const s = String(v || "").trim();
    if (s) return s;
  }
  return "";
}

function pickLocalized(value, preferredLangs) {
  if (!value) return { text: "", lang: "" };
  if (typeof value === "string") return { text: value.trim(), lang: "" };
  if (Array.isArray(value)) {
    return { text: pickFromArray(value), lang: "" };
  }
  if (typeof value === "object") {
    for (const lang of preferredLangs) {
      if (!(lang in value)) continue;
      const v = value[lang];
      if (Array.isArray(v)) {
        const s = pickFromArray(v);
        if (s) return { text: s, lang };
      }
      const s = String(v || "").trim();
      if (s) return { text: s, lang };
    }
    return { text: firstObjectValue(value), lang: "" };
  }
  return { text: "", lang: "" };
}

function pickCountry(v) {
  if (!v) return "";
  if (Array.isArray(v)) return String(v[0] || "").trim();
  return String(v || "").trim();
}

function pickDeadline(v) {
  if (!v) return "";
  if (Array.isArray(v)) return String(v[0] || "").trim();
  return String(v || "").trim();
}

function pickMainCpv(notice) {
  const fromProc = Array.isArray(notice["main-classification-proc"])
    ? String(notice["main-classification-proc"][0] || "").trim()
    : "";
  if (fromProc) return fromProc;
  const fromLot = Array.isArray(notice["main-classification-lot"])
    ? String(notice["main-classification-lot"][0] || "").trim()
    : "";
  return fromLot;
}

function pickEstimatedValue(notice) {
  const procVal = parseNumber(notice["estimated-value-proc"]);
  if (procVal !== null) {
    return {
      value: procVal,
      currency: String(notice["estimated-value-cur-proc"] || "").trim() || "EUR"
    };
  }
  const lotVal = parseNumber(notice["estimated-value-lot"]);
  if (lotVal !== null) {
    const curRaw = notice["estimated-value-cur-lot"];
    const cur = Array.isArray(curRaw) ? String(curRaw[0] || "").trim() : String(curRaw || "").trim();
    return { value: lotVal, currency: cur || "EUR" };
  }
  return { value: null, currency: "" };
}

function pickNoticeUrl(notice) {
  const links = notice && notice.links ? notice.links : null;
  if (!links || typeof links !== "object") return "";
  const html = links.html && typeof links.html === "object" ? links.html : null;
  if (html) {
    if (html.ENG) return String(html.ENG);
    const first = firstObjectValue(html);
    if (first) return first;
  }
  const htmlDirect = links.htmlDirect && typeof links.htmlDirect === "object" ? links.htmlDirect : null;
  if (htmlDirect) {
    if (htmlDirect.ENG) return String(htmlDirect.ENG);
    const first = firstObjectValue(htmlDirect);
    if (first) return first;
  }
  const xml = links.xml && typeof links.xml === "object" ? links.xml : null;
  if (xml) {
    if (xml.MUL) return String(xml.MUL);
    const first = firstObjectValue(xml);
    if (first) return first;
  }
  return "";
}

function extractBuyerName(notice, langs) {
  const buyer = notice && notice["buyer-name"] ? notice["buyer-name"] : null;
  if (!buyer) return "";
  const picked = pickLocalized(buyer, langs);
  return String(picked.text || "").trim();
}

function extractTitle(notice, langs) {
  const title1 = pickLocalized(notice && notice["notice-title"], langs);
  if (title1.text) return title1;
  const title2 = pickLocalized(notice && notice["title-proc"], langs);
  if (title2.text) return title2;
  const title3 = pickLocalized(notice && notice["title-lot"], langs);
  if (title3.text) return title3;
  return { text: "", lang: "" };
}

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const txt = await res.text();
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch (_) {
      json = null;
    }
    if (!res.ok) {
      const detail = json && (json.message || json.error)
        ? JSON.stringify({ message: json.message || "", error: json.error || "" })
        : (txt || `HTTP ${res.status}`);
      throw new Error(`ted_http_${res.status}: ${detail.slice(0, 400)}`);
    }
    if (!json || typeof json !== "object") {
      throw new Error("ted_invalid_json");
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
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
    if (!res.ok) throw new Error(`ted_detail_http_${res.status}`);
    if (!txt || txt.trim().length < 120) throw new Error("ted_detail_empty");
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
  const detailProbeCount = clampInt(options.detailProbeCount, 0, 60, Math.min(8, leads.length));
  const detailConcurrency = clampInt(options.detailConcurrency, 1, 6, 2);
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
        warnings.push(`ted_detail_${cur + 1}: ${String((e && e.message) ? e.message : e)}`);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < detailConcurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return leads;
}

function mapTedNoticeToLead(notice, geoBucket, langs) {
  const sourceId = String(notice["publication-number"] || "").trim();
  if (!sourceId) return null;

  const title = extractTitle(notice, langs);
  const buyerName = extractBuyerName(notice, langs);
  const buyerCountry = pickCountry(notice["buyer-country"] || "CYP") || "CYP";
  const deadlineRaw = pickDeadline(notice.deadline);
  const cpvMain = pickMainCpv(notice);
  const value = pickEstimatedValue(notice);
  const url = pickNoticeUrl(notice);

  return {
    source: "ted",
    source_id: sourceId,
    source_uid: `ted:${sourceId}`,
    title: title.text || sourceId,
    buyer_name: buyerName || "",
    country: buyerCountry,
    region: buyerCountry,
    language: title.lang || "eng",
    geo_bucket: geoBucket,
    deadline: deadlineRaw || "",
    cpv_main: cpvMain || "",
    cpv_codes: cpvMain ? [cpvMain] : [],
    budget_value: value.value,
    budget_currency: value.currency,
    procedure: String(notice["notice-type"] || "").trim(),
    status: "active",
    published_at: String(notice["publication-date"] || notice["dispatch-date"] || "").trim(),
    reference_no: sourceId,
    url: url || "",
    source_file: `TED ${sourceId}`,
    raw: {
      notice_type: String(notice["notice-type"] || ""),
      notice_subtype: String(notice["notice-subtype"] || "")
    }
  };
}

async function collectTedLeads(options = {}) {
  const limit = clampInt(options.limit, 1, 200, 40);
  const geoBucket = String(options.geoBucket || "CYPRUS_EN").trim() || "CYPRUS_EN";
  const query = String(options.query || defaultTedQueryByGeo(geoBucket)).trim();
  const scope = String(options.scope || "ACTIVE").trim() || "ACTIVE";
  const timeoutMs = clampInt(options.timeoutMs, 2000, 60000, 20000);
  const preferredLangs = Array.isArray(options.preferredLangs) && options.preferredLangs.length
    ? options.preferredLangs.map((x) => String(x || "").trim()).filter(Boolean)
    : ["eng", "ell", "en"];

  const payload = {
    scope,
    query,
    limit,
    paginationMode: "ITERATION",
    onlyLatestVersions: true,
    fields: DEFAULT_FIELDS
  };

  const json = await fetchJson(
    TED_API_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    timeoutMs
  );

  const notices = Array.isArray(json.notices) ? json.notices : [];
  const leads = [];
  for (const notice of notices) {
    const lead = mapTedNoticeToLead(notice || {}, geoBucket, preferredLangs);
    if (lead) leads.push(lead);
  }
  const warnings = [];
  await enrichLeadsWithDetails(leads, options, warnings);

  return {
    source: "ted",
    fetched: leads.length,
    totalNoticeCount: Number.isFinite(Number(json.totalNoticeCount)) ? Number(json.totalNoticeCount) : null,
    timedOut: !!json.timedOut,
    leads,
    warnings
  };
}

module.exports = {
  collectTedLeads
};
