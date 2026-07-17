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

const crypto = require('crypto');
const cheerio = require('cheerio');
const { fetch } = require('undici');
const { createLogger } = require('./logger');
const { ScrapingError } = require('./errors');
const { SITE_BASE_URL } = require('./config');
const { request, defaultHeaders } = require('./httpClient');

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

// ────────────────────────────────────────────────────────────────────────────
// Shared resolver helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * base64url (or plain base64) → Buffer. Tolerates missing padding and the
 * URL-safe alphabet (`-`/`_`).
 * @param {string} s - base64url/base64 string
 * @returns {Buffer}
 */
function b64urlToBuf(s) {
    let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return Buffer.from(t, 'base64');
}

/**
 * Minimal HTML-entity unescape for the escaped-JSON blobs some embeds inline
 * (e.g. OK.ru's `data-options`). Order matters: `&amp;` is resolved last.
 * @param {string} s
 * @returns {string}
 */
function htmlUnescape(s) {
    return String(s)
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/**
 * Pull the first .m3u8 (or, failing that, any absolute https media) URL out of a
 * jwplayer-style `sources:[{file:"..."}]` blob or raw text.
 * @param {string} text
 * @returns {string|null}
 */
function matchMediaUrl(text) {
    const m =
        text.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i) ||
        text.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
        text.match(/file:\s*["'](https?:\/\/[^"']+)["']/i);
    return m ? m[1] : null;
}

/**
 * Dean-Edwards P.A.C.K.E.R unpacker. Extracts and expands the first
 * `eval(function(p,a,c,k,e,d){…}('…',a,c,'k|k'.split('|')…))` block in `html`.
 * Returns the unpacked source, or null if no packed block is present.
 * @param {string} html
 * @returns {string|null}
 */
function unpackPacked(html) {
    const m = html.match(
        /\}\('(.+?)',(\d+),(\d+),'(.+?)'\.split\('\|'\)/s
    );
    if (!m) return null;

    // Un-escape the JS string literal payload (\' \" \\ \/ → literal).
    const payload = m[1].replace(/\\(['"\\/])/g, '$1');
    const radix = parseInt(m[2], 10);
    const count = parseInt(m[3], 10);
    const dict = m[4].split('|');

    const toBase = (n) =>
        (n < radix ? '' : toBase(Math.floor(n / radix))) +
        ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));

    const table = {};
    for (let i = count - 1; i >= 0; i--) {
        const tok = toBase(i);
        table[tok] = dict[i] && dict[i].length ? dict[i] : tok;
    }
    return payload.replace(/\b\w+\b/g, (w) =>
        Object.prototype.hasOwnProperty.call(table, w) ? table[w] : w
    );
}

/**
 * Follow HTTP redirects manually WITHOUT downloading any response body — used
 * for progressive-MP4 hosts (Sibnet) where the final URL is what we want, not
 * the (large) media bytes. Sends `Referer` on every hop.
 * @param {string} startUrl
 * @param {string} referer
 * @param {number} [maxHops=6]
 * @returns {Promise<string>} Final URL after the redirect chain
 */
async function followRedirectsNoBody(startUrl, referer, maxHops = 6) {
    let current = startUrl;
    for (let hop = 0; hop < maxHops; hop++) {
        const resp = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            headers: {
                'User-Agent': defaultHeaders['User-Agent'],
                'Referer': referer
            },
            signal: AbortSignal.timeout(15000)
        });
        // Never read the body — cancel it so we don't pull the whole video.
        try { await resp.body?.cancel?.(); } catch { /* already consumed */ }

        if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            if (!loc) return current;
            current = new URL(loc, current).href;
            continue;
        }
        return current;
    }
    return current;
}

/**
 * Filemoon-family "Byse" frontend (rotating domain, e.g. bysejikuar.com).
 * The /e/{code} page is a Vite/React SPA that fetches an AES-256-GCM-encrypted
 * blob from /api/videos/{code}/ and decrypts it client-side. The decryption is
 * fully deterministic from the response, so we reproduce it server-side:
 *   key   = b64url(key_parts[version-1]) ++ b64url(key_parts[30-version])  (32B)
 *   iv    = b64url(playback.iv)                                            (12B)
 *   blob  = b64url(playback.payload); ct = blob[:-16], tag = blob[-16:]
 * → JSON { sources:[{ url: master.m3u8 }] }.
 * @param {string} iframeSrc
 * @returns {Promise<{videoUrl: string, referer: string, origin: string}|null>}
 */
