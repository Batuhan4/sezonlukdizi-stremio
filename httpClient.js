/**
 * SezonlukDizi Stremio Addon - HTTP Client
 *
 * A single, serialized-friendly HTTP helper shared by search.js and scraper.js.
 *
 * Two site-specific concerns are handled here so callers don't have to:
 *
 *  1. CHARSET: every page and even the AJAX JSON on sezonlukdizi.cc is encoded
 *     as **windows-1254** (Turkish). undici/cheerio assume UTF-8 and would
 *     mangle Turkish bytes (e.g. "Do\xf0a\xfcst\xfc" -> garbage), which breaks
 *     both display and title search. We therefore read the raw bytes and decode
 *     them with `TextDecoder('windows-1254')` (built into Node's full-ICU) for
 *     both `.text()` and `.json()`.
 *
 *  2. RATE LIMITING: a small semaphore keeps concurrency low and human-paced.
 *     This account was suspended once for concurrent automated requests, so the
 *     default concurrency is 1 (fully serialized) and every request retries with
 *     exponential backoff rather than fanning out.
 *
 * Unlike the sister HDFilmCehennemi addon there is NO curl fallback: recon
 * confirmed undici and curl behave identically on every endpoint the addon
 * uses (the only CF-challenged path, /diziler.asp?adi=, is simply never hit).
 * A proxy fallback is retained but dormant by default (PROXY_ENABLED=never).
 *
 * @module httpClient
 */

const { fetch } = require('undici');
const { createLogger } = require('./logger');
const { NetworkError, TimeoutError } = require('./errors');
const { getWorkingProxy, markProxyBad, createProxyAgent, isProxyEnabled, isProxyAlways } = require('./proxy');
const { isSezonlukdiziUrl } = require('./config');

const log = createLogger('HttpClient');

// Reusable windows-1254 decoder (full-ICU Node ships this codec)
const win1254 = new TextDecoder('windows-1254');

const CONFIG = {
    timeout: 15000,        // 15 seconds per attempt
    maxRetries: 3,         // Attempts per direct/proxy path
    retryDelay: 1000,      // Base delay for exponential backoff (ms)
    maxConcurrent: 1,      // Fully serialized — never burst this site
    maxProxyAttempts: 5    // Distinct proxies to try when proxy fallback is on
};

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
};

// Simple semaphore for rate limiting
let activeRequests = 0;
const requestQueue = [];

/**
 * Acquire a request slot (rate limiting)
 * @returns {Promise<void>}
 */
function acquireSlot() {
    return new Promise((resolve) => {
        if (activeRequests < CONFIG.maxConcurrent) {
            activeRequests++;
            resolve();
        } else {
            requestQueue.push(resolve);
        }
    });
}

/**
 * Release a request slot
 */
function releaseSlot() {
    activeRequests--;
    if (requestQueue.length > 0) {
        activeRequests++;
        requestQueue.shift()();
    }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Decode a Buffer of windows-1254 bytes to a UTF-8 JS string.
 * @param {Buffer|ArrayBuffer|Uint8Array} bytes - Raw response bytes
 * @returns {string} Decoded string
 */
function decodeWin1254(bytes) {
    return win1254.decode(bytes);
}

/**
 * Wrap already-read bytes in a minimal response-like object whose `.text()` and
 * `.json()` decode windows-1254 (not UTF-8). Bytes are read once, up front, so
 * this works uniformly whether they came from a direct fetch or a proxy fetch.
 * @param {number} status - HTTP status code
 * @param {Buffer} bytes - Raw body bytes
 * @param {Headers} [headers] - Response headers
 * @returns {{status: number, ok: boolean, bytes: Buffer, headers: Headers|null, text: function(): string, json: function(): Object}}
 */
function makeResponse(status, bytes, headers = null, url = null) {
    return {
        status,
        ok: status >= 200 && status < 300,
        bytes,
        headers,
        url,                                   // final URL after redirects
        text: () => decodeWin1254(bytes),      // site bodies are windows-1254
        utf8: () => bytes.toString('utf-8'),   // embed-host bodies are UTF-8
        json: () => JSON.parse(decodeWin1254(bytes))
    };
}

/**
 * Detect Cloudflare interactive challenge HTML. The addon deliberately avoids
 * the only challenged endpoint (/diziler.asp?adi=), so this is a safety net.
 * NOTE: do not match 'challenge-platform' — CF injects that script into normal
 * 200 pages too; only the interactive "Just a moment" page means we're blocked.
 * @param {string} text - Decoded body
 * @returns {boolean}
 */
function isChallengePage(text) {
    return text.includes('cf-browser-verification') || text.includes('Just a moment');
}

/**
 * Build fetch options for a single attempt, merging default + caller headers
 * and encoding a urlencoded body for POSTs.
 * @param {Object} options - Caller options ({ method, headers, body, referer })
 * @param {AbortSignal} signal - Abort signal
 * @param {*} [dispatcher] - Optional undici dispatcher (proxy)
 * @returns {Object} undici fetch init
 */
function buildInit(options, signal, dispatcher) {
    const headers = { ...defaultHeaders, ...(options.headers || {}) };
    if (options.referer) {
        headers['Referer'] = options.referer;
        try {
            headers['Origin'] = new URL(options.referer).origin;
        } catch { /* malformed referer — omit Origin */ }
    }

    const init = {
        method: options.method || 'GET',
        headers,
        signal
    };
    if (dispatcher) init.dispatcher = dispatcher;

    if (options.body !== undefined && options.body !== null) {
        // AJAX endpoints are application/x-www-form-urlencoded
        if (typeof options.body === 'string') {
            init.body = options.body;
        } else {
            init.body = new URLSearchParams(options.body).toString();
        }
        headers['Content-Type'] = headers['Content-Type'] ||
            'application/x-www-form-urlencoded; charset=UTF-8';
    }

    return init;
}

/**
 * Perform one fetch attempt and read the full body as bytes.
 * @param {string} url - Target URL
 * @param {Object} init - undici fetch init
 * @returns {Promise<{status: number, bytes: Buffer, headers: Headers}>}
 */
async function fetchBytes(url, init) {
    const response = await fetch(url, init);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, headers: response.headers, url: response.url };
}

