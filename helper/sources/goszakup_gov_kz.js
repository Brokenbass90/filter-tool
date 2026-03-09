"use strict";

const GOSZAKUP_API_BASE = "https://ows.goszakup.gov.kz/v2";

function clampInt(v, min, max, defVal) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defVal;
  const m = Math.floor(n);
  if (m < min) return min;
  if (m > max) return max;
  return m;
}

function parseNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return parseNumber(v[0]);
  const n = Number(String(v).replace(/\s+/g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

function norm(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function extractEmail(v) {
  const m = String(v || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? String(m[0] || "").trim().toLowerCase() : "";
}

function extractPhone(v) {
  const m = String(v || "").match(/(?:\+?\d[\d ()-]{8,}\d)/);
  return m ? String(m[0] || "").replace(/\s+/g, " ").trim() : "";
}

function extractTelegram(v) {
  const s = String(v || "");
  const m2 = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,32})/i);
  if (m2 && m2[1]) return m2[1];
  const m1 = s.match(/(?:^|[\s,(])@([A-Za-z0-9_]{5,32})(?:\b|$)/);
  if (m1 && m1[1]) return m1[1];
  return "";
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    const s = norm(obj[k]);
    if (s) return s;
  }
  return "";
}

function parseDateAny(v) {
  const s = norm(v);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isFinite(d.getTime())) return d.toISOString();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!m) return "";
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = Number(m[4] || 0);
  const mi = Number(m[5] || 0);
  if (![dd, mm, yyyy, hh, mi].every(Number.isFinite)) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return `${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:00+05:00`;
}

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = null;
    try {
      res = await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("goszakup_timeout");
      const causeCode = e && e.cause && e.cause.code ? String(e.cause.code) : "";
      const causeMsg = e && e.cause && e.cause.message ? String(e.cause.message) : "";
      const msg = String((e && e.message) ? e.message : e);
      const suffix = (causeCode || causeMsg || msg) ? `:${causeCode || causeMsg || msg}` : "";
      throw new Error(`goszakup_fetch_failed${suffix}`);
    }
    const txt = await res.text();
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch (_) {
      json = null;
    }
    if (!res.ok) {
      if (res.status === 401) throw new Error("goszakup_unauthorized");
      throw new Error(`goszakup_http_${res.status}`);
    }
    if (!json || typeof json !== "object") throw new Error("goszakup_invalid_json");
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function recordsFromResponse(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.results)) return json.results;
  if (json.result && Array.isArray(json.result.items)) return json.result.items;
  if (json.response && Array.isArray(json.response.items)) return json.response.items;
  return [];
}

