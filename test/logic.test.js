import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../lib/logic.js';
import { PostHog } from '../lib/posthog.js';

const flag = {
  id: 1,
  key: 'price-test',
  active: true,
  version: 2,
  updated_at: '2026-10-22T20:31:45Z',
  filters: {
    groups: [{ variant: null, properties: [], rollout_percentage: 100 }],
    multivariate: {
      variants: [
        { key: 'usd_0_99', name: '$0.99', rollout_percentage: 100 },
        { key: 'usd_1_99', name: '$1.99', rollout_percentage: 0 },
      ],
    },
  },
};

test('control is "control" when present, otherwise the first variant', () => {
  assert.equal(L.controlKey(flag.filters.multivariate.variants), 'usd_0_99');
  assert.equal(L.controlKey([{ key: 'a' }, { key: 'control' }]), 'control');
  assert.equal(L.controlKey([]), null);
});

test('split must be whole numbers adding up to 100', () => {
  assert.equal(L.validateSplit({ a: 50, b: 50 }).ok, true);
  assert.deepEqual(L.validateSplit({ a: 60, b: 50 }).sum, 110);
  assert.equal(L.validateSplit({ a: 60, b: 50 }).ok, false);
  assert.equal(L.validateSplit({ a: 50.5, b: 49.5 }).ok, false);
  assert.equal(L.validateSplit({ a: Number.NaN, b: 100 }).ok, false);
  assert.equal(L.validateSplit({ a: -10, b: 110 }).ok, false);
});

test('even and winner splits', () => {
  const three = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.deepEqual(L.evenSplit(three), { a: 34, b: 33, c: 33 });
  assert.deepEqual(L.winnerSplit(three, 'b'), { a: 0, b: 100, c: 0 });
});

test('applyEdits changes only percentages and leaves the original untouched', () => {
  const next = L.applyEdits(flag.filters, { split: { usd_0_99: 50, usd_1_99: 50 }, rollouts: [30] });
  assert.equal(next.multivariate.variants[0].rollout_percentage, 50);
  assert.equal(next.multivariate.variants[1].name, '$1.99');
  assert.equal(next.groups[0].rollout_percentage, 30);
  assert.equal(flag.filters.multivariate.variants[0].rollout_percentage, 100);
  assert.equal(flag.filters.groups[0].rollout_percentage, 100);
});

test('diff lists exactly what changes', () => {
  const next = L.applyEdits(flag.filters, { split: { usd_0_99: 50, usd_1_99: 50 }, rollouts: [100] });
  assert.deepEqual(L.diffFilters(flag.filters, next), [
    { kind: 'variant', label: 'Вариант usd_0_99', before: 100, after: 50 },
    { kind: 'variant', label: 'Вариант usd_1_99', before: 0, after: 50 },
  ]);
  assert.deepEqual(L.diffFilters(flag.filters, structuredClone(flag.filters)), []);
});

test('warnings mention cached variants and a running experiment', () => {
  const rows = L.diffFilters(flag.filters, L.applyEdits(flag.filters, { split: { usd_0_99: 0, usd_1_99: 100 } }));
  const text = L.changeWarnings(flag, rows, { runningExperiment: 'Price test' }).join('\n');
  assert.match(text, /usd_1_99/);
  assert.match(text, /запоминает вариант/);
  assert.match(text, /Price test/);
});

test('HogQL strings are escaped', () => {
  assert.equal(L.hogqlString("a'b\\c"), "'a\\'b\\\\c'");
  const sql = L.buildResultsQuery({ variantProp: "x') OR 1=1 --", purchaseEvents: ["e'1"] });
  assert.ok(sql.includes("properties['x\\') OR 1=1 --']"));
  assert.ok(sql.includes("'e\\'1'"));
  assert.ok(sql.includes('{filters}'));
});

