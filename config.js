/**
 * SezonlukDizi Stremio Addon - Site Configuration
 *
 * Central place for the site domain and proxy mode so a domain rotation
 * (e.g. .cc -> .com) is a config change, not a code edit.
 *
 * Environment variables:
 * - SITE_DOMAIN:   main site domain (default: sezonlukdizi.cc)
 * - PROXY_ENABLED: 'never' | 'auto' | 'always' (default: never — the proxy
 *   subsystem only exists to bypass Cloudflare geo-blocking from outside
 *   Turkey; when deployed in Turkey the site is reachable directly)
 *
 * Note: unlike the sister HDFilmCehennemi addon there is NO single embed host.
 * sezonlukdizi.cc delegates playback to a rotating roster of third-party embed
 * hosts (VidMoly, Filemoon, Sibnet, Okru, ...) resolved per-episode via AJAX,
 * so the embed origin is derived per source in scraper.js rather than configured.
 *
 * @module config
 */

// Load .env before reading any environment variables (idempotent)
require('dotenv').config();

const SITE_DOMAIN = process.env.SITE_DOMAIN || 'sezonlukdizi.cc';

// The site serves on the bare apex (no www.) — a www. host 301s/CF-varies.
const SITE_BASE_URL = `https://${SITE_DOMAIN}`;

const PROXY_MODE = process.env.PROXY_ENABLED || 'never';

/**
 * Check if a URL belongs to the sezonlukdizi site (used to scope proxy/retry
 * behaviour to the main site only — embed hosts are fetched directly).
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isSezonlukdiziUrl(url) {
    return url.includes('sezonlukdizi');
}

module.exports = {
    SITE_DOMAIN,
    SITE_BASE_URL,
    PROXY_MODE,
    isSezonlukdiziUrl
};
