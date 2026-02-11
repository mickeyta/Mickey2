/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and Israeli
 * securities data from the TASE API.
 *
 * Auto-detects the Node.js proxy server (tries current origin, then
 * localhost:8081). Falls back to CORS proxy if server unavailable.
 */
const MarketData = (function () {
    'use strict';

    const _cache = {};
    let _cacheTTL = 5 * 60 * 1000; // 5 minutes
    let _corsProxy = 'https://api.allorigins.win/get?url=';
    let _serverBase = null; // auto-detected: '' (relative) or 'http://localhost:8081'
    let _serverProbed = false;

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

    /** Fetch with a timeout (ms). Returns null on timeout. */
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
     * Auto-detect the Node.js proxy server by pinging /api/ping.
     * Tries current origin first, then localhost:8081.
     * Result is cached so detection only happens once.
     */
    async function _findServer() {
        if (_serverProbed) return _serverBase;
        _serverProbed = true;

        // Try relative URL first (same origin)
        try {
            var r = await _fetchWithTimeout('/api/ping', 2000);
            if (r && r.ok) {
                _serverBase = '';
                console.log('[MarketData] Server found at current origin');
                return _serverBase;
            }
        } catch (e) {}

        // Try common local ports
        var ports = [8081, 8080, 3000, 5000];
        for (var i = 0; i < ports.length; i++) {
            try {
                var base = 'http://localhost:' + ports[i];
                var r2 = await _fetchWithTimeout(base + '/api/ping', 2000);
                if (r2 && r2.ok) {
                    _serverBase = base;
                    console.log('[MarketData] Server found at ' + base);
                    return _serverBase;
                }
            } catch (e) {}
        }

        console.log('[MarketData] No server found, using CORS proxy');
        _serverBase = null;
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

        // Auto-detect server on first call
        await _findServer();

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
     * Fetch Yahoo symbols via server batch endpoint or CORS proxy fallback.
     */
    async function _fetchYahooSymbols(syms, fetched, progress) {
        // Try server batch endpoint
        if (_serverBase !== null) {
            try {
                var resp = await _fetchWithTimeout(
                    _serverBase + '/api/yahoo/batch?symbols=' + syms.map(encodeURIComponent).join(','), 30000);
                if (resp && resp.ok) {
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
        }

        // Fall back to individual CORS-proxied fetches, 3 at a time
        console.log('[Yahoo] Falling back to CORS proxy');
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
     * Fetch TASE symbols via server batch endpoint or CORS proxy fallback.
     */
    async function _fetchTASESymbols(ids, fetched, progress) {
        // Try server batch endpoint
        if (_serverBase !== null) {
            try {
                var resp = await _fetchWithTimeout(
                    _serverBase + '/api/tase/batch?ids=' + ids.map(encodeURIComponent).join(','), 30000);
                if (resp && resp.ok) {
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
        }

        // Fall back to individual CORS-proxied fetches (try both stock + fund)
        console.log('[TASE] Falling back to CORS proxy');
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
