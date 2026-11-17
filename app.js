import { PostHog, HOSTS } from './lib/posthog.js';
import * as L from './lib/logic.js';

// ---------- Storage (this browser only; every access may throw in private mode) ----------

const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem('ph.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('ph.' + key, JSON.stringify(value));
    } catch {
      /* storage unavailable: the value lives until reload */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem('ph.' + key);
    } catch {
      /* ignore */
    }
  },
};

// ---------- DOM helper: text always goes in as text, never as HTML ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const app = document.getElementById('app');
const projectSelect = document.getElementById('project');
const dialog = document.getElementById('confirm');

function show(...nodes) {
  app.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}

function errorBox(error) {
  return h('p', { class: 'error' }, error?.message ?? String(error));
}

const pct = (x) => (x === null || x === undefined ? '100% (по умолчанию)' : `${x}%`);
const fmtPct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const fmtUsd = (x) => `$${x.toFixed(2)}`;
const today = () => new Date().toISOString().slice(0, 10);

// ---------- State ----------

const state = {
  client: null,
  keySource: null, // 'browser' | 'env'
  projects: [],
  flags: new Map(), // projectId -> flags
  experiments: new Map(), // projectId -> experiments
};

async function loadKey() {
  const saved = store.get('key');
  if (saved) return { apiKey: saved, host: store.get('host', HOSTS.eu), source: 'browser' };
  // Local run (`node dev/serve.mjs`) hands over the key from .env; on a static host this is a 404.
  try {
    const response = await fetch('local-config.json', { cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      if (config.apiKey) return { apiKey: config.apiKey, host: config.host || HOSTS.eu, source: 'env' };
    }
  } catch {
    /* no local server */
  }
  return null;
}

let connecting = null; // one key lookup at a time, even when two routes start together

function connect() {
  connecting ??= (async () => {
    const key = await loadKey();
    if (!key) {
      state.client = null;
      return false;
    }
    state.client = new PostHog({ host: key.host, apiKey: key.apiKey });
    state.keySource = key.source;
    return true;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function ensureProjects() {
  if (state.projects.length) return state.projects;
  state.projects = await state.client.listProjects();
  renderProjectSelect();
  return state.projects;
}

function renderProjectSelect(current) {
  if (!state.projects.length) {
    projectSelect.hidden = true;
    return;
  }
  projectSelect.replaceChildren(
    ...state.projects.map((p) =>
      h('option', { value: String(p.id) }, `${p.name} · ${p.orgName} (${p.id})`),
    ),
  );
  if (current) projectSelect.value = String(current);
  projectSelect.hidden = false;
}

projectSelect.addEventListener('change', () => {
  location.hash = `#/p/${projectSelect.value}`;
});

async function flagsOf(projectId, { reload = false } = {}) {
  if (reload || !state.flags.has(projectId)) {
    const [flags, experiments] = await Promise.all([
      state.client.listFlags(projectId),
      state.client.listExperiments(projectId).catch(() => []),
    ]);
    state.flags.set(projectId, flags.filter((f) => !f.deleted));
    state.experiments.set(projectId, experiments);
  }
  return state.flags.get(projectId);
}

function experimentFor(projectId, flag) {
  return (state.experiments.get(projectId) ?? []).find(
    (e) => e.feature_flag_key === flag.key || e.feature_flag?.id === flag.id,
  );
}

function experimentStatus(e) {
  if (!e.start_date) return 'черновик';
  if (e.end_date) return 'завершён';
  return 'идёт';
}

// ---------- Routing ----------

async function route() {
  if (dialog.open) dialog.close(); // a confirmation never outlives the page it was opened on
  if (!state.client && location.hash !== '#/settings') {
    if (!(await connect())) return renderSettings();
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'settings') return renderSettings();
    await ensureProjects();
    if (parts[0] === 'p' && parts[1] && parts[2] === 'f' && parts[3]) {
      return await renderFlag(Number(parts[1]), Number(parts[3]));
    }
    if (parts[0] === 'p' && parts[1]) return await renderProject(Number(parts[1]));
    const last = store.get('project');
    const target = state.projects.find((p) => p.id === last) ?? state.projects[0];
    if (target) location.replace(`#/p/${target.id}`);
    else show(h('p', {}, 'Ключ не видит ни одного проекта.'));
  } catch (error) {
    show(h('h1', {}, 'Не получилось'), errorBox(error), h('p', {}, h('a', { href: '#/settings' }, 'Проверить ключ')));
  }
}

window.addEventListener('hashchange', route);

// ---------- Settings ----------

function renderSettings() {
  const keyInput = h('input', {
    type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: state.keySource === 'browser' ? 'сохранён — вставьте новый, чтобы заменить' : 'phx_…',
  });
  const hostSelect = h('select', {},
    h('option', { value: HOSTS.eu }, 'EU — eu.posthog.com'),
    h('option', { value: HOSTS.us }, 'US — us.posthog.com'),
  );
  hostSelect.value = store.get('host', HOSTS.eu);
  const status = h('p', { class: 'small' });

  async function save() {
    const apiKey = keyInput.value.trim();
    if (!apiKey && state.keySource !== 'browser') {
      status.className = 'error';
      status.textContent = 'Вставьте ключ.';
      return;
    }
    const candidate = new PostHog({ host: hostSelect.value, apiKey: apiKey || store.get('key') });
    status.className = 'small muted';
    status.textContent = 'Проверяю ключ…';
    try {
      const projects = await candidate.listProjects();
      store.set('key', candidate.apiKey);
      store.set('host', candidate.host);
      state.client = candidate;
      state.keySource = 'browser';
      state.projects = projects;
      state.flags.clear();
      renderProjectSelect();
      keyInput.value = '';
      status.className = 'ok';
      status.textContent = `Готово: проектов — ${projects.length}.`;
      setTimeout(() => (location.hash = '#/'), 600);
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
    }
  }

  function forget() {
    store.remove('key');
    state.client = null;
    state.keySource = null;
    state.projects = [];
    state.flags.clear();
    projectSelect.hidden = true;
    renderSettings();
  }

  show(
    h('h1', {}, 'Ключ PostHog'),
    state.keySource === 'env'
      ? h('p', { class: 'ok small' }, 'Сейчас используется ключ из .env (локальный запуск). Здесь можно сохранить ключ для этого браузера.')
      : null,
    h('p', { class: 'small muted' },
      'Нужен Personal API key: PostHog → Settings → Personal API keys. Права: feature_flag (read, write), ',
      'experiment (read), query (read), project (read), organization (read). Лучше ограничить ключ нужными проектами.'),
    h('p', { class: 'small muted' },
      'Ключ хранится только в этом браузере (localStorage) и уходит только на выбранный адрес PostHog.'),
    h('label', {}, 'Personal API key'), keyInput,
    h('label', {}, 'Регион'), hostSelect,
    h('div', { class: 'buttons' },
      h('button', { class: 'primary', onclick: save }, 'Сохранить'),
      state.keySource === 'browser' ? h('button', { class: 'danger', onclick: forget }, 'Забыть ключ') : null,
      state.client ? h('button', { onclick: () => (location.hash = '#/') }, 'Назад') : null,
    ),
    status,
  );
}

// ---------- Project: flags and experiments ----------

function variantMeters(flag) {
  const variants = L.variantsOf(flag.filters);
  if (!variants.length) return null;
  return variants.map((v) =>
    h('div', { class: 'variant-line' },
      h('span', { class: 'mono' }, v.key, v.name && v.name !== v.key ? h('span', { class: 'muted' }, ` · ${v.name}`) : null),
      h('span', { class: 'num' }, `${v.rollout_percentage}%`),
      h('div', { class: 'meter' }, h('span', { style: { width: `${v.rollout_percentage}%` } })),
    ),
  );
}

function rolloutSummary(flag) {
  const groups = L.groupsOf(flag.filters);
  if (!groups.length) return 'нет условий';
  return groups
    .map((g) => `${pct(g.rollout_percentage)} · ${(g.properties ?? []).length ? `${g.properties.length} услов.` : 'все'}`)
    .join('; ');
}

async function renderProject(projectId) {
  store.set('project', projectId);
  renderProjectSelect(projectId);
  show(h('p', { class: 'muted' }, 'Загружаю флаги…'));
  const flags = await flagsOf(projectId, { reload: true });
  const project = state.projects.find((p) => p.id === projectId);
  const experiments = state.experiments.get(projectId) ?? [];
  const multivariate = flags.filter((f) => L.variantsOf(f.filters).length);
  const other = flags.filter((f) => !L.variantsOf(f.filters).length);

  const flagCard = (flag) => {
    const experiment = experimentFor(projectId, flag);
    return h('a', { class: 'card', href: `#/p/${projectId}/f/${flag.id}` },
      h('div', { class: 'row spread' },
        h('strong', { class: 'mono' }, flag.key),
        h('span', { class: `chip ${flag.active ? 'on' : 'off'}` }, flag.active ? 'включён' : 'выключен'),
      ),
      flag.name ? h('p', { class: 'small muted' }, flag.name) : null,
      experiment ? h('p', { class: 'small' }, `Эксперимент: ${experiment.name} (${experimentStatus(experiment)})`) : null,
      variantMeters(flag),
      h('p', { class: 'small muted' }, `Раскатка: ${rolloutSummary(flag)}`),
    );
  };

  show(
    h('h1', {}, project ? project.name : `Проект ${projectId}`),
    h('p', { class: 'small muted' }, project ? `${project.orgName} · id ${projectId}` : null),
    h('h2', {}, `Тесты (флаги с вариантами) — ${multivariate.length}`),
    multivariate.length ? multivariate.map(flagCard) : h('p', { class: 'muted' }, 'Нет флагов с вариантами.'),
    other.length ? [h('h2', {}, `Остальные флаги — ${other.length}`), other.map(flagCard)] : null,
    h('h2', {}, `Эксперименты PostHog — ${experiments.length}`),
    experiments.length
      ? experiments.map((e) =>
          h('a', { class: 'card', href: state.client.appUrl(projectId, `/experiments/${e.id}`), target: '_blank', rel: 'noopener' },
            h('div', { class: 'row spread' }, h('strong', {}, e.name), h('span', { class: 'chip' }, experimentStatus(e))),
            h('p', { class: 'small muted mono' }, e.feature_flag_key ?? ''),
          ))
      : h('p', { class: 'muted small' }, 'В разделе Experiments пусто. Тесты выше — это просто флаги с вариантами.'),
  );
}

// ---------- Flag: split editor ----------

async function renderFlag(projectId, flagId) {
  store.set('project', projectId);
  renderProjectSelect(projectId);
  show(h('p', { class: 'muted' }, 'Загружаю флаг…'));
  await flagsOf(projectId);
  const flag = await state.client.getFlag(projectId, flagId);
  const experiment = experimentFor(projectId, flag);
  const variants = L.variantsOf(flag.filters);
  const groups = L.groupsOf(flag.filters);
  const control = L.controlKey(variants);

  let split = L.currentSplit(flag.filters);
  let rollouts = L.currentRollouts(flag.filters);

  const sumLine = h('p', { class: 'sum' });
  const reviewButton = h('button', { class: 'primary' }, 'Проверить изменения…');
  const splitInputs = new Map();
  const rolloutInputs = [];

  function refresh() {
    for (const [key, { number, range }] of splitInputs) {
      number.value = split[key];
      range.value = split[key];
    }
    rolloutInputs.forEach((input, i) => {
      if (input) input.value = rollouts[i] ?? 100;
    });
    const check = L.validateSplit(split);
    const rolloutCheck = L.validateRollouts(rollouts);
    sumLine.textContent = variants.length ? `Сумма: ${check.sum}%` : '';
    sumLine.className = `sum ${check.ok ? '' : 'bad'}`;
    const changed = L.diffFilters(flag.filters, L.applyEdits(flag.filters, { split, rollouts })).length > 0;
    reviewButton.disabled = !changed || !check.ok || !rolloutCheck.ok;
  }

  const splitRows = variants.map((v) => {
    const number = h('input', { type: 'number', min: '0', max: '100', step: '1', inputmode: 'numeric', 'aria-label': `Доля ${v.key}` });
    const range = h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': `Доля ${v.key}` });
    const set = (value) => {
      split = { ...split, [v.key]: Number.parseInt(value, 10) };
      refresh();
    };
    number.addEventListener('input', () => set(number.value));
    range.addEventListener('input', () => set(range.value));
    splitInputs.set(v.key, { number, range });
    return h('div', { class: 'split-row' },
      h('span', {},
        h('span', { class: 'mono' }, v.key),
        v.key === control ? h('span', { class: 'chip' }, 'контроль') : null,
        v.name && v.name !== v.key ? h('span', { class: 'muted small' }, ` ${v.name}`) : null,
      ),
      number,
      h('button', { onclick: () => { split = L.winnerSplit(variants, v.key); refresh(); }, title: `Отдать ${v.key} 100%` }, '100%'),
      range,
    );
  });

  const groupRows = groups.map((g, i) => {
    if (g.rollout_percentage === null || g.rollout_percentage === undefined) {
      rolloutInputs.push(null);
      return h('div', { class: 'split-row' }, h('span', {}, `Условие ${i + 1}: ${(g.properties ?? []).length ? `${g.properties.length} услов.` : 'все пользователи'}`), h('span', { class: 'muted' }, '100%'), h('span'));
    }
    const number = h('input', { type: 'number', min: '0', max: '100', step: '1', inputmode: 'numeric', 'aria-label': `Раскатка условия ${i + 1}` });
    number.addEventListener('input', () => {
      rollouts = rollouts.map((r, j) => (j === i ? Number.parseInt(number.value, 10) : r));
      refresh();
    });
    rolloutInputs.push(number);
    return h('div', { class: 'split-row' },
      h('span', {}, `Условие ${i + 1}: ${(g.properties ?? []).length ? `${g.properties.length} услов.` : 'все пользователи'}`),
      number, h('span', { class: 'muted' }, '%'),
    );
  });

  reviewButton.addEventListener('click', () => openConfirm(projectId, flag, { split, rollouts }, experiment));

  show(
    h('p', { class: 'small' }, h('a', { href: `#/p/${projectId}` }, '← Все флаги')),
    h('h1', { class: 'mono' }, flag.key),
    h('div', { class: 'row' },
      h('span', { class: `chip ${flag.active ? 'on' : 'off'}` }, flag.active ? 'включён' : 'выключен'),
      h('span', { class: 'small muted' }, `изменён ${new Date(flag.updated_at).toLocaleString('ru-RU')}`),
    ),
    flag.name ? h('p', { class: 'muted' }, flag.name) : null,
    experiment ? h('p', { class: 'small' }, `Эксперимент PostHog: ${experiment.name} (${experimentStatus(experiment)})`) : null,
    h('p', { class: 'small' }, h('a', { href: state.client.appUrl(projectId, `/feature-flags/${flag.id}`), target: '_blank', rel: 'noopener' }, 'Открыть в PostHog ↗')),

    variants.length
      ? h('section', { class: 'card' },
          h('h2', { style: { marginTop: '0' } }, 'Доли вариантов'),
          splitRows,
          sumLine,
          h('div', { class: 'buttons' },
            h('button', { onclick: () => { split = L.evenSplit(variants); refresh(); } }, 'Поровну'),
            h('button', { onclick: () => { split = L.winnerSplit(variants, control); refresh(); } }, `Стоп: ${control} 100%`),
            h('button', { onclick: () => { split = L.currentSplit(flag.filters); rollouts = L.currentRollouts(flag.filters); refresh(); } }, 'Сбросить'),
          ),
        )
      : null,
    groups.length
      ? h('section', { class: 'card' },
          h('h2', { style: { marginTop: '0' } }, 'Раскатка (условия выпуска)'),
          groupRows,
        )
      : null,
    h('div', { class: 'buttons' }, reviewButton),
    variants.length ? resultsSection(projectId, flag) : h('p', { class: 'muted small' }, 'Результаты считаются только для флагов с вариантами.'),
  );
  refresh();
}

// ---------- Confirmation: the only path that writes to PostHog ----------

function openConfirm(projectId, flag, edits, experiment) {
  const next = L.applyEdits(flag.filters, edits);
  const rows = L.diffFilters(flag.filters, next);
  if (!rows.length) return;
  const warnings = L.changeWarnings(flag, rows, {
    runningExperiment: experiment && experimentStatus(experiment) === 'идёт' ? experiment.name : null,
  });
  const typed = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: flag.key, 'aria-label': 'Ключ флага для подтверждения' });
  const apply = h('button', { class: 'primary', disabled: true }, 'Применить');
  const cancel = h('button', { onclick: () => dialog.close() }, 'Отмена');
  const status = h('p', { class: 'small' });

  typed.addEventListener('input', () => {
    apply.disabled = typed.value.trim() !== flag.key;
  });

  apply.addEventListener('click', async () => {
    if (typed.value.trim() !== flag.key) return; // never write without the typed key
    apply.disabled = true;
    cancel.disabled = true;
    status.className = 'small muted';
    status.textContent = 'Сохраняю…';
    try {
      const saved = await state.client.updateFlagFilters(projectId, flag.id, next, flag);
      const check = L.diffFilters(next, saved.filters);
      state.flags.delete(projectId);
      dialog.close();
      await renderFlag(projectId, flag.id);
      app.prepend(
        h('p', { class: check.length ? 'error' : 'ok' },
          check.length
            ? 'PostHog сохранил не то, что ожидалось — проверьте флаг.'
            : `Сохранено: ${rows.map((r) => `${r.label} ${pct(r.after)}`).join(', ')}.`),
      );
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
      cancel.disabled = false;
      if (error.status === 409) {
        // The flag changed under us: this dialog's diff is stale, so it must not be retried.
        typed.disabled = true;
        apply.remove();
        status.after(h('div', { class: 'buttons' }, h('button', {
          class: 'primary',
          onclick: async () => {
            dialog.close();
            state.flags.delete(projectId);
            await renderFlag(projectId, flag.id);
          },
        }, 'Загрузить флаг заново')));
      }
    }
  });

  dialog.replaceChildren(
    h('h2', { style: { marginTop: '0' } }, 'Что изменится'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, 'Было'), h('th'), h('th', { class: 'num' }, 'Станет'))),
      h('tbody', {}, rows.map((r) =>
        h('tr', {},
          h('td', {}, r.label),
          h('td', { class: 'num' }, pct(r.before)),
          h('td', { class: 'arrow' }, '→'),
          h('td', { class: 'num' }, h('strong', {}, pct(r.after))),
        ))),
    ),
    h('div', { class: 'warn' }, h('ul', {}, warnings.map((w) => h('li', {}, w)))),
    h('label', {}, 'Чтобы применить, введите ключ флага: ', h('code', {}, flag.key)),
    typed,
    h('div', { class: 'buttons' }, apply, cancel),
    status,
  );
  dialog.showModal();
  typed.focus();
}

