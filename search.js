/**
 * SezonlukDizi Search & Matching Module
 *
 * Handles content discovery: IMDb ID -> sezonlukdizi.cc series page + episode URL.
 *
 * Discovery path (per recon):
 *   1. POST /ajax/arama.asp  q=<ttid>   — the Semantic-UI live-search endpoint.
 *      It accepts an IMDb tt-id directly and returns the matching series row, so
 *      tt-id -> series page is a SINGLE request, no Cinemeta round-trip needed.
 *      (The full-page /diziler.asp?adi= form is Cloudflare-challenge-gated and is
 *      never used.)
 *   2. Fallback (only if the tt-id search comes back empty): Cinemeta gives us the
 *      title/year, we POST arama.asp q=<title>, then CONFIRM each candidate by
 *      matching the imdb.com/title/<ttid> anchor on its series page.
 *
 * Episode URLs are deterministic — /<slug>/<S>-sezon-<E>-bolum.html — so we build
 * them straight from the slug + Stremio season/episode (the scraper GETs the page
 * and surfaces a clean not-found if the episode doesn't exist).
 *
 * @module search
 */

const cheerio = require('cheerio');
const { fetch } = require('undici');
const { createLogger } = require('./logger');
const { ContentNotFoundError, ValidationError } = require('./errors');
const { SITE_BASE_URL } = require('./config');
const { request } = require('./httpClient');

const log = createLogger('Search');

const BASE_URL = SITE_BASE_URL;
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta/series';

/**
 * Validate IMDb ID format
 * @param {string} imdbId - IMDb ID
 * @returns {boolean}
 */
function isValidImdbId(imdbId) {
    return /^tt\d{7,8}$/.test(imdbId);
}

/**
 * Validate season/episode numbers
 * @param {*} value - Value to validate
 * @returns {boolean}
 */
function isValidEpisodeNumber(value) {
    const num = parseInt(value);
    return !isNaN(num) && num > 0 && num < 100000;
}

/**
 * Derive the bare series slug from an arama.asp result URL.
 * e.g. "/diziler/supernatural.html" -> "supernatural";
 *      "/diziler/one-piece-izle.html" -> "one-piece-izle".
 * The slug can carry an "-izle" suffix — it is taken verbatim, never fabricated.
 * @param {string} url - Result URL from arama.asp
 * @returns {string} Bare slug
 */
