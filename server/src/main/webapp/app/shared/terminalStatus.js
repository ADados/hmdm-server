// DonationTap terminal status.
// The donation kiosk app writes JSON values into device custom properties through
// /rest/public/terminal-status (TerminalStatusResource.java):
//   {"type": "dt.terminal", "status": "CONNECTED", "reader": "...", "battery": 1.0, ...}
//   {"type": "dt.donation", "amount": 500, "currency": "usd", "result": "CAPTURED", ...}
// These are shown as a status badge in the device list and as details in the device dialog;
// any other custom property value is shown as plain text, as before.
angular.module('headwind-kiosk')
    .constant('TERMINAL_STATUS_STALE_MS', 15 * 60 * 1000)   // the app re-reports every 5 minutes
    .factory('terminalStatusParser', function () {
        var cache = {};
        var cacheSize = 0;
        return function (value) {
            if (typeof value !== 'string' || value.charAt(0) !== '{') {
                return null;
            }
            if (cache.hasOwnProperty(value)) {
                return cache[value];
            }
            var parsed = null;
            try {
                var obj = JSON.parse(value);
                if (obj && (obj.type === 'dt.terminal' || obj.type === 'dt.donation')) {
                    parsed = obj;
                }
            } catch (e) {
                // Not ours: plain custom property text that happens to start with '{'
            }
            if (cacheSize > 1000) {
                cache = {};
                cacheSize = 0;
            }
            cache[value] = parsed;
            cacheSize++;
            return parsed;
        };
    })
    .filter('terminalStatus', function (terminalStatusParser) {
        return terminalStatusParser;
    })
    .directive('terminalStatusValue', function (terminalStatusParser, TERMINAL_STATUS_STALE_MS) {
        var STATUS = {
            CONNECTED: {text: 'Connected', css: 'label-success'},
            NOT_CONNECTED: {text: 'Disconnected', css: 'label-danger'},
            CONNECTING: {text: 'Connecting', css: 'label-warning'},
            RECONNECTING: {text: 'Reconnecting', css: 'label-warning'},
            DISCOVERING: {text: 'Searching', css: 'label-warning'}
        };
        var DONATION = {
            CAPTURED: {text: 'Captured', css: 'label-success'},
            DECLINED: {text: 'Declined', css: 'label-danger'},
            FAILED: {text: 'Failed', css: 'label-danger'},
            CANCELED: {text: 'Canceled', css: 'label-default'}
        };
        var SYMBOLS = {usd: '$', cad: '$', aud: '$', eur: '€', gbp: '£'};

        function ago(ts) {
            if (!ts) {
                return '';
            }
            var minutes = Math.floor((Date.now() - ts) / 60000);
            if (minutes < 1) {
                return 'just now';
            }
            if (minutes < 60) {
                return minutes + ' min ago';
            }
            if (minutes < 48 * 60) {
                return Math.floor(minutes / 60) + ' h ago';
            }
            return Math.floor(minutes / 1440) + ' d ago';
        }

        return {
            restrict: 'E',
            scope: {
                value: '=',
                details: '@'
            },
            templateUrl: 'app/shared/view/terminalStatusValue.html',
            link: function (scope) {
                scope.ago = ago;
                scope.money = function (amount, currency) {
                    if (amount === undefined || amount === null) {
                        return '';
                    }
                    var code = (currency || '').toLowerCase();
                    var symbol = SYMBOLS.hasOwnProperty(code) ? SYMBOLS[code] : (code.toUpperCase() + ' ');
                    return symbol + (amount / 100).toFixed(2);
                };
                scope.percent = function (level) {
                    return (level === undefined || level === null) ? '' : Math.round(level * 100) + '%';
                };
                scope.$watch('value', function (value) {
                    var data = terminalStatusParser(value);
                    scope.data = data;
                    if (!data) {
                        return;
                    }
                    // Only the terminal status is re-reported periodically; a donation is a one-off event
                    scope.stale = data.type === 'dt.terminal' &&
                        (!data.ts || (Date.now() - data.ts) > TERMINAL_STATUS_STALE_MS);
                    var table = data.type === 'dt.terminal' ? STATUS : DONATION;
                    var key = data.type === 'dt.terminal' ? data.status : data.result;
                    scope.badge = table[key] || {text: key || 'Unknown', css: 'label-default'};
                });
            }
        };
    });
