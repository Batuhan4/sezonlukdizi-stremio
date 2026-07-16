/**
 * SezonlukDizi Addon Test Script
 *
 * Exercises the live pipeline end-to-end against the recon example series:
 *   Supernatural (2005) — IMDb tt0460681 — S1E1 "Pilot" (bolum id 8490).
 *
 * All requests go through httpClient, which is serialized and rate-limited, so
 * this test is human-paced by design. Override the target with env vars:
 *   TEST_IMDB=tt... TEST_SEASON=1 TEST_EPISODE=1 npm test
 */

const { getVideoAndSubtitles, toStremioStreams } = require('./scraper');
const { findContent, searchOnSite, resolveSeries, buildEpisodeUrl, isValidImdbId } = require('./search');
const { createLogger } = require('./logger');
const { ContentNotFoundError, ValidationError } = require('./errors');

const log = createLogger('Test');

const TEST_IMDB = process.env.TEST_IMDB || 'tt0460681'; // Supernatural
const TEST_SEASON = process.env.TEST_SEASON || '1';
const TEST_EPISODE = process.env.TEST_EPISODE || '1';

/**
 * Test search + series resolution (IMDb -> arama.asp -> series slug)
 */
async function testSearch() {
    log.info('='.repeat(60));
    log.info('Testing Search / Series resolution');
    log.info('='.repeat(60));

    log.info('IMDb ID validation...');
    console.log(`  tt0460681: ${isValidImdbId('tt0460681') ? '✅' : '❌'}`);
    console.log(`  invalid:   ${!isValidImdbId('invalid') ? '✅' : '❌'}`);

    log.info(`arama.asp search by tt-id (${TEST_IMDB})...`);
    try {
        const results = await searchOnSite(TEST_IMDB);
        if (results.length > 0) {
            log.info(`✅ Found: ${results[0].title} -> ${results[0].url} (slug: ${results[0].slug})`);
        } else {
            log.warn('⚠️ No results');
        }
    } catch (error) {
        log.error(`❌ Search failed: ${error.message}`);
    }

    log.info('resolveSeries...');
    try {
        const series = await resolveSeries(TEST_IMDB);
        if (series) {
            log.info(`✅ Resolved: ${series.title} (slug: ${series.slug})`);
            log.info(`   Episode URL S${TEST_SEASON}E${TEST_EPISODE}: ${buildEpisodeUrl(series.slug, TEST_SEASON, TEST_EPISODE)}`);
        } else {
            log.warn('⚠️ resolveSeries returned null');
        }
    } catch (error) {
        log.error(`❌ resolveSeries failed: ${error.message}`);
    }
}

/**
 * Test full extraction pipeline for the target episode
 */
async function testScraping() {
    log.info('');
    log.info('='.repeat(60));
    log.info('Testing Extraction pipeline');
    log.info('='.repeat(60));

    try {
        const content = await findContent('series', TEST_IMDB, TEST_SEASON, TEST_EPISODE);
        log.info(`Content: ${content.title} -> ${content.url}`);

        const result = await getVideoAndSubtitles(content.url);
        log.info(`✅ Extraction OK — ${result.sources.length} source(s):`);
        for (const s of result.sources) {
            log.info(`   - ${s.host} [${s.dilLabel}] q${s.quality}: ${s.videoUrl.substring(0, 70)}...`);
        }

        const stremio = toStremioStreams(result, content.title, 'http://localhost:7000');
        log.info(`📦 Stremio streams: ${stremio.streams.length}`);
    } catch (error) {
        if (error instanceof ContentNotFoundError) {
            log.warn(`⚠️ Not found: ${error.query}`);
        } else {
            log.error(`❌ Extraction failed: ${error.message}`);
        }
    }
}

/**
 * Test error handling
 */
async function testErrorHandling() {
    log.info('');
    log.info('='.repeat(60));
    log.info('Testing Error Handling');
    log.info('='.repeat(60));

    log.info('Invalid IMDb ID...');
    try {
        await findContent('series', 'invalid_id', 1, 1);
        log.error('❌ Should have thrown ValidationError');
    } catch (error) {
        log.info(error instanceof ValidationError
            ? `✅ ValidationError: ${error.message}`
            : `❌ Wrong error type: ${error.constructor.name}`);
    }

    log.info('Non-existent series...');
    try {
        await findContent('series', 'tt9999999', 1, 1);
        log.warn('⚠️ Expected ContentNotFoundError');
    } catch (error) {
        log.info(error instanceof ContentNotFoundError
            ? `✅ ContentNotFoundError: ${error.query}`
            : `ℹ️ Got ${error.constructor.name}: ${error.message}`);
    }
}

/**
 * Run all tests
 */
async function runTests() {
    console.log('');
    log.info('SezonlukDizi Addon Test Suite');
    log.info(`Target: ${TEST_IMDB} S${TEST_SEASON}E${TEST_EPISODE} | LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}`);
    console.log('');

    const startTime = Date.now();
    try {
        await testSearch();
        await testScraping();
        await testErrorHandling();
    } catch (error) {
        log.error(`Test suite error: ${error.message}`, error);
    }
    console.log('');
    log.info('='.repeat(60));
    log.info(`Tests completed in ${Date.now() - startTime}ms`);
    log.info('='.repeat(60));
}

runTests().catch(error => {
    log.error(`Fatal error: ${error.message}`, error);
    process.exit(1);
});
