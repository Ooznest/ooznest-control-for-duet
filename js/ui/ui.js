// UI State Management Module
// Handles connection state, button states, and UI updates

class UIManager {
    constructor() {
        this.statusInterval = null;
        this.unlockInProgress = false;
        this._startupTimers = [];
    }

    getUnlockButton() {
        return document.querySelector('button[title="Unlock ($X)"]');
    }

    setUnlockPending() {
        this.unlockInProgress = true;
        const btn = this.getUnlockButton();
        if (btn) {
            btn.disabled = true;
            btn.classList.add('opacity-50', 'pointer-events-none');
        }
        this.renderUnlockButton('unlocking');
    }

    clearUnlockPending() {
        this.unlockInProgress = false;
    }

    renderUnlockButton(mode) {
        const btn = this.getUnlockButton();
        if (!btn) return;

        btn.classList.remove(
            'btn-secondary',
            '!bg-red-600',
            '!text-white',
            'animate-pulse',
            '!border-red-500',
            'shockwave',
            '!bg-amber-900/20',
            '!text-amber-400/30',
            '!text-amber-400',
            '!border-amber-700/20',
            '!border-amber-700/30',
            '!opacity-100'
        );

        if (mode === 'alarm') {
            btn.innerHTML = '<i data-lucide="unlock" style="width:12px;height:12px"></i> Unlock';
            btn.classList.add('!bg-red-600', '!text-white', 'shockwave', '!border-red-500');
        } else if (mode === 'unlocking') {
            btn.innerHTML = '<i data-lucide="loader-circle" style="width:12px;height:12px"></i> Unlocking...';
            btn.classList.add('!bg-amber-900/20', '!text-amber-400', '!border-amber-700/30', '!opacity-100');
        } else {
            btn.innerHTML = '<i data-lucide="unlock" style="width:12px;height:12px"></i> Unlock';
            btn.classList.add('!bg-amber-900/20', '!text-amber-400/30', '!border-amber-700/20', '!opacity-100');
        }

        if (window.lucide) window.lucide.createIcons();
    }

