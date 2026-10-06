/*
 * Clinic CRM — in-browser demo backend.
 *
 * A JavaScript port of the FastAPI backend's business rules (receipts,
 * doctor commissions, payroll proration, pharmacy ledger, expenses, voiding,
 * roles), so the real frontend can run as a static site with fictional data.
 * Every name, amount and receipt here is invented.
 *
 * Works in the browser (window.CRMMock) and in Node (module.exports), so the
 * same code can be checked against the real API.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CRMMock = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const TZ_MS = 5 * HOUR; // Asia/Tashkent is UTC+5 all year (no DST)
  const ACCESS_TTL = 30 * MINUTE;
  const REFRESH_TTL = 7 * 24 * HOUR;

  // ---------------------------------------------------------------- dates
  const pad = (n) => String(n).padStart(2, "0");
  const tashDate = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
  const tashMidnight = (d) => Date.parse(d + "T00:00:00Z") - TZ_MS;
  const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  function addDays(d, n) {
    const x = new Date(d + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  }
  const weekday = (d) => new Date(d + "T00:00:00Z").getUTCDay(); // 0 = Sunday
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  function isValidDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }

  // Pydantic's datetime output for a UTC value: "Z", and microseconds only
  // when they are non-zero.
  function isoOut(ms) {
    if (ms == null) return null;
    const s = new Date(ms).toISOString();
    const frac = s.slice(20, 23);
    return frac === "000" ? s.slice(0, 19) + "Z" : `${s.slice(0, 19)}.${frac}000Z`;
  }

  // Datetime input. A value without an offset is read as clinic-local time,
  // which is what the deployed database does with a naive timestamp.
  function parseDateTime(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.abs(v) > 2e10 ? Math.trunc(v) : Math.trunc(v * 1000);
    }
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (isValidDate(s)) return tashMidnight(s);
    const m = s.match(
      /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/
    );
    if (!m || !isValidDate(m[1])) return null;
    const [, d, hh, mi, ss = "00", frac = "", tz] = m;
    if (+hh > 23 || +mi > 59 || +ss > 59) return null;
    let ms = Date.parse(`${d}T${hh}:${mi}:${ss}Z`) + Number((frac + "000").slice(0, 3));
    if (!tz) return ms - TZ_MS;
    if (tz === "Z" || tz === "z") return ms;
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0)) * MINUTE;
    return ms - sign * offset;
  }

  // ---------------------------------------------------------------- money
  // Exact decimal arithmetic in BigInt, rounding half away from zero like
  // Python's Decimal ROUND_HALF_UP (and PostgreSQL's numeric rounding).
  const SCALE = 6;
  const SCALE_F = 10n ** BigInt(SCALE);

  // Parses a decimal input into a BigInt scaled by 10^6, or null.
  function parseDecimal(v) {
    let s;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return null;
      s = String(v);
    } else if (typeof v === "string") {
      s = v.trim();
    } else return null;
    const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
    if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) return null;
    const [, sign, whole, frac = "", expRaw] = m;
    let digits = (whole || "0") + frac;
    let scale = frac.length - Number(expRaw || 0); // value = digits * 10^-scale
    let big = BigInt(digits);
    if (scale > SCALE) {
      const cut = 10n ** BigInt(scale - SCALE);
      big = divHalfUp(big, cut);
    } else if (scale < SCALE) {
      big = big * 10n ** BigInt(SCALE - scale);
    }
    return sign === "-" ? -big : big;
  }

  function divHalfUp(n, d) {
    const neg = n < 0n !== d < 0n;
    const a = n < 0n ? -n : n;
    const b = d < 0n ? -d : d;
    const q = (a * 2n + b) / (2n * b);
    return neg ? -q : q;
  }

  // Scaled(10^6) BigInt -> string with `places` decimals, rounded half-up.
  function quantize(big6, places) {
    const q = divHalfUp(big6, 10n ** BigInt(SCALE - places));
    if (places === 0) return q.toString();
    const neg = q < 0n;
    const s = (neg ? -q : q).toString().padStart(places + 1, "0");
    return (neg ? "-" : "") + s.slice(0, -places) + "." + s.slice(-places);
  }

  const units = (s) => BigInt(s); // whole-so'm string -> BigInt

  // str() of the Decimal that asyncpg returns for a whole number: trailing
  // all-zero base-10000 groups become an exponent ("200000" -> "2.0E+5").
  // Only the voided-records endpoint exposes this (its amount is a plain
  // Decimal, not the Money type).
  function pgDecimalText(s) {
    if (s == null) return null;
    const neg = s.startsWith("-");
    const digits = (neg ? s.slice(1) : s).replace(/^0+(?=\d)/, "");
    if (/^0+$/.test(digits)) return "0";
    const groups = [];
    for (let i = digits.length; i > 0; i -= 4) groups.unshift(digits.slice(Math.max(0, i - 4), i));
    let k = 0;
    while (groups.length > 1 && /^0+$/.test(groups[groups.length - 1])) { groups.pop(); k++; }
    if (k === 0) return s;
    const ds = String(Number(groups[0])) + groups.slice(1).map((g) => g.padStart(4, "0")).join("");
    const adjusted = 4 * k + ds.length - 1;
    return (neg ? "-" : "") + (ds.length === 1 ? ds : `${ds[0]}.${ds.slice(1)}`) + "E+" + adjusted;
  }
  const basisPoints = (pct) => BigInt(pct.replace(".", "")); // "50.00" -> 5000n
  const shareOf = (base, pct) => divHalfUp(base * basisPoints(pct), 10000n);

  // app/finance/calculations.py
  function consultationTotals(amount, minus, pct) {
    const a = units(amount);
    const m = minus == null ? 0n : units(minus);
    const share = shareOf(a - m, pct);
    return { income: a, doctor_share: share, expense: m, clinic_profit: a - share - m };
  }
  const surgeryTotals = consultationTotals;
  function roomTotals(amount, pct) {
    const a = units(amount);
    const share = shareOf(a, pct);
    return { income: a, doctor_share: share, expense: 0n, clinic_profit: a - share };
  }

  // app/salary/calculations.py
  function workingDays(from, to) {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (days <= 0) return 0;
    let sundays = Math.floor(days / 7);
    const rem = days % 7;
    const pyWeekday = (weekday(from) + 6) % 7; // Monday = 0 ... Sunday = 6
    if (rem && (((6 - pyWeekday) % 7) + 7) % 7 < rem) sundays += 1;
    return days - sundays;
  }

  function prorateFixedSalary(fixed, from, to) {
    let total = 0n;
    let current = from;
    while (current <= to) {
      const [y, m] = current.split("-").map(Number);
      const monthStart = `${y}-${pad(m)}-01`;
      const monthEnd = `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
      const segmentEnd = to < monthEnd ? to : monthEnd;
      const monthWd = workingDays(monthStart, monthEnd);
      const segWd = workingDays(current, segmentEnd);
      total += divHalfUp(fixed * BigInt(segWd), BigInt(monthWd));
      current = addDays(segmentEnd, 1);
    }
    return total;
  }

  // ---------------------------------------------------------------- errors
  class HttpError extends Error {
    constructor(status, detail, headers) {
      super(typeof detail === "string" ? detail : "error");
      this.status = status;
      this.detail = detail;
      this.headers = headers;
    }
  }
  class ValueErr extends Error {}
  class ServerError extends Error {}

  const NOT_AUTH = { "WWW-Authenticate": "Bearer" };

  // ---------------------------------------------------------- validation
  // Mirrors the shape of FastAPI/Pydantic 422 errors closely enough for the
  // UI, which mostly validates before sending.
  const MISSING = Symbol("missing");

  function enumText(values) {
    const q = values.map((v) => `'${v}'`);
    return q.length === 1 ? q[0] : q.slice(0, -1).join(", ") + " or " + q[q.length - 1];
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  // Validates one value against a spec. Returns {value} or {error}.
  function checkValue(spec, raw) {
    const t = spec.type;
    if (raw === null) {
      if (spec.nullable) return { value: null };
      const typeName = { int: "int_type", dec: "decimal_type", str: "string_type", enum: "enum", datetime: "datetime_type", date: "date_type", uuid: "uuid_type", bool: "bool_type" }[t];
      const msg = { int: "Input should be a valid integer", dec: "Decimal input should be an integer, float, string or Decimal object", str: "Input should be a valid string", enum: `Input should be ${enumText(spec.values || [])}`, datetime: "Input should be a valid datetime", date: "Input should be a valid date", uuid: "UUID input should be a string, bytes or UUID object", bool: "Input should be a valid boolean" }[t];
      return { error: { type: typeName, msg } };
    }
    let value = raw;
    if (t === "int") {
      if (typeof raw === "number") {
        if (!Number.isFinite(raw) || !Number.isInteger(raw))
          return { error: { type: "int_from_float", msg: "Input should be a valid integer, got a number with a fractional part" } };
      } else if (typeof raw === "string") {
        const s = raw.trim();
        if (!/^[+-]?\d+$/.test(s)) return { error: { type: "int_parsing", msg: "Input should be a valid integer, unable to parse string as an integer" } };
        value = Number(s);
      } else return { error: { type: "int_type", msg: "Input should be a valid integer" } };
    } else if (t === "dec") {
      if (typeof raw !== "number" && typeof raw !== "string")
        return { error: { type: "decimal_type", msg: "Decimal input should be an integer, float, string or Decimal object" } };
      value = parseDecimal(raw);
      if (value === null) return { error: { type: "decimal_parsing", msg: "Input should be a valid decimal" } };
    } else if (t === "str") {
      if (typeof raw !== "string") return { error: { type: "string_type", msg: "Input should be a valid string" } };
      const len = [...raw].length;
      if (spec.min != null && len < spec.min)
        return { error: { type: "string_too_short", msg: `String should have at least ${plural(spec.min, "character")}`, ctx: { min_length: spec.min } } };
      if (spec.max != null && len > spec.max)
        return { error: { type: "string_too_long", msg: `String should have at most ${plural(spec.max, "character")}`, ctx: { max_length: spec.max } } };
    } else if (t === "enum") {
      if (!spec.values.includes(raw))
        return { error: { type: "enum", msg: `Input should be ${enumText(spec.values)}`, ctx: { expected: enumText(spec.values) } } };
    } else if (t === "datetime") {
      value = parseDateTime(raw);
      if (value === null) return { error: { type: "datetime_parsing", msg: "Input should be a valid datetime" } };
    } else if (t === "date") {
      const s = typeof raw === "string" ? raw.trim() : raw;
      if (!isValidDate(s)) {
        return {
          error: typeof s === "string" && s.length < 10
            ? { type: "date_from_datetime_parsing", msg: "Input should be a valid date or datetime, input is too short", ctx: { error: "input is too short" } }
            : { type: "date_from_datetime_parsing", msg: "Input should be a valid date or datetime, invalid date", ctx: { error: "invalid date" } },
        };
      }
      value = s;
    } else if (t === "uuid") {
      if (typeof raw !== "string") return { error: { type: "uuid_type", msg: "UUID input should be a string, bytes or UUID object" } };
      if (!/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(raw.trim())) {
        const s = raw.trim();
        const bad = [...s].findIndex((ch) => !/[0-9a-fA-F-]/.test(ch));
        const why = bad >= 0
          ? `invalid character: found \`${[...s][bad]}\` at ${bad + 1}`
          : `invalid length: expected length 32 for simple format, found ${s.replace(/-/g, "").length}`;
        return { error: { type: "uuid_parsing", msg: `Input should be a valid UUID, ${why}`, ctx: { error: why } } };
      }
      const hex = raw.trim().replace(/-/g, "").toLowerCase();
      value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    // numeric constraints
    if (t === "int" || t === "dec") {
      const cmp = (bound) => (t === "int" ? value - bound : Number(value - parseDecimal(bound)));
      if (spec.gt != null && !(cmp(spec.gt) > 0))
        return { error: { type: "greater_than", msg: `Input should be greater than ${spec.gt}`, ctx: { gt: spec.gt } } };
      if (spec.ge != null && !(cmp(spec.ge) >= 0))
        return { error: { type: "greater_than_equal", msg: `Input should be greater than or equal to ${spec.ge}`, ctx: { ge: spec.ge } } };
      if (spec.le != null && !(cmp(spec.le) <= 0))
        return { error: { type: "less_than_equal", msg: `Input should be less than or equal to ${spec.le}`, ctx: { le: spec.le } } };
    }
    return { value };
  }

  // Validates a JSON body against {field: spec}. Returns {data, present}.
  function validateBody(schema, body, modelChecks) {
    if (body === MISSING || body === undefined) {
      throw new HttpError(422, [{ type: "missing", loc: ["body"], msg: "Field required", input: null }]);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(422, [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: body }]);
    }
    const errors = [];
    const data = {};
    const present = new Set();
    for (const [name, spec] of Object.entries(schema)) {
      if (!(name in body)) {
        if (spec.required) errors.push({ type: "missing", loc: ["body", name], msg: "Field required", input: body });
        else data[name] = spec.default === undefined ? null : spec.default;
        continue;
      }
      present.add(name);
      const raw = body[name];
      if (raw === null && spec.noNull) {
        errors.push({ type: "value_error", loc: ["body", name], msg: `Value error, ${name} cannot be null — omit the field to leave it unchanged`, input: null, ctx: { error: {} } });
        continue;
      }
      const res = checkValue(spec, raw);
      if (res.error) {
        const e = { type: res.error.type, loc: ["body", name], msg: res.error.msg, input: raw };
        if (res.error.ctx) e.ctx = res.error.ctx;
        errors.push(e);
      } else data[name] = res.value;
    }
    if (errors.length) throw new HttpError(422, errors);
    if (modelChecks) {
      const msg = modelChecks(data, present);
      if (msg) throw new HttpError(422, [{ type: "value_error", loc: ["body"], msg: `Value error, ${msg}`, input: body, ctx: { error: {} } }]);
    }
    return { data, present };
  }

  function validateQuery(schema, query) {
    const errors = [];
    const out = {};
    for (const [name, spec] of Object.entries(schema)) {
      const key = spec.alias || name;
      if (!query.has(key)) {
        out[name] = spec.default === undefined ? null : spec.default;
        continue;
      }
      const raw = query.get(key);
      let res;
      if (spec.type === "dec" || spec.type === "str" || spec.type === "enum" || spec.type === "date" || spec.type === "uuid") res = checkValue(spec, raw);
      else res = checkValue(spec, raw);
      if (res.error) {
        const e = { type: res.error.type, loc: ["query", key], msg: res.error.msg, input: raw };
        if (res.error.ctx) e.ctx = res.error.ctx;
        errors.push(e);
      } else out[name] = res.value;
    }
    if (errors.length) throw new HttpError(422, errors);
    return out;
  }

  const PAGE = { page: { type: "int", ge: 1, default: 1 }, page_size: { type: "int", ge: 1, le: 100, default: 20 } };
  const DATE_RANGE = { date_from: { type: "date" }, date_to: { type: "date" } };

  // ------------------------------------------------------------- helpers
  function businessRange(from, to) {
    if (from && to && from > to) throw new ValueErr("date_from cannot be after date_to");
    return { start: from ? tashMidnight(from) : null, end: to ? tashMidnight(addDays(to, 1)) : null };
  }
  const inRange = (ms, r) => (r.start == null || ms >= r.start) && (r.end == null || ms < r.end);
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byDateDescIdDesc = (key) => (a, b) => (b[key] < a[key] ? -1 : b[key] > a[key] ? 1 : b.id - a.id);

  function ilike(value, search) {
    const pattern = `%${search}%`;
    let re = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (ch === "%") re += "[\\s\\S]*";
      else if (ch === "_") re += "[\\s\\S]";
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(re + "$", "i").test(value || "");
  }

  function paginate(items, q, ser) {
    const total = items.length;
    const start = (q.page - 1) * q.page_size;
    return {
      items: items.slice(start, start + q.page_size).map(ser),
      page: q.page,
      page_size: q.page_size,
      total,
      pages: Math.floor((total + q.page_size - 1) / q.page_size),
    };
  }

  const MAX_NUMERIC_12 = 999999999999n;
  function storeMoney(big6) {
    const s = quantize(big6, 0);
    const v = BigInt(s);
    if (v > MAX_NUMERIC_12 || v < -MAX_NUMERIC_12) throw new ServerError("numeric field overflow");
    return s;
  }
  function storePercent(big6) {
    const s = quantize(big6, 2);
    if (Number(s) >= 1000) throw new ServerError("numeric field overflow");
    return s;
  }
  function storeInt32(n) {
    if (n > 2147483647 || n < -2147483648) throw new ServerError("integer out of range");
    return n;
  }

  // ---------------------------------------------------------- serializers
  const voidFields = (r) => ({
    created_by_id: r.created_by_id,
    is_voided: r.is_voided,
    voided_at: isoOut(r.voided_at),
    voided_by_id: r.voided_by_id,
    created_at: isoOut(r.created_at),
    updated_at: isoOut(r.updated_at),
  });
  const SER = {
    consultation: (r) => ({ id: r.id, type: r.type, receipt_number: r.receipt_number, date: isoOut(r.date), amount: r.amount, doctor_percent: r.doctor_percent, minus_beshming: r.minus_beshming, doctor_id: r.doctor_id, ...voidFields(r) }),
    surgery: (r) => ({ id: r.id, receipt_number: r.receipt_number, date: isoOut(r.date), amount: r.amount, surgery_expense: r.surgery_expense, doctor_percent: r.doctor_percent, doctor_id: r.doctor_id, ...voidFields(r) }),
    room: (r) => ({ id: r.id, receipt_number: r.receipt_number, date: isoOut(r.date), amount: r.amount, doctor_percent: r.doctor_percent, doctor_id: r.doctor_id, ...voidFields(r) }),
    duty_entry: (r) => ({ id: r.id, staff_id: r.staff_id, date: r.date, amount: r.amount, ...voidFields(r) }),
    salary_payment: (r) => ({ id: r.id, staff_id: r.staff_id, paid_at: isoOut(r.paid_at), period_start: r.period_start, period_end: r.period_end, payment_type: r.payment_type, amount: r.amount, ...voidFields(r) }),
    pharmacy_entry: (r) => ({ id: r.id, date: isoOut(r.date), medicine_cost: r.medicine_cost, amount_paid: r.amount_paid, comment: r.comment, ...voidFields(r) }),
    expense: (r) => ({ id: r.id, title: r.title, amount: r.amount, date: isoOut(r.date), ...voidFields(r) }),
    staff: (s) => ({ id: s.id, first_name: s.first_name, last_name: s.last_name, specialty: s.specialty, role: s.role, fixed_salary: s.fixed_salary, status: s.status, hire_date: s.hire_date, created_at: isoOut(s.created_at), updated_at: isoOut(s.updated_at) }),
    user: (u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, status: u.status }),
  };

  // Resource registry: table name, serializer, 404 text, void-conflict text.
  const RES = {
    consultation: { table: "consultations", notFound: "Consultation not found", already: "Consultation is already voided" },
    surgery: { table: "surgeries", notFound: "Surgery not found", already: "Surgery is already voided" },
    room: { table: "rooms", notFound: "Room record not found", already: "Room record is already voided" },
    duty_entry: { table: "duty_entries", notFound: "Duty entry not found", already: "Duty entry is already voided" },
    expense: { table: "expenses", notFound: "Expense not found", already: "Expense is already voided" },
    pharmacy_entry: { table: "pharmacy_entries", notFound: "Pharmacy entry not found", already: "Pharmacy entry is already voided" },
    salary_payment: { table: "salary_payments", notFound: "Salary payment not found", already: "Salary payment is already voided" },
  };

  // ------------------------------------------------------- business logic
  // Shared with the verification script, so it takes the state explicitly.
  function doctorShareSums(state, ids, from, to) {
    const totals = new Map(ids.map((id) => [id, 0n]));
    if (!ids.length) return totals;
    const r = businessRange(from, to);
    const want = new Set(ids);
    for (const c of state.consultations)
      if (!c.is_voided && want.has(c.doctor_id) && inRange(c.date, r))
        totals.set(c.doctor_id, totals.get(c.doctor_id) + consultationTotals(c.amount, c.minus_beshming, c.doctor_percent).doctor_share);
    for (const s of state.surgeries)
      if (!s.is_voided && want.has(s.doctor_id) && inRange(s.date, r))
        totals.set(s.doctor_id, totals.get(s.doctor_id) + surgeryTotals(s.amount, s.surgery_expense, s.doctor_percent).doctor_share);
    for (const m of state.rooms)
      if (!m.is_voided && want.has(m.doctor_id) && inRange(m.date, r))
        totals.set(m.doctor_id, totals.get(m.doctor_id) + roomTotals(m.amount, m.doctor_percent).doctor_share);
    return totals;
  }

  function staffBalance(state, from, to, staffId, nowMs) {
    const allTime = from == null && to == null;
    if (!allTime) {
      if (from == null || to == null) throw new ValueErr("date_from and date_to must be given together");
      if (from > to) throw new ValueErr("date_from cannot be after date_to");
    }
    const list = state.staff
      .filter((s) => s.status === "active" && (staffId == null || s.id === staffId))
      .sort((a, b) => cmpStr(a.last_name, b.last_name) || cmpStr(a.first_name, b.first_name) || a.id - b.id);
    const ids = list.map((s) => s.id);
    const shares = doctorShareSums(state, list.filter((s) => s.role === "doctor").map((s) => s.id), from, to);
    const duty = new Map(ids.map((id) => [id, 0n]));
    for (const d of state.duty_entries)
      if (!d.is_voided && duty.has(d.staff_id) && (from == null || d.date >= from) && (to == null || d.date <= to))
        duty.set(d.staff_id, duty.get(d.staff_id) + units(d.amount));
    const paid = new Map(ids.map((id) => [id, 0n]));
    for (const p of state.salary_payments)
      if (!p.is_voided && paid.has(p.staff_id) && (allTime || (p.period_start <= to && p.period_end >= from)))
        paid.set(p.staff_id, paid.get(p.staff_id) + units(p.amount));
    const today = tashDate(nowMs);
    return list.map((s) => {
      let base;
      if (s.role === "doctor") base = shares.get(s.id);
      else {
        const fixed = s.fixed_salary == null ? 0n : units(s.fixed_salary);
        if (allTime) {
          const startDay = s.hire_date || utcDate(s.created_at);
          base = startDay > today ? 0n : prorateFixedSalary(fixed, startDay, today);
        } else {
          const eff = s.hire_date && s.hire_date > from ? s.hire_date : from;
          base = eff > to ? 0n : prorateFixedSalary(fixed, eff, to);
        }
      }
      const earned = base + duty.get(s.id);
      const p = paid.get(s.id);
      return { staff_id: s.id, name: `${s.last_name} ${s.first_name}`, role: s.role, earned: earned.toString(), paid: p.toString(), remaining: (earned - p).toString() };
    });
  }

  function doctorShareList(state, groups) {
    const out = [];
    for (const [id, g] of groups) {
      const doc = state.staff.find((s) => s.id === id);
      if (!doc) continue;
      out.push({ doctor_id: doc.id, name: `${doc.last_name} ${doc.first_name}`, total_share: g.total.toString(), count: g.count });
    }
    return out;
  }

  function ownFilter(user) {
    return (r) => user.role !== "assistant" || r.created_by_id === user.id;
  }

  function consultationReport(state, from, to, user) {
    const r = businessRange(from, to);
    let korik = 0n, kc = 0, qayta = 0n, qc = 0, share = 0n, profit = 0n, expense = 0n;
    const groups = new Map();
    for (const c of state.consultations) {
      if (c.is_voided || !ownFilter(user)(c) || !inRange(c.date, r)) continue;
      const t = consultationTotals(c.amount, c.minus_beshming, c.doctor_percent);
      if (c.type === "korik") { korik += units(c.amount); kc++; } else { qayta += units(c.amount); qc++; }
      share += t.doctor_share; profit += t.clinic_profit; expense += t.expense;
      if (c.doctor_id != null) {
        const g = groups.get(c.doctor_id) || { total: 0n, count: 0 };
        g.total += t.doctor_share; g.count++;
        groups.set(c.doctor_id, g);
      }
    }
    return {
      korik: { total: korik.toString(), count: kc },
      qayta_korik: { total: qayta.toString(), count: qc },
      total_income: (korik + qayta).toString(),
      total_doctor_share: share.toString(),
      total_clinic_profit: profit.toString(),
      total_consultation_expense: expense.toString(),
      doctor_shares: doctorShareList(state, groups),
    };
  }

  function surgeryReport(state, from, to, user) {
    const r = businessRange(from, to);
    let income = 0n, share = 0n, expense = 0n, profit = 0n;
    const groups = new Map();
    for (const s of state.surgeries) {
      if (s.is_voided || !ownFilter(user)(s) || !inRange(s.date, r)) continue;
      const t = surgeryTotals(s.amount, s.surgery_expense, s.doctor_percent);
      income += t.income; share += t.doctor_share; expense += t.expense; profit += t.clinic_profit;
      if (s.doctor_id != null) {
        const g = groups.get(s.doctor_id) || { total: 0n, count: 0 };
        g.total += t.doctor_share; g.count++;
        groups.set(s.doctor_id, g);
      }
    }
    return {
      surgery_total_income: income.toString(),
      surgery_total_doctor_share: share.toString(),
      surgery_total_clinic_profit: profit.toString(),
      surgery_total_expense: expense.toString(),
      surgery_doctor_shares: doctorShareList(state, groups),
    };
  }

  function roomReport(state, from, to, user) {
    const r = businessRange(from, to);
    let income = 0n, share = 0n, profit = 0n;
    const groups = new Map();
    for (const m of state.rooms) {
      if (m.is_voided || !ownFilter(user)(m) || !inRange(m.date, r)) continue;
      const t = roomTotals(m.amount, m.doctor_percent);
      income += t.income; share += t.doctor_share; profit += t.clinic_profit;
      if (m.doctor_id != null) {
        const g = groups.get(m.doctor_id) || { total: 0n, count: 0 };
        g.total += t.doctor_share; g.count++;
        groups.set(m.doctor_id, g);
      }
    }
    return {
      room_total_income: income.toString(),
      room_total_doctor_share: share.toString(),
      room_total_clinic_profit: profit.toString(),
      room_doctor_shares: doctorShareList(state, groups),
    };
  }

  function totalReport(state, from, to, user) {
    const c = consultationReport(state, from, to, user);
    const s = surgeryReport(state, from, to, user);
    const m = roomReport(state, from, to, user);
    const sum = (...xs) => xs.reduce((a, x) => a + BigInt(x), 0n).toString();
    return {
      consultation_income: c.total_income,
      consultation_doctor_share: c.total_doctor_share,
      consultation_expense: c.total_consultation_expense,
      consultation_clinic_profit: c.total_clinic_profit,
      surgery_income: s.surgery_total_income,
      surgery_doctor_share: s.surgery_total_doctor_share,
      surgery_expense: s.surgery_total_expense,
      surgery_clinic_profit: s.surgery_total_clinic_profit,
      room_income: m.room_total_income,
      room_doctor_share: m.room_total_doctor_share,
      room_clinic_profit: m.room_total_clinic_profit,
      total_income: sum(c.total_income, s.surgery_total_income, m.room_total_income),
      total_doctor_share: sum(c.total_doctor_share, s.surgery_total_doctor_share, m.room_total_doctor_share),
      total_expense: sum(c.total_consultation_expense, s.surgery_total_expense),
      total_clinic_profit: sum(c.total_clinic_profit, s.surgery_total_clinic_profit, m.room_total_clinic_profit),
    };
  }

  // ------------------------------------------------------------- xlsx
  // A minimal .xlsx (zip, stored) with the same Field/Value layout as the
  // server's openpyxl export.
  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipStore(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function reportWorkbook(sheetTitle, report) {
    const rows = [["Field", "Value"]];
    (function flatten(prefix, value) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, v);
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => flatten(`${prefix}[${i}]`, item));
      } else rows.push([prefix, String(value)]);
    })("", report);
    const colName = (i) => String.fromCharCode(65 + i);
    const sheetRows = rows
      .map((row, r) => `<row r="${r + 1}">` + row.map((v, c) => `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`).join("") + "</row>")
      .join("");
    const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    return zipStore([
      { name: "[Content_Types].xml", data: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
      { name: "_rels/.rels", data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: XML + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetTitle.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: "xl/worksheets/sheet1.xml", data: XML + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` },
    ]);
  }

  // ------------------------------------------------------------- server
  function createServer(state, opts = {}) {
    const now = opts.now || (() => Date.now());
    const onChange = opts.onChange || (() => {});
    const newUuid = opts.uuid || (() => {
      const b = new Uint8Array(16);
      (globalThis.crypto || require("crypto").webcrypto).getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    });
    const newJti = () => newUuid().replace(/-/g, "");

    let changed = false;
    const touch = (data = true) => { changed = true; if (data) state.dirty = true; };
    const nextId = (table) => (state.seq[table] = (state.seq[table] || 0) + 1);

    // ---- auth
    function issuePair(user) {
      const t = now();
      for (const [jti, tok] of Object.entries(state.tokens)) if (tok.exp < t) delete state.tokens[jti];
      const a = newJti();
      const r = newJti();
      state.tokens[a] = { type: "access", uid: user.id, ver: user.token_version, exp: t + ACCESS_TTL };
      state.tokens[r] = { type: "refresh", uid: user.id, ver: user.token_version, exp: t + REFRESH_TTL };
      touch(false);
      return { access_token: `demo.access.${a}`, refresh_token: `demo.refresh.${r}`, token_type: "bearer" };
    }
    function decode(token, type) {
      const m = typeof token === "string" && token.match(/^demo\.(access|refresh)\.([0-9a-f]{32})$/);
      if (!m || m[1] !== type) return null;
      const tok = state.tokens[m[2]];
      if (!tok || tok.type !== type || tok.exp < now()) return null;
      return { jti: m[2], ...tok };
    }
    function currentUser(headers) {
      const h = headers.authorization || headers.Authorization || "";
      const [scheme, ...rest] = h.split(" ");
      const token = rest.join(" ").trim();
      if (!h || scheme.toLowerCase() !== "bearer" || !token) throw new HttpError(401, "Not authenticated", NOT_AUTH);
      const p = decode(token, "access");
      const bad = new HttpError(401, "Could not validate credentials", NOT_AUTH);
      if (!p) throw bad;
      const user = state.users.find((u) => u.id === p.uid);
      if (!user || p.ver !== user.token_version || user.status !== "approved") throw bad;
      return { user, token: p };
    }

    const SA = ["superadmin"];
    const MANAGE = ["superadmin", "manager"];
    const ALL = ["superadmin", "manager", "assistant"];

    // ---- shared record operations
    function getRecord(kind, id) {
      const rec = state[RES[kind].table].find((r) => r.id === id);
      if (!rec) throw new HttpError(404, RES[kind].notFound);
      return rec;
    }
    function forbidEditIfVoided(rec) {
      if (rec.is_voided) throw new HttpError(409, "A voided record cannot be edited. Restore it first.");
    }
    function hideIfVoided(rec, detail) {
      if (rec.is_voided) throw new HttpError(404, detail);
      return rec;
    }
    function voidRecord(kind, rec, user) {
      if (rec.is_voided) throw new HttpError(409, RES[kind].already);
      rec.is_voided = true;
      rec.voided_at = now();
      rec.voided_by_id = user.id;
      rec.updated_at = now();
      touch();
      return SER[kind](rec);
    }
    function restoreRecord(kind, rec) {
      if (!rec.is_voided) throw new HttpError(409, "Only a voided record can be restored");
      rec.is_voided = false;
      rec.voided_at = null;
      rec.voided_by_id = null;
      rec.updated_at = now();
      touch();
      return SER[kind](rec);
    }
    function hardDelete(kind, rec) {
      if (!rec.is_voided) throw new HttpError(409, "Only a voided record can be deleted. Void it first.");
      const table = state[RES[kind].table];
      table.splice(table.indexOf(rec), 1);
      touch();
      return null;
    }
    function newRecord(table, fields, user) {
      const t = now();
      const rec = { id: nextId(table), ...fields, created_by_id: user.id, is_voided: false, voided_at: null, voided_by_id: null, created_at: t, updated_at: t };
      state[table].push(rec);
      touch();
      return rec;
    }
    function requireDoctor(id) {
      if (id == null) return;
      const s = state.staff.find((x) => x.id === id);
      if (!s || s.role !== "doctor") throw new HttpError(404, "Doctor not found");
    }
    function getStaff(id) {
      const s = state.staff.find((x) => x.id === id);
      if (!s) throw new HttpError(404, "Staff member not found");
      return s;
    }
    function expenseNotGreater(amount6, expense6) {
      if (expense6 > amount6) throw new HttpError(422, "Expense cannot exceed amount");
    }
    const minusDefault = () => state.settings.default_minus_beshming;
    const settingsOut = () => ({ default_minus_beshming: state.settings.default_minus_beshming, updated_at: isoOut(state.settings.updated_at), updated_by_id: state.settings.updated_by_id });

    function listFinance(table, kind, user, q, extra) {
      const r = businessRange(q.date_from, q.date_to);
      const items = state[table]
        .filter((x) => !x.is_voided && ownFilter(user)(x) && (q.doctor_id == null || x.doctor_id === q.doctor_id) && (q.created_by_id == null || x.created_by_id === q.created_by_id) && (!extra || extra(x)) && inRange(x.date, r))
        .sort(byDateDescIdDesc("date"));
      return paginate(items, q, SER[kind]);
    }
    const valueErrTo422 = (fn) => {
      try { return fn(); } catch (e) { if (e instanceof ValueErr) throw new HttpError(422, e.message); throw e; }
    };

    // ---- schemas
    const DEC = (o = {}) => ({ type: "dec", ...o });
    const S = {
      consultationCreate: {
        type: { type: "enum", values: ["korik", "qaytakorik"], required: true },
        receipt_number: { type: "int", gt: 0, required: true },
        date: { type: "datetime", nullable: true },
        amount: DEC({ ge: 0, required: true }),
        doctor_percent: DEC({ ge: 0, le: 100, required: true }),
        minus_beshming: DEC({ ge: 0, nullable: true }),
        doctor_id: { type: "int", nullable: true },
      },
      consultationUpdate: {
        type: { type: "enum", values: ["korik", "qaytakorik"], nullable: true, noNull: true },
        receipt_number: { type: "int", gt: 0, nullable: true, noNull: true },
        date: { type: "datetime", nullable: true, noNull: true },
        amount: DEC({ ge: 0, nullable: true, noNull: true }),
        doctor_percent: DEC({ ge: 0, le: 100, nullable: true, noNull: true }),
        minus_beshming: DEC({ ge: 0, nullable: true }),
        doctor_id: { type: "int", nullable: true },
      },
      surgeryCreate: {
        receipt_number: { type: "int", gt: 0, required: true },
        date: { type: "datetime", nullable: true },
        amount: DEC({ ge: 0, required: true }),
        surgery_expense: DEC({ ge: 0, required: true }),
        doctor_percent: DEC({ ge: 0, le: 100, required: true }),
        doctor_id: { type: "int", nullable: true },
      },
      surgeryUpdate: {
        receipt_number: { type: "int", gt: 0, nullable: true, noNull: true },
        date: { type: "datetime", nullable: true, noNull: true },
        amount: DEC({ ge: 0, nullable: true, noNull: true }),
        surgery_expense: DEC({ ge: 0, nullable: true, noNull: true }),
        doctor_percent: DEC({ ge: 0, le: 100, nullable: true, noNull: true }),
        doctor_id: { type: "int", nullable: true },
      },
      roomCreate: {
        receipt_number: { type: "int", gt: 0, nullable: true },
        date: { type: "datetime", nullable: true },
        amount: DEC({ ge: 0, required: true }),
        doctor_percent: DEC({ ge: 0, le: 100, required: true }),
        doctor_id: { type: "int", nullable: true },
      },
      roomUpdate: {
        receipt_number: { type: "int", gt: 0, nullable: true },
        date: { type: "datetime", nullable: true, noNull: true },
        amount: DEC({ ge: 0, nullable: true, noNull: true }),
        doctor_percent: DEC({ ge: 0, le: 100, nullable: true, noNull: true }),
        doctor_id: { type: "int", nullable: true },
      },
      dutyCreate: { staff_id: { type: "int", required: true }, date: { type: "date", nullable: true }, amount: DEC({ ge: 0, required: true }) },
      dutyUpdate: { staff_id: { type: "int", nullable: true }, date: { type: "date", nullable: true, noNull: true }, amount: DEC({ ge: 0, nullable: true, noNull: true }) },
      salaryCreate: {
        staff_id: { type: "int", required: true },
        paid_at: { type: "datetime", nullable: true },
        period_start: { type: "date", required: true },
        period_end: { type: "date", required: true },
        payment_type: { type: "enum", values: ["full", "avans"], required: true },
        amount: DEC({ ge: 0, required: true }),
      },
      salaryUpdate: {
        staff_id: { type: "int", nullable: true },
        paid_at: { type: "datetime", nullable: true, noNull: true },
        period_start: { type: "date", nullable: true, noNull: true },
        period_end: { type: "date", nullable: true, noNull: true },
        payment_type: { type: "enum", values: ["full", "avans"], nullable: true, noNull: true },
        amount: DEC({ ge: 0, nullable: true, noNull: true }),
      },
      pharmacyCreate: {
        date: { type: "datetime", nullable: true },
        medicine_cost: DEC({ ge: 0, nullable: true }),
        amount_paid: DEC({ ge: 0, nullable: true }),
        comment: { type: "str", max: 500, nullable: true },
      },
      pharmacyUpdate: {
        date: { type: "datetime", nullable: true, noNull: true },
        medicine_cost: DEC({ ge: 0, nullable: true }),
        amount_paid: DEC({ ge: 0, nullable: true }),
        comment: { type: "str", max: 500, nullable: true },
      },
      expenseCreate: { title: { type: "str", min: 1, max: 255, required: true }, amount: DEC({ ge: 0, required: true }), date: { type: "datetime", nullable: true } },
      expenseUpdate: {
        title: { type: "str", min: 1, max: 255, nullable: true, noNull: true },
        amount: DEC({ ge: 0, nullable: true, noNull: true }),
        date: { type: "datetime", nullable: true, noNull: true },
      },
      staffCreate: {
        first_name: { type: "str", min: 1, max: 50, required: true },
        last_name: { type: "str", min: 1, max: 50, required: true },
        role: { type: "enum", values: ["doctor", "nurse", "other"], required: true },
        specialty: { type: "str", max: 50, nullable: true },
        fixed_salary: DEC({ ge: 0, nullable: true }),
        hire_date: { type: "date", required: true },
      },
      staffUpdate: {
        first_name: { type: "str", min: 1, max: 50, nullable: true, noNull: true },
        last_name: { type: "str", min: 1, max: 50, nullable: true, noNull: true },
        role: { type: "enum", values: ["doctor", "nurse", "other"], nullable: true, noNull: true },
        specialty: { type: "str", max: 50, nullable: true },
        fixed_salary: DEC({ ge: 0, nullable: true }),
        hire_date: { type: "date", nullable: true, noNull: true },
      },
      userCreate: {
        username: { type: "str", min: 3, max: 64, required: true },
        full_name: { type: "str", min: 3, max: 64, required: true },
        password: { type: "str", min: 8, required: true },
      },
      superadminUpdate: {
        superadmin_username: { type: "str", min: 3, max: 64, nullable: true },
        superadmin_password: { type: "str", min: 8, nullable: true },
      },
      settingsUpdate: { default_minus_beshming: DEC({ ge: 0, required: true }) },
      refresh: { refresh_token: { type: "str", required: true } },
    };

    // Marks a handler's body schema, so a bad path parameter and a bad body
    // are reported together, as FastAPI does.
    const withBody = (schema, fn) => Object.assign(fn, { bodySchema: schema });

    // ---- finance (consultations, surgeries, rooms)
    function financeRoutes(prefix, kind, table, createSchema, updateSchema, build, applyUpdate) {
      const idName = { consultation: "consultation_id", surgery: "surgery_id", room: "room_id" }[kind];
      return [
        ["POST", prefix, ALL, (c) => {
          const { data } = validateBody(createSchema, c.body);
          return [201, SER[kind](build(data, c.user))];
        }],
        ["GET", prefix, ALL, (c) => {
          const q = validateQuery({ doctor_id: { type: "int" }, ...(kind === "consultation" ? { type: { type: "enum", values: ["korik", "qaytakorik"] } } : {}), created_by_id: { type: "uuid" }, ...DATE_RANGE, ...PAGE }, c.query);
          return valueErrTo422(() => listFinance(table, kind, c.user, q, kind === "consultation" && q.type ? (x) => x.type === q.type : null));
        }],
        ["GET", `${prefix}/{${idName}:int}`, ALL, (c) => {
          const rec = getRecord(kind, c.params[idName]);
          if (c.user.role === "assistant" && rec.created_by_id !== c.user.id) throw new HttpError(403, "You do not have permission to view this record");
          return SER[kind](hideIfVoided(rec, RES[kind].notFound));
        }],
        ["PATCH", `${prefix}/{${idName}:int}`, MANAGE, withBody(updateSchema, (c) => {
          const { data, present } = validateBody(updateSchema, c.body);
          const rec = getRecord(kind, c.params[idName]);
          forbidEditIfVoided(rec);
          if (present.has("doctor_id")) requireDoctor(data.doctor_id);
          applyUpdate(rec, data, present);
          rec.updated_at = now();
          touch();
          return SER[kind](rec);
        })],
        ["POST", `${prefix}/{${idName}:int}/void`, MANAGE, (c) => voidRecord(kind, getRecord(kind, c.params[idName]), c.user)],
        ["POST", `${prefix}/{${idName}:int}/restore`, SA, (c) => restoreRecord(kind, getRecord(kind, c.params[idName]))],
        ["DELETE", `${prefix}/{${idName}:int}`, SA, (c) => [204, hardDelete(kind, getRecord(kind, c.params[idName]))]],
      ];
    }

    const dateOrNow = (v) => (v == null ? now() : v);

    const consultationRoutes = financeRoutes("/consultations", "consultation", "consultations", S.consultationCreate, S.consultationUpdate,
      (d, user) => {
        requireDoctor(d.doctor_id);
        const minus6 = d.minus_beshming == null ? parseDecimal(minusDefault()) : d.minus_beshming;
        expenseNotGreater(d.amount, minus6);
        return newRecord("consultations", {
          type: d.type, receipt_number: storeInt32(d.receipt_number), date: dateOrNow(d.date), amount: storeMoney(d.amount),
          doctor_percent: storePercent(d.doctor_percent), minus_beshming: storeMoney(minus6), doctor_id: d.doctor_id,
        }, user);
      },
      (rec, d, present) => {
        const amount6 = present.has("amount") ? d.amount : parseDecimal(rec.amount);
        const minus6 = present.has("minus_beshming") ? d.minus_beshming : rec.minus_beshming == null ? null : parseDecimal(rec.minus_beshming);
        expenseNotGreater(amount6, minus6 == null ? 0n : minus6);
        if (present.has("type")) rec.type = d.type;
        if (present.has("receipt_number")) rec.receipt_number = storeInt32(d.receipt_number);
        if (present.has("date")) rec.date = d.date;
        if (present.has("amount")) rec.amount = storeMoney(d.amount);
        if (present.has("doctor_percent")) rec.doctor_percent = storePercent(d.doctor_percent);
        if (present.has("minus_beshming")) rec.minus_beshming = d.minus_beshming == null ? null : storeMoney(d.minus_beshming);
        if (present.has("doctor_id")) rec.doctor_id = d.doctor_id;
      });

    const surgeryRoutes = financeRoutes("/surgeries", "surgery", "surgeries", S.surgeryCreate, S.surgeryUpdate,
      (d, user) => {
        requireDoctor(d.doctor_id);
        expenseNotGreater(d.amount, d.surgery_expense);
        return newRecord("surgeries", {
          receipt_number: storeInt32(d.receipt_number), date: dateOrNow(d.date), amount: storeMoney(d.amount),
          surgery_expense: storeMoney(d.surgery_expense), doctor_percent: storePercent(d.doctor_percent), doctor_id: d.doctor_id,
        }, user);
      },
      (rec, d, present) => {
        const amount6 = present.has("amount") ? d.amount : parseDecimal(rec.amount);
        const exp6 = present.has("surgery_expense") ? d.surgery_expense : parseDecimal(rec.surgery_expense);
        expenseNotGreater(amount6, exp6);
        if (present.has("receipt_number")) rec.receipt_number = storeInt32(d.receipt_number);
        if (present.has("date")) rec.date = d.date;
        if (present.has("amount")) rec.amount = storeMoney(d.amount);
        if (present.has("surgery_expense")) rec.surgery_expense = storeMoney(d.surgery_expense);
        if (present.has("doctor_percent")) rec.doctor_percent = storePercent(d.doctor_percent);
        if (present.has("doctor_id")) rec.doctor_id = d.doctor_id;
      });

    const roomRoutes = financeRoutes("/rooms", "room", "rooms", S.roomCreate, S.roomUpdate,
      (d, user) => {
        requireDoctor(d.doctor_id);
        return newRecord("rooms", {
          receipt_number: d.receipt_number == null ? null : storeInt32(d.receipt_number), date: dateOrNow(d.date),
          amount: storeMoney(d.amount), doctor_percent: storePercent(d.doctor_percent), doctor_id: d.doctor_id,
        }, user);
      },
      (rec, d, present) => {
        if (present.has("receipt_number")) rec.receipt_number = d.receipt_number == null ? null : storeInt32(d.receipt_number);
        if (present.has("date")) rec.date = d.date;
        if (present.has("amount")) rec.amount = storeMoney(d.amount);
        if (present.has("doctor_percent")) rec.doctor_percent = storePercent(d.doctor_percent);
        if (present.has("doctor_id")) rec.doctor_id = d.doctor_id;
      });

    // ---- simple voidable resources (duty, pharmacy, expenses, salary)
    function voidableTail(prefix, kind, idName, manageRoles, notFoundText) {
      return [
        ["GET", `${prefix}/{${idName}:int}`, manageRoles, (c) => SER[kind](hideIfVoided(getRecord(kind, c.params[idName]), notFoundText))],
        ["PATCH", `${prefix}/{${idName}:int}`, manageRoles, withBody(S[UPDATE_SCHEMA[kind]], (c) => {
          const { data, present } = validateBody(S[UPDATE_SCHEMA[kind]], c.body);
          const rec = getRecord(kind, c.params[idName]);
          UPDATERS[kind](rec, data, present);
          rec.updated_at = now();
          touch();
          return SER[kind](rec);
        })],
        ["POST", `${prefix}/{${idName}:int}/void`, manageRoles, (c) => voidRecord(kind, getRecord(kind, c.params[idName]), c.user)],
        ["POST", `${prefix}/{${idName}:int}/restore`, SA, (c) => restoreRecord(kind, getRecord(kind, c.params[idName]))],
        ["DELETE", `${prefix}/{${idName}:int}`, SA, (c) => [204, hardDelete(kind, getRecord(kind, c.params[idName]))]],
      ];
    }

    const UPDATE_SCHEMA = { duty_entry: "dutyUpdate", pharmacy_entry: "pharmacyUpdate", expense: "expenseUpdate", salary_payment: "salaryUpdate" };
    const UPDATERS = {
      duty_entry(rec, d, present) {
        forbidEditIfVoided(rec);
        if (present.has("staff_id") && d.staff_id != null) getStaff(d.staff_id);
        if (present.has("staff_id")) rec.staff_id = d.staff_id;
        if (present.has("date")) rec.date = d.date;
        if (present.has("amount")) rec.amount = storeMoney(d.amount);
      },
      pharmacy_entry(rec, d, present) {
        forbidEditIfVoided(rec);
        const cost = present.has("medicine_cost") ? d.medicine_cost : rec.medicine_cost;
        const paid = present.has("amount_paid") ? d.amount_paid : rec.amount_paid;
        if (cost == null && paid == null) throw new HttpError(422, "At least one of medicine_cost or amount_paid is required");
        if (present.has("date")) rec.date = d.date;
        if (present.has("medicine_cost")) rec.medicine_cost = d.medicine_cost == null ? null : storeMoney(d.medicine_cost);
        if (present.has("amount_paid")) rec.amount_paid = d.amount_paid == null ? null : storeMoney(d.amount_paid);
        if (present.has("comment")) rec.comment = typeof d.comment === "string" ? d.comment.trim() || null : d.comment;
      },
      expense(rec, d, present) {
        forbidEditIfVoided(rec);
        if (present.has("title")) rec.title = d.title.trim();
        if (present.has("amount")) rec.amount = storeMoney(d.amount);
        if (present.has("date")) rec.date = d.date;
      },
      salary_payment(rec, d, present) {
        forbidEditIfVoided(rec);
        if (present.has("staff_id") && d.staff_id != null) getStaff(d.staff_id);
        const start = present.has("period_start") ? d.period_start : rec.period_start;
        const end = present.has("period_end") ? d.period_end : rec.period_end;
        if (start > end) throw new HttpError(422, "period_start cannot be after period_end");
        if (present.has("staff_id")) rec.staff_id = d.staff_id;
        if (present.has("paid_at")) rec.paid_at = d.paid_at;
        if (present.has("period_start")) rec.period_start = d.period_start;
        if (present.has("period_end")) rec.period_end = d.period_end;
        if (present.has("payment_type")) rec.payment_type = d.payment_type;
        if (present.has("amount")) rec.amount = storeMoney(d.amount);
      },
    };

    const dutyRoutes = [
      ["POST", "/duty-entries", MANAGE, (c) => {
        const { data: d } = validateBody(S.dutyCreate, c.body);
        getStaff(d.staff_id);
        return [201, SER.duty_entry(newRecord("duty_entries", { staff_id: d.staff_id, date: d.date == null ? tashDate(now()) : d.date, amount: storeMoney(d.amount) }, c.user))];
      }],
      ["GET", "/duty-entries", MANAGE, (c) => {
        const q = validateQuery({ staff_id: { type: "int" }, ...DATE_RANGE, ...PAGE }, c.query);
        if (q.date_from && q.date_to && q.date_from > q.date_to) throw new HttpError(422, "date_from cannot be after date_to");
        const items = state.duty_entries
          .filter((d) => !d.is_voided && (q.staff_id == null || d.staff_id === q.staff_id) && (q.date_from == null || d.date >= q.date_from) && (q.date_to == null || d.date <= q.date_to))
          .sort(byDateDescIdDesc("date"));
        return paginate(items, q, SER.duty_entry);
      }],
      ...voidableTail("/duty-entries", "duty_entry", "duty_entry_id", MANAGE, "Duty entry not found"),
    ];

    const salaryRoutes = [
      ["POST", "/salary/payments", MANAGE, (c) => {
        const { data: d } = validateBody(S.salaryCreate, c.body, (d) => (d.period_start > d.period_end ? "period_start cannot be after period_end" : null));
        getStaff(d.staff_id);
        return [201, SER.salary_payment(newRecord("salary_payments", {
          staff_id: d.staff_id, paid_at: d.paid_at == null ? now() : d.paid_at, period_start: d.period_start,
          period_end: d.period_end, payment_type: d.payment_type, amount: storeMoney(d.amount),
        }, c.user))];
      }],
      ["GET", "/salary/payments", MANAGE, (c) => {
        const q = validateQuery({ staff_id: { type: "int" }, ...DATE_RANGE, ...PAGE }, c.query);
        return valueErrTo422(() => {
          const r = businessRange(q.date_from, q.date_to);
          const items = state.salary_payments
            .filter((p) => !p.is_voided && (q.staff_id == null || p.staff_id === q.staff_id) && inRange(p.paid_at, r))
            .sort(byDateDescIdDesc("paid_at"));
          return paginate(items, q, SER.salary_payment);
        });
      }],
      ["GET", "/salary/total-paid", MANAGE, (c) => {
        const q = validateQuery(DATE_RANGE, c.query);
        let r;
        try { r = businessRange(q.date_from, q.date_to); } catch (e) { throw new ServerError(e.message); }
        let total = 0n;
        for (const p of state.salary_payments) if (!p.is_voided && inRange(p.paid_at, r)) total += units(p.amount);
        return { total_paid: Number(total) };
      }],
      ["GET", "/salary/balance", MANAGE, (c) => {
        const q = validateQuery({ ...DATE_RANGE, staff_id: { type: "int" } }, c.query);
        return valueErrTo422(() => staffBalance(state, q.date_from, q.date_to, q.staff_id, now()));
      }],
      ...voidableTail("/salary/payments", "salary_payment", "salary_payment_id", MANAGE, "Salary payment not found"),
    ];

    const pharmacyRoutes = [
      ["POST", "/pharmacy/entries", MANAGE, (c) => {
        const { data: d } = validateBody(S.pharmacyCreate, c.body, (d) => (d.medicine_cost == null && d.amount_paid == null ? "At least one of medicine_cost or amount_paid is required" : null));
        return [201, SER.pharmacy_entry(newRecord("pharmacy_entries", {
          date: dateOrNow(d.date), medicine_cost: d.medicine_cost == null ? null : storeMoney(d.medicine_cost),
          amount_paid: d.amount_paid == null ? null : storeMoney(d.amount_paid), comment: d.comment ? d.comment.trim() : null,
        }, c.user))];
      }],
      ["GET", "/pharmacy/entries", MANAGE, (c) => {
        const q = validateQuery({ ...DATE_RANGE, ...PAGE }, c.query);
        return valueErrTo422(() => {
          const r = businessRange(q.date_from, q.date_to);
          return paginate(state.pharmacy_entries.filter((p) => !p.is_voided && inRange(p.date, r)).sort(byDateDescIdDesc("date")), q, SER.pharmacy_entry);
        });
      }],
      ["GET", "/pharmacy/summary", MANAGE, (c) => {
        const q = validateQuery(DATE_RANGE, c.query);
        return valueErrTo422(() => {
          const r = businessRange(q.date_from, q.date_to);
          let paid = 0n, cost = 0n;
          for (const p of state.pharmacy_entries) {
            if (p.is_voided || !inRange(p.date, r)) continue;
            if (p.amount_paid != null) paid += units(p.amount_paid);
            if (p.medicine_cost != null) cost += units(p.medicine_cost);
          }
          return { total_paid: paid.toString(), total_medicine_cost: cost.toString(), balance: (paid - cost).toString() };
        });
      }],
      ...voidableTail("/pharmacy/entries", "pharmacy_entry", "pharmacy_entry_id", MANAGE, "Pharmacy entry not found"),
    ];

    function expenseFilter(q) {
      const r = businessRange(q.date_from, q.date_to);
      return (e) => !e.is_voided && inRange(e.date, r) && (!q.search || ilike(e.title, q.search.trim()));
    }
    const expenseRoutes = [
      ["POST", "/expenses", MANAGE, (c) => {
        const { data: d } = validateBody(S.expenseCreate, c.body);
        return [201, SER.expense(newRecord("expenses", { title: d.title.trim(), amount: storeMoney(d.amount), date: dateOrNow(d.date) }, c.user))];
      }],
      ["GET", "/expenses", MANAGE, (c) => {
        const q = validateQuery({ ...DATE_RANGE, search: { type: "str" }, ...PAGE }, c.query);
        return valueErrTo422(() => paginate(state.expenses.filter(expenseFilter(q)).sort(byDateDescIdDesc("date")), q, SER.expense));
      }],
      ["GET", "/expenses/summary", MANAGE, (c) => {
        const q = validateQuery({ ...DATE_RANGE, search: { type: "str" } }, c.query);
        return valueErrTo422(() => {
          const items = state.expenses.filter(expenseFilter(q));
          return { total_amount: items.reduce((a, e) => a + units(e.amount), 0n).toString(), count: items.length };
        });
      }],
      ...voidableTail("/expenses", "expense", "expense_id", MANAGE, "Expense not found"),
    ];

    // ---- staff
    function validateRoleFields(role, specialty, fixed) {
      if (role === "doctor") {
        if (!specialty || !specialty.trim()) throw new HttpError(422, "specialty is required for doctors");
        if (fixed != null) throw new HttpError(422, "fixed_salary is not applicable to doctors");
      }
    }
    const staffSort = (a, b) => cmpStr(a.last_name, b.last_name) || cmpStr(a.first_name, b.first_name) || a.id - b.id;
    const staffRoutes = [
      ["POST", "/staff", MANAGE, (c) => {
        const { data: d } = validateBody(S.staffCreate, c.body, (d) => {
          if (d.role === "doctor") {
            if (!d.specialty || !d.specialty.trim()) return "specialty is required for doctors";
            if (d.fixed_salary != null) return "fixed_salary is not applicable to doctors";
          }
          return null;
        });
        const t = now();
        const s = {
          id: nextId("staff"), first_name: d.first_name.trim(), last_name: d.last_name.trim(), specialty: d.specialty ? d.specialty.trim() : null,
          role: d.role, fixed_salary: d.fixed_salary == null ? null : storeMoney(d.fixed_salary), status: "active", hire_date: d.hire_date, created_at: t, updated_at: t,
        };
        state.staff.push(s);
        touch();
        return [201, SER.staff(s)];
      }],
      ["GET", "/staff/options", ALL, (c) => {
        const q = validateQuery({ role: { type: "enum", values: ["doctor", "nurse", "other"] } }, c.query);
        const role = c.user.role === "assistant" ? "doctor" : q.role;
        return state.staff.filter((s) => s.status === "active" && (role == null || s.role === role)).sort(staffSort)
          .map((s) => ({ id: s.id, name: `${s.last_name} ${s.first_name}`, role: s.role }));
      }],
      ["GET", "/staff/{staff_id:int}", MANAGE, (c) => SER.staff(getStaff(c.params.staff_id))],
      ["PATCH", "/staff/{staff_id:int}", MANAGE, withBody(S.staffUpdate, (c) => {
        const { data: d, present } = validateBody(S.staffUpdate, c.body);
        const s = getStaff(c.params.staff_id);
        const next = { ...s };
        for (const f of present) {
          let v = d[f];
          if (f === "fixed_salary") v = v == null ? null : storeMoney(v);
          else if (typeof v === "string" && f !== "role" && f !== "hire_date") v = v.trim();
          next[f] = v;
        }
        validateRoleFields(next.role, next.specialty, next.fixed_salary);
        Object.assign(s, next, { updated_at: now() });
        touch();
        return SER.staff(s);
      })],
      ["GET", "/staff", MANAGE, (c) => {
        const q = validateQuery({ role: { type: "enum", values: ["doctor", "nurse", "other"] }, status: { type: "enum", values: ["active", "inactive"] }, search: { type: "str" }, ...PAGE }, c.query);
        const search = q.search ? q.search.trim() : null;
        const items = state.staff
          .filter((s) => (q.role == null || s.role === q.role) && (q.status == null || s.status === q.status) && (!q.search || ilike(s.first_name, search) || ilike(s.last_name, search) || ilike(s.specialty, search)))
          .sort(staffSort);
        return paginate(items, q, SER.staff);
      }],
      ["POST", "/staff/{staff_id:int}/activate", MANAGE, (c) => {
        const s = getStaff(c.params.staff_id);
        if (s.status !== "active") { s.status = "active"; s.updated_at = now(); touch(); }
        return SER.staff(s);
      }],
      ["POST", "/staff/{staff_id:int}/deactivate", MANAGE, (c) => {
        const s = getStaff(c.params.staff_id);
        if (s.status !== "inactive") { s.status = "inactive"; s.updated_at = now(); touch(); }
        return SER.staff(s);
      }],
      ["DELETE", "/staff/{staff_id:int}", SA, (c) => {
        const s = getStaff(c.params.staff_id);
        const id = s.id;
        const history = state.consultations.some((r) => r.doctor_id === id) || state.surgeries.some((r) => r.doctor_id === id) || state.rooms.some((r) => r.doctor_id === id) ||
          state.duty_entries.some((r) => r.staff_id === id) || state.salary_payments.some((r) => r.staff_id === id);
        if (history) throw new HttpError(409, "Cannot delete staff with existing financial/payroll history; deactivate instead.");
        state.staff.splice(state.staff.indexOf(s), 1);
        touch();
        return [204, null];
      }],
    ];

    // ---- users and auth
    function requireUsernameAvailable(username, excludeId) {
      if (state.users.some((u) => u.username === username && u.id !== excludeId)) throw new HttpError(409, "Username already taken");
    }
    function createUser(actor, d, role) {
      requireUsernameAvailable(d.username);
      if ([...d.full_name].length > 50) throw new ServerError("value too long for type character varying(50)");
      const t = now();
      const u = { id: newUuid(), username: d.username, full_name: d.full_name, password: d.password, role, status: "approved", token_version: 0, created_by_id: actor.id, created_at: t, updated_at: t };
      state.users.push(u);
      touch();
      return u;
    }
    function updateCredentials(target, username, fullName, password) {
      let changedAny = false;
      if (username && username !== target.username) { requireUsernameAvailable(username, target.id); target.username = username; changedAny = true; }
      if (fullName && fullName !== target.full_name) {
        if ([...fullName].length > 50) throw new ServerError("value too long for type character varying(50)");
        target.full_name = fullName; changedAny = true;
      }
      if (password) { target.password = password; changedAny = true; }
      if (changedAny) { target.token_version += 1; target.updated_at = now(); touch(); }
      return SER.user(target);
    }
    function setStatus(target, status) {
      if (target.status === status) return SER.user(target);
      target.status = status;
      target.token_version += 1;
      target.updated_at = now();
      touch();
      return SER.user(target);
    }
    function userOfRole(id, role, notFound) {
      const u = state.users.find((x) => x.id === id);
      if (!u || u.role !== role) throw new HttpError(404, notFound);
      return u;
    }
    const listUsers = (role, q) => paginate(state.users.filter((u) => u.role === role).sort((a, b) => cmpStr(a.full_name, b.full_name) || cmpStr(a.username, b.username)), q, SER.user);

    const authRoutes = [
      ["POST", "/auth/login", null, (c) => {
        const form = c.form || new URLSearchParams();
        const errors = [];
        for (const f of ["username", "password"]) if (!form.has(f)) errors.push({ type: "missing", loc: ["body", f], msg: "Field required", input: null });
        if (errors.length) throw new HttpError(422, errors);
        const u = state.users.find((x) => x.username === form.get("username"));
        if (!u || u.status !== "approved" || u.password !== form.get("password"))
          throw new HttpError(401, "Login yoki Parol xato, Adminga murojaat qiling!", NOT_AUTH);
        return issuePair(u);
      }],
      ["POST", "/auth/refresh", null, (c) => {
        const { data } = validateBody(S.refresh, c.body);
        const p = decode(data.refresh_token, "refresh");
        if (!p) throw new HttpError(401, "Invalid or expired refresh token");
        const u = state.users.find((x) => x.id === p.uid);
        if (!u || u.status !== "approved" || u.token_version !== p.ver) throw new HttpError(401, "Refresh token no longer valid");
        delete state.tokens[p.jti];
        return issuePair(u);
      }],
      ["POST", "/auth/logout", ALL, (c) => {
        delete state.tokens[c.token.jti];
        if (c.body && c.body !== MISSING && typeof c.body === "object" && typeof c.body.refresh_token === "string") {
          const p = decode(c.body.refresh_token, "refresh");
          if (p) delete state.tokens[p.jti];
        }
        touch(false);
        return [204, null];
      }],
      ["GET", "/auth/me", ALL, (c) => SER.user(c.user)],
      ["GET", "/users/managers", SA, (c) => listUsers("manager", validateQuery(PAGE, c.query))],
      ["POST", "/users/managers", SA, (c) => [201, SER.user(createUser(c.user, validateBody(S.userCreate, c.body).data, "manager"))]],
      ["PATCH", "/users/managers/{manager_id:uuid}", MANAGE, withBody(S.userCreate, (c) => {
        const { data } = validateBody(S.userCreate, c.body);
        const m = userOfRole(c.params.manager_id, "manager", "Manager not found");
        if (c.user.role === "manager" && c.user.id !== m.id) throw new HttpError(403, "Managers can only update their own profile");
        return updateCredentials(m, data.username, data.full_name, data.password);
      })],
      ["POST", "/users/managers/{manager_id:uuid}/block", SA, (c) => setStatus(userOfRole(c.params.manager_id, "manager", "Manager not found"), "blocked")],
      ["POST", "/users/managers/{manager_id:uuid}/unblock", SA, (c) => setStatus(userOfRole(c.params.manager_id, "manager", "Manager not found"), "approved")],
      ["GET", "/users/assistants", MANAGE, (c) => listUsers("assistant", validateQuery(PAGE, c.query))],
      ["POST", "/users/assistants", MANAGE, (c) => [201, SER.user(createUser(c.user, validateBody(S.userCreate, c.body).data, "assistant"))]],
      ["PATCH", "/users/assistants/{assistant_id:uuid}", MANAGE, withBody(S.userCreate, (c) => {
        const { data } = validateBody(S.userCreate, c.body);
        return updateCredentials(userOfRole(c.params.assistant_id, "assistant", "Assistant not found"), data.username, data.full_name, data.password);
      })],
      ["POST", "/users/assistants/{assistant_id:uuid}/block", MANAGE, (c) => setStatus(userOfRole(c.params.assistant_id, "assistant", "Assistant not found"), "blocked")],
      ["POST", "/users/assistants/{assistant_id:uuid}/unblock", MANAGE, (c) => setStatus(userOfRole(c.params.assistant_id, "assistant", "Assistant not found"), "approved")],
      ["PATCH", "/users/superadmin", SA, (c) => {
        const { data } = validateBody(S.superadminUpdate, c.body);
        return updateCredentials(c.user, data.superadmin_username, null, data.superadmin_password);
      }],
    ];

    // ---- reports and settings
    function reportRoute(name, roles, build) {
      return ["GET", `/reports/${name}`, roles, (c) => {
        const q = validateQuery({ ...DATE_RANGE, format: { type: "enum", values: ["json", "xlsx"], default: "json" } }, c.query);
        const report = valueErrTo422(() => build(state, q.date_from, q.date_to, c.user));
        if (q.format === "xlsx") {
          return {
            __raw: true,
            status: 200,
            bytes: reportWorkbook(name, report),
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers: { "content-disposition": `attachment; filename="${name}_${q.date_from || "all"}_${q.date_to || "all"}.xlsx"` },
          };
        }
        return report;
      }];
    }
    const reportRoutes = [
      reportRoute("consultations", MANAGE, consultationReport),
      reportRoute("surgeries", MANAGE, surgeryReport),
      reportRoute("rooms", MANAGE, roomReport),
      reportRoute("total", ALL, totalReport),
      ["GET", "/admin/settings/finance", SA, () => settingsOut()],
      ["PATCH", "/admin/settings/finance", SA, (c) => {
        const { data } = validateBody(S.settingsUpdate, c.body);
        state.settings.default_minus_beshming = storeMoney(data.default_minus_beshming);
        state.settings.updated_by_id = c.user.id;
        state.settings.updated_at = now();
        touch();
        return settingsOut();
      }],
    ];

    // ---- voided records (audit)
    const VOIDED_LABELS = { consultation: "Ko'rik", surgery: "Operatsiya", room: "Xona", duty_entry: "Navbatchilik", expense: "Xarajat", pharmacy_entry: "Dorixona", salary_payment: "Oylik to'lovi" };
    const ORDER = ["consultation", "surgery", "room", "duty_entry", "expense", "pharmacy_entry", "salary_payment"];
    function describe(kind, r) {
      const label = (prefix, n) => (n != null ? `${prefix} #${n}` : prefix);
      switch (kind) {
        case "consultation": return [label(r.type === "qaytakorik" ? "Qayta ko'rik" : "Ko'rik", r.receipt_number), isoOut(r.date), r.amount];
        case "surgery": return [label("Operatsiya", r.receipt_number), isoOut(r.date), r.amount];
        case "room": return [label("Xona", r.receipt_number), isoOut(r.date), r.amount];
        case "duty_entry": return ["Navbatchilik", `${r.date}T00:00:00`, r.amount];
        case "expense": return [r.title, isoOut(r.date), r.amount];
        case "pharmacy_entry": return [r.comment || "Dorixona yozuvi", isoOut(r.date), r.amount_paid != null ? r.amount_paid : r.medicine_cost];
        default: return [r.payment_type === "avans" ? "Avans" : "To'liq oylik", isoOut(r.paid_at), r.amount];
      }
    }
    const auditRoutes = [
      ["GET", "/voided-records", SA, (c) => {
        const q = validateQuery({ resource_type: { type: "str" }, ...PAGE }, c.query);
        const rows = [];
        for (const kind of ORDER) {
          if (q.resource_type != null && q.resource_type !== kind) continue;
          for (const r of [...state[RES[kind].table]].sort((a, b) => a.id - b.id)) {
            if (!r.is_voided) continue;
            const [summary, when, amount] = describe(kind, r);
            const voider = state.users.find((u) => u.id === r.voided_by_id);
            rows.push({ resource_type: kind, resource_label: VOIDED_LABELS[kind], id: r.id, summary, date: when, amount: pgDecimalText(amount), voided_at: r.voided_at, voided_by_name: voider ? voider.full_name : null });
          }
        }
        // Python: sort(key=(voided_at is not None, voided_at), reverse=True), stable.
        const keyed = rows.map((r, i) => ({ r, i }));
        keyed.sort((a, b) => {
          const ka = a.r.voided_at == null ? -Infinity : a.r.voided_at;
          const kb = b.r.voided_at == null ? -Infinity : b.r.voided_at;
          return kb - ka || a.i - b.i;
        });
        return paginate(keyed.map((k) => k.r), q, (r) => ({ ...r, voided_at: isoOut(r.voided_at) }));
      }],
      ["DELETE", "/voided-records", SA, (c) => {
        const q = validateQuery({ resource_type: { type: "str" } }, c.query);
        if (q.resource_type != null && !(q.resource_type in VOIDED_LABELS)) throw new HttpError(422, `Unknown resource_type: ${q.resource_type}`);
        let deleted = 0;
        for (const kind of ORDER) {
          if (q.resource_type != null && q.resource_type !== kind) continue;
          const table = RES[kind].table;
          const before = state[table].length;
          state[table] = state[table].filter((r) => !r.is_voided);
          deleted += before - state[table].length;
        }
        if (deleted) touch();
        return { deleted };
      }],
    ];

    // Registration order matters for matching, as in FastAPI.
    const ROUTES = [
      ...authRoutes, ...staffRoutes, ...consultationRoutes, ...surgeryRoutes, ...roomRoutes, ...reportRoutes,
      ...dutyRoutes, ...salaryRoutes, ...pharmacyRoutes, ...expenseRoutes, ...auditRoutes,
    ].map(([method, pattern, roles, handler]) => {
      const params = [];
      const re = new RegExp("^" + pattern.replace(/\{(\w+):(\w+)\}/g, (_, name, type) => { params.push([name, type]); return "([^/]+)"; }) + "$");
      return { method, re, params, roles, handler };
    });

    function respond(status, json, headers) {
      return { status, json, headers: headers || {} };
    }

    // handle({method, path, query, headers, body, form}) -> {status, json|bytes|text, headers}
    function handle(req) {
      changed = false;
      const method = (req.method || "GET").toUpperCase();
      const query = req.query instanceof URLSearchParams ? req.query : new URLSearchParams(req.query || "");
      const headers = {};
      for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = v;
      let pathMatched = false;
      let route = null;
      let match = null;
      for (const r of ROUTES) {
        const m = req.path.match(r.re);
        if (!m) continue;
        pathMatched = true;
        if (r.method === method) { route = r; match = m; break; }
      }
      try {
        if (!route) {
          if (pathMatched) return respond(405, { detail: "Method Not Allowed" });
          return respond(404, { detail: "Not Found" });
        }
        const ctx = { query, body: req.body === undefined ? MISSING : req.body, form: req.form, params: {} };
        if (route.roles) {
          const { user, token } = currentUser(headers);
          if (!route.roles.includes(user.role)) throw new HttpError(403, "You dont have permission to perform this action");
          ctx.user = user;
          ctx.token = token;
        }
        const pathErrors = [];
        route.params.forEach(([name, type], i) => {
          const raw = decodeURIComponent(match[i + 1]);
          const res = checkValue({ type }, raw);
          if (res.error) {
            const e = { type: res.error.type, loc: ["path", name], msg: res.error.msg, input: raw };
            if (res.error.ctx) e.ctx = res.error.ctx;
            pathErrors.push(e);
          } else ctx.params[name] = res.value;
        });
        if (pathErrors.length) {
          if (route.handler.bodySchema) {
            try { validateBody(route.handler.bodySchema, ctx.body); } catch (e) {
              if (e instanceof HttpError && Array.isArray(e.detail)) pathErrors.push(...e.detail.filter((x) => x.loc.length > 1));
            }
          }
          throw new HttpError(422, pathErrors);
        }
        const out = route.handler(ctx);
        if (changed) onChange(state);
        if (out && out.__raw) return out;
        if (Array.isArray(out) && typeof out[0] === "number" && out.length === 2 && route.method !== "GET") {
          return out[0] === 204 ? { status: 204, json: undefined, headers: {} } : respond(out[0], out[1]);
        }
        return respond(200, out);
      } catch (e) {
        if (changed) onChange(state);
        if (e instanceof HttpError) return respond(e.status, { detail: e.detail }, e.headers);
        if (e instanceof ServerError) return { status: 500, text: "Internal Server Error", headers: {} };
        throw e;
      }
    }

    return { handle, state };
  }

  // ------------------------------------------------------------- demo data
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DEMO_USERS = {
    admin: { id: "0b6f7c1e-3d2a-4f5b-9c8d-1a2b3c4d5e01", username: "admin", full_name: "Bosh administrator", password: "admin123", role: "superadmin" },
    manager: { id: "0b6f7c1e-3d2a-4f5b-9c8d-1a2b3c4d5e02", username: "sardor", full_name: "Sardor Nazarov", password: "sardor123", role: "manager" },
    shahnoza: { id: "0b6f7c1e-3d2a-4f5b-9c8d-1a2b3c4d5e03", username: "shahnoza", full_name: "Shahnoza Umarova", password: "shahnoza123", role: "assistant" },
    dilshod: { id: "0b6f7c1e-3d2a-4f5b-9c8d-1a2b3c4d5e04", username: "dilshod", full_name: "Dilshod Hasanov", password: "dilshod123", role: "assistant" },
    kamola: { id: "0b6f7c1e-3d2a-4f5b-9c8d-1a2b3c4d5e05", username: "kamola", full_name: "Kamola Yo'ldosheva", password: "kamola123", role: "assistant", status: "blocked" },
  };

  // Free-text demo data in English, for the English build of the demo.
  const EN_DATA = {
    "Bosh administrator": "Clinic Owner",
    Terapevt: "Therapist", Kardiolog: "Cardiologist", Xirurg: "Surgeon", Nevrolog: "Neurologist", LOR: "ENT",
    Hamshira: "Nurse", Administrator: "Receptionist", Haydovchi: "Driver",
    "Bino ijarasi": "Building rent", "Kommunal to'lovlar": "Utilities", "Internet va telefon": "Internet and phone",
    "Tibbiy sarf materiallari": "Medical supplies", "Tozalash vositalari": "Cleaning supplies", "Printer kartridji": "Printer cartridge",
    "Uskuna ta'miri": "Equipment repair", "Ofis anjomlari": "Office supplies", "Xodimlar uchun tushlik": "Staff lunch",
    "Konditsioner xizmati": "Air conditioning service",
    Antibiotiklar: "Antibiotics", "Bog'lov materiallari": "Dressings", Vitaminlar: "Vitamins", "Shprits va tizimlar": "Syringes and IV sets",
    "Og'riq qoldiruvchilar": "Painkillers", "Dezinfeksiya vositalari": "Disinfectants", "Naqd to'lov": "Cash payment",
  };

  // Builds a fresh, deterministic dataset covering the 1st of the month two
  // months back through `nowMs`, so "this month" always has data.
  function generate(nowMs, opts = {}) {
    const tr = (s) => (opts.lang === "en" && EN_DATA[s]) || s;
    const rng = mulberry32(20260907);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const today = tashDate(nowMs);
    const [ty, tm] = today.split("-").map(Number);
    let sy = ty, sm = tm - 2;
    if (sm < 1) { sm += 12; sy -= 1; }
    const start = `${sy}-${pad(sm)}-01`;
    const at = (d, h, m) => tashMidnight(d) + h * HOUR + m * MINUTE;
    const setupTime = at(addDays(start, -20), 10, 0);

    const state = {
      version: 1, lang: opts.lang === "en" ? "en" : "uz", generatedFor: today, generatedAt: nowMs, dirty: false, seq: {},
      users: [], staff: [], consultations: [], surgeries: [], rooms: [], duty_entries: [], salary_payments: [],
      pharmacy_entries: [], expenses: [], tokens: {},
      settings: { default_minus_beshming: "5000", updated_at: setupTime, updated_by_id: null },
    };

    for (const u of Object.values(DEMO_USERS)) {
      state.users.push({
        id: u.id, username: u.username, full_name: tr(u.full_name), password: u.password, role: u.role, status: u.status || "approved",
        token_version: 0, created_by_id: u.role === "superadmin" ? null : u.role === "manager" ? DEMO_USERS.admin.id : DEMO_USERS.manager.id,
        created_at: setupTime, updated_at: setupTime,
      });
    }
    const A = DEMO_USERS;

    const prevMonth = sm === 12 ? `${sy + 1}-01` : `${sy}-${pad(sm + 1)}`; // month after start = previous month
    const STAFF = [
      [1, "Aziz", "Karimov", "Terapevt", "doctor", null, "2024-03-01"],
      [2, "Dilnoza", "Rahimova", "Kardiolog", "doctor", null, "2024-03-01"],
      [3, "Jasur", "Toshmatov", "Xirurg", "doctor", null, "2024-09-01"],
      [4, "Malika", "Yusupova", "Nevrolog", "doctor", null, "2025-02-10"],
      [5, "Rustam", "Sobirov", "LOR", "doctor", null, "2025-04-01"],
      [6, "Nodira", "Qodirova", "Hamshira", "nurse", "4200000", "2025-06-01"],
      [7, "Feruza", "Usmonova", "Hamshira", "nurse", "3800000", "2025-11-10"],
      [8, "Bekzod", "Aliyev", "Administrator", "other", "3200000", "2025-05-01"],
      [9, "Gulnora", "Ergasheva", "Hamshira", "nurse", "4000000", `${prevMonth}-15`],
      [10, "Anvar", "Xolmatov", "Haydovchi", "other", "2800000", "2025-01-15"],
    ];
    for (const [id, first, last, spec, role, fixed, hire] of STAFF) {
      const created = hire > addDays(start, -20) ? at(hire, 9, 30) : setupTime;
      state.staff.push({ id, first_name: first, last_name: last, specialty: tr(spec), role, fixed_salary: fixed, status: id === 10 ? "inactive" : "active", hire_date: hire, created_at: created, updated_at: created });
    }
    state.seq.staff = STAFF.length;

    const PCT = { 1: "50.00", 2: "45.00", 3: "40.00", 4: "45.00", 5: "50.00" };
    const PRICE = { 1: [150000, 150000, 180000], 2: [200000, 220000], 3: [200000], 4: [180000, 200000], 5: [150000, 170000] };
    const DOC_WEIGHTS = [1, 1, 1, 2, 2, 3, 4, 4, 5, 5];

    // Working days in the window (Mon–Sat).
    const days = [];
    for (let d = start; d <= today; d = addDays(d, 1)) if (weekday(d) !== 0) days.push(d);

    let receipt = 10400;
    const add = (table, rec) => {
      rec.id = (state.seq[table] = (state.seq[table] || 0) + 1);
      state[table].push(rec);
      return rec;
    };
    const base = (t, by) => {
      const created = Math.min(t + (2 + Math.floor(rng() * 5)) * MINUTE, nowMs);
      return { created_by_id: by, is_voided: false, voided_at: null, voided_by_id: null, created_at: created, updated_at: created };
    };
    const enteredBy = (hour) => (rng() < 0.05 ? A.manager.id : hour < 13 ? A.shahnoza.id : A.dilshod.id);

    for (const d of days) {
      const events = [];
      const n = 6 + Math.floor(rng() * 7);
      for (let i = 0; i < n; i++) {
        const h = 8 + Math.floor(rng() * 10);
        const m = pick([0, 10, 15, 20, 30, 40, 45, 50]);
        const doc = pick(DOC_WEIGHTS);
        const korik = rng() < 0.75;
        events.push({ kind: "consultation", t: at(d, h, m), h, doc, korik, amount: korik ? pick(PRICE[doc]) : pick([80000, 100000]) });
      }
      if (rng() < 0.3) {
        const h = 10 + Math.floor(rng() * 4);
        const amount = pick([3500000, 4800000, 6200000, 7500000, 9000000]);
        events.push({ kind: "surgery", t: at(d, h, 0), h, amount, expense: Math.floor((amount * pick([0.18, 0.22, 0.25])) / 1000) * 1000 });
      }
      const rooms = rng() < 0.55 ? (rng() < 0.3 ? 2 : 1) : 0;
      for (let i = 0; i < rooms; i++) {
        const h = 12 + Math.floor(rng() * 4);
        events.push({ kind: "room", t: at(d, h, pick([0, 30])), h, amount: pick([400000, 500000, 650000]), doc: 1 + Math.floor(rng() * 5), noReceipt: rng() < 0.15 });
      }
      events.sort((a, b) => a.t - b.t);
      for (const e of events) {
        if (e.t > nowMs) continue;
        const by = enteredBy(e.h);
        if (e.kind === "consultation") {
          add("consultations", { type: e.korik ? "korik" : "qaytakorik", receipt_number: ++receipt, date: e.t, amount: String(e.amount), doctor_percent: PCT[e.doc], minus_beshming: "5000", doctor_id: e.doc, ...base(e.t, by) });
        } else if (e.kind === "surgery") {
          add("surgeries", { receipt_number: ++receipt, date: e.t, amount: String(e.amount), surgery_expense: String(e.expense), doctor_percent: "35.00", doctor_id: 3, ...base(e.t, by) });
        } else {
          add("rooms", { receipt_number: e.noReceipt ? null : ++receipt, date: e.t, amount: String(e.amount), doctor_percent: "10.00", doctor_id: e.doc, ...base(e.t, by) });
        }
      }
    }

    // Overtime shifts (navbatchilik), entered by the manager the same evening.
    for (const d of days) {
      if (d >= today || rng() >= 0.33) continue;
      const pool = [6, 7, 8, 1, 2].concat(`${prevMonth}-15` <= d ? [9] : []);
      const t = at(d, 18, 10);
      add("duty_entries", { staff_id: pick(pool), date: d, amount: String(pick([150000, 200000, 250000])), ...base(t, A.manager.id) });
    }

    // Pharmacy account: deliveries on Mondays, payments on Fridays.
    const deliveries = ["Antibiotiklar", "Bog'lov materiallari", "Vitaminlar", "Shprits va tizimlar", "Og'riq qoldiruvchilar", "Dezinfeksiya vositalari"];
    let deliveryIndex = 0;
    for (const d of days) {
      const wd = weekday(d);
      if (wd === 1) {
        const t = at(d, 11, 0);
        if (t <= nowMs) add("pharmacy_entries", { date: t, medicine_cost: String(pick([820000, 1150000, 1480000, 1960000, 2450000])), amount_paid: null, comment: tr(deliveries[deliveryIndex++ % deliveries.length]), ...base(t, A.manager.id) });
      } else if (wd === 5) {
        const t = at(d, 16, 0);
        if (t <= nowMs) add("pharmacy_entries", { date: t, medicine_cost: null, amount_paid: String(pick([1000000, 1500000, 1800000, 2000000])), comment: rng() < 0.5 ? tr("Naqd to'lov") : null, ...base(t, A.manager.id) });
      }
    }

    // Other expenses: fixed monthly bills plus a few one-offs.
    const months = [];
    for (let y = sy, m = sm; `${y}-${pad(m)}` <= today.slice(0, 7); m === 12 ? ((m = 1), y++) : m++) months.push([y, m]);
    const firstWorkingDayFrom = (d) => { while (weekday(d) === 0) d = addDays(d, 1); return d; };
    const oneOffs = [
      ["Tibbiy sarf materiallari", [1800000, 2300000, 2600000]],
      ["Tozalash vositalari", [350000, 380000, 420000]],
      ["Printer kartridji", [250000]],
      ["Uskuna ta'miri", [900000, 1100000, 1200000]],
      ["Ofis anjomlari", [300000, 320000]],
      ["Xodimlar uchun tushlik", [600000, 650000]],
      ["Konditsioner xizmati", [450000]],
    ];
    const expenseEvents = [];
    for (const [y, m] of months) {
      const ym = `${y}-${pad(m)}`;
      expenseEvents.push([firstWorkingDayFrom(`${ym}-01`), 10, "Bino ijarasi", 8000000]);
      const fifth = firstWorkingDayFrom(`${ym}-05`);
      expenseEvents.push([fifth, 15, "Kommunal to'lovlar", pick([1650000, 1780000, 1920000])]);
      expenseEvents.push([fifth, 15, "Internet va telefon", 420000]);
      const count = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        const [title, amounts] = pick(oneOffs);
        const day = firstWorkingDayFrom(`${ym}-${pad(2 + Math.floor(rng() * 26))}`);
        expenseEvents.push([day, 14, title, pick(amounts)]);
      }
    }
    expenseEvents.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    for (const [d, h, title, amount] of expenseEvents) {
      const t = at(d, h, 0);
      if (d.slice(0, 7) <= today.slice(0, 7) && t <= nowMs) add("expenses", { title: tr(title), amount: String(amount), date: t, ...base(t, A.manager.id) });
    }

    // A few corrections, voided by the manager shortly after entry.
    const voidOne = (table, idx) => {
      const rec = state[table][idx];
      if (!rec) return;
      const t = rec.created_at + 25 * MINUTE;
      if (t > nowMs) return;
      rec.is_voided = true;
      rec.voided_at = t;
      rec.voided_by_id = A.manager.id;
      rec.updated_at = t;
    };
    voidOne("consultations", Math.floor(state.consultations.length * 0.37));
    voidOne("consultations", Math.floor(state.consultations.length * 0.71));
    voidOne("expenses", Math.floor(state.expenses.length * 0.5));
    voidOne("duty_entries", Math.floor(state.duty_entries.length * 0.6));

    // Salaries: an advance on the 15th, and the rest of the month paid on the
    // 3rd working day of the next month (computed with the payroll rules, so
    // paid months settle to zero). The latest month leaves two people unpaid.
    const ADVANCE = { 1: 1500000, 2: 1500000, 3: 2000000, 4: 1500000, 5: 1500000, 6: 1700000, 7: 1500000, 8: 1300000, 9: 1600000 };
    const payEvents = [];
    for (const [y, m] of months) {
      const ym = `${y}-${pad(m)}`;
      const monthStart = `${ym}-01`;
      const monthEnd = `${ym}-${pad(daysInMonth(y, m))}`;
      const advanceDay = firstWorkingDayFrom(`${ym}-15`);
      for (const s of state.staff) {
        if (s.status !== "active" || s.hire_date > `${ym}-14`) continue;
        payEvents.push({ t: at(advanceDay, 17, 0), staff: s.id, type: "avans", amount: ADVANCE[s.id], period: [monthStart, monthEnd] });
      }
      let payDay = addDays(monthEnd, 1);
      for (let k = 0; k < 2 || weekday(payDay) === 0; ) { payDay = addDays(payDay, 1); if (weekday(payDay) !== 0) k++; }
      for (const s of state.staff) {
        if (s.status !== "active" || s.hire_date > monthEnd) continue;
        if (ym === prevMonth && (s.id === 5 || s.id === 9)) continue;
        payEvents.push({ t: at(payDay, 17, 30), staff: s.id, type: "full", amount: null, period: [monthStart, monthEnd] });
      }
    }
    payEvents.sort((a, b) => a.t - b.t || (a.type === b.type ? a.staff - b.staff : a.type === "avans" ? -1 : 1));
    for (const p of payEvents) {
      if (p.t > nowMs) continue;
      let amount = p.amount;
      if (amount == null) {
        const [row] = staffBalance(state, p.period[0], p.period[1], p.staff, p.t);
        amount = Number(row.remaining);
        if (amount <= 0) continue;
      }
      add("salary_payments", { staff_id: p.staff, paid_at: p.t, period_start: p.period[0], period_end: p.period[1], payment_type: p.type, amount: String(amount), ...base(p.t, A.manager.id) });
    }

    return state;
  }

  return {
    generate,
    createServer,
    DEMO_USERS,
    // exported for the verification script
    _internals: { consultationTotals, roomTotals, prorateFixedSalary, workingDays, staffBalance, totalReport, consultationReport, surgeryReport, roomReport, parseDecimal, quantize, parseDateTime, isoOut, tashDate },
  };
});
