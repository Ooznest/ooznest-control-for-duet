const { app } = require('electron');
const { writeFileSync, writeSync } = require('node:fs');
const assert = require('node:assert/strict');
console.log('Duet check entry loaded');
app.once('ready', () => console.log('Electron ready'));
app.on('browser-window-created', (_, win) => {
    console.log('Desktop window created');
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', async (_, level, message) => {
        if (message !== 'Duet settings loaded') return;
        const screenshot = await win.webContents.capturePage();
        if (!screenshot.isEmpty()) writeFileSync(require('node:path').join(__dirname, 'duet-settings.png'), screenshot.toPNG());
    });
    win.webContents.on('did-fail-load', (_, code, description) => console.error('Desktop load failed', code, description));
    win.webContents.once('did-finish-load', async () => {
        try {
            const wc = win.webContents;
            win.unmaximize();
            win.setSize(1280, 850);
            const capture = async name => {
                if (process.env.DUET_BENCH_SKIP_SCREENSHOTS === '1') return;
                await wc.executeJavaScript("new Promise(resolve => setTimeout(resolve, 100))");
                const screenshot = await wc.capturePage();
                assert.ok(!screenshot.isEmpty(), 'Empty Electron screenshot');
                writeFileSync(require('node:path').join(__dirname, name + '.png'), screenshot.toPNG());
            };
            const result = await wc.executeJavaScript(`(async () => {
                for (let i = 0; i < 100 && !window.macroHandler; i++) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                const modal = document.getElementById('macro-modal');
                const visible = () => getComputedStyle(modal).display !== 'none';
                const startup = visible();
                if (!document.getElementById("duet-network-controls").hidden) throw Error("Network controls visible offline");
                if (document.getElementById('jogContinuous').getClientRects().length) throw Error('Continuous jogging visible at startup');
                const decline = document.getElementById('analytics-decline');
                for (let i = 0; i < 30 && !decline.getClientRects().length; i++) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (decline.getClientRects().length) decline.click();
                return { startup };
            })()`);
            await capture('duet-startup');
            result.opened = await wc.executeJavaScript(`(() => {
                document.querySelector('[data-tab="macros-view"]').click();
                document.querySelector('.macro-card--add').click();
                return document.getElementById('macro-modal').getClientRects().length > 0 &&
                    !document.getElementById('analytics-decline').getClientRects().length;
            })()`);
            await capture('duet-macro-open');
            result.closed = await wc.executeJavaScript(`(() => {
                document.getElementById('btn-close-macro').click();
                return !document.getElementById('macro-modal').getClientRects().length;
            })()`);
            await capture('duet-macro-closed');
            wc.on('console-message', async (_, level, message) => {
                if (message !== 'Capture Duet Probe panel' || process.env.DUET_BENCH_SKIP_SCREENSHOTS === '1') return;
                win.unmaximize();
                win.setSize(1100, 740);
                await capture('duet-probe');
            });
            const bench = await wc.executeJavaScript(`(async () => {
                let pauseStop = 'not run';
                window.setConnectionType('telnet');
                document.getElementById('ip-telnet').value = '';
                let addressError;
                const onAddressError = error => { addressError = error.message; };
                window.ws.on('error', onAddressError);
                try {
                    await window.ws.connect();
                } finally {
                    window.ws.off('error', onAddressError);
                }
                if (!addressError?.includes('Enter the Duet address') || window.ws.isConnected) {
                    throw new Error('Blank HTTP address did not show the expected connection error');
                }
                window.reporter.closeModal();
                document.getElementById('ip-telnet').value = '192.168.251.2';
                await window.ws.connect();
                if (document.getElementById('jogContinuous').getClientRects().length) throw Error('Continuous jogging visible over Duet HTTP');
                if (!document.getElementById('duet-sd-usb-help').hidden) throw Error('USB SD hint shown over HTTP');
                const connected = !!window.ws.duet && window.ws.isConnected;
                if (!document.getElementById("duet-network-controls").hidden) throw Error("Network controls visible over HTTP");
                if (connected) {
                    document.querySelector('[data-tab="probe-view"]').click();
                    console.log('Capture Duet Probe panel');
                    await new Promise(resolve => setTimeout(resolve, 350));
                    if (window.ws.duetState !== 'O') throw new Error('Probe preflight check requires the bare board to be Off');
                    if (document.getElementById('machine-state').textContent.trim().toLowerCase() !== 'off' || !document.getElementById('machine-state').classList.contains('status-warn')) throw new Error('HTTP did not show Off');
                    const liveStatus = await window.ws.duet.call('status', { type: 2 });
                    try {
                        window.ws.updateDuetStatus({ ...liveStatus, status: '?' });
                        if (document.getElementById('machine-state').textContent.trim().toLowerCase() !== 'unknown' ||
                            !document.querySelector('.jog-btn').disabled) throw new Error('Unknown status did not lock jogging');
                    } finally {
                        window.ws.updateDuetStatus(liveStatus);
                    }
                    window.switchTab('probe-view');
                    const probe = window.probeHandler;
                    if (!document.getElementById('probe-panel-content').getClientRects().length) {
                        throw new Error('Original Probe panel hidden on Duet');
                    }
                    const unsupportedProbeControls = Array.from(document.querySelectorAll('[data-duet-probe-unsupported]'));
                    if (!unsupportedProbeControls.length || unsupportedProbeControls.some(control => control.getClientRects().length)) {
                        throw new Error('Unsupported Probe controls were not hidden on Duet');
                    }
                    if (!window.ws.duetProbeKnown || probe._isProbeTriggered()) throw new Error('HTTP probe input did not show Open');
                    document.getElementById('prb-z-thick').value = '10';
                    document.getElementById('prb-tool-outside').value = '6';
                    document.getElementById('prb-feed').value = '50';
                    const probeClient = window.ws.duet;
                    const probeCall = probeClient.call;
                    probeClient.call = function (endpoint, ...args) {
                        if (endpoint !== 'status' && endpoint !== 'model' && endpoint !== 'reply') {
                            throw new Error('Probe preflight attempted a write');
                        }
                        return probeCall.call(this, endpoint, ...args);
                    };
                    let probeError;
                    const onProbeError = error => { probeError = error.message; };
                    window.ws.on('error', onProbeError);
                    try {
                        probe.probeSafe = true;
                        probe.runSingleAxis('Z', -1);
                        window.reporter.domFooter.querySelector('.btn-primary').click();
                        for (let i = 0; i < 60 && !probeError; i++) await new Promise(resolve => setTimeout(resolve, 100));
                        if (!probeError?.includes('must be idle with Z homed')) throw new Error('Bare board probe preflight returned: ' + probeError);
                        probeError = undefined;
                        probe.probeSafe = true;
                        probe.runAutoCorner();
                        window.reporter.domFooter.querySelector('.btn-primary').click();
                        for (let i = 0; i < 60 && !probeError; i++) await new Promise(resolve => setTimeout(resolve, 100));
                        if (!probeError?.includes('must be idle with Z homed')) throw new Error('Bare board corner preflight returned: ' + probeError);
                    } finally {
                        window.ws.off('error', onProbeError);
                        probeClient.call = probeCall;
                    }
                    const waitOverride = async value => {
                        for (let i = 0; i < 100; i++) {
                            if (window.ws.duetFeedOverride === value && document.getElementById('feed-ovr').textContent === value + '%') return;
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        throw new Error('Expected feed override ' + value + ', controller reported ' + window.ws.duetFeedOverride + ', UI displayed ' + document.getElementById('feed-ovr').textContent);
                    };
                    const continuous = document.getElementById('jogContinuous');
                    if (!continuous.disabled || continuous.checked || document.getElementById('stepSize').disabled) {
                        throw new Error('Duet jogging did not switch to incremental mode');
                    }
                    const recovery = document.getElementById('duet-recover-job');
                    if (getComputedStyle(recovery).display === 'none' || (window.ws.duetState === 'O' && !recovery.disabled)) {
                        throw new Error('Power Loss Resume visibility or disabled state is incorrect');
                    }
                    const z = document.getElementById('duet-z-adjustment');
                    if (getComputedStyle(z).display === 'none' || !/mm$/.test(z.querySelector('output').textContent)) {
                        throw new Error('Duet Z offset was not displayed');
                    }
                    if (window.ws.duetState === 'O' && [...z.querySelectorAll('button')].some(button => !button.disabled)) {
                        throw new Error('Z adjustment enabled while the Duet is off');
                    }
                    const original = window.ws.duetFeedOverride;
                    try {
                        document.getElementById('feed-ovr').previousElementSibling.click();
                        await waitOverride(Math.max(10, original - 10));
                        document.getElementById('feed-ovr').nextElementSibling.nextElementSibling.click();
                        await waitOverride(100);
                        document.querySelector('[data-tab="settings-view"]').click();
                        for (let i = 0; i < 50 && !document.getElementById('duet-axis-rows').children.length; i++) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        document.querySelector('[data-duet-settings-nav="Spindle"]').click();
                        await window.ws.readDuetSpindles();
                        const spindle = document.getElementById('duet-spindle-status');
                        if (!spindle.getClientRects().length || spindle.textContent !== 'No spindles configured.') {
                            throw new Error('Duet spindle status: ' + spindle.textContent + ' (visible: ' + Boolean(spindle.getClientRects().length) + ')');
                        }

                        const search = document.getElementById('duet-settings-search');
                        search.value = 'maximum travel';
                        search.dispatchEvent(new Event('input'));
                        if (!spindle.closest('tr').hidden ||
                            !document.querySelector('#duet-axis-rows input[aria-label="X-axis maximum travel"]').getClientRects().length) {
                            throw new Error('Settings search did not filter across groups');
                        }
                        document.querySelector('[data-duet-settings-nav="X-axis"]').click();
                        console.log('Duet settings loaded');
                        if (document.getElementById('duet-settings-actions').disabled) throw Error('Duet Settings disabled over HTTP');
                        const axes = document.getElementById('duet-axis-rows');
                        if (!axes.getClientRects().length || !axes.textContent.includes('X-axis maximum travel') || ![...axes.querySelectorAll('input')].some(input => input.getAttribute('aria-label') === 'X-axis maximum travel' && input.valueAsNumber === 270)) {
                            throw new Error('Duet Settings did not display the bench axis readback');
                        }
                        const edit = axes.querySelector('input[aria-label="X-axis maximum travel"]');
                        edit.value = '271';
                        edit.dispatchEvent(new Event('input'));
                        window.switchTab('viewer-view');
                        window.switchTab('settings-view');
                        if (!edit.isConnected || edit.value !== '271') throw Error('Switching tabs discarded the edit');
                        const save = document.getElementById('duet-save-settings');
                        if (save.disabled) throw Error('Edited Duet row did not enable Save');
                        if (window.ws.duetState === 'O') {
                            save.click();
                            window.reporter.domFooter.querySelector('.btn-primary').click();
                            const status = document.getElementById('duet-axis-settings');
                            for (let i = 0; i < 35 && !status.textContent.includes('powered and idle'); i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (!status.textContent.includes('powered and idle')) throw Error('Off controller did not reject settings write');
                        }
                        const refresh = [...document.querySelectorAll('#settings-view button')]
                            .find(button => button.getClientRects().length && button.textContent.trim() === 'Refresh');
                        refresh.click();
                        if (!window.reporter.domBody.textContent.includes('discards your unsaved edits')) throw Error('Refresh confirmation missing');
                        window.reporter.closeModal();
                        if (edit.value !== '271' || !edit.isConnected) throw Error('Cancelling Refresh lost the edit');
                        refresh.click();
                        window.reporter.domFooter.querySelector('.btn-primary').click();
                        for (let i = 0; i < 50 && edit.isConnected; i++) await new Promise(resolve => setTimeout(resolve, 100));
                        if (edit.isConnected || axes.querySelector('input[aria-label="X-axis maximum travel"]')?.valueAsNumber !== 270) {
                            throw Error('Refresh did not restore the controller value');
                        }
                        const selector = document.getElementById('wcs-select');
                        const readWorkplace = async () => (await window.ws.duet.call('model', { key: 'move.workplaceNumber' })).result;
                        const originalWorkplace = await readWorkplace();
                        const selectWorkplace = async number => {
                            selector.value = 'G' + (54 + number);
                            selector.dispatchEvent(new Event('change', { bubbles: true }));
                            for (let i = 0; i < 20; i++) {
                                if (await readWorkplace() === number) return;
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            throw new Error('Duet did not select workplace ' + number);
                        };
                        if (!Number.isInteger(originalWorkplace) || originalWorkplace < 0 || originalWorkplace > 5) {
                            throw new Error('Unexpected initial workplace');
                        }
                        try {
                            await selectWorkplace(originalWorkplace === 1 ? 0 : 1);
                        } finally {
                            await selectWorkplace(originalWorkplace);
                        }
                        const handler = window.macroHandler;
                        const index = handler.macros.push({ name: 'Bench read-only', gcode: 'M115\\nM552' }) - 1;
                        const sent = [];
                        const onSent = line => {
                            if (line === 'M115' || line === 'M552') sent.push(line);
                        };
                        window.ws.on('sent', onSent);
                        try {
                            await handler.run(index);
                            if (sent.join(',') !== 'M115,M552') throw Error('Expected M115,M552 from Duet macro, got ' + JSON.stringify(sent));
                        } finally {
                            window.ws.off('sent', onSent);
                            handler.macros.pop();
                        }
                        const wcsVerified = true;

                        document.getElementById('sd-tab-btn').click();
                        await window.sdHandler.refresh();
                        for (let i = 0; i < 35 && !document.querySelector('#sd-table tr[data-dirpath="/sys"]'); i++) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        const system = document.querySelector('#sd-table tr[data-dirpath="/sys"]');
                        if (!system) throw new Error('SD tab did not show the Duet system directory');
                        const duet = window.ws.duet;
                        document.querySelector('[data-tab="viewer-view"]').click();
                        const jobName = '/gcodes/ooznest-progress-' + Date.now() + '.gcode';
                        await duet.call('upload', { name: '0:' + jobName }, new TextEncoder().encode('G4 P500\\n'.repeat(32)));
                        let progress = 0;
                        const bar = document.getElementById('job-progress-bar');
                        const observe = () => {
                            if (bar.getClientRects().length) progress = Math.max(progress, parseFloat(bar.style.width) || 0);
                        };
                        window.addEventListener('sd-status', observe);
                        const originalCall = duet.call;
                        let filenameDelayed = false;
                        const filenameReplies = [];
                        duet.call = function (endpoint, params, body) {
                            if (!filenameDelayed && endpoint === 'model' && params?.key === 'job.file.fileName') {
                                filenameDelayed = true;
                                return Promise.reject(new Error('Simulated filename HTTP failure'));
                            }
                            const response = originalCall.call(this, endpoint, params, body);
                            if (endpoint !== 'model' || params?.key !== 'job.file.fileName') return response;
                            return response.then(reply => {
                                filenameReplies.push(reply);
                                return reply;
                            });
                        };
                        try {
                            await window.sdHandler._changeDirectory('/gcodes');
                            const jobFile = jobName.split('/').pop();
                            const row = document.querySelector('#sd-table tr[data-filename="' + jobFile + '"]');
                            if (!row) throw new Error('Temporary SD job was not listed');
                            window.sdHandler.runFile(jobFile);
                            window.reporter.domFooter.querySelector('.btn-primary').click();
                            for (let i = 0; i < 40 && window.currentSDFile !== jobName; i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (window.currentSDFile !== jobName || !window.currentGCodeContent?.includes('G4 P500')) {
                                throw new Error('Duet SD preview did not load the expected job');
                            }
                            for (let i = 0; i < 40 && !window.reporter.domBody.textContent.includes('Run now?'); i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (!window.reporter.domBody.textContent.includes('Run now?') || window.jobController.sdJobActive) {
                                throw new Error('Load & View did not wait for Run confirmation');
                            }
                            window.reporter.closeModal();
                            window.sdHandler.runFile(jobFile);
                            [...window.reporter.domFooter.querySelectorAll('button')].find(button => button.textContent.trim() === 'No').click();
                            [...window.reporter.domFooter.querySelectorAll('button')].find(button => button.textContent.trim() === 'Run Now').click();
                            const load = document.getElementById('duet-preview-job');
                            for (let i = 0; i < 120 && !load.getClientRects().length; i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (!filenameDelayed || !load.getClientRects().length) {
                                throw new Error('Load Current Job unavailable: ' + JSON.stringify({
                                    filenameDelayed, filename: window.ws.duetJobFile ?? null,
                                    active: window.jobController.sdJobActive, progress, filenameReplies
                                }));
                            }
                            window.currentSDFile = null;
                            window.sdHandler.pendingRunFile = jobFile;
                            load.click();
                            for (let i = 0; i < 40 && window.currentSDFile !== jobName; i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (window.currentSDFile !== jobName) throw new Error('Load Current Job did not open the SD file');
                            const rejectStart = error => { startError = error.message; };
                            let startError;
                            window.ws.on('error', rejectStart);
                            try {
                                await window.ws.sendCommand('$F=/gcodes/missing-bench-file.gcode');
                                if (!startError?.includes('Wait for the current job')) throw new Error('Second SD start was not blocked');
                            } finally {
                                window.ws.off('error', rejectStart);
                            }
                            await new Promise(resolve => setTimeout(resolve, 600));
                            if (window.sdHandler.pendingRunFile !== null || window.reporter.domBody.textContent.includes('Run now?')) {
                                throw new Error('Load Current Job retained a stale Run request or opened a Run prompt');
                            }
                            document.querySelector('[onclick="window.unloadDuetPreview()"]').click();
                            if (window.currentSDFile !== jobName || !document.body.textContent.includes('Wait for the job or download to finish before unloading.')) {
                                throw new Error('Unload did not preserve the active preview and explain why');
                            }
                            document.getElementById('stop-job-btn').click();
                            window.reporter.domFooter.querySelector('.btn-primary').click();
                            const stopMessage = 'Pause the job before stopping it.';
                            for (let i = 0; i < 25 && !document.getElementById('toast-container').textContent.includes(stopMessage); i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (!document.getElementById('toast-container').textContent.includes(stopMessage)) {
                                throw new Error('Stop did not explain that the job must be paused');
                            }
                            for (let i = 0; i < 190; i++) {
                                if (progress > 0 && !window.jobController.sdJobActive) break;
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (!(progress > 0 && progress <= 100) || window.jobController.sdJobActive) {
                                throw new Error('SD job progress did not advance and clear');
                            }
                            document.querySelector('[onclick="window.unloadDuetPreview()"]').click();
                            if (window.currentSDFile !== null || window.currentGCodeContent !== null || window.editor.getValue() !== '') {
                                throw new Error('Unload G-code left a file loaded');
                            }
                            const remaining = await duet.call('download', { name: '0:' + jobName });
                            if (!new TextDecoder().decode(remaining).includes('G4 P500')) throw new Error('Unload changed the SD file');
                            if (window.ws.duetState === 'O') {
                                pauseStop = 'skipped: Duet reports Off';
                            } else {
                            await window.ws.sendCommand('$F=' + jobName);
                            try {
                                for (let i = 0; i < 50 && !window.jobController.sdJobActive; i++) {
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                }
                                if (!window.jobController.sdJobActive) throw new Error('Pause fixture did not start');
                                const pauseButton = document.getElementById('pause-job-btn');
                                pauseButton.click();
                                for (let i = 0; i < 50 && pauseButton.textContent.trim() !== 'Resume'; i++) {
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                }
                                if (pauseButton.textContent.trim() !== 'Resume' || window.ws.duetState !== 'A') {
                                    throw new Error('Pause did not reflect the Duet paused state');
                                }
                                document.getElementById('stop-job-btn').click();
                                window.reporter.domFooter.querySelector('.btn-primary').click();
                                for (let i = 0; i < 50 && window.jobController.sdJobActive; i++) {
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                }
                                if (window.jobController.sdJobActive) throw new Error('Stop did not clear the paused job');
                                pauseStop = 'passed';
                            } finally {
                                const activeFile = await duet.call('model', { key: 'job.file.fileName' });
                                if (activeFile.result === '0:' + jobName) await duet.send('M0 H1');
                            }
                            }
                        } catch (error) {
                            console.error('SD job verification failed:', error.message);
                            throw error;
                        } finally {
                            window.removeEventListener('sd-status', observe);
                            duet.call = originalCall;
                            for (let attempt = 0; ; attempt++) {
                                try {
                                    await duet.call('delete', { name: '0:' + jobName });
                                    break;
                                } catch (error) {
                                    if (attempt === 14) {
                                        console.error('Could not remove temporary SD job', jobName, error.message);
                                        throw error;
                                    }
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                }
                            }
                        }
                        document.querySelector('[data-tab="settings-view"]').click();
                        await window.sdHandler.editDuetFile('config-network.g', '/sys');
                        for (let i = 0; i < 60 && document.getElementById('editor-file-name').textContent.trim() !== 'config-network.g'; i++) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        if (document.getElementById('editor-file-name').textContent.trim() !== 'config-network.g' || !window.editor.getValue().includes('M552')) {
                            throw new Error('Network config did not open in the editor');
                        }
                        const filename = "ooznest-editor-check-&'-" + Date.now() + '.txt';
                        const name = '0:/sys/' + filename;
                        const renamed = 'renamed ' + filename;
                        const renamedPath = '0:/sys/' + renamed;
                        const content = '; Editor verification';
                        await duet.call('upload', { name }, new TextEncoder().encode(content));
                        try {
                            await window.sdHandler._changeDirectory('/sys');
                            const row = document.querySelector('#sd-table tr[data-filename="' + filename + '"]');
                            if (!row) throw new Error('Temporary system file was not listed');
                            row.querySelector('[aria-label="Rename"]').click();
                            const input = document.getElementById('cnc-modal-input');
                            if (input?.value !== filename) throw new Error('Rename prompt did not show the original name');
                            input.value = renamed;
                            window.reporter.domFooter.querySelector('.btn-primary').click();
                            const renamedSelector = '#sd-table tr[data-filename="' + renamed + '"]';
                            for (let i = 0; i < 40 && !document.querySelector(renamedSelector); i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (!document.querySelector(renamedSelector)) throw new Error('Renamed file was not listed');
                            if (new TextDecoder().decode(await duet.call('download', { name: renamedPath })) !== content) {
                                throw new Error('Renamed file contents changed');
                            }
                            await duet.call('move', { old: renamedPath, new: name, deleteexisting: 'no' });
                            await window.sdHandler._changeDirectory('/sys');
                            document.querySelector('#sd-table tr[data-filename="' + filename + '"] [aria-label="Edit file"]').click();
                            for (let i = 0; i < 40 && window.editor.getValue() !== content; i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (window.editor.getValue() !== content) throw new Error('System file did not open in editor');
                            const revised = content + ' updated';
                            document.getElementById('editor-upload-sd-btn').click();
                            const staleConfirm = window.reporter.domFooter.querySelector('.btn-primary');
                            if (!staleConfirm) throw new Error('System file confirmation missing');
                            window.editor.setValue(revised);
                            const originalEditorCall = duet.call;
                            let attemptedStaleUpload = false;
                            duet.call = function (endpoint, params, body) {
                                if (endpoint === 'upload' && params?.name === name) attemptedStaleUpload = true;
                                return originalEditorCall.call(this, endpoint, params, body);
                            };
                            try {
                                staleConfirm.click();
                                await Promise.resolve();
                                if (attemptedStaleUpload) throw new Error('Stale system file confirmation attempted an upload');
                                if (!document.getElementById('toast-container').textContent.includes('Save cancelled because the editor or connection changed')) {
                                    throw new Error('Stale save did not explain why it was cancelled');
                                }
                            } finally {
                                duet.call = originalEditorCall;
                            }
                            const unchanged = new TextDecoder().decode(await duet.call('download', { name }));
                            if (unchanged !== content) throw new Error('Stale confirmation changed the system file');
                            await window.sdHandler._changeDirectory('/');
                            document.getElementById('editor-upload-sd-btn').click();
                            const confirm = window.reporter.domFooter.querySelector('.btn-primary');
                            if (!confirm || !window.reporter.domBody.textContent.includes(name)) {
                                throw new Error('Save did not target the original system file');
                            }
                            confirm.click();
                            for (let i = 0; i < 40 && getComputedStyle(window.reporter.overlay).display !== 'none'; i++) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                            }
                            if (getComputedStyle(window.reporter.overlay).display !== 'none') {
                                throw new Error('System file save did not finish');
                            }
                            const saved = new TextDecoder().decode(await duet.call('download', { name }));
                            if (saved !== revised) throw new Error('System file save did not round-trip; WCS verified: ' + wcsVerified);
                            const uploadButton = document.getElementById('editor-upload-sd-btn');
                            const originalUpload = uploadButton.onclick;
                            window.loadGCode('G4 P500', filename);
                            uploadButton.click();
                            if (uploadButton.onclick === originalUpload || window.reporter.domBody.textContent.includes(name)) {
                                throw new Error('Local file retained the system file upload action');
                            }
                            window.reporter.closeModal();
                        } finally {
                            await duet.call('delete', { name }).catch(() => {});
                            await duet.call('delete', { name: renamedPath }).catch(() => {});
                        }
                    } finally {
                        await window.ws.sendCommand('M220 S' + original);
                        await waitOverride(original);
                        await window.ws.disconnect();
                    }
                }
                if (document.getElementById('duet-axis-rows').children.length) throw Error('Duet settings survived disconnect');
                window.setConnectionType('usb');
                const port = document.getElementById('port-node');
                for (let i = 0; i < 35 && ![...port.options].some(option => option.value === 'COM22'); i++) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                port.value = 'COM22';
                if (port.value !== 'COM22') throw new Error('COM22 is missing from desktop USB ports');
                window.store.set('jog.continuous', true);
                await window.ws.connect();
                try {
                    for (let i = 0; i < 55 && !window.ws.duetState; i++) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    if (!window.ws.isDuetSerial || !window.ws.duetState) {
                        throw new Error('COM22 firmware identification or status timed out');
                    }
                    await window.troubleshootingInfo.render();
                    const info = document.getElementById('trouble-tab-info-content').textContent;
                    if (!info.includes('Duet Ethernet') || !info.includes(window.ws.duetFirmwareInfo.version)) {
                        throw new Error('Troubleshooting Info did not show the COM22 board and firmware');
                    }
                    if (!['X', 'Y', 'Z'].every(axis => info.includes(axis + ' Axis: Not homed'))) {
                        throw new Error('Troubleshooting Info did not show the unhomed COM22 axes');
                    }
                    document.querySelector('[data-tab="sd-view"]').click();
                    if (!document.getElementById('duet-sd-usb-help').getClientRects().length) {
                        throw new Error('SD Card tab did not show HTTP connection guidance over COM22');
                    }
                    const jogMode = document.getElementById('jogContinuous');
                    if (jogMode.checked || !jogMode.disabled || jogMode.getClientRects().length) {
                        throw new Error('COM22 did not suppress the saved continuous jog preference');
                    }
                    if (document.getElementById('machine-state').textContent.trim().toLowerCase() !== 'off' || !document.getElementById('machine-state').classList.contains('status-warn')) throw new Error('COM22 did not show Off');
                    const original = window.ws.duetFeedOverride;
                    if (!Number.isFinite(original)) throw new Error('COM22 feed override missing');
                    const waitForOverride = async value => {
                        for (let i = 0; i < 35; i++) {
                            if (window.ws.duetFeedOverride === value) return;
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        throw new Error('COM22 feed override did not reach ' + value);
                    };
                    try {
                        await window.ws.sendCommand('M220 S' + (original === 90 ? 100 : 90));
                        await waitForOverride(original === 90 ? 100 : 90);
                    } finally {
                        await window.ws.sendCommand('M220 S' + original);
                        await waitForOverride(original);
                    }
                    const macros = window.macroHandler;
                    const macroIndex = macros.macros.push({ name: 'USB bench queries', gcode: 'M115\\nM552' }) - 1;
                    const acknowledgements = [];
                    const onResult = ({ command, response }) => {
                        if (['M115', 'M552'].includes(command) && response === 'ok') acknowledgements.push(command);
                    };
                    window.ws.on('command-result', onResult);
                    try {
                        await macros.run(macroIndex);
                        for (let i = 0; i < 40 && acknowledgements.length < 2; i++) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        if (acknowledgements.join(',') !== 'M115,M552') throw Error('USB macro acknowledgements missing or out of order');
                    } finally {
                        window.ws.off('command-result', onResult);
                        macros.macros.pop();
                    }
                    window.switchTab('settings-view');
                    if (document.getElementById('duet-settings-actions').disabled) throw Error('USB Settings disabled');
                    document.querySelector('[data-duet-settings-nav="Y-axis"]').click();
                    const axisRows = document.getElementById('duet-axis-rows');
                    const travel = () => axisRows.querySelector('input[aria-label="Y-axis maximum travel"]');
                    for (let i = 0; i < 50 && !travel(); i++) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    const ganged = axisRows.querySelector('input[aria-label="Ganged Y-motor travel resolution"]');
                    if (travel()?.valueAsNumber !== 270 || ganged?.valueAsNumber !== 400 || !ganged.getClientRects().length) {
                        throw Error('USB Settings did not show live Y travel and ganged motor resolution');
                    }
                    if (window.ws.duetState === 'O') {
                        const edit = travel();
                        edit.value = '271';
                        edit.dispatchEvent(new Event('input'));
                        document.getElementById('duet-save-settings').click();
                        if (!window.reporter.domBody.textContent.includes('for this session')) {
                            throw Error('USB Settings did not explain session-only writes');
                        }
                        window.reporter.domFooter.querySelector('.btn-primary').click();
                        if (!document.getElementById('duet-axis-settings').textContent.includes('powered and idle')) {
                            throw Error('Off controller did not reject USB settings write');
                        }
                        edit.value = '270';
                        edit.dispatchEvent(new Event('input'));
                    }
                    const settingsTitle = document.getElementById('duet-settings-group-title');
                    document.querySelector('[data-duet-settings-nav="Networking"]').click();
                    if (settingsTitle.textContent.trim() !== 'Networking') throw Error('USB Networking group did not open');
                    document.querySelector('[data-duet-settings-nav="Ethernet"]').click();
                    if (settingsTitle.textContent.trim() !== 'Ethernet' ||
                        !document.getElementById('duet-network-controls').getClientRects().length) {
                        throw Error('USB Ethernet settings did not open');
                    }
                    const netForm = document.getElementById('duet-network-form');
                    netForm.elements.mode.value = 'dhcp';
                    netForm.requestSubmit();
                    if (!window.reporter.domBody.textContent.includes('HTTP address field will be cleared')) {
                        throw new Error('DHCP confirmation did not explain the address change');
                    }
                    window.reporter.closeModal();
                    netForm.reset();
                    const pendingLines = [];
                    const onPending = line => pendingLines.push(line);
                    window.ws.on('line', onPending);
                    try {
                        window.ws.handleSerialLine('Network is enabled, configured IP address: 0.0.0.0, actual IP address: 0.0.0.0');
                        if (!pendingLines.some(line => line.includes('waiting for a DHCP address'))) {
                            throw new Error('DHCP pending message missing');
                        }
                    } finally {
                        window.ws.off('line', onPending);
                    }
                    if (document.getElementById('duet-network-controls').hidden) throw Error('Networking hidden over COM22');
                    if (netForm.elements.ssid.getClientRects().length) throw Error('Wi-Fi input visible on Ethernet');
                    const address = document.getElementById('ip-telnet');
                    address.value = '';
                    let networkReply = '';
                    const onLine = line => {
                        if (/actual IP address/i.test(line)) networkReply = line;
                    };
                    window.ws.on('line', onLine);
                    try {
                        netForm.elements.enabled.value = '1';
                        netForm.requestSubmit();
                        window.reporter.domFooter.querySelector('.btn-primary').click();
                        for (let i = 0; i < 35 && !networkReply; i++) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        if (!networkReply.includes('192.168.251.2') ||
                            document.getElementById('console-view').classList.contains('hidden')) {
                            throw new Error('Network Info did not open Console and report the bench IP');
                        }
                    } finally {
                        window.ws.off('line', onLine);
                    }
                    if (address.value !== '192.168.251.2') throw Error('USB did not fill HTTP address');
                    window.switchTab('settings-view');
                    netForm.elements.mode.value = 'static';
                    netForm.elements.address.value = address.value;
                    netForm.requestSubmit();
                    if (!window.reporter.domBody.textContent.includes(address.value)) throw Error('Static IP confirmation missing');
                    window.reporter.domFooter.querySelector('.btn-primary').click();
                    for (let i = 0; i < 60 && address.value !== '192.168.251.2'; i++) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                    if (address.value !== '192.168.251.2') throw Error('Static IP did not return over USB');

                } finally {
                    await window.ws.disconnect();
                }
                for (let i = 0; i < 50 && window.ws.isConnected; i++) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (window.ws.isConnected) throw new Error('COM22 disconnect acknowledgement timed out');
                if (window.ws.duetProbeKnown) throw new Error('Probe input did not clear on disconnect');
                if (document.getElementById('machine-state').textContent !== 'Offline' || document.getElementById('machine-state').classList.contains('status-idle')) throw new Error('COM22 disconnect did not show Offline');
                window.setConnectionType('telnet');
                await window.ws.connect();
                try {
                    if (!window.ws.duet || !window.ws.isConnected || !window.ws.duetState) {
                        throw new Error('HTTP reconnect using USB-discovered IP failed');
                    }
                } finally {
                    await window.ws.disconnect();
                }
                if (document.getElementById('machine-state').textContent !== 'Offline' || document.getElementById('machine-state').classList.contains('status-idle')) throw new Error('HTTP disconnect did not show Offline');
                if (window.troubleshooting.lastHomingMask !== null) throw new Error('Homing status survived disconnect');
                return { connected, usb: true, pauseStop };
            })()`);
            const { pauseStop, ...connections } = bench;
            assert.ok(['passed', 'skipped: Duet reports Off'].includes(pauseStop));
            assert.deepEqual({ ...result, ...connections }, { startup: false, opened: true, closed: true, connected: true, usb: true });
            writeSync(1, JSON.stringify({ ...result, ...bench }) + "\n");
            process.exit(0);
        } catch (error) {
            console.error(error);
            app.exit(1);
        }
    });
});
setTimeout(() => {
    console.error('Startup timeout', { ready: app.isReady(), lock: app.hasSingleInstanceLock() });
    app.exit(1);
}, 60000);
console.log('Loading main.js');
require('./main.js');
console.log('main.js loaded');