    /**
     * Update UI based on connection state
     * @param {boolean} state - Connected state
     * @param {Object} ws - WebSerial instance
     * @param {Object} sdHandler - SD card handler
     */
    updateConnectionState(state, ws, sdHandler) {
        this._startupTimers.forEach(clearTimeout);
        this._startupTimers = [];
        this._identifyingFirmware = false;
        const later = (fn, delay) => this._startupTimers.push(setTimeout(() => {
            if (ws.isConnected) fn();
        }, delay));
        const btn = document.getElementById('btn-connect');
        const resetBtn = document.getElementById('btn-reset');

        if (state) {
            if (resetBtn) {
                resetBtn.classList.remove('opacity-50', 'pointer-events-none');
                resetBtn.disabled = false;
            }

            // Update Connect Button to Disconnect
            btn.innerHTML = '<i data-lucide="plug"></i> Disconnect';
            btn.className = "btn btn-secondary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0 !bg-red-500 !text-white hover:!bg-red-600";
            if (window.lucide) window.lucide.createIcons();

            // Update Status Pill
            document.getElementById('connection-dot').classList.replace('bg-red-500', 'bg-green-500');
            document.getElementById('connection-text').textContent = 'Online';

            // Start status polling
            this.startStatusPolling(ws);

            ws.isGrblHAL = false;
            ws.supportsProbeStatus = false;
            if (ws.duet) {
                this.syncFirmwareUI('duet');
                return;
            }
            window.grblSettings?.resetControllerData?.();
            this.syncFirmwareUI('unknown');
            this._identifyingFirmware = true;
            this._firmwareSeen = false;
            this._startFirmwareInit = () => {
                if (!ws.isGrblHAL) {
                    window.lineProcessor.startInitTracking([
                        { label: 'Grbl Settings Loaded', icon: 'settings' },
                        { label: 'Parameters Loaded', icon: 'sliders' },
                        { label: 'CNC Connected', icon: 'plug' }
                    ], (idx, step) => window.showToast?.(step.label, step.icon, 'success'),
                    () => ws.disconnect(), 5000);
                    later(() => ws.sendCommand('$$'), 0);
                    later(() => ws.sendCommand('$#'), 500);
                    later(() => ws.sendCommand('$G'), 1000);
                    return;
                }
                // Init progress tracking — advances on each 'ok' response
                var initSteps = [
                    { label: 'Alarm Code Definitions Loaded', icon: 'alert-triangle' },
                    { label: 'Error Code Definitions Loaded', icon: 'x-circle' },
                    { label: 'Setting Groups Loaded', icon: 'folder-tree' },
                    { label: 'Settings Info Loaded', icon: 'list' },
                    { label: 'Grbl Settings Loaded', icon: 'settings' },
                    { label: 'Parameters Loaded', icon: 'sliders' },
                    { label: 'Firmware Build Info Loaded', icon: 'info' },
                    { label: 'CNC Connected', icon: 'plug' }
                ];
                window.lineProcessor.startInitTracking(initSteps, function(idx, step) {
                    if (window.showToast) window.showToast(step.label, step.icon, 'success');
                }, function(idx, step) {
                    if (window.showToast) window.showToast('Failed: ' + step.label, 'plug-zap', 'error');
                    if (window.ws && window.ws.disconnect) window.ws.disconnect();
                }, 5000);

                later(() => ws.sendCommand('$EA'), 500);
                later(() => ws.sendCommand('$EE'), 1000);
                later(() => sdHandler.probeAvailabilityOnBoot(), 1500);
                later(() => ws.sendCommand('$EG'), 2000);
                later(() => ws.sendCommand('$ES'), 2500);
                later(() => ws.sendCommand('$$'), 3000);
                later(() => ws.sendCommand('$#'), 3500);
                later(() => ws.sendCommand('$I+'), 4000);
                later(() => {
                    if (window.troubleshooting?.primeStartupDiscovery) {
                        window.troubleshooting.primeStartupDiscovery();
                    }
                }, 4250);
                later(() => {
                    window.userRequestedStatus = true;
                    ws.sendRealtime('\x87');
                }, 4500);
            };
            if (ws.type === 'webserial' || ws.type === 'usb') later(() => ws.sendCommand('\nM115'), 500);
            later(() => {
                if (this._identifyingFirmware && !ws.isDuetSerial && ['usb', 'webserial'].includes(ws.type)) {
                    ws.sendCommand('\nM115');
                }
            }, 2000);
            later(() => {
                if (this._identifyingFirmware && !ws.isDuetSerial) {
                    this._identifyingFirmware = false;
                    window.showToast?.('Controller identification timed out', 'plug-zap', 'error');
                    ws.disconnect();
                }
            }, 7000);
        } else {
            this.syncFirmwareUI('offline');
            if (this.statusInterval) clearInterval(this.statusInterval);
            if (window.lineProcessor) window.lineProcessor.cancelInitTracking();
            btn.innerHTML = 'Connect';
            btn.className = "btn btn-primary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0";

            document.getElementById('connection-dot').classList.replace('bg-green-500', 'bg-red-500');
            document.getElementById('connection-text').textContent = 'Offline';

            if (resetBtn) {
                resetBtn.classList.add('opacity-50', 'pointer-events-none');
                resetBtn.disabled = true;
            }

            this.applyStateLock('offline');
        }
    }


    startStatusPolling(ws) {
        if (this.statusInterval) clearInterval(this.statusInterval);
        const pollingRate = ws.type === 'websocket' ? 500 : 250;
        this.statusInterval = setInterval(() => this.pollStatus(ws), pollingRate);
    }

    pollStatus(ws, now = Date.now()) {
        if (!ws.isConnected || ws.duet) return;
        if (ws.isDuetSerial) {
            if (ws.duetAxisWrite || ws.duetSerialPollPending || now - (this._lastDuetSerialPoll ?? 0) < 500) return;
            this._lastDuetSerialPoll = now;
            ws.duetSerialPollPending = true;
            ws.sendCommand('M408 S0').catch(error => {
                ws.duetSerialPollPending = false;
                ws.emit('error', error);
            });
            return;
        }
        if (this._identifyingFirmware && (ws.type === 'usb' || ws.type === 'webserial')) return;
        ws.sendRealtime(ws.supportsProbeStatus ? '\x80' : '?');
    }

