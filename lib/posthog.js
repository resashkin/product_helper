// PostHog private API client. Runs in the browser and in Node 18+ (global fetch).
// The key is sent only to `host`, as a bearer token. Nothing here logs it.

export const HOSTS = {
  eu: 'https://eu.posthog.com',
  us: 'https://us.posthog.com',
};

export class PostHogError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export class PostHog {
  constructor({ host = HOSTS.eu, apiKey, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    if (!apiKey) throw new Error('Нет ключа API PostHog');
    if (!Object.values(HOSTS).includes(host)) throw new Error(`Неизвестный адрес PostHog: ${host}`);
    this.host = host;
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const response = await this.fetch(this.host + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { detail: text.slice(0, 300) };
    }
    if (!response.ok) {
      const detail = data?.detail ?? data?.error ?? response.statusText;
      const hint =
        response.status === 401
          ? 'Ключ не подошёл'
          : response.status === 403
            ? 'У ключа нет нужного права'
            : `PostHog ответил ${response.status}`;
      throw new PostHogError(response.status, `${hint}: ${detail}`, data);
    }
    return data;
  }

  get(path) {
    return this.request('GET', path);
  }

  async getAll(path) {
    const items = [];
    let next = path;
    for (let page = 0; next && page < 20; page++) {
      const data = await this.get(next);
      items.push(...(data.results ?? []));
      next = data.next ? new URL(data.next).pathname + new URL(data.next).search : null;
    }
    return items;
  }

  /** Every project the key can see, across organizations. */
  async listProjects() {
    const orgs = await this.getAll('/api/organizations/');
    const projects = [];
    for (const org of orgs) {
      const list = await this.getAll(`/api/organizations/${org.id}/projects/`);
      for (const p of list) projects.push({ id: p.id, name: p.name, orgId: org.id, orgName: org.name });
    }
    return projects;
  }

  listFlags(projectId) {
    return this.getAll(`/api/projects/${projectId}/feature_flags/?limit=200`);
  }

  getFlag(projectId, flagId) {
    return this.get(`/api/projects/${projectId}/feature_flags/${flagId}/`);
  }

  listExperiments(projectId) {
    return this.getAll(`/api/projects/${projectId}/experiments/?limit=100`);
  }

  /**
   * Writes new filters, but only if the flag is still the version the user reviewed.
   * Returns the flag as PostHog saved it.
   */
  async updateFlagFilters(projectId, flagId, filters, reviewed) {
    const fresh = await this.getFlag(projectId, flagId);
    if (fresh.version !== reviewed.version || fresh.updated_at !== reviewed.updated_at) {
      throw new PostHogError(409, 'Флаг изменили, пока вы его смотрели. Обновите страницу и проверьте доли заново.');
    }
    if (JSON.stringify(fresh.filters) !== JSON.stringify(reviewed.filters)) {
      throw new PostHogError(409, 'Условия флага уже другие. Обновите страницу и проверьте доли заново.');
    }
    // `version` lets PostHog refuse the write too (409) on flags whose filters.version is 2.
    return this.request('PATCH', `/api/projects/${projectId}/feature_flags/${flagId}/`, {
      filters,
      version: reviewed.version,
    });
  }

  /** HogQL query. `filters` is HogQL filters (dateRange, filterTestAccounts) for the {filters} placeholder. */
  query(projectId, sql, filters) {
    return this.request('POST', `/api/projects/${projectId}/query/`, {
      query: { kind: 'HogQLQuery', query: sql, ...(filters ? { filters } : {}) },
      name: 'product_helper',
    });
  }

  appUrl(projectId, path = '') {
    return `${this.host}/project/${projectId}${path}`;
  }
}