// ---------- Results ----------

function projectSettings(projectId) {
  return store.get(`project.${projectId}`, {
    purchaseEvents: null, // detected on first run
    priceProp: 'price',
    currencyProp: 'currency',
    unitProp: 'install_id',
    excludeTestflight: true,
    filterTestAccounts: true,
  });
}

function flagSettings(projectId, flagId) {
  return store.get(`flag.${projectId}.${flagId}`, { variantProp: null, exclude: '', from: null, to: null });
}

function resultsSection(projectId, flag) {
  const ps = projectSettings(projectId);
  const fs = flagSettings(projectId, flag.id);
  const created = flag.created_at.slice(0, 10);
  const updated = flag.updated_at.slice(0, 10);

  const from = h('input', { type: 'date', value: fs.from ?? created, max: today() });
  const to = h('input', { type: 'date', value: fs.to ?? '', max: today() });
  const variantProp = h('input', { type: 'text', value: fs.variantProp ?? '', placeholder: 'определится само', autocapitalize: 'off', spellcheck: 'false' });
  const candidates = h('p', { class: 'small muted' });
  const exclude = h('input', { type: 'text', value: fs.exclude ?? '', placeholder: 'например variant_source=fallback', autocapitalize: 'off', spellcheck: 'false' });
  const purchaseEvents = h('input', { type: 'text', value: (ps.purchaseEvents ?? []).join(', '), placeholder: 'определятся сами', autocapitalize: 'off', spellcheck: 'false' });
  const priceProp = h('input', { type: 'text', value: ps.priceProp, autocapitalize: 'off', spellcheck: 'false' });
  const currencyProp = h('input', { type: 'text', value: ps.currencyProp, autocapitalize: 'off', spellcheck: 'false' });
  const unitProp = h('input', { type: 'text', value: ps.unitProp, autocapitalize: 'off', spellcheck: 'false' });
  const excludeTestflight = h('input', { type: 'checkbox', checked: ps.excludeTestflight });
  const filterTestAccounts = h('input', { type: 'checkbox', checked: ps.filterTestAccounts });
  const output = h('div');
  const run = h('button', { class: 'primary' }, 'Посчитать');

  function saveSettings() {
    const events = purchaseEvents.value.split(',').map((s) => s.trim()).filter(Boolean);
    store.set(`project.${projectId}`, {
      purchaseEvents: events.length ? events : null,
      priceProp: priceProp.value.trim() || 'price',
      currencyProp: currencyProp.value.trim() || 'currency',
      unitProp: unitProp.value.trim(),
      excludeTestflight: excludeTestflight.checked,
      filterTestAccounts: filterTestAccounts.checked,
    });
    store.set(`flag.${projectId}.${flag.id}`, {
      variantProp: variantProp.value.trim() || null,
      exclude: exclude.value.trim(),
      from: from.value || null,
      to: to.value || null,
    });
  }

  async function compute() {
    run.disabled = true;
    output.replaceChildren(h('p', { class: 'muted' }, 'Считаю…'));
    try {
      if (!variantProp.value.trim()) {
        const response = await state.client.query(projectId, L.buildCandidatesQuery(flag.key));
        const found = L.rowsFromQuery(response);
        variantProp.value = L.pickVariantProperty(found, flag);
        candidates.textContent = found.length
          ? `Нашлись свойства: ${found.map((c) => `${c.property} (${c.events})`).join(', ')}`
          : '';
      }
      if (!purchaseEvents.value.trim()) {
        const response = await state.client.query(projectId, L.buildPurchaseEventsQuery());
        purchaseEvents.value = L.rowsFromQuery(response).map((r) => r.event).join(', ');
      }
      saveSettings();
      const events = purchaseEvents.value.split(',').map((s) => s.trim()).filter(Boolean);
      const [exProp, ...exValue] = exclude.value.split('=');
      const sql = L.buildResultsQuery({
        variantProp: variantProp.value.trim(),
        unitProp: unitProp.value.trim(),
        purchaseEvents: events,
        priceProp: priceProp.value.trim() || 'price',
        currencyProp: currencyProp.value.trim() || 'currency',
        excludeTestflight: excludeTestflight.checked,
        exclude: exProp?.trim() ? { prop: exProp.trim(), value: exValue.join('=').trim() } : null,
      });
      const response = await state.client.query(projectId, sql, {
        dateRange: { date_from: from.value || created, date_to: to.value || null },
        filterTestAccounts: filterTestAccounts.checked,
      });
      const shaped = L.shapeResults(L.rowsFromQuery(response), flag, events);
      output.replaceChildren(renderResults(flag, shaped, events, variantProp.value.trim()));
    } catch (error) {
      output.replaceChildren(errorBox(error));
    } finally {
      run.disabled = false;
    }
  }

  run.addEventListener('click', compute);

  return h('section', { class: 'card' },
    h('h2', { style: { marginTop: '0' } }, 'Результаты по вариантам'),
    h('div', { class: 'row' },
      h('div', { style: { flex: '1 1 140px' } }, h('label', {}, 'С'), from),
      h('div', { style: { flex: '1 1 140px' } }, h('label', {}, 'По (пусто = сегодня)'), to),
    ),
    updated !== created
      ? h('p', { class: 'small' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); from.value = updated; } }, `С последнего изменения флага (${updated})`))
      : null,
    h('details', {},
      h('summary', {}, 'Настройки подсчёта'),
      h('label', {}, 'Свойство события с вариантом'), variantProp, candidates,
      h('label', {}, 'Не считать события, где (свойство=значение)'), exclude,
      h('label', {}, 'События покупки (через запятую)'), purchaseEvents,
      h('label', {}, 'Свойство с ценой'), priceProp,
      h('label', {}, 'Свойство с валютой'), currencyProp,
      h('label', {}, 'Свойство с ID устройства (если есть — считаем устройства, иначе сессии)'), unitProp,
      h('label', { class: 'inline' }, excludeTestflight, 'Без TestFlight и симулятора'),
      h('label', { class: 'inline' }, filterTestAccounts, 'Без тестовых аккаунтов (фильтр проекта)'),
    ),
    h('div', { class: 'buttons' }, run),
    output,
  );
}

