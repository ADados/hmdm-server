// DonationTap kiosk dashboard.
// A friendly view of the donation kiosks: online state, card reader, donation amount, kiosk lock,
// with per-kiosk settings and restarts.
//
// Where things live in Headwind:
// - Donation settings are application settings of com.betacoders.donationtap. The kiosk configuration
//   holds the defaults; device-level settings override them per kiosk.
// - The card reader status is the DonationTap terminal status JSON in device custom property 1.
// - Kiosk mode belongs to the configuration, not the device. "Lock all / Unlock all" toggles kiosk mode on
//   the kiosk configuration. A single kiosk is unlocked by moving it to a twin configuration
//   ("<name> (unlocked)", identical except for kiosk mode) and locked again by moving it back.
//   The twin is created on first use as a copy. It is not kept in sync with later edits of the main
//   configuration: re-create it (delete it while no kiosk uses it) after changing the main configuration.
angular.module('headwind-kiosk')
    .constant('KIOSK_DASHBOARD', {
        configId: 1,                        // "MCWS - Terminals"
        unlockedSuffix: ' (unlocked)',
        pkg: 'com.betacoders.donationtap',
        onlineMs: 15 * 60 * 1000,           // the app re-reports its terminal status every 5 minutes
        refreshMs: 60 * 1000,
        quickAmounts: [5, 10, 15, 20, 25, 50, 100],
        maxPresets: 5
    })
    .factory('kioskPushService', function ($resource) {
        return $resource('', {}, {
            send: {url: 'rest/private/push', method: 'POST'}
        });
    })
    .controller('KiosksTabController', function ($scope, $q, $interval, $timeout, deviceService, configurationService,
                                                 applicationService, kioskPushService, authService,
                                                 terminalStatusParser, KIOSK_DASHBOARD) {
        var K = KIOSK_DASHBOARD;
        var SETTING = {amount: 'DONATION_AMOUNT', presets: 'DONATION_PRESETS', location: 'STRIPE_LOCATION_ID'};

        $scope.quickAmounts = K.quickAmounts;
        $scope.loading = true;
        $scope.sites = [];
        $scope.counts = {total: 0, online: 0, locked: 0, readers: 0};
        $scope.canEdit = authService.hasPermission('edit_devices');

        var mainConfig = null;          // the kiosk configuration (full object)
        var twinConfig = null;          // its unlocked twin (list entry), if it exists
        var configDefaults = {};        // config-level DonationTap settings by name
        var donationTapAppId = null;
        var deviceSettings = {};        // device id -> full device-level application settings list

        // ------------------------------------------------------------------ helpers

        var unwrap = function (response) {
            if (response && response.status === 'OK') {
                return response.data;
            }
            return $q.reject(response && response.message ? response.message : 'Request failed');
        };

        var call = function (method, params, body) {
            var args = [params || {}];
            if (body !== undefined) {
                args.push(body);
            }
            return method.apply(null, args).$promise.then(unwrap);
        };

        var toastTimer = null;
        var flash = function (text, isError) {
            $scope.toast = {text: text, error: !!isError};
            if (toastTimer) {
                $timeout.cancel(toastTimer);
            }
            toastTimer = $timeout(function () {
                $scope.toast = null;
            }, isError ? 6000 : 3000);
        };

        var failed = function (what) {
            return function (err) {
                flash(what + ': ' + (typeof err === 'string' ? err : 'request failed'), true);
                return $q.reject(err);
            };
        };

        var ago = function (ts) {
            if (!ts) {
                return 'never';
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
        };

        var settingsToMap = function (list) {
            var map = {};
            (list || []).forEach(function (s) {
                if (s.applicationPkg === K.pkg) {
                    map[s.name] = s;
                }
            });
            return map;
        };

        var settingValue = function (map, name) {
            return map[name] && map[name].value !== null && map[name].value !== undefined ? String(map[name].value) : '';
        };

        // Saving a configuration replaces its application list, so it must carry the list exactly as the
        // configuration editor does: the configuration as loaded plus its applications with a non-zero action
        var saveConfiguration = function (configId, changes) {
            return $q.all([
                call(configurationService.getById, {id: configId}),
                call(configurationService.getApplications, {id: configId})
            ]).then(function (results) {
                var request = angular.extend({}, results[0], changes);
                request.applications = results[1].filter(function (app) {
                    return app.action != 0;
                });
                return call(configurationService.updateConfiguration, {}, request);
            });
        };

        var getDonationTapVersion = function (device, status) {
            if (device.info && device.info.applications) {
                var app = device.info.applications.find(function (a) {
                    return a.pkg === K.pkg;
                });
                if (app && app.version) {
                    return app.version;
                }
            }
            return status && status.app ? status.app : '?';
        };

        var READER = {
            CONNECTED: {label: 'Connected', css: 'ok'},
            NOT_CONNECTED: {label: 'Not connected', css: 'bad'},
            CONNECTING: {label: 'Connecting', css: 'warn'},
            RECONNECTING: {label: 'Reconnecting', css: 'warn'},
            DISCOVERING: {label: 'Searching', css: 'warn'}
        };

        // ------------------------------------------------------------------ loading

        var buildKiosk = function (device) {
            var status = terminalStatusParser(device.custom1);
            if (status && status.type !== 'dt.terminal') {
                status = null;
            }
            var lastSeen = Math.max(device.lastUpdate || 0, (status && status.ts) || 0);
            var online = lastSeen > 0 && (Date.now() - lastSeen) < K.onlineMs;
            var reader = {label: 'Unknown', css: 'unknown'};
            if (status && online && (Date.now() - (status.ts || 0)) < K.onlineMs) {
                reader = READER[status.status] || {label: status.status || 'Unknown', css: 'unknown'};
            }

            var own = settingsToMap(deviceSettings[device.id]);
            var amount = settingValue(own, SETTING.amount) || settingValue(configDefaults, SETTING.amount);
            var presets = settingValue(own, SETTING.presets) || settingValue(configDefaults, SETTING.presets);
            var ownLocation = settingValue(own, SETTING.location);

            var onTwin = twinConfig && device.configurationId === twinConfig.id;
            var locked = onTwin ? false : !!mainConfig.kioskMode;
            var name = device.number;
            var dash = name.indexOf('-');

            return {
                id: device.id,
                number: device.number,
                name: name,
                description: device.description,
                site: dash > 0 ? name.substring(0, dash).toUpperCase() : 'Other',
                online: online,
                seenLabel: (online ? 'Checked in ' : 'Last seen ') + ago(lastSeen),
                reader: reader,
                amount: amount,
                amountLabel: amount ? '$' + amount : 'Not set',
                presets: presets,
                location: ownLocation,
                locationLabel: ownLocation ? ownLocation : 'Default location',
                onTwin: onTwin,
                locked: locked,
                lockHint: locked ? 'Locked to Donation Tap' : 'Unlocked: home screen reachable',
                pendingLock: device.kioskMode !== undefined && device.kioskMode !== null && device.kioskMode !== locked,
                app: getDonationTapVersion(device, status),
                launcher: device.launcherVersion || '?'
            };
        };

        var buildView = function (devices) {
            var kiosks = devices.map(buildKiosk);
            kiosks.sort(function (a, b) {
                return a.name.localeCompare(b.name, undefined, {numeric: true});
            });

            var bySite = {};
            var order = [];
            kiosks.forEach(function (k) {
                if (!bySite[k.site]) {
                    bySite[k.site] = [];
                    order.push(k.site);
                }
                bySite[k.site].push(k);
            });
            order.sort(function (a, b) {
                return a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b);
            });

            // Keep the open restart confirmation across refreshes
            var confirming = $scope.confirmRestartId;
            $scope.sites = order.map(function (site) {
                var list = bySite[site];
                var on = list.filter(function (k) { return k.online; }).length;
                return {
                    title: site === 'Other' ? 'Other kiosks' : site + ' kiosks',
                    summary: on + ' of ' + list.length + ' online',
                    kiosks: list
                };
            });
            $scope.kiosks = kiosks;
            $scope.confirmRestartId = kiosks.some(function (k) { return k.id === confirming; }) ? confirming : null;
            $scope.counts = {
                total: kiosks.length,
                online: kiosks.filter(function (k) { return k.online; }).length,
                locked: kiosks.filter(function (k) { return k.locked; }).length,
                readers: kiosks.filter(function (k) { return k.reader.css === 'ok'; }).length
            };
            $scope.fleetLocked = !!mainConfig.kioskMode;
            $scope.configName = mainConfig.name;
        };

        var loadDevices = function (configId) {
            return call(deviceService.getAllDevices, {}, {
                value: '',
                configurationId: configId,
                pageNum: 1,
                pageSize: 500,
                sortBy: null,
                sortDir: 'ASC'
            }).then(function (data) {
                return data.devices.items;
            });
        };

        var loading = null;
        var load = function () {
            if (loading) {
                return loading;
            }
            loading = $q.all([
                call(configurationService.getById, {id: K.configId}),
                call(configurationService.getAllConfigurations, {})
            ]).then(function (results) {
                mainConfig = results[0];
                configDefaults = settingsToMap(mainConfig.applicationSettings);
                var twinName = mainConfig.name + K.unlockedSuffix;
                twinConfig = (results[1] || []).find(function (c) {
                    return c.name === twinName;
                }) || null;

                var lists = [loadDevices(K.configId)];
                if (twinConfig) {
                    lists.push(loadDevices(twinConfig.id));
                }
                return $q.all(lists);
            }).then(function (lists) {
                var devices = [].concat.apply([], lists);
                return $q.all(devices.map(function (d) {
                    return call(deviceService.getDeviceApplicationSettings, {id: d.id}).then(function (list) {
                        deviceSettings[d.id] = list || [];
                    }, function () {
                        deviceSettings[d.id] = deviceSettings[d.id] || [];
                    });
                })).then(function () {
                    return devices;
                });
            }).then(function (devices) {
                buildView(devices);
                $scope.updatedAt = Date.now();
                $scope.loadError = null;
            }, function (err) {
                $scope.loadError = typeof err === 'string' ? err : 'Could not load the kiosks.';
            }).finally(function () {
                $scope.loading = false;
                loading = null;
            });
            return loading;
        };

        $scope.updatedLabel = function () {
            return $scope.updatedAt ? ago($scope.updatedAt) : '';
        };

        $scope.refresh = function () {
            load().then(function () {
                if (!$scope.loadError) {
                    flash('Kiosk status refreshed');
                }
            });
        };

        // ------------------------------------------------------------------ kiosk lock

        var ensureTwin = function () {
            if (twinConfig) {
                return $q.when(twinConfig);
            }
            var twinName = mainConfig.name + K.unlockedSuffix;
            return call(configurationService.copyConfiguration, {}, {
                id: mainConfig.id,
                name: twinName,
                description: 'Same as ' + mainConfig.name + ' with kiosk mode off. Used by the Kiosks page to unlock single kiosks.'
            }).then(function () {
                return call(configurationService.getAllConfigurations, {});
            }).then(function (configs) {
                var twin = (configs || []).find(function (c) {
                    return c.name === twinName;
                });
                if (!twin) {
                    return $q.reject('The unlocked copy of the configuration was not created');
                }
                return saveConfiguration(twin.id, {kioskMode: false}).then(function () {
                    twinConfig = twin;
                    return twin;
                });
            });
        };

        var moveDevices = function (ids, configId) {
            return call(deviceService.updateDevice, {}, {ids: ids, configurationId: configId});
        };

        var setKioskLock = function (kiosk, locked) {
            if (locked === kiosk.locked) {
                return $q.when();
            }
            if (locked) {
                if (!mainConfig.kioskMode) {
                    flash('The whole fleet is unlocked. Use "Lock all" to lock kiosks again.', true);
                    return $q.reject('fleet unlocked');
                }
                return moveDevices([kiosk.id], mainConfig.id);
            }
            if (!kiosk.onTwin && !mainConfig.kioskMode) {
                return $q.when();
            }
            return ensureTwin().then(function (twin) {
                return moveDevices([kiosk.id], twin.id);
            });
        };

        $scope.toggleLock = function (kiosk) {
            if ($scope.busy[kiosk.id]) {
                return;
            }
            var locked = !kiosk.locked;
            $scope.busy[kiosk.id] = true;
            setKioskLock(kiosk, locked).then(function () {
                flash(locked ? kiosk.name + ' locked to Donation Tap' : kiosk.name + ' unlocked');
                return load();
            }, function (err) {
                if (err !== 'fleet unlocked') {
                    return failed('Could not change the kiosk lock of ' + kiosk.name)(err);
                }
            }).finally(function () {
                delete $scope.busy[kiosk.id];
            });
        };

        $scope.busy = {};

        // ------------------------------------------------------------------ fleet actions

        $scope.ask = null;
        var confirmFleet = function (title, text, okLabel, action, safe) {
            $scope.ask = {title: title, text: text, okLabel: okLabel, action: action, safe: !!safe};
        };
        $scope.cancelAsk = function () {
            $scope.ask = null;
        };
        $scope.confirmAsk = function () {
            var action = $scope.ask && $scope.ask.action;
            $scope.ask = null;
            if (action) {
                action();
            }
        };

        $scope.lockAll = function () {
            confirmFleet('Lock all kiosks?', 'Every kiosk goes back to the Donation Tap screen and the home screen is hidden.',
                'Lock all', function () {
                    $scope.fleetBusy = true;
                    var unlocked = $scope.kiosks.filter(function (k) { return k.onTwin; }).map(function (k) { return k.id; });
                    var steps = mainConfig.kioskMode ? $q.when() : saveConfiguration(mainConfig.id, {kioskMode: true});
                    steps.then(function () {
                        return unlocked.length ? moveDevices(unlocked, mainConfig.id) : null;
                    }).then(function () {
                        flash('All kiosks locked to Donation Tap');
                        return load();
                    }, failed('Could not lock the kiosks')).finally(function () {
                        $scope.fleetBusy = false;
                    });
                }, true);
        };

        $scope.unlockAll = function () {
            confirmFleet('Unlock all kiosks?', 'Kiosk mode is turned off on "' + mainConfig.name +
                '". Anyone at a kiosk can reach the home screen until you lock them again.',
                'Unlock all', function () {
                    $scope.fleetBusy = true;
                    saveConfiguration(mainConfig.id, {kioskMode: false}).then(function () {
                        flash('All kiosks unlocked');
                        return load();
                    }, failed('Could not unlock the kiosks')).finally(function () {
                        $scope.fleetBusy = false;
                    });
                });
        };

        var restart = function (kiosks) {
            return call(kioskPushService.send, {}, {
                messageType: 'reboot',
                deviceNumbers: kiosks.map(function (k) { return k.number; })
            });
        };

        $scope.restartAll = function () {
            var online = $scope.kiosks.filter(function (k) { return k.online; });
            if (online.length === 0) {
                flash('No kiosk is online right now', true);
                return;
            }
            confirmFleet('Restart ' + online.length + ' online kiosk' + (online.length === 1 ? '' : 's') + '?',
                'Donations pause for about a minute while they reboot.', 'Restart all', function () {
                    $scope.fleetBusy = true;
                    restart(online).then(function () {
                        flash('Restart sent to ' + online.length + ' online kiosk' + (online.length === 1 ? '' : 's'));
                    }, failed('Could not send the restart')).finally(function () {
                        $scope.fleetBusy = false;
                    });
                });
        };

        // ------------------------------------------------------------------ restart one kiosk

        $scope.confirmRestartId = null;
        $scope.askRestart = function (kiosk) {
            $scope.confirmRestartId = kiosk.id;
        };
        $scope.cancelRestart = function () {
            $scope.confirmRestartId = null;
        };
        $scope.doRestart = function (kiosk) {
            $scope.confirmRestartId = null;
            restart([kiosk]).then(function () {
                flash('Restart sent to ' + kiosk.name);
            }, failed('Could not restart ' + kiosk.name));
        };

        // ------------------------------------------------------------------ screenshot viewer
        // Same flow as the device list's screenshot dialog: ask the kiosk by push, then poll until DonationTap has
        // uploaded a screenshot newer than the one we had

        var SHOT_POLL_MS = 3000;
        var SHOT_WAIT_MS = 2 * 60 * 1000;
        var shotPoll = null;

        $scope.shot = null;

        var stopShotPolling = function () {
            if (shotPoll) {
                $interval.cancel(shotPoll);
                shotPoll = null;
            }
            if ($scope.shot) {
                $scope.shot.waiting = false;
            }
        };

        var loadShot = function (kiosk) {
            return call(deviceService.getScreenshot, {id: kiosk.id});
        };

        $scope.takeScreenshot = function () {
            var shot = $scope.shot;
            var previousTs = shot.image ? shot.image.ts : 0;
            stopShotPolling();
            shot.error = null;
            shot.timedOut = false;
            shot.waiting = true;
            var since = Date.now();
            call(deviceService.requestScreenshot, {id: shot.kiosk.id}, {}).then(function () {
                if ($scope.shot !== shot) {
                    return;
                }
                shotPoll = $interval(function () {
                    loadShot(shot.kiosk).then(function (image) {
                        if ($scope.shot !== shot) {
                            return;
                        }
                        if (image && image.ts > previousTs) {
                            shot.image = image;
                            stopShotPolling();
                        } else if (Date.now() - since > SHOT_WAIT_MS) {
                            stopShotPolling();
                            shot.timedOut = true;
                        }
                    }, function (err) {
                        stopShotPolling();
                        shot.error = typeof err === 'string' ? err : 'Could not load the screenshot';
                    });
                }, SHOT_POLL_MS);
            }, function (err) {
                shot.waiting = false;
                shot.error = typeof err === 'string' ? err : 'Could not ask the kiosk for a screenshot';
            });
        };

        $scope.openScreenshot = function (kiosk) {
            $scope.confirmRestartId = null;
            $scope.shot = {kiosk: kiosk, image: null, waiting: true, timedOut: false, error: null};
            var shot = $scope.shot;
            // Show the last screenshot right away while a fresh one is on its way
            loadShot(kiosk).then(function (image) {
                if ($scope.shot === shot) {
                    shot.image = image || null;
                }
            }, angular.noop).finally(function () {
                if ($scope.shot === shot) {
                    $scope.takeScreenshot();
                }
            });
        };

        $scope.closeScreenshot = function () {
            stopShotPolling();
            $scope.shot = null;
        };

        // ------------------------------------------------------------------ settings panel

        $scope.sel = null;
        $scope.draft = null;

        $scope.openSettings = function (kiosk) {
            $scope.confirmRestartId = null;
            $scope.sel = kiosk;
            $scope.draftError = null;
            $scope.defaultLocation = settingValue(configDefaults, SETTING.location);
            $scope.draft = {
                amount: kiosk.amount ? parseInt(kiosk.amount, 10) : null,
                presets: (kiosk.presets || '').split(',').map(function (p) { return p.trim(); }).join(', '),
                location: kiosk.location,
                locked: kiosk.locked
            };
        };

        $scope.closeSettings = function () {
            if ($scope.saving) {
                return;
            }
            $scope.sel = null;
            $scope.draft = null;
        };

        $scope.pickAmount = function (n) {
            $scope.draft.amount = n;
        };

        var normalizePresets = function (text) {
            var parts = (text || '').split(',').map(function (s) {
                return s.trim().replace(/^\$/, '');
            }).filter(function (s) {
                return s.length > 0;
            });
            if (parts.length > K.maxPresets) {
                return {error: 'Use at most ' + K.maxPresets + ' preset amounts.'};
            }
            for (var i = 0; i < parts.length; i++) {
                if (!/^\d+$/.test(parts[i]) || parseInt(parts[i], 10) < 1) {
                    return {error: 'Preset amounts must be whole dollars, like 10, 25, 50.'};
                }
            }
            return {value: parts.map(function (p) { return String(parseInt(p, 10)); }).join(',')};
        };

        var findAppId = function () {
            if (donationTapAppId) {
                return $q.when(donationTapAppId);
            }
            var fromSettings = Object.keys(configDefaults).map(function (k) {
                return configDefaults[k];
            }).find(function (s) {
                return s.applicationId;
            });
            if (fromSettings) {
                donationTapAppId = fromSettings.applicationId;
                return $q.when(donationTapAppId);
            }
            return call(applicationService.getAllApplications, {}).then(function (apps) {
                var app = (apps || []).find(function (a) {
                    return a.pkg === K.pkg;
                });
                if (!app) {
                    return $q.reject('Donation Tap is not in the application list');
                }
                donationTapAppId = app.id;
                return app.id;
            });
        };

        // Sets (value non-empty) or removes (empty) a device-level DonationTap setting in the full list
        var putSetting = function (list, appId, name, value) {
            var index = list.findIndex(function (s) {
                return s.applicationPkg === K.pkg && s.name === name;
            });
            if (!value) {
                if (index >= 0) {
                    list.splice(index, 1);
                }
                return;
            }
            var base = index >= 0 ? list[index] : {
                applicationId: appId,
                applicationPkg: K.pkg,
                name: name,
                type: configDefaults[name] && configDefaults[name].type ? configDefaults[name].type : 'STRING',
                comment: null,
                readonly: false
            };
            var item = angular.extend({}, base, {value: value, lastUpdate: Date.now()});
            if (index >= 0) {
                list[index] = item;
            } else {
                list.push(item);
            }
        };

        $scope.saveSettings = function () {
            var kiosk = $scope.sel;
            var draft = $scope.draft;
            $scope.draftError = null;

            var amount = parseInt(draft.amount, 10);
            if (!amount || amount < 1 || String(amount) !== String(draft.amount).trim()) {
                $scope.draftError = 'The donation amount must be a whole number of dollars.';
                return;
            }
            var presets = normalizePresets(draft.presets);
            if (presets.error) {
                $scope.draftError = presets.error;
                return;
            }
            var location = (draft.location || '').trim();
            if (location === $scope.defaultLocation) {
                location = '';
            }

            $scope.saving = true;
            findAppId().then(function (appId) {
                var list = angular.copy(deviceSettings[kiosk.id] || []);
                putSetting(list, appId, SETTING.amount, String(amount));
                putSetting(list, appId, SETTING.presets, presets.value);
                putSetting(list, appId, SETTING.location, location);
                return call(deviceService.saveDeviceApplicationSettings, {id: kiosk.id}, list);
            }).then(function () {
                return call(deviceService.notifyDeviceOnAppSettingsUpdate, {id: kiosk.id}, {});
            }).then(function () {
                return setKioskLock(kiosk, draft.locked).catch(function (err) {
                    // The settings went through; report the lock separately
                    if (err !== 'fleet unlocked') {
                        flash('Settings sent, but the kiosk lock could not be changed', true);
                    }
                    return 'lock failed';
                });
            }).then(function (lockResult) {
                $scope.saving = false;
                $scope.sel = null;
                $scope.draft = null;
                if (lockResult !== 'lock failed') {
                    flash(kiosk.name + ' updated and notified');
                }
                return load();
            }, function (err) {
                $scope.saving = false;
                $scope.draftError = 'Could not save: ' + (typeof err === 'string' ? err : 'request failed');
            });
        };

        // ------------------------------------------------------------------ lifecycle

        // The panel has no viewport meta, so phones render it zoomed out at desktop width. This page is built for
        // phones, so it sets one while it is open and puts the old state back when it closes
        var viewport = document.querySelector('meta[name="viewport"]');
        var viewportBefore = viewport ? viewport.getAttribute('content') : null;
        if (!viewport) {
            viewport = document.createElement('meta');
            viewport.setAttribute('name', 'viewport');
            document.head.appendChild(viewport);
        }
        viewport.setAttribute('content', 'width=device-width, initial-scale=1');
        $scope.$on('$destroy', function () {
            if (viewportBefore === null) {
                viewport.parentNode.removeChild(viewport);
            } else {
                viewport.setAttribute('content', viewportBefore);
            }
        });

        var timer = $interval(function () {
            if (!$scope.sel && !$scope.ask && !$scope.shot) {
                load();
            }
        }, K.refreshMs);

        $scope.$on('$destroy', function () {
            $interval.cancel(timer);
            stopShotPolling();
            if (toastTimer) {
                $timeout.cancel(toastTimer);
            }
        });

        load();
    });
