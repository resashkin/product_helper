// Pure logic: flag splits, diffs, HogQL queries and the win probability.
// No DOM and no network here, so `node --test` covers it.

// ---------- Flag splits ----------

export function variantsOf(filters) {
  return filters?.multivariate?.variants ?? [];
}

export function groupsOf(filters) {
  return filters?.groups ?? [];
}

/** The baseline variant: one named "control" if present, otherwise the first one. */
export function controlKey(variants) {
  if (!variants.length) return null;
  return (variants.find((v) => v.key === 'control') ?? variants[0]).key;
}

/** Checks a proposed split: whole numbers 0..100 that add up to 100. */
export function validateSplit(split) {
  const errors = [];
  const values = Object.values(split);
  for (const [key, value] of Object.entries(split)) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      errors.push(`${key}: нужно целое число от 0 до 100`);
    }
  }
  const sum = values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (values.length && sum !== 100) errors.push(`Сумма долей ${sum}%, а должна быть 100%`);
  return { ok: errors.length === 0, sum, errors };
}

export function validateRollouts(rollouts) {
  const errors = [];
  rollouts.forEach((value, i) => {
    if (value === null) return; // a condition without a percentage means 100%, left untouched
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      errors.push(`Условие ${i + 1}: нужно целое число от 0 до 100`);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function currentSplit(filters) {
  return Object.fromEntries(variantsOf(filters).map((v) => [v.key, v.rollout_percentage]));
}

export function currentRollouts(filters) {
  return groupsOf(filters).map((g) => g.rollout_percentage ?? null);
}

/** Splits 100% as evenly as whole numbers allow; the first variants get the remainder. */
export function evenSplit(variants) {
  const n = variants.length;
  const base = Math.floor(100 / n);
  let rest = 100 - base * n;
  return Object.fromEntries(variants.map((v) => [v.key, base + (rest-- > 0 ? 1 : 0)]));
}

/** One variant at 100%, every other one at 0%. */
export function winnerSplit(variants, winner) {
  return Object.fromEntries(variants.map((v) => [v.key, v.key === winner ? 100 : 0]));
}

/** A copy of `filters` with the new split and rollouts; everything else stays as it was. */
export function applyEdits(filters, { split, rollouts }) {
  const next = structuredClone(filters);
  if (split && next.multivariate?.variants) {
    for (const v of next.multivariate.variants) {
      if (v.key in split) v.rollout_percentage = split[v.key];
    }
  }
  if (rollouts && next.groups) {
    next.groups.forEach((g, i) => {
      if (rollouts[i] !== undefined && rollouts[i] !== null) g.rollout_percentage = rollouts[i];
    });
  }
  return next;
}

function describeGroup(group, index) {
  const conditions = (group.properties ?? []).length;
  const who = conditions ? `${conditions} услов.` : 'все пользователи';
  return `Условие ${index + 1} (${who})`;
}

/** What changes between two filter objects, as rows for the confirmation dialog. */
export function diffFilters(before, after) {
  const rows = [];
  const oldVariants = new Map(variantsOf(before).map((v) => [v.key, v.rollout_percentage]));
  for (const v of variantsOf(after)) {
    const was = oldVariants.get(v.key);
    if (was !== v.rollout_percentage) {
      rows.push({ kind: 'variant', label: `Вариант ${v.key}`, before: was, after: v.rollout_percentage });
    }
  }
  const oldGroups = groupsOf(before);
  groupsOf(after).forEach((g, i) => {
    const was = oldGroups[i]?.rollout_percentage ?? null;
    const now = g.rollout_percentage ?? null;
    if (was !== now) {
      rows.push({ kind: 'group', label: `Раскатка: ${describeGroup(g, i)}`, before: was, after: now });
    }
  });
  return rows;
}

/** Plain-language warnings to show above the confirmation input. */
export function changeWarnings(flag, rows, { runningExperiment } = {}) {
  const warnings = [
    `Флаг «${flag.key}» сразу изменится у всех приложений, которые его читают.`,
  ];
  const variantRows = rows.filter((r) => r.kind === 'variant');
  if (variantRows.length) {
    const winner = variantRows.find((r) => r.after === 100);
    if (winner) {
      warnings.push(`Все новые назначения получат ${winner.label.replace('Вариант ', '')}.`);
    } else {
      warnings.push('PostHog перераспределит пользователей по новым долям: часть уже назначенных сменит вариант.');
    }
    warnings.push('Если приложение запоминает вариант на устройстве, уже назначенные устройства его не сменят: новая доля коснётся только новых.');
  }
  if (rows.some((r) => r.kind === 'group' && r.after === 0)) {
    warnings.push('Условие с 0% выключает флаг для его пользователей: приложение получит значение по умолчанию.');
  }
  if (runningExperiment) {
    warnings.push(`Флаг ведёт эксперимент «${runningExperiment}»: данные до и после изменения смешаются.`);
  }
  if (flag.active === false) {
    warnings.push('Флаг выключен: доли начнут действовать, только когда его включат.');
  }
  return warnings;
}

// ---------- HogQL ----------

/** A HogQL string literal. */
export function hogqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function prop(name) {
  return `properties[${hogqlString(name)}]`;
}

function propString(name) {
  return `ifNull(toString(${prop(name)}), '')`;
}

/**
 * Per-variant results. One row per variant: units (devices if `unitProp` is on the event,
 * otherwise sessions = distinct_id), approximate devices, buyers per purchase event and revenue in USD.
 * A unit gets the first variant it was seen with; units seen with two variants land in '__mixed__'.
 * Use with HogQLQuery `filters` (dateRange, filterTestAccounts) — the query has a {filters} placeholder.
 */
export function buildResultsQuery({
  variantProp,
  unitProp = '',
  purchaseEvents = [],
  priceProp = 'price',
  currencyProp = 'currency',
  excludeTestflight = true,
  exclude = null, // { prop, value }
}) {
  if (!variantProp) throw new Error('Не задано свойство с вариантом');
  const events = purchaseEvents.length ? purchaseEvents.map(hogqlString).join(', ') : "''";
  const unit = unitProp
    ? `if(${propString(unitProp)} != '', concat('device:', ${propString(unitProp)}), concat('session:', distinct_id))`
    : `concat('session:', distinct_id)`;
  const where = ['{filters}'];
  if (excludeTestflight) {
    where.push(`NOT ifNull(toBool(${prop('$is_testflight')}), false)`);
    where.push(`NOT ifNull(toBool(${prop('$is_emulator')}), false)`);
  }
  if (exclude?.prop) {
    where.push(`${propString(exclude.prop)} != ${hogqlString(exclude.value ?? '')}`);
  }
  const perEvent = purchaseEvents
    .map((e, i) => `countIf(has(bought, ${hogqlString(e)})) AS buyers_${i}`)
    .join(',\n    ');

  return `SELECT
    if(variants_seen > 1, '__mixed__', variant) AS variant_key,
    count() AS units,
    countIf(startsWith(unit, 'device:')) AS device_units,
    uniq(device) AS approx_devices,
    countIf(length(bought) > 0) AS buyers,
    sum(purchases) AS purchases,
    round(sum(revenue_usd), 2) AS revenue_usd${perEvent ? ',\n    ' + perEvent : ''}
FROM (
    SELECT
        unit,
        argMinIf(vp, ts, vp != '') AS variant,
        uniqExactIf(vp, vp != '') AS variants_seen,
        any(dev) AS device,
        groupUniqArrayIf(event, is_purchase) AS bought,
        countIf(is_purchase) AS purchases,
        sumIf(price_usd, is_purchase) AS revenue_usd
    FROM (
        SELECT
            ${unit} AS unit,
            timestamp AS ts,
            event,
            ${propString(variantProp)} AS vp,
            concat(${propString('$device_model')}, '|', ${propString('$os_version')}, '|', ${propString('$geoip_country_code')}) AS dev,
            event IN (${events}) AS is_purchase,
            if(is_purchase,
               toFloat(convertCurrency(
                   if(${propString(currencyProp)} != '', upper(${propString(currencyProp)}), 'USD'),
                   'USD',
                   toDecimal(ifNull(toFloat(${prop(priceProp)}), 0), 10),
                   toDate(timestamp))),
               0) AS price_usd
        FROM events
        WHERE ${where.join('\n          AND ')}
    )
    GROUP BY unit
)
WHERE variant != ''
GROUP BY variant_key
ORDER BY variant_key`;
}

/** Event properties that may hold a variant: anything named *variant* plus `$feature/<flag>`. */
export function buildCandidatesQuery(flagKey, days = 30) {
  return `SELECT k AS property, count() AS events, groupUniqArray(20)(JSONExtractString(properties, k)) AS sample_values
FROM events
ARRAY JOIN JSONExtractKeys(properties) AS k
WHERE timestamp >= now() - INTERVAL ${Number(days)} DAY
  AND (k ILIKE '%variant%' OR k = ${hogqlString('$feature/' + flagKey)})
GROUP BY k
ORDER BY events DESC
LIMIT 50`;
}

/** Purchase-like events: names with "purchas" that are not attempts, cancels or failures. */
export function buildPurchaseEventsQuery(days = 90) {
  return `SELECT event, count() AS events
FROM events
WHERE timestamp >= now() - INTERVAL ${Number(days)} DAY
  AND event ILIKE '%purchas%'
  AND NOT match(event, '(?i)(initiat|start|cancel|fail|error|restore|attempt)')
GROUP BY event
ORDER BY events DESC
LIMIT 20`;
}

/**
 * The property most likely to carry this flag's variant: its values must be the flag's
 * variant keys. The app's own property wins over `$feature/<flag>` (the SDK's live value).
 */
export function pickVariantProperty(candidates, flag) {
  const keys = new Set(variantsOf(flag.filters).map((v) => v.key));
  const scored = candidates
    .map((c) => {
      const values = (c.sample_values ?? []).filter((v) => v !== '');
      const matching = values.filter((v) => keys.has(v)).length;
      return { ...c, matching, clean: values.length > 0 && matching === values.length };
    })
    .filter((c) => c.matching > 0);
  scored.sort((a, b) => {
    const own = (c) => (c.property.startsWith('$feature/') ? 0 : 1);
    return (Number(b.clean) - Number(a.clean)) || (own(b) - own(a)) || (b.events - a.events);
  });
  return scored[0]?.property ?? `$feature/${flag.key}`;
}

/** Turns a HogQL response into plain objects. */
export function rowsFromQuery(response) {
  const columns = response.columns ?? [];
  return (response.results ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

/** Results per variant, in the flag's variant order, with conversion and per-event buyers. */
export function shapeResults(rows, flag, purchaseEvents) {
  const order = variantsOf(flag.filters).map((v) => v.key);
  const byKey = new Map(rows.map((r) => [r.variant_key, r]));
  const out = [];
  const keys = [...order, ...rows.map((r) => r.variant_key).filter((k) => !order.includes(k) && k !== '__mixed__')];
  for (const key of keys) {
    const r = byKey.get(key) ?? {};
    const units = Number(r.units ?? 0);
    const buyers = Number(r.buyers ?? 0);
    out.push({
      key,
      known: order.includes(key),
      units,
      deviceUnits: Number(r.device_units ?? 0),
      approxDevices: Number(r.approx_devices ?? 0),
      buyers,
      purchases: Number(r.purchases ?? 0),
      revenue: Number(r.revenue_usd ?? 0),
      conversion: units ? buyers / units : 0,
      revenuePerUnit: units ? Number(r.revenue_usd ?? 0) / units : 0,
      perEvent: purchaseEvents.map((e, i) => ({ event: e, buyers: Number(r[`buyers_${i}`] ?? 0) })),
    });
  }
  const mixed = byKey.get('__mixed__');
  return { variants: out, mixedUnits: Number(mixed?.units ?? 0) };
}

// ---------- Win probability ----------

/** Small seeded PRNG, so tests are repeatable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia–Tsang
function gamma(shape, rng) {
  if (shape < 1) return gamma(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function beta(a, b, rng) {
  const x = gamma(a, rng);
  return x / (x + gamma(b, rng));
}

/** Weight of the shared prior, in units (sessions or devices). */
export const PRIOR_WEIGHT = 10;

/**
 * Bayesian chance that each variant's conversion beats the control, and that it is the best.
 * `arms` = [{ key, units, buyers }].
 *
 * Every arm gets the same prior: Beta centred on the pooled conversion of all arms, worth
 * PRIOR_WEIGHT units. A flat Beta(1, 1) assumes 50% conversion, which at a ~3% rate makes
 * a tiny arm with zero buyers look better than a control with real purchases.
 */
export function winProbabilities(arms, control, { draws = 20000, rng = Math.random, priorWeight = PRIOR_WEIGHT } = {}) {
  const live = arms.filter((a) => a.units > 0);
  const result = Object.fromEntries(arms.map((a) => [a.key, { beatsControl: null, best: null }]));
  if (live.length < 2) return result;
  const units = live.reduce((s, a) => s + a.units, 0);
  const buyers = live.reduce((s, a) => s + a.buyers, 0);
  const pooled = (buyers + 1) / (units + 2); // smoothed, so zero buyers still gives a valid prior
  const priorA = pooled * priorWeight;
  const priorB = (1 - pooled) * priorWeight;
  const wins = Object.fromEntries(live.map((a) => [a.key, 0]));
  const best = Object.fromEntries(live.map((a) => [a.key, 0]));
  const hasControl = live.some((a) => a.key === control);
  for (let i = 0; i < draws; i++) {
    let top = null;
    let topValue = -1;
    const sample = {};
    for (const a of live) {
      const value = beta(priorA + a.buyers, priorB + Math.max(0, a.units - a.buyers), rng);
      sample[a.key] = value;
      if (value > topValue) {
        topValue = value;
        top = a.key;
      }
    }
    best[top]++;
    if (hasControl) {
      for (const a of live) if (a.key !== control && sample[a.key] > sample[control]) wins[a.key]++;
    }
  }
  for (const a of live) {
    result[a.key] = {
      beatsControl: hasControl && a.key !== control ? wins[a.key] / draws : null,
      best: best[a.key] / draws,
    };
  }
  return result;
}
