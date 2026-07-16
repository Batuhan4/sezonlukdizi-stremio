/**
 * SezonlukDizi Stremio Addon - Scraper Module
 *
 * Extracts playable video URLs for an episode page on sezonlukdizi.cc.
 *
 * Pipeline (per recon, verified end-to-end on Supernatural S1E1):
 *
 *   episode page  ──▶  bolum id (#dilsec[data-id])
 *        │
 *        ▼   POST /ajax/dataAlternatif22.asp  bid=<id>&dil=<1|0>
 *   list of sources  [{ id, baslik(host), kalite }]        (dil 1=Altyazı, 0=Dublaj)
 *        │
 *        ▼   POST /ajax/dataEmbed22.asp  id=<embedId>
 *   <iframe src="//<host>/embed-<code>.html">
 *        │
 *        ▼   per-host resolver (GET embed page, scrape player source)
 *   playable .m3u8 / .mp4  +  the Referer/Origin the CDN expects
 *
 * Only hosts with a registered resolver are attempted; unknown hosts are logged
 * and skipped (add a resolver to HOST_RESOLVERS to support more). All requests
 * are serialized and rate-limited by httpClient — never fan these out.
 *
 * @module scraper
 */

const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { ScrapingError } = require('./errors');
const { SITE_BASE_URL } = require('./config');
const { request } = require('./httpClient');

const log = createLogger('Scraper');

const BASE_URL = SITE_BASE_URL;

// Language variants to request. 1 = Altyazılı (subtitled), 0 = Dublaj (dubbed).
const DIL_LABELS = { 1: 'Altyazılı', 0: 'Dublaj' };

// Cap on how many embed sources we resolve per episode, to stay human-paced.
const MAX_SOURCES_PER_DIL = 4;

/**
 * Normalize a (possibly protocol-relative) iframe/embed URL to https://.
 * @param {string} src - URL from an iframe src attribute
 * @returns {string} Absolute https URL
 */
function normalizeUrl(src) {
    if (!src) return src;
    if (src.startsWith('//')) return 'https:' + src;
    if (src.startsWith('http://')) return 'https://' + src.slice('http://'.length);
    return src;
}

/**
 * VidMoly resolver.
 * The embed at //vidmoly.net/embed-<code>.html 301-redirects to vidmoly.biz and
 * carries the playable URL inline in a jwplayer `sources: [{ file: '...m3u8' }]`
 * block (plain text, not obfuscated).
 * @param {string} iframeSrc - Embed iframe src (may be protocol-relative)
 * @returns {Promise<{videoUrl: string, referer: string, origin: string}|null>}
 */