function slugFromUrl(url) {
    return url.replace(/^\/?diziler\//, '').replace(/\.html$/, '').replace(/^\/+|\/+$/g, '');
}

/**
 * Search sezonlukdizi.cc via the AJAX live-search endpoint.
 * Accepts an IMDb tt-id OR a title. Returns only the series ("diziler") group.
 *
 * @param {string} query - IMDb ID or title
 * @returns {Promise<Array<{did: number, title: string, url: string, slug: string, imdbRating: number|null}>>}
 */
async function searchOnSite(query) {
    try {
        log.info(`Searching arama.asp: "${query}"`);
        const response = await request(`${BASE_URL}/ajax/arama.asp`, {
            method: 'POST',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/javascript, */*; q=0.01'
            },
            body: { q: query },
            referer: `${BASE_URL}/`
        });

        // Body is windows-1254; httpClient decodes before JSON.parse
        const data = response.json();

        const rows = data &&
            data.results &&
            data.results.diziler &&
            Array.isArray(data.results.diziler.results)
            ? data.results.diziler.results
            : [];

        const results = rows
            .filter(r => r && r.url)
            .map(r => ({
                did: r.did,
                title: (r.title || '').trim(),
                url: r.url,
                slug: slugFromUrl(r.url),
                // NOTE: arama.asp's `imdb` field is the IMDb RATING (e.g. 8.4),
                // NOT the tt-id — do not treat it as an identifier.
                imdbRating: typeof r.imdb === 'number' ? r.imdb : null
            }));

        log.info(`Search "${query}": ${results.length} dizi result(s)`);
        return results;
    } catch (error) {
        log.error(`Search failed for "${query}": ${error.message}`);
        return [];
    }
}

/**
 * Fetch a series page and read its canonical IMDb tt-id from the
 * `<a ... class="ui label imdb" href="https://www.imdb.com/title/tt...">` anchor.
 * Used to confirm a title-search candidate really is the requested show.
 * @param {string} seriesUrl - Absolute series page URL
 * @returns {Promise<string|null>} tt-id found on the page, or null
 */
async function getImdbIdFromSeriesPage(seriesUrl) {
    try {
        const response = await request(seriesUrl);
        const html = response.text();
        const m = html.match(/imdb\.com\/title\/(tt\d{7,8})/i);
        return m ? m[1].toLowerCase() : null;
    } catch (error) {
        log.warn(`Could not read IMDb anchor from ${seriesUrl}: ${error.message}`);
        return null;
    }
}

/**
 * Fetch title + year from Cinemeta for the title-search fallback path.
 * @param {string} imdbId - IMDb tt-id
 * @returns {Promise<{name: string|null, year: number|null}>}
 */
async function getCinemetaMeta(imdbId) {
    try {
        const response = await fetch(`${CINEMETA_URL}/${imdbId}.json`, {
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) return { name: null, year: null };
        const data = await response.json();
        const meta = data && data.meta ? data.meta : {};
        const year = meta.year ? parseInt(String(meta.year).match(/\d{4}/)?.[0]) : null;
        return { name: meta.name || null, year: Number.isNaN(year) ? null : year };
    } catch (error) {
        log.warn(`Cinemeta lookup failed for ${imdbId}: ${error.message}`);
        return { name: null, year: null };
    }
}

/**
 * Resolve an IMDb ID to a sezonlukdizi series {slug, title, url}.
 * Primary: arama.asp q=<ttid>. Fallback: Cinemeta title -> arama.asp q=<title>
 * -> confirm by matching the imdb.com/title anchor on the candidate's page.
 * @param {string} imdbId - IMDb tt-id
 * @returns {Promise<{slug: string, title: string, url: string}|null>}
 */
async function resolveSeries(imdbId) {
    // 1. Direct tt-id search (single request, exact match)
    const direct = await searchOnSite(imdbId);
    if (direct.length > 0) {
        const hit = direct[0];
        log.info(`Resolved ${imdbId} via tt-id search: ${hit.title} -> ${hit.url}`);
        return { slug: hit.slug, title: hit.title, url: `${BASE_URL}${hit.url}` };
    }

    // 2. Fallback: Cinemeta title -> title search -> IMDb-anchor confirmation
    log.info(`tt-id search empty for ${imdbId}, falling back to Cinemeta title search`);
    const { name, year } = await getCinemetaMeta(imdbId);
    if (!name) {
        log.warn(`No Cinemeta title for ${imdbId}`);
        return null;
    }

    const candidates = await searchOnSite(name);
    if (candidates.length === 0) return null;

    // Prefer a candidate whose page carries the exact tt-id anchor.
    for (const cand of candidates) {
        const seriesUrl = `${BASE_URL}${cand.url}`;
        const pageImdb = await getImdbIdFromSeriesPage(seriesUrl);
        if (pageImdb === imdbId.toLowerCase()) {
            log.info(`Confirmed ${imdbId} via IMDb anchor: ${cand.title} -> ${cand.url}`);
            return { slug: cand.slug, title: cand.title, url: seriesUrl };
        }
    }

    // No anchor confirmation — fall back to a title/year heuristic on the first
    // candidate rather than returning a possibly-wrong match silently.
    const yearHint = year ? new RegExp(`\\(${year}\\)`) : null;
    const byYear = yearHint ? candidates.find(c => yearHint.test(c.title)) : null;
    const chosen = byYear || candidates[0];
    log.warn(`No IMDb-anchor confirmation for ${imdbId}; using best-effort match: ${chosen.title}`);
    return { slug: chosen.slug, title: chosen.title, url: `${BASE_URL}${chosen.url}` };
}

/**
 * Build the deterministic episode URL for a series slug + season/episode.
 * Pattern (verified): https://sezonlukdizi.cc/<slug>/<S>-sezon-<E>-bolum.html
 * The slug is the BARE series slug (no /diziler/ prefix) taken from arama.asp.
 * @param {string} slug - Bare series slug
 * @param {number|string} season - Season number
 * @param {number|string} episode - Episode number
 * @returns {string} Absolute episode URL
 */
function buildEpisodeUrl(slug, season, episode) {
    return `${BASE_URL}/${slug}/${parseInt(season)}-sezon-${parseInt(episode)}-bolum.html`;
}

/**
 * Find content on sezonlukdizi.cc by IMDb ID (series only).
 *
 * @param {'series'} type - Content type (only 'series' is supported)
 * @param {string} imdbId - IMDb ID (e.g. tt0460681)
 * @param {number} [season] - Season number
 * @param {number} [episode] - Episode number
 * @returns {Promise<{url: string, title: string, seriesTitle: string, slug: string}>}
 * @throws {ValidationError|ContentNotFoundError}
 */
async function findContent(type, imdbId, season = null, episode = null) {
    if (!imdbId || typeof imdbId !== 'string') {
        throw new ValidationError('IMDb ID gerekli', 'imdbId', imdbId);
    }
    if (!isValidImdbId(imdbId)) {
        throw new ValidationError('Geçersiz IMDb ID formatı (örnek: tt1234567)', 'imdbId', imdbId);
    }
    if (type !== 'series') {
        // This addon only serves series; movies are out of scope.
        throw new ValidationError('Yalnızca dizi (series) desteklenir', 'type', type);
    }
    if (!season || !episode) {
        throw new ValidationError('Sezon ve bölüm numarası gerekli', 'season/episode', `${season}/${episode}`);
    }
    if (!isValidEpisodeNumber(season)) {
        throw new ValidationError('Geçersiz sezon numarası', 'season', season);
    }
    if (!isValidEpisodeNumber(episode)) {
        throw new ValidationError('Geçersiz bölüm numarası', 'episode', episode);
    }

    log.info(`Finding content: ${type} - ${imdbId} S${season}E${episode}`);

    const series = await resolveSeries(imdbId);
    if (!series) {
        throw new ContentNotFoundError(imdbId, { type, reason: 'not_found_on_site' });
    }

    const url = buildEpisodeUrl(series.slug, season, episode);
    log.info(`Episode URL: ${url}`);

    return {
        url,
        title: `${series.title} S${season}E${episode}`,
        seriesTitle: series.title,
        slug: series.slug
    };
}

module.exports = {
    findContent,
    searchOnSite,
    resolveSeries,
    buildEpisodeUrl,
    isValidImdbId
};