    renderDuetSettingsGroup(group) {
        const view = document.getElementById('duet-settings-view');
        const search = document.getElementById('duet-settings-search');
        const groups = [...view.querySelectorAll('[data-duet-settings-nav]')];
        if (group) search.value = '';
        if (group === 'Spindle') window.ws?.readDuetSpindles();
        const selected = group || view.dataset.activeGroup || 'Root';
        const active = groups.some(button => !button.hidden && button.dataset.duetSettingsNav === selected)
            ? selected : 'Root';
        const networkAvailable = document.getElementById('duet-network-controls').dataset.unavailable === 'false';
        const networkGroup = networkAvailable && ['Networking', 'Ethernet', 'Wi-Fi'].includes(active);
        document.getElementById('duet-save-network').hidden = !networkGroup;
        document.getElementById('duet-settings-actions').hidden = networkGroup;
        view.dataset.activeGroup = active;
        const query = search.value.trim().toLowerCase();
        groups.forEach(button => {
            const current = !query && button.dataset.duetSettingsNav === active;
            button.classList.toggle('is-active', current);
            if (current) button.setAttribute('aria-current', 'true');
            else button.removeAttribute('aria-current');
        });
        let matches = 0;
        view.querySelectorAll('[data-duet-settings-group]').forEach(section => {
            const name = section.dataset.duetSettingsGroup;
            const available = section.dataset.unavailable !== 'true';
            const axisRows = section.id === 'duet-axis-rows';
            const inGroup = name === active || (axisRows && active.endsWith('-axis'));
            section.hidden = !available || (!query && !inGroup);
            const rows = section.matches('tr') ? [section] : [...section.rows];
            rows.forEach(row => {
                const unavailable = row.hasAttribute('data-duet-wifi') && name !== 'Wi-Fi';
                const match = (name + ' ' + row.textContent + ' ' + (row.querySelector('input:not([type=password])')?.value || ''))
                    .toLowerCase().includes(query);
                row.hidden = unavailable || section.hidden || (!!query && !match) ||
                    (!query && axisRows && row.dataset.duetAxisGroup !== active);
                if (!row.hidden) matches++;
            });
        });
        document.getElementById('duet-settings-group-title').textContent = query ? 'Search Results (' + matches + ')' : active;
        document.getElementById('duet-settings-table').hidden = matches === 0;
        const categories = document.getElementById('duet-settings-subcategories');
        const grid = categories.querySelector('.grid');
        const children = groups.filter(button => {
            const name = button.dataset.duetSettingsNav;
            const networkChild = name === 'Wi-Fi' || name === 'Ethernet';
            const axisChild = name.endsWith('-axis');
            return !button.hidden && (active === 'Root' ? name !== 'Root' && !networkChild && !axisChild :
                (active === 'Networking' && networkChild) || (active === 'Axes' && axisChild));
        });
        categories.hidden = !!query || !children.length;
        if (!categories.hidden) {
            const template = document.getElementById('duet-settings-category-card');
            grid.replaceChildren(...children.map(button => {
                const card = template.content.firstElementChild.cloneNode(true);
                card.querySelector('span span').textContent = button.dataset.duetSettingsNav;
                card.onclick = () => button.click();
                return card;
            }));
            window.lucide?.createIcons();
        }
        document.getElementById('duet-axis-settings').hidden = !query && active !== 'Axes' && !active.endsWith('-axis');
        if (group && networkGroup) void window.ws?.readDuetNetwork?.();
        document.getElementById('duet-network-settings-hint').hidden =
            !!query || active !== 'Networking' ||
            document.getElementById('duet-network-controls').dataset.unavailable !== 'true';
    }

