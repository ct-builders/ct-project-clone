/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { loadCredentials } from './config.mjs';
import { log } from './log.mjs';

const RETRYABLE = new Set([429, 500, 502, 503, 504, 509]);

class HttpError extends Error {
  constructor(status, body, method, url) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    super(`${method} ${url} -> ${status} ${detail?.slice(0, 2000)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
  }
  /** commercetools error codes present in the response, e.g. ['DuplicateField']. */
  get codes() {
    const errs = this.body && this.body.errors;
    return Array.isArray(errs) ? errs.map((e) => e.code) : [];
  }
  has(code) {
    return this.codes.includes(code);
  }
}

export { HttpError };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CtClient {
  constructor(side, { concurrency = 6 } = {}) {
    this.cfg = loadCredentials(side);
    this.side = side;
    this.projectKey = this.cfg.projectKey;
    this._token = null;
    this._tokenExp = 0;
    this._tokenPromise = null;
    this.concurrency = concurrency;
    this.stats = { requests: 0, retries: 0 };
  }

  get label() {
    return `${this.side}:${this.projectKey}`;
  }

  /**
   * Base URL for the Import API, which is a different host to the HTTP API
   * but takes the same token. `request` passes absolute URLs through
   * untouched, so every existing verb works against it.
   */
  get importBase() {
    return `${this.cfg.importUrl}/${this.projectKey}`;
  }

  async token() {
    if (this._token && Date.now() < this._tokenExp - 60_000) return this._token;
    if (this._tokenPromise) return this._tokenPromise;
    this._tokenPromise = (async () => {
      const url = `${this.cfg.authUrl}/oauth/token`;
      const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(res.status, body, 'POST', url);
      this._token = body.access_token;
      this._tokenExp = Date.now() + (body.expires_in || 3600) * 1000;
      this._scope = body.scope || '';
      return this._token;
    })().finally(() => {
      this._tokenPromise = null;
    });
    return this._tokenPromise;
  }

  /** Raw request against the project endpoint. `path` starts with '/'. */
  async request(method, path, { body, query, raw = false, maxAttempts = 6 } = {}) {
    let url = path.startsWith('http')
      ? path
      : `${this.cfg.apiUrl}/${this.projectKey}${path}`;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
        else qs.append(k, String(v));
      }
      url += (url.includes('?') ? '&' : '?') + qs.toString();
    }

    let attempt = 0;
    for (;;) {
      attempt++;
      const tok = await this.token();
      const headers = { Authorization: `Bearer ${tok}` };
      let payload;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      this.stats.requests++;
      let res;
      try {
        res = await fetch(url, { method, headers, body: payload });
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        this.stats.retries++;
        await sleep(Math.min(2 ** attempt * 250, 8000));
        continue;
      }

      if (res.status === 401 && attempt < maxAttempts) {
        this._token = null;
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
        this.stats.retries++;
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 300, 10_000) + Math.floor(Math.random() * 250);
        log.debug(`${this.label} ${res.status} on ${method} ${path} — retry ${attempt} in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      const text = await res.text();
      let parsed = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* leave as text */
        }
      }
      if (!res.ok) throw new HttpError(res.status, parsed, method, url);
      return raw ? { status: res.status, body: parsed } : parsed;
    }
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts) { return this.request('POST', path, { ...opts, body }); }
  del(path, opts) { return this.request('DELETE', path, opts); }

  /**
   * Page through a query endpoint. Uses `withTotal=false` + id-sorted keyset
   * paging so it stays correct past the 10k offset ceiling.
   */
  async *paginate(path, { where, expand, limit = 500, sort, extraQuery } = {}) {
    let lastId = null;
    for (;;) {
      const predicates = [];
      if (where) predicates.push(...(Array.isArray(where) ? where : [where]));
      if (lastId) predicates.push(`id > "${lastId}"`);
      const query = {
        limit,
        withTotal: false,
        sort: sort || 'id asc',
        ...(predicates.length ? { where: predicates } : {}),
        ...(expand ? { expand } : {}),
        ...(extraQuery || {}),
      };
      const page = await this.get(path, { query });
      const results = page.results || [];
      for (const r of results) yield r;
      if (results.length < limit) return;
      lastId = results[results.length - 1].id;
      if (!lastId) return;
    }
  }

  /**
   * Offset paging, for endpoints that cannot keyset-page.
   * `/product-selections/{id}/products` is the case here: its only sortable
   * fields are product, variantSelection and variantExclusion, so sorting by
   * id is rejected outright.
   */
  async *paginateOffset(path, { limit = 500, extraQuery } = {}) {
    let offset = 0;
    for (;;) {
      const page = await this.get(path, { query: { limit, offset, ...(extraQuery || {}) } });
      const results = page.results || [];
      for (const r of results) yield r;
      if (results.length < limit) return;
      offset += limit;
      if (offset >= 10_000) return; // the platform's offset ceiling
    }
  }

  async all(path, opts) {
    const out = [];
    for await (const r of this.paginate(path, opts)) out.push(r);
    return out;
  }

  async count(path, where) {
    const res = await this.get(path, { query: { limit: 0, withTotal: true, ...(where ? { where } : {}) } });
    return res.total ?? 0;
  }

  /** GET one resource by key, returning null on 404. */
  async byKey(path, key) {
    try {
      return await this.get(`${path}/key=${encodeURIComponent(key)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async byId(path, id) {
    try {
      return await this.get(`${path}/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /** Run `fn` over `items` with bounded concurrency, preserving input order. */
  async mapLimit(items, fn, concurrency = this.concurrency) {
    const out = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async projectSettings() {
    return this.get('');
  }
}
