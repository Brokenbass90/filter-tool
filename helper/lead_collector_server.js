"use strict";

const fs = require("fs");
const path = require("path");
const { collectTedLeads } = require("./sources/ted");
const { collectCyprusEprocLeads } = require("./sources/cyprus_eprocurement");
const { collectZakupkiGovRuLeads } = require("./sources/zakupki_gov_ru");
const { collectGoszakupGovKzLeads } = require("./sources/goszakup_gov_kz");
const { collectIcetradeByLeads } = require("./sources/icetrade_by");

const GEO_CONFIG = {
  CYPRUS_EN: {
    defaultSources: ["ted", "cyprus_eprocurement"],
    allowedSources: new Set(["ted", "cyprus_eprocurement"]),
    tedQuery: "(buyer-country in (CYP))",
    countryAllowlist: new Set(["CY", "CYP"])
  },
  RU_CIS: {
    defaultSources: ["ted", "zakupki_gov_ru", "goszakup_gov_kz", "icetrade_by"],
    allowedSources: new Set(["ted", "zakupki_gov_ru", "goszakup_gov_kz", "icetrade_by"]),
    tedQuery: "((buyer-country in (RUS)) OR (buyer-country in (KAZ)) OR (buyer-country in (UZB)) OR (buyer-country in (KGZ)) OR (buyer-country in (ARM)) OR (buyer-country in (AZE)) OR (buyer-country in (TJK)) OR (buyer-country in (TKM)) OR (buyer-country in (MDA)) OR (buyer-country in (BLR)))",
    countryAllowlist: new Set([
      "RU", "RUS",
      "KZ", "KAZ",
      "BY", "BLR",
      "AM", "ARM",
      "AZ", "AZE",
      "KG", "KGZ",
      "UZ", "UZB",
      "TJ", "TJK",
      "TM", "TKM",
      "MD", "MDA"
    ])
  }
};

function nowIso() {
  return new Date().toISOString();
}

function clampInt(v, min, max, defVal) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defVal;
  const m = Math.floor(n);
  if (m < min) return min;
  if (m > max) return max;
  return m;
}

function normalizeText(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function normalizeEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function normalizePhone(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const m = s.match(/[+()0-9][0-9 ()-]{7,}[0-9]/);
  if (!m) return "";
  return String(m[0] || "").replace(/\s+/g, " ").trim().slice(0, 64);
}

function pickEmailFromObject(obj) {
  if (!obj || typeof obj !== "object") return "";
  const directKeys = [
    "email",
    "contact_email",
    "buyer_email",
    "customer_email",
    "organizer_email",
    "email_address",
    "mail"
  ];
  for (const k of directKeys) {
    const e = normalizeEmail(obj[k]);
    if (e) return e;
  }
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  for (const v of Object.values(obj)) {
    if (typeof v !== "string") continue;
    const m = v.match(re);
    if (!m) continue;
    const e = normalizeEmail(m[0]);
    if (e) return e;
  }
  return "";
}

function pickPhoneFromObject(obj) {
  if (!obj || typeof obj !== "object") return "";
  const directKeys = [
    "phone",
    "contact_phone",
    "mobile_phone",
    "telephone",
    "phone_number",
    "customer_phone",
    "organizer_phone"
  ];
  for (const k of directKeys) {
    const p = normalizePhone(obj[k]);
    if (p) return p;
  }
  const re = /(?:\+?\d[\d ()-]{8,}\d)/;
  for (const v of Object.values(obj)) {
    if (typeof v !== "string") continue;
    const m = v.match(re);
    if (!m) continue;
    const p = normalizePhone(m[0]);
    if (p) return p;
  }
  return "";
}

function normalizeTelegram(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const mUrl = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})/i);
  if (mUrl && mUrl[1]) return mUrl[1];
  const mAt = s.match(/(?:^|[\s,(])@([A-Za-z0-9_]{5,32})(?:\b|$)/);
  if (mAt && mAt[1]) return mAt[1];
  if (/^[A-Za-z0-9_]{5,32}$/.test(s)) return s;
  return "";
}