test('results query uses the device id when given and sessions otherwise', () => {
  const withDevice = L.buildResultsQuery({ variantProp: 'v', unitProp: 'install_id', purchaseEvents: ['p'] });
  assert.match(withDevice, /concat\('device:'/);
  const sessions = L.buildResultsQuery({ variantProp: 'v', purchaseEvents: ['p'] });
  assert.doesNotMatch(sessions, /concat\('device:'/);
  assert.match(sessions, /concat\('session:', distinct_id\) AS unit/);
  assert.throws(() => L.buildResultsQuery({ variantProp: '' }));
});

test('picks the app property over the SDK $feature value', () => {
  const candidates = [
    { property: '$feature/price-test', events: 900, sample_values: ['usd_0_99', 'usd_1_99'] },
    { property: 'price_variant', events: 120, sample_values: ['usd_0_99', 'usd_1_99'] },
    { property: 'variant_source', events: 110, sample_values: ['fallback', 'flag', 'cached'] },
  ];
  assert.equal(L.pickVariantProperty(candidates, flag), 'price_variant');
  assert.equal(L.pickVariantProperty([], flag), '$feature/price-test');
});

test('shapes query rows in flag order with conversion', () => {
  const response = {
    columns: ['variant_key', 'units', 'device_units', 'approx_devices', 'buyers', 'purchases', 'revenue_usd', 'buyers_0'],
    results: [
      ['usd_1_99', 6, 0, 5, 0, 0, null, 0],
      ['usd_0_99', 120, 0, 80, 5, 5, 5.5, 5],
      ['__mixed__', 2, 0, 2, 0, 0, null, 0],
    ],
  };
  const { variants, mixedUnits } = L.shapeResults(L.rowsFromQuery(response), flag, ['pass_purchased']);
  assert.deepEqual(variants.map((v) => v.key), ['usd_0_99', 'usd_1_99']);
  assert.equal(variants[0].conversion, 5 / 120);
  assert.equal(variants[1].revenue, 0);
  assert.deepEqual(variants[0].perEvent, [{ event: 'pass_purchased', buyers: 5 }]);
  assert.equal(mixedUnits, 2);
});

test('win probability favours the clearly better arm and is ~50% for equal arms', () => {
  const rng = L.mulberry32(42);
  const clear = L.winProbabilities(
    [{ key: 'a', units: 1000, buyers: 50 }, { key: 'b', units: 1000, buyers: 80 }], 'a', { draws: 20000, rng });
  assert.ok(clear.b.beatsControl > 0.99, `got ${clear.b.beatsControl}`);
  assert.equal(clear.a.beatsControl, null);
  const even = L.winProbabilities(
    [{ key: 'a', units: 500, buyers: 25 }, { key: 'b', units: 500, buyers: 25 }], 'a', { draws: 20000, rng });
  assert.ok(Math.abs(even.b.beatsControl - 0.5) < 0.03, `got ${even.b.beatsControl}`);
  const empty = L.winProbabilities([{ key: 'a', units: 10, buyers: 1 }, { key: 'b', units: 0, buyers: 0 }], 'a');
  assert.equal(empty.b.beatsControl, null);
});

test('a tiny arm with no buyers does not look like a winner at low conversion', () => {
  // Control 4/120 vs a new arm 0/5: a flat Beta(1,1) prior calls the empty arm ~78% better.
  const p = L.winProbabilities(
    [{ key: 'usd_0_99', units: 120, buyers: 4 }, { key: 'usd_1_99', units: 5, buyers: 0 }], 'usd_0_99',
    { draws: 20000, rng: L.mulberry32(7) });
  assert.ok(p.usd_1_99.beatsControl < 0.5, `got ${p.usd_1_99.beatsControl}`);
});

test('no buyers anywhere gives about even odds, not an error', () => {
  const p = L.winProbabilities(
    [{ key: 'a', units: 50, buyers: 0 }, { key: 'b', units: 50, buyers: 0 }], 'a', { draws: 20000, rng: L.mulberry32(3) });
  assert.ok(Math.abs(p.b.beatsControl - 0.5) < 0.05, `got ${p.b.beatsControl}`);
});

// ---------- Client write guard ----------

function fakeFetch(flagOnServer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const body = init.method === 'PATCH' ? { ...flagOnServer, filters: JSON.parse(init.body).filters } : flagOnServer;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

test('PATCH goes out only when the flag is still the reviewed version', async () => {
  const next = L.applyEdits(flag.filters, { split: { usd_0_99: 50, usd_1_99: 50 } });

  const same = fakeFetch(flag);
  const client = new PostHog({ apiKey: 'test', fetchImpl: same.fetchImpl });
  const saved = await client.updateFlagFilters(42, 1, next, flag);
  assert.deepEqual(same.calls.map((c) => c.method), ['GET', 'PATCH']);
  assert.equal(saved.filters.multivariate.variants[0].rollout_percentage, 50);
  assert.deepEqual(JSON.parse(same.calls[1].body).version, 2);
  assert.deepEqual(Object.keys(JSON.parse(same.calls[1].body)).sort(), ['filters', 'version']);

  const changed = fakeFetch({ ...flag, version: 3 });
  const client2 = new PostHog({ apiKey: 'test', fetchImpl: changed.fetchImpl });
  await assert.rejects(client2.updateFlagFilters(42, 1, next, flag), /изменили/);
  assert.deepEqual(changed.calls.map((c) => c.method), ['GET']);
});

test('client refuses unknown hosts, so the key cannot be sent elsewhere', () => {
  assert.throws(() => new PostHog({ apiKey: 'k', host: 'https://evil.example' }));
  assert.throws(() => new PostHog({ host: 'https://eu.posthog.com' }));
});