/**
 * Try a URL through a specific proxy with retries.
 * @param {string} url - Target URL
 * @param {{address: string, type: string}} proxy - Proxy object
 * @param {Object} options - Caller options
 * @returns {Promise<Object|null>} Response-like object or null on failure
 */
async function tryFetchWithProxy(url, proxy, options) {
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
            await acquireSlot();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
            try {
                const dispatcher = createProxyAgent(proxy);
                const { status, bytes, headers, url: finalUrl } = await fetchBytes(
                    url, buildInit(options, controller.signal, dispatcher)
                );
                clearTimeout(timeoutId);

                if (status === 403) {
                    log.warn(`Proxy ${proxy.type}://${proxy.address} blocked (403)`);
                    return null;
                }
                if (status < 200 || status >= 300) {
                    throw new NetworkError(`HTTP ${status}`, url, status);
                }
                if (isChallengePage(decodeWin1254(bytes))) {
                    log.warn(`Proxy ${proxy.type}://${proxy.address} got CF challenge`);
                    return null;
                }
                log.info(`Fetch via proxy success: ${url} (${bytes.length} bytes)`);
                return makeResponse(status, bytes, headers, finalUrl);
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (error) {
            log.warn(`Proxy ${proxy.type}://${proxy.address} attempt ${attempt} failed: ${error.message}`);
            if (attempt < CONFIG.maxRetries) {
                await sleep(CONFIG.retryDelay * Math.pow(2, attempt - 1));
            }
        } finally {
            releaseSlot();
        }
    }
    return null;
}

/**
 * HTTP request with windows-1254 decoding, retry/backoff and a dormant proxy
 * fallback. Supports GET and POST (urlencoded).
 *
 * @param {string} url - Target URL
 * @param {Object} [options] - Request options
 * @param {'GET'|'POST'} [options.method] - HTTP method (default GET)
 * @param {Object} [options.headers] - Extra headers
 * @param {string|Object} [options.body] - Body (string or {k:v} -> urlencoded)
 * @param {string} [options.referer] - Referer (also sets Origin)
 * @returns {Promise<{status: number, ok: boolean, bytes: Buffer, text: function(): string, json: function(): Object}>}
 * @throws {NetworkError|TimeoutError}
 */
async function request(url, options = {}) {
    let lastError = null;
    let useProxy = isProxyAlways() && isSezonlukdiziUrl(url);

    // Phase 1: direct connection (unless proxy is forced 'always')
    if (!useProxy) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                await acquireSlot();
                log.debug(`${options.method || 'GET'} direct (attempt ${attempt}/${CONFIG.maxRetries}): ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
                try {
                    const { status, bytes, headers, url: finalUrl } = await fetchBytes(
                        url, buildInit(options, controller.signal)
                    );
                    clearTimeout(timeoutId);

                    // CF block / challenge — only meaningful for the main site.
                    // There is no curl fallback (undici == curl here); if the
                    // proxy layer is enabled we hand off to it, else we error.
                    if (isSezonlukdiziUrl(url) &&
                        (status === 403 || isChallengePage(decodeWin1254(bytes)))) {
                        log.warn(`Cloudflare block/challenge on ${url}`);
                        lastError = new NetworkError('Cloudflare block', url, 403);
                        useProxy = true;
                        break;
                    }

                    if (status < 200 || status >= 300) {
                        throw new NetworkError(`HTTP ${status}`, url, status);
                    }

                    log.debug(`${options.method || 'GET'} success: ${url} (${bytes.length} bytes)`);
                    return makeResponse(status, bytes, headers, finalUrl);
                } finally {
                    clearTimeout(timeoutId);
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    lastError = new TimeoutError(url, CONFIG.timeout);
                } else if (error instanceof NetworkError) {
                    lastError = error;
                } else {
                    lastError = new NetworkError(error.message, url);
                }
                if (attempt < CONFIG.maxRetries) {
                    const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
                    log.warn(`Request failed, retrying in ${delay}ms... (${lastError.message})`);
                    await sleep(delay);
                }
            } finally {
                releaseSlot();
            }
        }
    }

    // Phase 2: proxy fallback (dormant unless PROXY_ENABLED != never)
    if (useProxy && isProxyEnabled() && isSezonlukdiziUrl(url)) {
        log.info(`Proxy fallback activated for: ${url}`);
        const tried = new Set();
        for (let i = 1; i <= CONFIG.maxProxyAttempts; i++) {
            const proxy = await getWorkingProxy();
            if (!proxy) {
                if (i < CONFIG.maxProxyAttempts) await sleep(2000);
                continue;
            }
            if (tried.has(proxy.address)) {
                markProxyBad(proxy);
                continue;
            }
            tried.add(proxy.address);
            const res = await tryFetchWithProxy(url, proxy, options);
            if (res) return res;
            markProxyBad(proxy);
        }
        lastError = new NetworkError(`All ${CONFIG.maxProxyAttempts} proxy attempts failed`, url);
    }

    throw lastError || new NetworkError('All attempts failed', url);
}

module.exports = {
    request,
    decodeWin1254,
    defaultHeaders
};