    syncFirmwareUI(firmware) {
        if (firmware === 'duet' || firmware === 'offline') this._identifyingFirmware = false;
        document.documentElement.dataset.controllerFirmware = firmware;
        if (firmware === 'duet' &&
            document.querySelector('.probe-tab-content[data-duet-probe-unsupported]:not(.hidden)')) {
            const outside = document.querySelector('.probe-tab-btn[data-target="tab-outside-corner"]');
            if (outside) window.probeHandler?.switchProbeTab('tab-outside-corner', outside);
        }
        const continuousJog = document.getElementById('jogContinuous');
        continuousJog.disabled = firmware === 'duet';
        if (continuousJog.disabled) {
            continuousJog.checked = false;
            document.getElementById('stepSize').disabled = !window.ws?.isConnected;
        } else {
            continuousJog.checked = !!window.store.get('jog.continuous');
            document.getElementById('stepSize').disabled = continuousJog.checked || !window.ws?.isConnected;
        }
        const serialOnly = firmware === 'duet' && window.ws?.isDuetSerial;
        document.getElementById('duet-sd-usb-help').hidden = !serialOnly;
        document.querySelectorAll('[data-duet-settings-action]').forEach(fieldset => {
            fieldset.disabled = !(window.ws?.duet || serialOnly);
        });
        const networkControls = document.getElementById('duet-network-controls');
        const board = window.ws?.duetFirmwareInfo?.board || '';
        const wifi = /Duet(?: 2)? WiFi\b/i.test(board);
        const ethernet = /Duet Ethernet/i.test(board);
        const networkAvailable = serialOnly && (wifi || ethernet);
        networkControls.dataset.duetSettingsGroup = wifi ? 'Wi-Fi' : 'Ethernet';
        networkControls.dataset.unavailable = String(!networkAvailable);
        document.querySelector('[data-duet-settings-nav="Wi-Fi"]').hidden = !serialOnly || !wifi;
        document.querySelector('[data-duet-settings-nav="Ethernet"]').hidden = !serialOnly || !ethernet;
        networkControls.querySelectorAll('[data-duet-wifi]').forEach(row => { row.hidden = !wifi; });
        if (!serialOnly) document.getElementById('duet-network-form').reset();
        document.getElementById('duet-workbee-model').disabled = !(window.ws?.duet || serialOnly);
        this.renderDuetSettingsGroup();
        const sdTab = document.getElementById('sd-tab-btn');
        if (sdTab) sdTab.hidden = serialOnly;
        document.getElementById('run-job-btn').hidden = serialOnly;
        if (serialOnly && !document.getElementById('sd-view')?.classList.contains('hidden')) {
            window.switchTab?.('viewer-view');
        }
        if (firmware === 'grbl' || firmware === 'unknown') {
            // Move away from panels that are unavailable on this controller.
            const activePane = document.querySelector('.tab-pane:not(.hidden)[data-grblhal-only]');
            if (activePane) window.switchTab?.('viewer-view');
            const activeTrouble = document.querySelector('.trouble-tab-content:not(.hidden)[data-grblhal-only]');
            if (activeTrouble) window.switchTroubleTab?.('trouble-tab-signals', document.querySelector('.trouble-tab-btn'));
        }
        window.troubleshooting?.updateSignalVisibility();
        window.troubleshooting?.syncProbeControls?.();
    }

    handleFirmwareIdentification(line) {
        if (!this._identifyingFirmware) return;
        if (line.startsWith('[VER:')) {
            this._firmwareSeen = true;
            const match = line.match(/^\[VER:[^:]*\.(\d{8})(?=:|\])/);
            this._firmwareBuild = match ? Number(match[1]) : 0;
        }
        // Newer grblHAL $I responses end after the info blocks (e.g. [STA IP:...])
        // with no trailing ok, so complete as soon as the firmware id arrives.
        // (Legacy Grbl 1.1 has no [FIRMWARE:] line and still completes on ok.)
        const firmwareMatch = line.match(/^\[FIRMWARE:(.*)\]$/i);
        if (firmwareMatch) {
            window.ws.isGrblHAL = /^grblHAL$/i.test(firmwareMatch[1]);
            this._finishFirmwareIdentification();
            return;
        }
        if (line === 'ok' && this._firmwareSeen) {
            this._finishFirmwareIdentification();
        }
    }

    _finishFirmwareIdentification() {
        if (!this._identifyingFirmware) return;
        this._identifyingFirmware = false;
        window.ws.supportsProbeStatus = window.ws.isGrblHAL && this._firmwareBuild > 20261013;
        window.troubleshooting?.resetProbeStatus?.();
        if (window.ws.supportsProbeStatus) window.ws.sendRealtime('\x87');
        this.syncFirmwareUI(window.ws.isGrblHAL ? 'grblhal' : 'grbl');
        if (!window.ws.isGrblHAL) {
            window.showToast?.('Grbl 1.1 compatibility mode - hiding incompatible features', 'info', 'compatibility');
        }
        this._startupTimers.push(setTimeout(() => {
            if (window.ws.isConnected) this._startFirmwareInit();
        }, 0));
    }