function pickTelegramFromObject(obj) {
  if (!obj || typeof obj !== "object") return "";
  const directKeys = ["telegram", "telegram_username", "tg", "contact_telegram"];
  for (const k of directKeys) {
    const tg = normalizeTelegram(obj[k]);
    if (tg) return tg;
  }
  for (const v of Object.values(obj)) {
    if (typeof v !== "string") continue;
    const tg = normalizeTelegram(v);
    if (tg) return tg;
  }
  return "";
}

function pickContactNameFromObject(obj) {
  if (!obj || typeof obj !== "object") return "";
  const keys = [
    "contact_name",
    "contact_person",
    "person_name",
    "fio",
    "full_name",
    "buyer_contact",
    "responsible_person"
  ];
  for (const k of keys) {
    const s = normalizeText(obj[k]);
    if (s) return s;
  }
  return "";
}

function geoConfig(geoBucket) {
  const key = String(geoBucket || "").trim().toUpperCase();
  return GEO_CONFIG[key] || GEO_CONFIG.CYPRUS_EN;
}

function normalizeCountryCode(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "CYPRUS") return "CYP";
  if (s === "RUSSIA") return "RUS";
  if (s === "KAZAKHSTAN") return "KAZ";
  if (s === "BELARUS") return "BLR";
  if (s === "MOLDOVA") return "MDA";
  return s;
}

function sanitizeSourcesForGeo(sources, geoBucket) {
  const out = [];
  const cfg = geoConfig(geoBucket);
  const allowed = cfg && cfg.allowedSources instanceof Set ? cfg.allowedSources : null;
  for (const src0 of (sources || [])) {
    const src = String(src0 || "").trim();
    if (!src) continue;
    if (allowed && !allowed.has(src)) continue;
    out.push(src);
  }
  return Array.from(new Set(out));
}

function isLeadAllowedForGeo(lead, geoBucket) {
  const cfg = geoConfig(geoBucket);
  const allow = cfg.countryAllowlist;
  if (!allow || !allow.size) return true;

  const c1 = normalizeCountryCode(lead && lead.country);
  const c2 = normalizeCountryCode(lead && lead.region);
  if (c1 || c2) return allow.has(c1) || allow.has(c2);
  return String((lead && lead.geo_bucket) || "").trim().toUpperCase() === String(geoBucket || "").trim().toUpperCase();
}

function normalizeLead(lead) {
  const source = normalizeText(lead && lead.source);
  const sourceId = normalizeText(lead && lead.source_id);
  const sourceUid = normalizeText(lead && lead.source_uid) || `${source}:${sourceId}`;
  const rawObj = (lead && typeof lead.raw === "object" && lead.raw) ? lead.raw : {};
  const contactEmail = normalizeEmail(lead && (lead.contact_email || lead.email)) || pickEmailFromObject(rawObj);
  const contactPhone = normalizePhone(lead && (lead.contact_phone || lead.phone)) || pickPhoneFromObject(rawObj);
  const contactTelegram = normalizeTelegram(lead && (lead.contact_telegram || lead.telegram || lead.telegram_username)) || pickTelegramFromObject(rawObj);
  const contactName = normalizeText(lead && (lead.contact_name || lead.contact_person)) || pickContactNameFromObject(rawObj);
  const country = normalizeText(lead && lead.country);
  const region = normalizeText(lead && lead.region);
  let geoBucket = normalizeText(lead && lead.geo_bucket);
  const countryNorm = normalizeCountryCode(country || region);
  if (geoBucket === "RU_CIS" && (source === "cyprus_eprocurement" || countryNorm === "CY" || countryNorm === "CYP")) {
    geoBucket = "CYPRUS_EN";
  }

  const cpvMain = normalizeText(lead && lead.cpv_main);
  const cpvCodes = Array.isArray(lead && lead.cpv_codes)
    ? lead.cpv_codes.map((x) => normalizeText(x)).filter(Boolean)
    : (cpvMain ? [cpvMain] : []);

  const budgetVal = (lead && lead.budget_value !== undefined && lead.budget_value !== null)
    ? Number(lead.budget_value)
    : null;

  return {
    source,
    source_id: sourceId,
    source_uid: sourceUid,
    title: normalizeText(lead && lead.title),
    buyer_name: normalizeText(lead && lead.buyer_name),
    contact_name: contactName,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    contact_telegram: contactTelegram,
    country,
    region,
    language: normalizeText(lead && lead.language),
    geo_bucket: geoBucket,
    deadline: normalizeText(lead && lead.deadline),
    deadline_raw: normalizeText(lead && lead.deadline_raw),
    cpv_main: cpvMain,
    cpv_codes: cpvCodes,
    budget_value: Number.isFinite(budgetVal) ? budgetVal : null,
    budget_currency: normalizeText(lead && lead.budget_currency),
    procedure: normalizeText(lead && lead.procedure),
    status: normalizeText(lead && lead.status),
    published_at: normalizeText(lead && lead.published_at),
    reference_no: normalizeText(lead && lead.reference_no),
    url: normalizeText(lead && lead.url),
    source_file: normalizeText(lead && lead.source_file),
    raw: rawObj,
    first_seen_at: normalizeText(lead && lead.first_seen_at),
    last_seen_at: normalizeText(lead && lead.last_seen_at),
    score: Number.isFinite(Number(lead && lead.score)) ? Number(lead.score) : 0,
    score_factors: (lead && typeof lead.score_factors === "object" && lead.score_factors) ? lead.score_factors : {}
  };
}