async function resolveFilemoon(iframeSrc) {
    const url = normalizeUrl(iframeSrc);
    const u = new URL(url);
    const code = u.pathname.split('/').filter(Boolean).pop();
    if (!code) {
        log.debug('Filemoon: no file_code in iframe path');
        return null;
    }

    const apiUrl = `${u.origin}/api/videos/${code}/`;
    const resp = await request(apiUrl, {
        headers: { 'Accept': 'application/json' },
        referer: `${u.origin}/`
    });
    const data = JSON.parse(resp.utf8());
    const pb = data && data.playback;
    if (!pb || !pb.payload || !pb.iv || !Array.isArray(pb.key_parts)) {
        log.debug('Filemoon: unexpected API shape (no playback blob)');
        return null;
    }

    // Key-index selection: version n → [n, 31-n] (only two of ~30 parts are real).
    const n = parseInt(String(pb.version).trim(), 10);
    if (!(n >= 1 && n <= 20)) {
        log.warn(`Filemoon: version ${pb.version} out of 1..20 — scheme changed, re-recon`);
        return null;
    }
    const idxA = n;
    const idxI = 31 - n;
    const kp = pb.key_parts;
    if (idxA < 1 || idxA > kp.length || idxI < 1 || idxI > kp.length) {
        log.warn(`Filemoon: key index [${idxA},${idxI}] exceeds key_parts(${kp.length}) — re-recon`);
        return null;
    }

    const key = Buffer.concat([b64urlToBuf(kp[idxA - 1]), b64urlToBuf(kp[idxI - 1])]);
    if (key.length !== 32) {
        log.warn(`Filemoon: derived key length ${key.length} != 32 — re-recon`);
        return null;
    }
    const iv = b64urlToBuf(pb.iv);
    const blob = b64urlToBuf(pb.payload);
    const tag = blob.subarray(blob.length - 16);
    const ct = blob.subarray(0, blob.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');

    const decoded = JSON.parse(plain);
    const src = Array.isArray(decoded.sources) ? decoded.sources[0] : null;
    if (!src || !src.url) {
        log.debug('Filemoon: no sources[0].url in decrypted payload');
        return null;
    }
    // CDN token carries its own auth; Referer/Origin are ignored but harmless.
    return { videoUrl: src.url, referer: `${u.origin}/`, origin: u.origin };
}

/**
 * Sibnet (video.sibnet.ru). Plain inline `player.src([{src:"/v/<token>/<id>.mp4"}])`
 * in shell.php. Prepend the origin and follow the (Referer-gated) redirect chain
 * server-side to the token-signed dv*.sibnet.ru CDN URL, which then needs no
 * headers. Progressive MP4 (not HLS), so it is handed to the client directly.
 * @param {string} iframeSrc
 * @returns {Promise<{videoUrl: string, referer: string, origin: string}|null>}
 */
async function resolveSibnet(iframeSrc) {
    const url = normalizeUrl(iframeSrc);
    const resp = await request(url, { referer: `${BASE_URL}/` });
    const html = resp.utf8(); // path is ASCII; page charset (win-1251) is irrelevant

    const m = html.match(/player\.src\(\[\{\s*src:\s*["']([^"']+)["']/i);
    if (!m) {
        log.debug('Sibnet: no player.src path found');
        return null;
    }
    const path = m[1];
    const abs = /^https?:\/\//i.test(path) ? path : `https://video.sibnet.ru${path}`;
    const final = await followRedirectsNoBody(abs, url);
    return { videoUrl: final, referer: '', origin: '' };
}

/**
 * VideoSoft (videoseyred.in). jwplayer setup with an external playlist JSON:
 * `var playlistUrl='/playlist/<n>.json'`. The playlist's sources[].file (the
 * entry typed application/vnd.apple.mpegurl) is the master HLS manifest.
 * @param {string} iframeSrc
 * @returns {Promise<{videoUrl: string, referer: string, origin: string}|null>}
 */
async function resolveVideoSoft(iframeSrc) {
    const url = normalizeUrl(iframeSrc);
    const origin = new URL(url).origin;
    const embedRef = `${origin}/`;

    const resp = await request(url, { referer: embedRef });
    const html = resp.utf8();
    const m = html.match(/playlistUrl\s*=\s*["'](\/playlist\/\d+\.json)["']/i);
    if (!m) {
        log.debug('VideoSoft: no playlistUrl in embed HTML');
        return null;
    }

    const plResp = await request(origin + m[1], {
        headers: { 'Accept': 'application/json' },
        referer: embedRef
    });
    const pl = JSON.parse(plResp.utf8());
    const first = Array.isArray(pl) ? pl[0] : pl;
    const sources = first && Array.isArray(first.sources) ? first.sources : [];
    const src =
        sources.find(s => /mpegurl/i.test(s.type || '')) ||
        sources.find(s => s.default === 'true' || s.default === true) ||
        sources[0];
    if (!src || !src.file) {
        log.debug('VideoSoft: no playable source in playlist JSON');
        return null;
    }
    return { videoUrl: src.file, referer: embedRef, origin };
}

/**
 * OK.ru / Odnoklassniki. The embed page carries an HTML-escaped JSON blob in a
 * `data-options="…"` attribute; flashvars.metadata (a nested JSON string) holds
 * `hlsManifestUrl` (master) and a `videos[]` MP4 fallback. Prefer HLS so the
 * addon's m3u8 proxy can attach the Chrome UA the signed CDN URLs require.
 * @param {string} iframeSrc
 * @returns {Promise<{videoUrl: string, referer: string, origin: string}|null>}
 */
async function resolveOkru(iframeSrc) {
    const url = normalizeUrl(iframeSrc);
    const resp = await request(url, { referer: `${BASE_URL}/` });
    const html = resp.utf8();

    const m = html.match(/data-options=["']([^"']+)["']/i);
    if (!m) {
        log.debug('Okru: no data-options attribute');
        return null;
    }
    let options;
    try {
        options = JSON.parse(htmlUnescape(m[1]));
    } catch (e) {
        log.debug(`Okru: data-options parse failed: ${e.message}`);
        return null;
    }
    const metaStr = options && options.flashvars && options.flashvars.metadata;
    if (!metaStr) {
        log.debug('Okru: no flashvars.metadata (geo/login restricted?)');
        return null;
    }
    const meta = JSON.parse(metaStr);

    let videoUrl = meta.hlsManifestUrl;
    if (!videoUrl && Array.isArray(meta.videos) && meta.videos.length) {
        const full = meta.videos.find(v => v.name === 'full') ||
            meta.videos[meta.videos.length - 1];
        videoUrl = full && full.url;
    }
    if (!videoUrl) {
        log.debug('Okru: no hlsManifestUrl / videos[] in metadata');
        return null;
    }
    // Media URLs need a Chrome-family UA (attached by the proxy); no Referer.
    return { videoUrl, referer: '', origin: '' };
}

/**
 * Streamruby (rubyvidhub.com embed → *.streamruby.net CDN). Standard
 * XFileSharing packed `eval(function(p,a,c,k,e,d){…})` wrapping a
 * `jwplayer().setup({sources:[{file:"…master.m3u8…"}]})`. The media token is
 * IP-locked, so playback must go through the addon's proxy (same egress IP).
 * @param {string} iframeSrc
 * @returns {Promise<{videoUrl: string, referer: string, origin: string}|null>}
 */
async function resolveStreamruby(iframeSrc) {
    const url = normalizeUrl(iframeSrc);
    const resp = await request(url, { referer: `${BASE_URL}/` });
    const html = resp.utf8();

    const unpacked = unpackPacked(html);
    const src = (unpacked && matchMediaUrl(unpacked)) || matchMediaUrl(html);
    if (!src) {
        log.debug('Streamruby: no m3u8 after unpacking');
        return null;
    }
    return { videoUrl: src, referer: '', origin: '' };
}

/**
 * ABStream (abstream.to → delucloud.xyz CDN). Plain jwplayer setup with the
 * master m3u8 inline in the page HTML. The CDN REQUIRES `Referer: abstream.to`
 * on the master, variant and every segment — the addon proxy propagates it.
 * @param {string} iframeSrc
 * @returns {Promise<{videoUrl: string, referer: string, origin: string}|null>}
 */
async function resolveAbstream(iframeSrc) {
    const url = normalizeUrl(iframeSrc);
    const resp = await request(url, { referer: `${BASE_URL}/` });
    const html = resp.utf8();

    let src = matchMediaUrl(html);
    if (!src) {
        const unpacked = unpackPacked(html);
        if (unpacked) src = matchMediaUrl(unpacked);
    }
    if (!src) {
        log.debug('ABStream: no m3u8 in embed HTML');
        return null;
    }
    return { videoUrl: src, referer: 'https://abstream.to/', origin: 'https://abstream.to' };
}

/**
 * Registry of embed-host resolvers, keyed by the lowercased `baslik` returned by
 * dataAlternatif22.asp. Add entries here to support more hosts (Netu, Pixel,
 * Dzen, ...) — each needs its own extractor + the Referer/Origin its CDN wants.
 * @type {Object<string, function(string): Promise<{videoUrl: string, referer: string, origin: string}|null>>}
 */
const HOST_RESOLVERS = {
    vidmoly: resolveVidmoly,
    filemoon: resolveFilemoon,
    sibnet: resolveSibnet,
    videosoft: resolveVideoSoft,
    okru: resolveOkru,
    streamruby: resolveStreamruby,
    abstream: resolveAbstream
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
