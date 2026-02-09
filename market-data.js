/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Yahoo Finance API and caches results.
 * Designed as a standalone module to be used alongside the portfolio app.
 *
 * Usage:
 *   const quotes = await MarketData.fetchQuotes(['AAPL', 'MSFT']);
 *   console.log(quotes.AAPL.price); // 185.50
 *
 * Configuration:
 *   MarketData.configure({ corsProxy: 'https://corsproxy.io/?' });
 */
const MarketData = (function () {
    'use strict';

    const _cache = {};
    let _cacheTTL = 5 * 60 * 1000; // 5 minutes
    let _corsProxy = '';

    /**
     * Configure the service.
     * @param {Object} options
     * @param {number} [options.cacheTTL] - Cache duration in ms (default 5 min)
     * @param {string} [options.corsProxy] - CORS proxy URL prefix to prepend to API requests
     */
    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.corsProxy !== undefined) _corsProxy = options.corsProxy;
    }

    /**
     * Check if a symbol looks like an Israeli fund ID (numeric, typically 7 digits).
     * @param {string} symbol
     * @returns {boolean}
     */
    function _isIsraeliFund(symbol) {
        return /^\d{5,8}$/.test(symbol);
    }

    /**
     * Fetch current quotes for the given stock symbols.
     * Returns a map of symbol -> quote data. Symbols without data will have null.
     * Automatically routes Israeli fund IDs to the TASE Maya API.
     * @param {string[]} symbols
     * @returns {Promise<Object.<string, QuoteData|null>>}
     */
    async function fetchQuotes(symbols) {
        if (!symbols || symbols.length === 0) return {};

        const now = Date.now();
        const upper = symbols.map(function (s) { return s.toUpperCase(); });
        var stale = upper.filter(function (s) {
            return !_cache[s] || (now - _cache[s]._ts > _cacheTTL);
        });

        if (stale.length > 0) {
            // Separate Israeli funds from regular symbols
            var israeliFunds = stale.filter(_isIsraeliFund);
            var regularSymbols = stale.filter(function (s) { return !_isIsraeliFund(s); });

            // Fetch both in parallel
            var fetchPromises = [];
            if (regularSymbols.length > 0) {
                fetchPromises.push(_fetchFromYahoo(regularSymbols));
            } else {
                fetchPromises.push(Promise.resolve({}));
            }
            if (israeliFunds.length > 0) {
                fetchPromises.push(_fetchFromTASE(israeliFunds));
            } else {
                fetchPromises.push(Promise.resolve({}));
            }

            var results = await Promise.all(fetchPromises);
            var fetched = Object.assign({}, results[0], results[1]);

            var ts = Date.now();
            for (var sym in fetched) {
                _cache[sym] = Object.assign({}, fetched[sym], { _ts: ts });
            }
            // Mark symbols that weren't found
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
     * Fetch quotes from Yahoo Finance v7 API.
     * @param {string[]} symbols
     * @returns {Promise<Object>}
     */
    async function _fetchFromYahoo(symbols) {
        var url = _corsProxy
            ? _corsProxy + 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbols.join(','))
            : '/api/yahoo?symbols=' + encodeURIComponent(symbols.join(','));

        var resp = await fetch(url);
        if (!resp.ok) {
            throw new Error('Market data request failed (HTTP ' + resp.status + ')');
        }

        var json = await resp.json();
        var items = (json && json.quoteResponse && json.quoteResponse.result) || [];
        var out = {};

        for (var i = 0; i < items.length; i++) {
            var q = items[i];
            out[q.symbol] = {
                price: q.regularMarketPrice != null ? q.regularMarketPrice : null,
                previousClose: q.regularMarketPreviousClose != null ? q.regularMarketPreviousClose : null,
                change: q.regularMarketChange != null ? q.regularMarketChange : null,
                changePercent: q.regularMarketChangePercent != null ? q.regularMarketChangePercent : null,
                currency: q.currency || 'USD',
                name: q.shortName || q.longName || q.symbol,
            };
        }

        return out;
    }

    /**
     * Fetch quote data for Israeli funds from the TASE Maya API.
     * Each fund is fetched individually and results are merged.
     * @param {string[]} fundIds
     * @returns {Promise<Object>}
     */
    async function _fetchFromTASE(fundIds) {
        var out = {};
        var promises = fundIds.map(function (id) {
            var url = _corsProxy
                ? _corsProxy + 'https://mayaapi.tase.co.il/api/fund/details?fundId=' + encodeURIComponent(id)
                : '/api/tase/fund?fundId=' + encodeURIComponent(id);

            return fetch(url).then(function (resp) {
                if (!resp.ok) return null;
                return resp.json();
            }).then(function (data) {
                if (!data || data.UnitValuePrice == null) return;
                // UnitValuePrice is in agorot (1/100 ILS), convert to ILS
                var priceILS = data.UnitValuePrice / 100;
                out[id] = {
                    price: priceILS,
                    previousClose: null,
                    change: null,
                    changePercent: data.DayYield != null ? data.DayYield : null,
                    currency: 'ILS',
                    name: data.FundLongName || data.FundShortName || id,
                };
            }).catch(function () {
                // Silently ignore individual fund fetch failures
            });
        });

        await Promise.all(promises);
        return out;
    }

    /**
     * Get a previously cached quote without making a network request.
     * @param {string} symbol
     * @returns {QuoteData|null}
     */
    function getCached(symbol) {
        var c = _cache[symbol.toUpperCase()];
        if (!c) return null;
        var entry = Object.assign({}, c);
        delete entry._ts;
        return entry;
    }

    /** Clear all cached quotes. */
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