function renderResults(flag, { variants, mixedUnits }, events, variantProp) {
  const control = L.controlKey(L.variantsOf(flag.filters));
  const totalUnits = variants.reduce((a, v) => a + v.units, 0);
  const deviceUnits = variants.reduce((a, v) => a + v.deviceUnits, 0);
  const totalBuyers = variants.reduce((a, v) => a + v.buyers, 0);
  const unitName = deviceUnits === 0 ? 'Сессии' : deviceUnits === totalUnits ? 'Устройства' : 'Устройства и сессии';
  const probabilities = L.winProbabilities(
    variants.filter((v) => v.known).map((v) => ({ key: v.key, units: v.units, buyers: v.buyers })),
    control,
  );

  if (!totalUnits) {
    return h('p', { class: 'muted' }, `За этот период нет событий со свойством ${variantProp}.`);
  }

  const notes = [];
  if (deviceUnits === 0) {
    notes.push('Сессия — это один distinct_id. Если приложение меняет ID каждую сессию, одно устройство считается несколько раз. «≈ устройств» — оценка по модели, версии ОС и стране.');
  } else if (deviceUnits < totalUnits) {
    notes.push(`${totalUnits - deviceUnits} из ${totalUnits} без ID устройства (старые версии) посчитаны как сессии.`);
  }
  if (mixedUnits) notes.push(`${mixedUnits} ${unitName.toLowerCase()} видели два варианта — их нет в таблице.`);
  if (totalBuyers < 30) notes.push(`Покупателей всего ${totalBuyers}: вероятность победы пока ненадёжна.`);
  if (variantProp.startsWith('$feature/')) {
    notes.push(`${variantProp} — значение флага в момент события. Если приложение запоминает вариант на устройстве, после смены долей эти значения расходятся с тем, что видит пользователь.`);
  }

  return h('div', {},
    variants.map((v) => {
      const p = probabilities[v.key] ?? {};
      return h('div', { class: 'card' },
        h('div', { class: 'row spread' },
          h('strong', { class: 'mono' }, v.key),
          v.key === control ? h('span', { class: 'chip' }, 'контроль') : null,
          !v.known ? h('span', { class: 'chip off' }, 'нет во флаге') : null,
        ),
        h('div', { class: 'stats' },
          stat(unitName, v.units),
          deviceUnits < totalUnits ? stat('≈ устройств', v.approxDevices) : null,
          stat('Купили', `${v.buyers}`),
          stat('Конверсия', fmtPct(v.conversion, 2)),
          stat('Выручка', fmtUsd(v.revenue)),
          stat(`На ${unitName === 'Сессии' ? 'сессию' : 'устройство'}`, fmtUsd(v.revenuePerUnit)),
          p.beatsControl !== null && p.beatsControl !== undefined ? stat('Лучше контроля', fmtPct(p.beatsControl, 0)) : null,
          p.best !== null && p.best !== undefined ? stat('Лучший вариант', fmtPct(p.best, 0)) : null,
        ),
        events.length > 1
          ? h('p', { class: 'small muted' }, v.perEvent.map((e) => `${e.event}: ${e.buyers}`).join(' · '))
          : null,
      );
    }),
    notes.length ? h('div', { class: 'warn small' }, h('ul', {}, notes.map((n) => h('li', {}, n)))) : null,
    h('p', { class: 'small muted' },
      'Выручка — сумма цен покупок в USD по курсу дня покупки. ',
      `Вероятности — байесовская оценка конверсии: у всех вариантов общий априор, средняя конверсия с весом ${L.PRIOR_WEIGHT} ${unitName === 'Сессии' ? 'сессий' : 'единиц'}.`),
  );
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));
}

route();
