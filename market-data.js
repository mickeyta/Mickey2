/**
 * MarketData - Stock market data retrieval service.
 *
 * Fetches current stock prices from Twelve Data API (free, CORS-friendly).
 * Caches results to minimize API calls.
 *
 * Setup:
 *   1. Get a free API key at https://twelvedata.com/pricing (takes 10 seconds)
 *   2. Enter the key in the app's API Key field, or call:
 *      MarketData.configure({ apiKey: 'YOUR_KEY' });
 *
 * Usage:
 *   const quotes = await MarketData.fetchQuotes(['AAPL', 'MSFT']);
 *   console.log(quotes.AAPL.price); // 276.21
 */
const MarketData = (function () {
    'use strict';

    var STORAGE_KEY = 'marketDataApiKey';
    var API_BASE = 'https://api.twelvedata.com/quote';
    var _cache = {};
    var _cacheTTL = 5 * 60 * 1000; // 5 minutes
    var _apiKey = localStorage.getItem(STORAGE_KEY) || '';

    /**
     * Configure the service.
     * @param {Object} options
     * @param {string} [options.apiKey] - Twelve Data API key (persisted to localStorage)
     * @param {number} [options.cacheTTL] - Cache duration in ms (default 5 min)
     */
    function configure(options) {
        if (options.cacheTTL !== undefined) _cacheTTL = options.cacheTTL;
        if (options.apiKey !== undefined) {
            _apiKey = options.apiKey;
            localStorage.setItem(STORAGE_KEY, _apiKey);
        }
    }

    /** @returns {string} The current API key */
    function getApiKey() {
        return _apiKey;
    }

    /**
     * Fetch current quotes for the given stock symbols.
     * @param {string[]} symbols
     * @returns {Promise<Object.<string, QuoteData|null>>}
     */
    async function fetchQuotes(symbols) {
        if (!symbols || symbols.length === 0) return {};
        if (!_apiKey) throw new Error('API key not set');

        var now = Date.now();
        var upper = symbols.map(function (s) { return s.toUpperCase(); });
        var stale = upper.filter(function (s) {
            return !_cache[s] || (now - _cache[s]._ts > _cacheTTL);
        });

        if (stale.length > 0) {
            var fetched = await _fetchFromTwelveData(stale);
            var ts = Date.now();
            for (var sym in fetched) {
                _cache[sym] = Object.assign({}, fetched[sym], { _ts: ts });
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
     * Fetch quotes from Twelve Data API.
     * Fetches each symbol individually to stay within free-tier limits.
     * @param {string[]} symbols
     * @returns {Promise<Object>}
     */
    async function _fetchFromTwelveData(symbols) {
        var out = {};
        var promises = symbols.map(function (symbol) {
            var url = API_BASE + '?symbol=' + encodeURIComponent(symbol) + '&apikey=' + encodeURIComponent(_apiKey);
            return fetch(url)
                .then(function (resp) {
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    return resp.json();
                })
                .then(function (q) {
                    if (q.code && q.code === 401) throw new Error(q.message || 'Invalid API key');
                    if (q.code && q.code === 404) return; // symbol not found
                    if (q.symbol && q.close) {
                        out[q.symbol.toUpperCase()] = {
                            price: parseFloat(q.close),
                            previousClose: q.previous_close ? parseFloat(q.previous_close) : null,
                            change: q.change ? parseFloat(q.change) : null,
                            changePercent: q.percent_change ? parseFloat(q.percent_change) : null,
                            currency: q.currency || 'USD',
                            name: q.name || q.symbol,
                        };
                    }
                })
                .catch(function (err) {
                    console.warn('Failed to fetch ' + symbol + ':', err.message);
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
        getApiKey: getApiKey,
        fetchQuotes: fetchQuotes,
        getCached: getCached,
        clearCache: clearCache,
    };
})();
