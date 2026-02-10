/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and Israeli
 * securities data from the TASE API (via local proxy server).
 *
 * Usage:
 *   const quotes = await MarketData.fetchQuotes(['AAPL', 'MSFT']);
 *   console.log(quotes.AAPL.price); // 185.50
 *
 * With progress callback:
 *   await MarketData.fetchQuotes(['AAPL','MSFT'], function(done, total) {
 *       console.log(done + '/' + total);
 *   });
 */
const MarketData = (function () {
    'use strict';

    const _cache = {};
    let _cacheTTL = 5 * 60 * 1000; // 5 minutes
    let _corsProxy = 'https://api.allorigins.win/get?url=';

    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.corsProxy !== undefined) _corsProxy = options.corsProxy;
    }

    /** Israeli security IDs are 5-8 digit numbers */
    function _isIsraeliSecurity(symbol) {
        return /^\d{5,8}$/.test(symbol);
    }

    /** Parse Yahoo v8 chart JSON into a quote object */
    function _parseYahooChart(json, sym) {
        if (!json || !json.chart || !json.chart.result || !json.chart.result[0]) return null;
        var meta = json.chart.result[0].meta;
        var currency = meta.currency || 'USD';
        if (currency === 'ILA') currency = 'ILS';
        var price = meta.regularMarketPrice;
        if (meta.currency === 'ILA' && price != null) price = price / 100;
        var prevClose = meta.chartPreviousClose;
        if (meta.currency === 'ILA' && prevClose != null) prevClose = prevClose / 100;
        return {
            price: price != null ? price : null,
            previousClose: prevClose != null ? prevClose : null,
            change: (price != null && prevClose != null) ? price - prevClose : null,
            changePercent: (price != null && prevClose != null && prevClose !== 0)
                ? ((price - prevClose) / prevClose) * 100 : null,
            currency: currency,
            name: meta.shortName || meta.longName || meta.symbol || sym,
        };
    }

    /**
     * Fetch current quotes for the given stock symbols.
     * @param {string[]} symbols
     * @param {Function} [onProgress] - callback(fetched, total, symbol)
     * @returns {Promise<Object.<string, QuoteData|null>>}
     */
    async function fetchQuotes(symbols, onProgress) {
        if (!symbols || symbols.length === 0) return {};

        const now = Date.now();
        const upper = symbols.map(function (s) { return s.toUpperCase(); });
        var stale = upper.filter(function (s) {
            return !_cache[s] || (now - _cache[s]._ts > _cacheTTL);
        });

        if (stale.length > 0) {
            var israeliIds = stale.filter(_isIsraeliSecurity);
            var yahooSymbols = stale.filter(function (s) { return !_isIsraeliSecurity(s); });

            var total = stale.length;
            var done = 0;
            var fetched = {};

            function progress(sym) {
                done++;
                if (onProgress) onProgress(done, total, sym);
            }

            // Fire Yahoo batch + TASE batch in parallel
            var yahooDone = false;
            var yahooPromise = null;
            if (yahooSymbols.length > 0) {
                yahooPromise = _fetchYahooBatch(yahooSymbols).then(function (batchData) {
                    for (var ri = 0; ri < yahooSymbols.length; ri++) {
                        var sym = yahooSymbols[ri];
                        if (batchData && batchData[sym]) {
                            var q = _parseYahooChart(batchData[sym], sym);
                            if (q) fetched[sym] = q;
                        }
                        progress(sym);
                    }
                }).catch(function () {
                    for (var ri = 0; ri < yahooSymbols.length; ri++) {
                        progress(yahooSymbols[ri]);
                    }
                });
            }

            var tasePromise = null;
            if (israeliIds.length > 0) {
                tasePromise = _fetchTASEBatch(israeliIds).then(function (batchData) {
                    for (var fi = 0; fi < israeliIds.length; fi++) {
                        var id = israeliIds[fi];
                        if (batchData && batchData[id]) {
                            fetched[id] = _parseTASEResult(id, batchData[id]);
                        }
                        progress(id);
                    }
                }).catch(function () {
                    for (var fi = 0; fi < israeliIds.length; fi++) {
                        progress(israeliIds[fi]);
                    }
                });
            }

            // Wait for everything
            await Promise.all([yahooPromise, tasePromise].filter(Boolean));

            var ts = Date.now();
            for (var sym2 in fetched) {
                _cache[sym2] = Object.assign({}, fetched[sym2], { _ts: ts });
            }
            for (var i = 0; i < stale.length; i++) {
                if (!fetched[stale[i]] && !_cache[stale[i]]) {
                    _cache[stale[i]] = { price: null, _ts: ts };
                }
            }
        }

        var result = {};
        for (var j = 0; j < upper.length; j++) {
            var s = upper[j];
            if (_cache[s]) {
                var entry = Object.assign({}, _cache[s]);
                delete entry._ts;
                result[s] = entry;
            } else {
                result[s] = null;
            }
        }
        return result;
    }

    /**
     * Fetch all Yahoo symbols in one batch via local server proxy.
     * Server throttles to 3-at-a-time to avoid Yahoo rate limits.
     */
    async function _fetchYahooBatch(syms) {
        try {
            var resp = await fetch('/api/yahoo/batch?symbols=' + syms.map(encodeURIComponent).join(','));
            if (!resp.ok) {
                console.warn('[Yahoo] Batch HTTP ' + resp.status);
                return null;
            }
            return await resp.json();
        } catch (e) {
            console.warn('[Yahoo] Batch failed: ' + e.message);
            return null;
        }
    }

    /**
     * Fetch all Israeli securities in one batch request.
     * Server fires all TASE API calls in parallel and returns results.
     */
    async function _fetchTASEBatch(ids) {
        try {
            var resp = await fetch('/api/tase/batch?ids=' + ids.map(encodeURIComponent).join(','));
            if (!resp.ok) {
                console.warn('[TASE] Batch HTTP ' + resp.status);
                return null;
            }
            return await resp.json();
        } catch (e) {
            console.warn('[TASE] Batch failed: ' + e.message);
            return null;
        }
    }

    /** Convert a TASE batch result item to a quote object */
    function _parseTASEResult(id, data) {
        if (!data || !data.price) return null;
        return {
            price: data.price / 100,  // agorot to ILS
            previousClose: null,
            change: null,
            changePercent: data.dayYield != null ? data.dayYield : null,
            currency: 'ILS',
            name: data.name || id,
        };
    }

    function getCached(symbol) {
        var c = _cache[symbol.toUpperCase()];
        if (!c) return null;
        var entry = Object.assign({}, c);
        delete entry._ts;
        return entry;
    }

    function clearCache() {
        for (var k in _cache) {
            if (_cache.hasOwnProperty(k)) {
                delete _cache[k];
            }
        }
    }

    return {
        configure: configure,
        fetchQuotes: fetchQuotes,
        getCached: getCached,
        clearCache: clearCache,
    };
})();