function mapRecordToLead(rec, geoBucket) {
  const id = norm(rec.id || rec.id_lot || rec.id_plan || rec.id_announce || rec.ref_buy || rec.trd_buy_id || rec.number_announced);
  if (!id) return null;

  const title = pickFirst(rec, [
    "name_ru",
    "name_kz",
    "name_en",
    "lot_name_ru",
    "lot_name_kz",
    "trd_buy_name_ru",
    "trd_buy_name_kz",
    "title",
    "description_ru",
    "description"
  ]) || String(id);

  const buyer = pickFirst(rec, [
    "customer_name_ru",
    "customer_name_kz",
    "name_ru_customer",
    "name_kz_customer",
    "organizer_name_ru",
    "organizer_name_kz",
    "company_name"
  ]);

  const deadline = parseDateAny(
    rec.end_date ||
    rec.date_end ||
    rec.accept_end_date ||
    rec.time_end ||
    rec.publish_date
  );
  const published = parseDateAny(rec.publish_date || rec.created_at || rec.updated_at);

  const cpv = pickFirst(rec, ["ktru_code", "cpv", "code", "trd_buy_code"]);
  const amount = parseNumber(
    rec.amount ||
    rec.sum ||
    rec.price ||
    rec.total_sum ||
    rec.plan_sum
  );
  const contactName = pickFirst(rec, [
    "contact_name",
    "contact_person",
    "fio",
    "author_name",
    "manager_name",
    "responsible_person"
  ]);
  const contactEmail = extractEmail(
    pickFirst(rec, [
      "contact_email",
      "email",
      "customer_email",
      "organizer_email",
      "email_address"
    ]) || JSON.stringify(rec || {})
  );
  const contactPhone = extractPhone(
    pickFirst(rec, [
      "contact_phone",
      "phone",
      "telephone",
      "customer_phone",
      "organizer_phone",
      "phone_number"
    ]) || JSON.stringify(rec || {})
  );
  const contactTelegram = extractTelegram(
    pickFirst(rec, [
      "telegram",
      "telegram_username",
      "contact_telegram",
      "tg"
    ]) || JSON.stringify(rec || {})
  );

  const url = norm(
    rec.url ||
    rec.link ||
    rec.portal_url ||
    (rec.number_announced ? `https://goszakup.gov.kz/ru/announce/index/${encodeURIComponent(rec.number_announced)}` : "")
  );

  return {
    source: "goszakup_gov_kz",
    source_id: String(id),
    source_uid: `goszakup_gov_kz:${id}`,
    title: title,
    buyer_name: buyer,
    contact_name: contactName,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    contact_telegram: contactTelegram,
    country: "KAZ",
    region: "KAZ",
    language: "ru",
    geo_bucket: geoBucket,
    deadline: deadline || "",
    deadline_raw: norm(rec.end_date || rec.date_end || rec.accept_end_date || rec.time_end),
    cpv_main: cpv || "",
    cpv_codes: cpv ? [cpv] : [],
    budget_value: amount,
    budget_currency: amount !== null ? "KZT" : "",
    procedure: pickFirst(rec, ["type_name_ru", "trade_method_name_ru", "trd_buy_type"]),
    status: pickFirst(rec, ["status", "status_name_ru"]) || "active",
    published_at: published || "",
    reference_no: norm(rec.number_announced || rec.ref_buy || id),
    url: url,
    source_file: `GOSZAKUP_KZ ${id}`,
    raw: {}
  };
}

async function collectGoszakupGovKzLeads(options = {}) {
  const limit = clampInt(options.limit, 1, 300, 40);
  const timeoutMs = clampInt(options.timeoutMs, 2000, 60000, 20000);
  const geoBucket = String(options.geoBucket || "RU_CIS").trim() || "RU_CIS";
  const endpoint = norm(options.endpoint || process.env.GOSZAKUP_API_ENDPOINT || "lots");
  const token = norm(options.token || process.env.GOSZAKUP_API_TOKEN || "");

  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (token) qs.set("access_token", token);
  const url = `${GOSZAKUP_API_BASE}/${encodeURIComponent(endpoint)}?${qs.toString()}`;

  const headers = { "Accept": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let json = null;
  const warnings = [];
  if (!token) {
    warnings.push("goszakup_token_missing");
    warnings.push("goszakup_requires_api_token");
    return {
      source: "goszakup_gov_kz",
      fetched: 0,
      totalNoticeCount: null,
      timedOut: false,
      leads: [],
      warnings
    };
  }
  try {
    json = await fetchJson(url, { method: "GET", headers }, timeoutMs);
  } catch (e) {
    warnings.push(String((e && e.message) ? e.message : e));
    return {
      source: "goszakup_gov_kz",
      fetched: 0,
      totalNoticeCount: null,
      timedOut: false,
      leads: [],
      warnings
    };
  }

  const records = recordsFromResponse(json);
  const leads = [];
  for (const rec of records) {
    const lead = mapRecordToLead(rec || {}, geoBucket);
    if (lead) leads.push(lead);
    if (leads.length >= limit) break;
  }
  if (!leads.length) warnings.push("no_records_mapped");

  return {
    source: "goszakup_gov_kz",
    fetched: leads.length,
    totalNoticeCount: Number.isFinite(Number(json && json.total)) ? Number(json.total) : null,
    timedOut: false,
    leads,
    warnings
  };
}

module.exports = {
  collectGoszakupGovKzLeads
};
