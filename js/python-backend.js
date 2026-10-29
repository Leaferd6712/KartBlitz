/**
 * Optional FastAPI bridge for completed results, profiles, and leaderboards.
 *
 * This module is deliberately outside the input, physics, and render paths.
 * Production leaves it disabled and performs no Python requests. Enable it with
 * `?backend=http://127.0.0.1:8001` or `window.KARTBLITZ_BACKEND_URL`.
 */
(function attachKartBlitzPythonBackend(global) {
  'use strict';

  const SESSION_KEY = 'kartblitz_python_backend_url';
  const REQUEST_TIMEOUT_MS = 4500;

  function cleanBaseUrl(raw) {
    const value = String(raw || '').trim().replace(/\/$/, '');
    if (!value) return '';
    try {
      const parsed = new URL(value, global.location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.origin + parsed.pathname.replace(/\/$/, '');
    } catch (_) {
      return '';
    }
  }

  function configuredBaseUrl() {
    let queryValue = '';
    try {
      queryValue = new URLSearchParams(global.location.search).get('backend') || '';
      if (queryValue) global.sessionStorage.setItem(SESSION_KEY, queryValue);
    } catch (_) {}
    let sessionValue = '';
    try { sessionValue = global.sessionStorage.getItem(SESSION_KEY) || ''; } catch (_) {}
    return cleanBaseUrl(queryValue || global.KARTBLITZ_BACKEND_URL || sessionValue);
  }

  let baseUrl = configuredBaseUrl();

  function emit(type, detail) {
    try {
      global.dispatchEvent(new CustomEvent('kartblitz:python-backend', {
        detail: Object.assign({ type: type, enabled: !!baseUrl }, detail || {})
      }));
    } catch (_) {}
  }

  async function request(path, options) {
    if (!baseUrl) throw new Error('python_backend_disabled');
    const controller = new AbortController();
    const timer = global.setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      const response = await global.fetch(baseUrl + path, Object.assign({
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      }, options || {}));
      let body = null;
      try { body = await response.json(); } catch (_) {}
      if (!response.ok) {
        const detail = body && body.detail;
        const code = detail && detail.code ? detail.code : ('http_' + response.status);
        const error = new Error(code);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    } finally {
      global.clearTimeout(timer);
    }
  }

  async function requestWithRetry(path, options) {
    try {
      return await request(path, options);
    } catch (error) {
      if (error && error.status) throw error;
      await new Promise(function (resolve) { global.setTimeout(resolve, 250); });
      return request(path, options);
    }
  }

  function configure(url) {
    baseUrl = cleanBaseUrl(url);
    try {
      if (baseUrl) global.sessionStorage.setItem(SESSION_KEY, baseUrl);
      else global.sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {}
    emit('configured', { baseUrl: baseUrl });
    return baseUrl;
  }

  function saveResult(payload) {
    if (!baseUrl) return Promise.resolve(null);
    return requestWithRetry('/api/v1/results', {
      method: 'POST',
      body: JSON.stringify(payload || {})
    }).then(function (data) {
      emit('result', data || {});
      return data;
    }).catch(function (error) {
      emit('error', { error: String(error && error.message || error) });
      return null;
    });
  }

  global.KartBlitzPython = Object.freeze({
    isEnabled: function () { return !!baseUrl; },
    configure: configure,
    getBaseUrl: function () { return baseUrl; },
    health: function () { return request('/api/health'); },
    saveResult: saveResult,
    leaderboard: function (mode, trackId) {
      const query = '?mode=' + encodeURIComponent(mode || 'trial') +
        '&trackId=' + encodeURIComponent(trackId);
      return request('/api/v1/leaderboard' + query);
    },
    profile: function (playerId) {
      return request('/api/v1/profiles/' + encodeURIComponent(playerId));
    }
  });
})(window);