function leadCacheKey(lead) {
  const uid = normalizeText(lead && lead.source_uid);
  const geo = normalizeText(lead && lead.geo_bucket);
  if (!uid) return "";
  return geo ? `${uid}::${geo}` : uid;
}

function parseIsoDate(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isFinite(d.getTime())) return d;

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d2 = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isFinite(d2.getTime())) return d2;
  }
  return null;
}

function calcBudgetScore(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return 0;
  const v = Number(value);
  if (v >= 10000000) return 35;
  if (v >= 5000000) return 30;
  if (v >= 1000000) return 24;
  if (v >= 500000) return 20;
  if (v >= 100000) return 14;
  if (v >= 50000) return 10;
  return 6;
}

function calcDeadlineScore(deadlineValue) {
  const d = parseIsoDate(deadlineValue);
  if (!d) return 0;
  const ms = d.getTime() - Date.now();
  const days = Math.floor(ms / (24 * 3600 * 1000));
  if (days < 0) return -10;
  if (days <= 7) return 25;
  if (days <= 14) return 22;
  if (days <= 30) return 18;
  if (days <= 60) return 10;
  return 4;
}

function calcCpvScore(cpvMain, cpvPriority) {
  const cpv = String(cpvMain || "").trim();
  if (!cpv) return 0;
  const p = Array.isArray(cpvPriority) ? cpvPriority : [];
  for (const pref of p) {
    const x = String(pref || "").trim();
    if (!x) continue;
    if (cpv.startsWith(x)) return 16;
  }
  return 6;
}

function calcKeywordScore(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return 0;
  let s = 0;
  if (/(supply|procurement|equipment|materials|προμήθεια|εξοπλισμ|поставк|оборуд|товар)/.test(t)) s += 8;
  if (/(service|consult|υπηρεσ|υποστήριξ|услуг|консалт)/.test(t)) s -= 3;
  if (/(construction|repair|κατασκευ|εργασ|строит|ремонт)/.test(t)) s += 5;
  return s;
}

function scoreLeads(leads, cpvPriority) {
  const buyerFreq = new Map();
  for (const lead of leads) {
    const key = normalizeText(lead.buyer_name).toLowerCase();
    if (!key) continue;
    buyerFreq.set(key, (buyerFreq.get(key) || 0) + 1);
  }

  for (const lead of leads) {
    const budgetScore = calcBudgetScore(lead.budget_value);
    const deadlineScore = calcDeadlineScore(lead.deadline || lead.deadline_raw);
    const cpvScore = calcCpvScore(lead.cpv_main, cpvPriority);
    const keywordScore = calcKeywordScore(lead.title);
    const regionScore = lead.country === "CY" || lead.region === "CY" ? 6 : 2;

    const buyerKey = normalizeText(lead.buyer_name).toLowerCase();
    const freq = buyerKey ? (buyerFreq.get(buyerKey) || 0) : 0;
    const freqScore = freq >= 6 ? 12 : (freq >= 3 ? 8 : (freq >= 2 ? 5 : 2));

    const sourceScore = lead.source === "ted" ? 4
      : (lead.source === "cyprus_eprocurement" ? 3
        : (lead.source === "zakupki_gov_ru" ? 3
          : (lead.source === "goszakup_gov_kz" ? 3
            : (lead.source === "icetrade_by" ? 3 : 0))));
    const hasAltContact = !!normalizePhone(lead.contact_phone) || !!normalizeTelegram(lead.contact_telegram);
    const contactScore = lead.contact_email ? 5 : (hasAltContact ? 2 : 0);
    const baseScore = 15;

    const total = Math.max(0, Math.min(100,
      baseScore + budgetScore + deadlineScore + cpvScore + keywordScore + regionScore + freqScore + sourceScore + contactScore
    ));

    lead.score = total;
    lead.score_factors = {
      base: baseScore,
      budget: budgetScore,
      deadline: deadlineScore,
      cpv: cpvScore,
      title: keywordScore,
      region: regionScore,
      buyer_freq: freqScore,
      source: sourceScore,
      contact: contactScore
    };
  }
}