async function resolveVidmoly(iframeSrc) {
    const url = normalizeUrl(iframeSrc);
    const response = await request(url, { referer: `${BASE_URL}/` });
    const html = response.utf8(); // embed host is UTF-8, not windows-1254

    const m = html.match(/file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
    if (!m) {
        log.debug('VidMoly: no m3u8 found in embed page');
        return null;
    }

    // Referer/Origin the CDN expects = the final (post-redirect) embed origin.
    let origin = 'https://vidmoly.biz';
    try {
        origin = new URL(response.url || url).origin;
    } catch { /* keep default */ }

    return { videoUrl: m[1], referer: origin + '/', origin };
}

/**
 * Registry of embed-host resolvers, keyed by the lowercased `baslik` returned by
 * dataAlternatif22.asp. Add entries here to support more hosts (Filemoon, Sibnet,
 * Okru, Netu, Pixel, VideoSoft, ...) — each needs its own extractor + referer.
 * @type {Object<string, function(string): Promise<{videoUrl: string, referer: string, origin: string}|null>>}
 */
const HOST_RESOLVERS = {
    vidmoly: resolveVidmoly
};

/**
 * Resolve the bolum (episode) id from an episode page.
 * @param {string} html - Decoded episode page HTML
 * @returns {string|null} Bolum id, or null if not present
 */
function parseBolumId(html) {
    const $ = cheerio.load(html);
    const id = $('#dilsec').attr('data-id');
    if (id) return id.trim();

    // Fallback: #topBarBtn carries bid="..."
    const m = html.match(/bid=["'](\d+)["']/);
    return m ? m[1] : null;
}

/**
 * Which language variants (dil) does this episode page expose?
 * Looks for `<a data-dil="1">` / `<a data-dil="0">`; defaults to [1, 0].
 * @param {string} html - Decoded episode page HTML
 * @returns {number[]} Ordered list of dil values to request
 */
function parseAvailableDils(html) {
    const dils = [];
    if (/data-dil=["']1["']/.test(html)) dils.push(1);
    if (/data-dil=["']0["']/.test(html)) dils.push(0);
    return dils.length > 0 ? dils : [1, 0];
}

/**
 * List embed sources for a bolum in one language.
 * @param {string} bolumId - Bolum id
 * @param {number} dil - 1 (subtitled) or 0 (dubbed)
 * @param {string} episodeUrl - Referer (the episode page)
 * @returns {Promise<Array<{id: number, baslik: string, kalite: number}>>}
 */
async function listSources(bolumId, dil, episodeUrl) {
    const response = await request(`${BASE_URL}/ajax/dataAlternatif22.asp`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: { bid: bolumId, dil: String(dil) },
        referer: episodeUrl
    });

    const data = response.json();
    const rows = data && Array.isArray(data.data) ? data.data : [];
    return rows.filter(r => r && r.id && r.baslik);
}

/**
 * Resolve a single embed id to its iframe src.
 * @param {number} embedId - Embed id from dataAlternatif22
 * @param {string} episodeUrl - Referer (the episode page)
 * @returns {Promise<string|null>} Iframe src, or null
 */
async function resolveEmbedIframe(embedId, episodeUrl) {
    const response = await request(`${BASE_URL}/ajax/dataEmbed22.asp`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: { id: String(embedId) },
        referer: episodeUrl
    });

    const html = response.text();
    const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    return m ? m[1] : null;
}

/**
 * Extract every resolvable playable source for an episode page.
 *
 * @param {string} episodeUrl - Absolute episode page URL
 * @returns {Promise<{episodeUrl: string, sources: Array<{videoUrl: string, host: string, dil: number, dilLabel: string, quality: number, referer: string, origin: string}>}>}
 * @throws {ScrapingError}
 */
async function getVideoAndSubtitles(episodeUrl) {
    log.info(`Extracting from episode: ${episodeUrl}`);

    const pageResponse = await request(episodeUrl);
    const html = pageResponse.text();

    const bolumId = parseBolumId(html);
    if (!bolumId) {
        log.warn('No bolum id (#dilsec[data-id]) on episode page');
        throw new ScrapingError('Bölüm kimliği bulunamadı', episodeUrl);
    }
    log.debug(`Bolum id: ${bolumId}`);

    const dils = parseAvailableDils(html);
    const sources = [];

    for (const dil of dils) {
        let rows;
        try {
            rows = await listSources(bolumId, dil, episodeUrl);
        } catch (error) {
            log.warn(`listSources failed (dil=${dil}): ${error.message}`);
            continue;
        }
        if (rows.length === 0) {
            log.debug(`No sources for dil=${dil}`);
            continue;
        }

        // Highest quality first, and only attempt hosts we can resolve.
        const resolvable = rows
            .filter(r => HOST_RESOLVERS[r.baslik.toLowerCase()])
            .sort((a, b) => (b.kalite || 0) - (a.kalite || 0))
            .slice(0, MAX_SOURCES_PER_DIL);

        if (resolvable.length === 0) {
            log.debug(`dil=${dil}: no resolvable hosts among [${rows.map(r => r.baslik).join(', ')}]`);
            continue;
        }

        for (const row of resolvable) {
            const host = row.baslik;
            try {
                const iframeSrc = await resolveEmbedIframe(row.id, episodeUrl);
                if (!iframeSrc) {
                    log.debug(`${host}: no iframe from dataEmbed22 (id=${row.id})`);
                    continue;
                }
                const resolved = await HOST_RESOLVERS[host.toLowerCase()](iframeSrc);
                if (resolved && resolved.videoUrl) {
                    sources.push({
                        videoUrl: resolved.videoUrl,
                        host,
                        dil,
                        dilLabel: DIL_LABELS[dil] || String(dil),
                        quality: row.kalite || 0,
                        referer: resolved.referer,
                        origin: resolved.origin
                    });
                    log.info(`Resolved ${host} (${DIL_LABELS[dil]}): ${resolved.videoUrl.substring(0, 70)}...`);
                }
            } catch (error) {
                log.warn(`${host} resolve failed: ${error.message}`);
            }
        }
    }

    if (sources.length === 0) {
        throw new ScrapingError('Oynatılabilir video kaynağı bulunamadı', episodeUrl);
    }

    log.info(`Extraction OK: ${sources.length} source(s) for ${episodeUrl}`);
    return { episodeUrl, sources };
}

/**
 * Convert an extraction result to Stremio stream format — one stream per
 * resolved source, tagged with host + language + quality. m3u8 URLs are routed
 * through the addon's /proxy/m3u8 endpoint (TV clients like libVLC ignore
 * behaviorHints.proxyHeaders); PC clients also get proxyHeaders as a fallback.
 *
 * @param {Object} result - Result from getVideoAndSubtitles
 * @param {string} [title='SezonlukDizi'] - Base title (e.g. "Show S1E1")
 * @param {string} [baseUrl] - Addon base URL for the m3u8 proxy
 * @returns {{streams: Array}}
 */
function toStremioStreams(result, title = 'SezonlukDizi', baseUrl = null) {
    if (!result || !Array.isArray(result.sources) || result.sources.length === 0) {
        return { streams: [] };
    }

    // Highest quality first, then group by language.
    const sorted = [...result.sources].sort((a, b) => (b.quality || 0) - (a.quality || 0));

    const streams = sorted.map((src) => {
        const isM3u8 = /\.m3u8(\?|$)/i.test(src.videoUrl);

        let streamUrl = src.videoUrl;
        if (baseUrl && isM3u8) {
            // base64url: '+' in plain base64 becomes a space in query strings
            const encodedUrl = Buffer.from(src.videoUrl).toString('base64url');
            const encodedRef = Buffer.from(src.referer).toString('base64url');
            streamUrl = `${baseUrl}/proxy/m3u8?url=${encodedUrl}&ref=${encodedRef}`;
        }

        return {
            url: streamUrl,
            name: `SezonlukDizi\n${src.dilLabel}`,
            title: `${title}\n${src.host} • ${src.dilLabel}`,
            behaviorHints: {
                notWebReady: true,
                bingeGroup: `sezonlukdizi-${src.host}-${src.dil}`,
                proxyHeaders: {
                    request: {
                        'Referer': src.referer,
                        'Origin': src.origin
                    }
                }
            }
        };
    });

    return { streams };
}

module.exports = {
    getVideoAndSubtitles,
    toStremioStreams,
    HOST_RESOLVERS
};
