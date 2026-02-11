/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and Israeli
 * securities data from the TASE API.
 *
 * Tries local server proxy first (/api/* endpoints), falls back to
 * CORS proxy (allorigins.win) if the server isn't available.
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
     * Fetch a URL through the allorigins CORS proxy with retry.
     * The /get endpoint wraps the response in {contents: "..."}.
     */
    async function _proxiedFetch(targetUrl, retries) {
        if (retries === undefined) retries = 2;
        var url = _corsProxy + encodeURIComponent(targetUrl);

        for (var attempt = 0; attempt <= retries; attempt++) {
            try {
                if (attempt > 0) {
                    await new Promise(function (r) { setTimeout(r, 1000 * attempt); });
                }
                var resp = await fetch(url);
                if (!resp.ok) continue;

                var wrapper = await resp.json();
                if (wrapper && wrapper.contents !== undefined) {
                    if (wrapper.status && wrapper.status.http_code && wrapper.status.http_code >= 400) {
                        continue;
                    }
                    return JSON.parse(wrapper.contents);
                }
                return wrapper;
            } catch (e) {
                // retry
            }
        }
        return null;
    }

    /** Run async tasks in chunks with a delay between chunks */
    async function _throttled(items, concurrency, delayMs, fn) {
        for (var i = 0; i < items.length; i += concurrency) {
            if (i > 0) await new Promise(function (r) { setTimeout(r, delayMs); });
            var chunk = items.slice(i, i + concurrency);
            await Promise.all(chunk.map(fn));
        }
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

            // Fire Yahoo + TASE in parallel
            var yahooPromise = null;
            if (yahooSymbols.length > 0) {
                yahooPromise = _fetchYahooSymbols(yahooSymbols).then(function (results) {
                    for (var ri = 0; ri < yahooSymbols.length; ri++) {
                        var sym = yahooSymbols[ri];
                        if (results && results[sym]) {
                            fetched[sym] = results[sym];
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
                tasePromise = _fetchTASESymbols(israeliIds).then(function (results) {
                    for (var fi = 0; fi < israeliIds.length; fi++) {
                        var id = israeliIds[fi];
                        if (results && results[id]) {
                            fetched[id] = results[id];
                        }
                        progress(id);
                    }
                }).catch(function () {
                    for (var fi = 0; fi < israeliIds.length; fi++) {
                        progress(israeliIds[fi]);
                    }
                });
            }

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
     * Fetch Yahoo symbols: try local batch endpoint, fall back to CORS proxy.
     * Returns { SYMBOL: quoteObject, ... }
     */
    async function _fetchYahooSymbols(syms) {
        // Try local server batch endpoint first
        try {
            var resp = await fetch('/api/yahoo/batch?symbols=' + syms.map(encodeURIComponent).join(','));
            if (resp.ok) {
                var batchData = await resp.json();
                var out = {};
                for (var i = 0; i < syms.length; i++) {
                    var sym = syms[i];
                    if (batchData && batchData[sym]) {
                        var q = _parseYahooChart(batchData[sym], sym);
                        if (q) out[sym] = q;
                    }
                }
                return out;
            }
        } catch (e) {
            // Server not available
        }

        // Fall back to individual CORS-proxied fetches, 2 at a time
        console.log('[Yahoo] Falling back to CORS proxy');
        var out = {};
        await _throttled(syms, 2, 500, function (sym) {
            var targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                encodeURIComponent(sym) + '?range=1d&interval=1d';
            return _proxiedFetch(targetUrl).then(function (json) {
                var q = _parseYahooChart(json, sym);
                if (q) out[sym] = q;
            }).catch(function () {});
        });
        return out;
    }

    /**
     * Fetch TASE symbols: try local batch endpoint, fall back to CORS proxy.
     * Returns { ID: quoteObject, ... }
     */
    async function _fetchTASESymbols(ids) {
        // Try local server batch endpoint first
        try {
            var resp = await fetch('/api/tase/batch?ids=' + ids.map(encodeURIComponent).join(','));
            if (resp.ok) {
                var batchData = await resp.json();
                var out = {};
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    if (batchData && batchData[id]) {
                        var q = _parseTASEResult(id, batchData[id]);
                        if (q) out[id] = q;
                    }
                }
                return out;
            }
        } catch (e) {
            // Server not available
        }

        // Fall back to individual CORS-proxied fetches (try both stock + fund)
        console.log('[TASE] Falling back to CORS proxy');
        var out = {};
        await _throttled(ids, 2, 500, function (id) {
            var stockUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
                encodeURIComponent(id) + '&lang=1';
            var fundUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' +
                encodeURIComponent(id);

            return Promise.all([
                _proxiedFetch(stockUrl).catch(function () { return null; }),
                _proxiedFetch(fundUrl).catch(function () { return null; }),
            ]).then(function (results) {
                var stockData = results[0];
                var fundData = results[1];

                if (stockData && stockData.LastRate != null) {
                    out[id] = {
                        price: stockData.LastRate / 100,
                        previousClose: null,
                        change: null,
                        changePercent: stockData.Change != null ? stockData.Change : null,
                        currency: 'ILS',
                        name: stockData.LongName || stockData.Name || id,
                    };
                } else if (fundData && fundData.UnitValuePrice != null) {
                    out[id] = {
                        price: fundData.UnitValuePrice / 100,
                        previousClose: null,
                        change: null,
                        changePercent: fundData.DayYield != null ? fundData.DayYield : null,
                        currency: 'ILS',
                        name: fundData.FundLongName || fundData.FundShortName || id,
                    };
                }
            });
        });
        return out;
    }

    /** Convert a TASE batch result item (from server proxy) to a quote object */
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