class LeadCollector {
  constructor(opts = {}) {
    this.cacheFile = opts.cacheFile;
    this.lastCollectAt = "";
    this.lastCollectMeta = null;
  }

  _readCache() {
    try {
      const raw = fs.readFileSync(this.cacheFile, "utf8");
      const json = JSON.parse(raw);
      if (!json || typeof json !== "object") throw new Error("bad_cache");
      const leadsRaw = Array.isArray(json.leads) ? json.leads : [];
      return {
        version: 1,
        updated_at: normalizeText(json.updated_at),
        leads: leadsRaw.map(normalizeLead)
      };
    } catch (_) {
      return { version: 1, updated_at: "", leads: [] };
    }
  }

  _writeCache(cache) {
    const out = {
      version: 1,
      updated_at: nowIso(),
      leads: Array.isArray(cache.leads) ? cache.leads : []
    };
    fs.writeFileSync(this.cacheFile, JSON.stringify(out, null, 2), "utf8");
  }

  _mergeLeads(existingLeads, incomingLeads) {
    const byUid = new Map();
    for (const lead of existingLeads) {
      const key = leadCacheKey(lead);
      if (!key) continue;
      byUid.set(key, lead);
    }

    let inserted = 0;
    let updated = 0;

    for (const inc0 of incomingLeads) {
      const inc = normalizeLead(inc0);
      const key = leadCacheKey(inc);
      if (!key) continue;
      const prev = byUid.get(key);
      if (!prev) {
        inc.first_seen_at = nowIso();
        inc.last_seen_at = nowIso();
        existingLeads.push(inc);
        byUid.set(key, inc);
        inserted += 1;
        continue;
      }

      const keepScore = Number.isFinite(Number(prev.score)) ? Number(prev.score) : 0;
      const keepFactors = prev.score_factors && typeof prev.score_factors === "object" ? prev.score_factors : {};
      const merged = {
        ...prev,
        ...inc,
        first_seen_at: prev.first_seen_at || nowIso(),
        last_seen_at: nowIso(),
        score: keepScore,
        score_factors: keepFactors
      };
      Object.assign(prev, merged);
      updated += 1;
    }

    return { inserted, updated };
  }

  _sortLeads(leads) {
    leads.sort((a, b) => {
      const s1 = Number(a.score || 0);
      const s2 = Number(b.score || 0);
      if (s1 !== s2) return s2 - s1;

      const d1 = parseIsoDate(a.deadline || a.deadline_raw);
      const d2 = parseIsoDate(b.deadline || b.deadline_raw);
      const t1 = d1 ? d1.getTime() : Number.MAX_SAFE_INTEGER;
      const t2 = d2 ? d2.getTime() : Number.MAX_SAFE_INTEGER;
      if (t1 !== t2) return t1 - t2;

      const p1 = parseIsoDate(a.published_at);
      const p2 = parseIsoDate(b.published_at);
      const pp1 = p1 ? p1.getTime() : 0;
      const pp2 = p2 ? p2.getTime() : 0;
      return pp2 - pp1;
    });
  }