    /**
     * Apply button state locks based on Grbl machine state
     * @param {string} state - Grbl state (Idle, Alarm, Run, Hold, etc) or 'offline'
     */
    applyStateLock(state) {
        state = (state || 'offline').toLowerCase().split(':')[0];

        if (state !== 'alarm' && this.unlockInProgress) {
            this.clearUnlockPending();
        }

        const setDisabled = (selector, isDisabled) => {
            document.querySelectorAll(selector).forEach(el => {
                if (!el) return;
                el.disabled = isDisabled;
                if (isDisabled) {
                    el.classList.add('opacity-50', 'pointer-events-none');
                } else {
                    el.classList.remove('opacity-50', 'pointer-events-none');
                }
            });
        };

        // UI Control Selectors
        const jogControls = '.jog-btn, .jog-btn-extra, .dro-zero-btn, .dro-sub-btn, #stepSize, #jogContinuous';
        const runControls = '#run-job-btn';
        const macroControls = '#macros-view button, #probe-panel-content, #probe-panel-content button, #probe-panel-content input';
        const txtConsole = '#console-input-area, #cmdInput, #btnSend';
        const unlockBtn = 'button[title="Unlock ($X)"]';
        const ensureSdTabEnabled = () => {
            const sdTabBtn = document.getElementById('sd-tab-btn');
            if (!sdTabBtn) return;
            sdTabBtn.disabled = false;
            sdTabBtn.classList.remove('opacity-50', 'pointer-events-none');
        };
        const syncJogModeState = () => {
            if (window.joggingController?.syncModeState) window.joggingController.syncModeState();
        };

        if (state === 'offline') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, true);
            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');

            // Completely disable specific outer blocks remaining from previous UI styles
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => {
                el.classList.add('opacity-50', 'pointer-events-none');
            });
        }
        else if (state === 'alarm') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false); // Keep console alive to query settings out of alarm

            // Keep HOME button enabled during alarm (needed for homing-lock recovery)
            setDisabled('#home-all-btn', false);
            document.querySelectorAll('.dro-home-btn').forEach(el => {
                el.disabled = false;
                el.classList.remove('opacity-50', 'pointer-events-none');
            });

            if (this.unlockInProgress) {
                setDisabled(unlockBtn, true);
                this.renderUnlockButton('unlocking');
            } else {
                setDisabled(unlockBtn, false);
                this.renderUnlockButton('alarm');
            }

            // Clean up general offline locks if they were present
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else if (state === 'run' || state === 'jog' || state === 'homing') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false); // Keep console to send realtime intercepts

            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else if (['hold', 'door', 'sleep', 'off', 'unknown'].includes(state)) {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false);

            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else {
            // Idle Space
            setDisabled(jogControls, false);
            setDisabled(macroControls, false);
            setDisabled(txtConsole, false);

            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');

            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));

            this.updateRunButtonsState();
        }

        ensureSdTabEnabled();
        syncJogModeState();
    }

    /**
     * Update Run button states based on SD file context
     */
    updateRunButtonsState() {
        const runJobContainer = document.getElementById('run-job-btn');
        const runJobBtn = runJobContainer?.querySelector('button');

        if (window.currentSDFile) {
            if (runJobContainer) {
                runJobContainer.classList.add('opacity-50', 'pointer-events-none');
                runJobContainer.title = "Streaming disabled for SD files. Use SD option in dropdown";
            }
            if (runJobBtn) runJobBtn.disabled = true;
        } else {
            if (window.ws && window.ws.isConnected && runJobContainer) {
                runJobContainer.classList.remove('opacity-50', 'pointer-events-none');
                runJobContainer.title = "Run Job (Stream)";
            }
            if (runJobBtn) runJobBtn.disabled = false;
        }
    }
}

// Export singleton instance
window.uiManager = new UIManager();
