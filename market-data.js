/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and Israeli
 * securities data from the TASE API.
 *
 * Tries local server first (same origin, then localhost:8081),
 * falls back to CORS proxy if server unavailable.
 */
const MarketData = (function () {
    'use strict';

    const _cache = {};
    let _cacheTTL = 5 * 60 * 1000; // 5 minutes
    let _corsProxy = 'https://api.allorigins.win/get?url=';
    let _serverBase = null; // null = not detected, '' = same origin, 'http://...' = different port

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

    /** Fetch with a timeout (ms). Returns null on timeout/error. */
    async function _fetchWithTimeout(url, timeoutMs) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        try {
            var resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            return resp;
        } catch (e) {
            clearTimeout(timer);
            return null;
        }
    }

    /**
     * Try to fetch a server API path. Tries relative URL first,
     * then http://localhost:8081. Returns the response or null.
     */
    async function _serverFetch(path, timeoutMs) {
        // If we already know the server base, use it directly
        if (_serverBase !== null) {
            var resp = await _fetchWithTimeout(_serverBase + path, timeoutMs);
            if (resp && resp.ok) return resp;
            // Server stopped working, reset detection
            _serverBase = null;
            return null;
        }

        // Try relative URL (same origin) - quick probe with /api/ping
        var ping1 = await _fetchWithTimeout('/api/ping', 2000);
        if (ping1 && ping1.ok) {
            _serverBase = '';
            console.log('[MarketData] Server at current origin');
            // Now do the actual request with full timeout
            var resp1 = await _fetchWithTimeout(path, timeoutMs);
            if (resp1 && resp1.ok) return resp1;
            return null;
        }

        // Try localhost:8081
        var ping2 = await _fetchWithTimeout('http://localhost:8081/api/ping', 2000);
        if (ping2 && ping2.ok) {
            _serverBase = 'http://localhost:8081';
            console.log('[MarketData] Server at http://localhost:8081');
            var resp2 = await _fetchWithTimeout('http://localhost:8081' + path, timeoutMs);
            if (resp2 && resp2.ok) return resp2;
            return null;
        }

        return null;
    }

    /**
     * Fetch a URL through the allorigins CORS proxy.
     * Single attempt with 8s timeout.
     */
    async function _proxiedFetch(targetUrl) {
        var url = _corsProxy + encodeURIComponent(targetUrl);
        try {
            var resp = await _fetchWithTimeout(url, 8000);
            if (!resp || !resp.ok) return null;
            var wrapper = await resp.json();
            if (wrapper && wrapper.contents !== undefined) {
                if (wrapper.status && wrapper.status.http_code && wrapper.status.http_code >= 400) {
                    return null;
                }
                return JSON.parse(wrapper.contents);
            }
            return wrapper;
        } catch (e) {
            return null;
        }
    }

    /**
     * Fetch current quotes for the given stock symbols.
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

            var yahooPromise = yahooSymbols.length > 0
                ? _fetchYahooSymbols(yahooSymbols, fetched, progress)
                : Promise.resolve();

            var tasePromise = israeliIds.length > 0
                ? _fetchTASESymbols(israeliIds, fetched, progress)
                : Promise.resolve();

            await Promise.all([yahooPromise, tasePromise]);

            var ts = Date.now();
            for (var sym2 in fetched) {
                _cache[sym2] = Object.assign({}, fetched[sym2], { _ts: ts });
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
     * Fetch Yahoo symbols via server or CORS proxy.
     */
    async function _fetchYahooSymbols(syms, fetched, progress) {
        // Try server batch endpoint (same origin or localhost:8081)
        try {
            var resp = await _serverFetch(
                '/api/yahoo/batch?symbols=' + syms.map(encodeURIComponent).join(','), 30000);
            if (resp) {
                var batchData = await resp.json();
                for (var i = 0; i < syms.length; i++) {
                    var sym = syms[i];
                    if (batchData && batchData[sym]) {
                        var q = _parseYahooChart(batchData[sym], sym);
                        if (q) fetched[sym] = q;
                    }
                    progress(sym);
                }
                return;
            }
        } catch (e) {}

        // Fall back to individual CORS-proxied fetches, 3 at a time
        console.log('[Yahoo] Using CORS proxy');
        for (var ci = 0; ci < syms.length; ci += 3) {
            var chunk = syms.slice(ci, ci + 3);
            await Promise.all(chunk.map(function (sym) {
                var targetUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                    encodeURIComponent(sym) + '?range=1d&interval=1d';
                return _proxiedFetch(targetUrl).then(function (json) {
                    var q = _parseYahooChart(json, sym);
                    if (q) fetched[sym] = q;
                    progress(sym);
                }).catch(function () { progress(sym); });
            }));
        }
    }

    /**
     * Fetch TASE symbols via server or CORS proxy.
     */
    async function _fetchTASESymbols(ids, fetched, progress) {
        // Try server batch endpoint
        try {
            var resp = await _serverFetch(
                '/api/tase/batch?ids=' + ids.map(encodeURIComponent).join(','), 30000);
            if (resp) {
                var batchData = await resp.json();
                for (var i = 0; i < ids.length; i++) {
                    var id = ids[i];
                    if (batchData && batchData[id]) {
                        var q = _parseTASEResult(id, batchData[id]);
                        if (q) fetched[id] = q;
                    }
                    progress(id);
                }
                return;
            }
        } catch (e) {}

        // Fall back to individual CORS-proxied fetches (try both stock + fund)
        console.log('[TASE] Using CORS proxy');
        for (var ci = 0; ci < ids.length; ci += 2) {
            var chunk = ids.slice(ci, ci + 2);
            await Promise.all(chunk.map(function (id) {
                var stockUrl = 'https://api.tase.co.il/api/company/securitydata?securityId=' +
                    encodeURIComponent(id) + '&lang=1';
                var fundUrl = 'https://mayaapi.tase.co.il/api/fund/details?fundId=' +
                    encodeURIComponent(id);

                return Promise.all([
                    _proxiedFetch(stockUrl),
                    _proxiedFetch(fundUrl),
                ]).then(function (results) {
                    var stockData = results[0];
                    var fundData = results[1];

                    if (stockData && stockData.LastRate != null) {
                        fetched[id] = {
                            price: stockData.LastRate / 100,
                            previousClose: null,
                            change: null,
                            changePercent: stockData.Change != null ? stockData.Change : null,
                            currency: 'ILS',
                            name: stockData.LongName || stockData.Name || id,
                        };
                    } else if (fundData && fundData.UnitValuePrice != null) {
                        fetched[id] = {
                            price: fundData.UnitValuePrice / 100,
                            previousClose: null,
                            change: null,
                            changePercent: fundData.DayYield != null ? fundData.DayYield : null,
                            currency: 'ILS',
                            name: fundData.FundLongName || fundData.FundShortName || id,
                        };
                    }
                    progress(id);
                }).catch(function () { progress(id); });
            }));
        }
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