  _filterLeads(leads, opts = {}) {
    const srcSet = Array.isArray(opts.sources) && opts.sources.length
      ? new Set(opts.sources.map((x) => String(x || "").trim()).filter(Boolean))
      : null;
    const geoBucket = normalizeText(opts.geoBucket);

    let out = leads;
    if (srcSet) {
      out = out.filter((x) => srcSet.has(String(x.source || "")));
    }
    if (geoBucket) {
      out = out.filter((x) => isLeadAllowedForGeo(x, geoBucket));
    }
    return out;
  }

  async collect(options = {}) {
    const limit = clampInt(options.limit, 1, 300, 60);
    const geoBucket = normalizeText(options.geoBucket || "CYPRUS_EN") || "CYPRUS_EN";
    const cfg = geoConfig(geoBucket);
    const requestedSources = Array.isArray(options.sources) && options.sources.length
      ? options.sources.map((x) => String(x || "").trim()).filter(Boolean)
      : cfg.defaultSources;
    const sources = sanitizeSourcesForGeo(requestedSources, geoBucket);
    const skippedSources = requestedSources.filter((src) => !sources.includes(src));
    const timeoutMs = clampInt(options.timeoutMs, 2000, 60000, 20000);
    const deepParse = options.deepParse !== false;
    const detailProbeCount = clampInt(options.detailProbeCount, 0, 100, 10);
    const detailTimeoutMs = clampInt(options.detailTimeoutMs, 1500, 60000, 9000);
    const detailConcurrency = clampInt(options.detailConcurrency, 1, 6, 3);
    const cpvPriority = Array.isArray(options.cpvPriority)
      ? options.cpvPriority.map((x) => String(x || "").trim()).filter(Boolean)
      : ["39", "42", "43", "44", "45", "46", "48", "34", "33"];

    const incoming = [];
    const sourceReports = [];
    for (const skipped of skippedSources) {
      sourceReports.push({ source: skipped, ok: true, fetched: 0, warnings: [`skipped_for_geo:${geoBucket}`] });
    }

    const sourceLimit = clampInt(Math.ceil(limit / Math.max(1, sources.length)), 1, 250, 40);
    if (!sources.length) {
      sourceReports.push({ source: "none", ok: false, fetched: 0, error: "no_sources_for_geo" });
    }

    for (const src of sources) {
      if (src === "ted") {
        try {
          const tedQuery = options.ted && options.ted.query
            ? String(options.ted.query)
            : String(cfg.tedQuery || "");
          const rep = await collectTedLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            query: tedQuery || undefined
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "ted", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [] });
        } catch (e) {
          sourceReports.push({ source: "ted", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e) });
        }
        continue;
      }

      if (src === "cyprus_eprocurement") {
        try {
          const rep = await collectCyprusEprocLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            maxPages: options.cyprus && options.cyprus.maxPages
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "cyprus_eprocurement", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [] });
        } catch (e) {
          sourceReports.push({ source: "cyprus_eprocurement", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e) });
        }
        continue;
      }

      if (src === "zakupki_gov_ru") {
        try {
          const rep = await collectZakupkiGovRuLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            maxPages: options.zakupki && options.zakupki.maxPages,
            searchString: options.zakupki && options.zakupki.searchString
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "zakupki_gov_ru", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [] });
        } catch (e) {
          sourceReports.push({ source: "zakupki_gov_ru", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e) });
        }
        continue;
      }

      if (src === "goszakup_gov_kz") {
        try {
          const rep = await collectGoszakupGovKzLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            endpoint: options.goszakup && options.goszakup.endpoint,
            token: options.goszakup && options.goszakup.token
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "goszakup_gov_kz", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [] });
        } catch (e) {
          sourceReports.push({ source: "goszakup_gov_kz", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e) });
        }
        continue;
      }

      if (src === "icetrade_by") {
        try {
          const rep = await collectIcetradeByLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            maxPages: options.icetrade && options.icetrade.maxPages
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "icetrade_by", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [] });
        } catch (e) {
          sourceReports.push({ source: "icetrade_by", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e) });
        }
        continue;
      }

      sourceReports.push({ source: src, ok: false, fetched: 0, error: "unsupported_source" });
    }

    const incomingRawCount = incoming.length;
    const incomingFiltered = incoming
      .filter((x) => isLeadAllowedForGeo(x, geoBucket))
      .map((x) => ({ ...x, geo_bucket: geoBucket }));
    const droppedByGeo = Math.max(0, incomingRawCount - incomingFiltered.length);

    const cache = this._readCache();
    const merged = this._mergeLeads(cache.leads, incomingFiltered);

    scoreLeads(cache.leads, cpvPriority);
    this._sortLeads(cache.leads);
    this._writeCache(cache);

    this.lastCollectAt = nowIso();
    this.lastCollectMeta = {
      requestedSources,
      sources,
      limit,
      incoming: incomingFiltered.length,
      incomingRaw: incomingRawCount,
      droppedByGeo,
      inserted: merged.inserted,
      updated: merged.updated,
      sourceReports
    };

    const batchByUid = new Set(incomingFiltered.map((x) => leadCacheKey(x)).filter(Boolean));
    const batchLeads = cache.leads.filter((x) => batchByUid.has(leadCacheKey(x)));
    this._sortLeads(batchLeads);

    return {
      ok: true,
      collected_at: this.lastCollectAt,
      inserted: merged.inserted,
      updated: merged.updated,
      fetched: incomingFiltered.length,
      fetched_raw: incomingRawCount,
      dropped_by_geo: droppedByGeo,
      total_cached: cache.leads.length,
      source_reports: sourceReports,
      leads: batchLeads.slice(0, limit)
    };
  }

  async diagnose(options = {}) {
    const limit = clampInt(options.limit, 1, 120, 24);
    const geoBucket = normalizeText(options.geoBucket || "CYPRUS_EN") || "CYPRUS_EN";
    const cfg = geoConfig(geoBucket);
    const requestedSources = Array.isArray(options.sources) && options.sources.length
      ? options.sources.map((x) => String(x || "").trim()).filter(Boolean)
      : cfg.defaultSources;
    const sources = sanitizeSourcesForGeo(requestedSources, geoBucket);
    const skippedSources = requestedSources.filter((src) => !sources.includes(src));
    const timeoutMs = clampInt(options.timeoutMs, 2000, 60000, 12000);
    const deepParse = options.deepParse === true;
    const detailProbeCount = clampInt(options.detailProbeCount, 0, 30, 3);
    const detailTimeoutMs = clampInt(options.detailTimeoutMs, 1500, 60000, 7000);
    const detailConcurrency = clampInt(options.detailConcurrency, 1, 6, 2);
    const cpvPriority = Array.isArray(options.cpvPriority)
      ? options.cpvPriority.map((x) => String(x || "").trim()).filter(Boolean)
      : ["39", "42", "43", "44", "45", "46", "48", "34", "33"];

    const incoming = [];
    const sourceReports = [];
    for (const skipped of skippedSources) {
      sourceReports.push({ source: skipped, ok: true, fetched: 0, warnings: [`skipped_for_geo:${geoBucket}`], duration_ms: 0 });
    }

    const sourceLimit = clampInt(Math.ceil(limit / Math.max(1, sources.length)), 1, 60, 8);
    if (!sources.length) {
      sourceReports.push({ source: "none", ok: false, fetched: 0, error: "no_sources_for_geo", duration_ms: 0 });
    }

    for (const src of sources) {
      const t0 = Date.now();
      if (src === "ted") {
        try {
          const tedQuery = options.ted && options.ted.query
            ? String(options.ted.query)
            : String(cfg.tedQuery || "");
          const rep = await collectTedLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            query: tedQuery || undefined
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "ted", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [], duration_ms: Date.now() - t0 });
        } catch (e) {
          sourceReports.push({ source: "ted", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e), duration_ms: Date.now() - t0 });
        }
        continue;
      }

      if (src === "cyprus_eprocurement") {
        try {
          const rep = await collectCyprusEprocLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            maxPages: options.cyprus && options.cyprus.maxPages
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "cyprus_eprocurement", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [], duration_ms: Date.now() - t0 });
        } catch (e) {
          sourceReports.push({ source: "cyprus_eprocurement", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e), duration_ms: Date.now() - t0 });
        }
        continue;
      }

      if (src === "zakupki_gov_ru") {
        try {
          const rep = await collectZakupkiGovRuLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            maxPages: options.zakupki && options.zakupki.maxPages,
            searchString: options.zakupki && options.zakupki.searchString
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "zakupki_gov_ru", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [], duration_ms: Date.now() - t0 });
        } catch (e) {
          sourceReports.push({ source: "zakupki_gov_ru", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e), duration_ms: Date.now() - t0 });
        }
        continue;
      }

      if (src === "goszakup_gov_kz") {
        try {
          const rep = await collectGoszakupGovKzLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            endpoint: options.goszakup && options.goszakup.endpoint,
            token: options.goszakup && options.goszakup.token
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "goszakup_gov_kz", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [], duration_ms: Date.now() - t0 });
        } catch (e) {
          sourceReports.push({ source: "goszakup_gov_kz", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e), duration_ms: Date.now() - t0 });
        }
        continue;
      }

      if (src === "icetrade_by") {
        try {
          const rep = await collectIcetradeByLeads({
            limit: sourceLimit,
            geoBucket,
            timeoutMs,
            deepParse,
            detailProbeCount,
            detailTimeoutMs,
            detailConcurrency,
            maxPages: options.icetrade && options.icetrade.maxPages
          });
          incoming.push(...(rep.leads || []));
          sourceReports.push({ source: "icetrade_by", ok: true, fetched: rep.fetched || 0, warnings: rep.warnings || [], duration_ms: Date.now() - t0 });
        } catch (e) {
          sourceReports.push({ source: "icetrade_by", ok: false, fetched: 0, error: String((e && e.message) ? e.message : e), duration_ms: Date.now() - t0 });
        }
        continue;
      }

      sourceReports.push({ source: src, ok: false, fetched: 0, error: "unsupported_source", duration_ms: Date.now() - t0 });
    }

    const incomingRawCount = incoming.length;
    const incomingFiltered = incoming
      .filter((x) => isLeadAllowedForGeo(x, geoBucket))
      .map((x) => ({ ...x, geo_bucket: geoBucket }));
    const droppedByGeo = Math.max(0, incomingRawCount - incomingFiltered.length);
    scoreLeads(incomingFiltered, cpvPriority);
    this._sortLeads(incomingFiltered);

    return {
      ok: true,
      diagnosed_at: nowIso(),
      fetched: incomingFiltered.length,
      fetched_raw: incomingRawCount,
      dropped_by_geo: droppedByGeo,
      source_reports: sourceReports,
      sample_leads: incomingFiltered.slice(0, limit),
      settings: {
        geoBucket,
        sources,
        requestedSources,
        limit,
        timeoutMs
      }
    };
  }

  clear(options = {}) {
    const clearMetaOnly = !!(options && options.metaOnly);
    if (!clearMetaOnly) {
      this._writeCache({ version: 1, updated_at: nowIso(), leads: [] });
    }
    this.lastCollectAt = "";
    this.lastCollectMeta = null;
    const cache = this._readCache();
    return {
      ok: true,
      cleared: !clearMetaOnly,
      meta_reset: true,
      total_cached: Array.isArray(cache.leads) ? cache.leads.length : 0,
      updated_at: cache.updated_at || ""
    };
  }

  list(options = {}) {
    const limit = clampInt(options.limit, 1, 500, 100);
    const cache = this._readCache();
    const leads = this._filterLeads(cache.leads, options).map((x) => normalizeLead(x));
    this._sortLeads(leads);
    return {
      ok: true,
      updated_at: cache.updated_at,
      total: leads.length,
      leads: leads.slice(0, limit)
    };
  }

  health() {
    const cache = this._readCache();
    const bySource = {};
    for (const lead of cache.leads) {
      const src = normalizeText(lead.source) || "unknown";
      bySource[src] = (bySource[src] || 0) + 1;
    }
    return {
      ok: true,
      cacheFile: this.cacheFile,
      updated_at: cache.updated_at,
      total_cached: cache.leads.length,
      by_source: bySource,
      last_collect_at: this.lastCollectAt,
      last_collect_meta: this.lastCollectMeta
    };
  }
}

function createLeadCollector(opts = {}) {
  const cacheDir = opts.cacheDir || path.join(__dirname, ".cache");
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  const cacheFile = opts.cacheFile || path.join(cacheDir, "lead_cache_v1.json");
  return new LeadCollector({ cacheFile });
}

module.exports = {
  createLeadCollector
};
