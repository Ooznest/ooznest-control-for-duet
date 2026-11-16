import { DuetHttp, duetCommand, duetProbeRoutine, duetCornerProbeRoutine, duetOutsideCornerRoutine } from './duet-http.mjs';
import { GrblFlowControl } from './grbl-flow-control.js?v=20261016';
import { registerModal } from '../ui/modal.js';

export class ConnectionManager {
    constructor(webSerial) {
        this.webSerial = webSerial;
        this.flowControl = new GrblFlowControl(this);
        this.type = 'webserial'; // 'webserial', 'usb', 'telnet'
        this.backendWs = null;
        this.isElectron = window.electron !== undefined;
        // cordova.js loads async, so window.cordova may not exist yet at
        // construction time. Default to false and upgrade on deviceready;
        // also detect a Cordova file:// context synchronously when possible.
        this.isCordova = typeof window !== 'undefined' && !!window.cordova;
        if (!this.isCordova && typeof location !== 'undefined' && location.protocol === 'file:') {
            this.isCordova = true;
        }
        this.hasBackend = this.isElectron;
        this.httpBaseUrl = null;
        this._scanning = false;
        this._cordovaTelnetSocketId = null;
        this._isConnecting = false;
        // Direct connection mode â€” skip the connect modal entirely
        this._isDirectMode = false;

        this.listeners = {
            connect: [],
            disconnect: [],
            line: [],
            sent: [],
            'command-result': [],
            error: [],
            firmware: [],
            ports: []
        };
        this._backendBuffer = '';
        this._connectionGeneration = 0;

        // UI element references
        this.modal = document.getElementById('connection-modal');
        this.modalController = registerModal(this.modal, { closeOnBackdrop: true, closeOnEscape: true });
        this.btnConnect = document.getElementById('btn-connect');

        // Expose globals for UI callbacks
        window.toggleConnectionModal = () => this.toggleModal();
        window.setConnectionType = (type) => this.setConnectionType(type);
        window.handleConnectClick = () => this.connect();
        window.refreshNodePorts = () => this.refreshNodePorts();
        window.scanTelnetNetwork = () => this.openTelnetScanner();
        window.openTelnetScanner = () => this.openTelnetScanner();
        window.closeTelnetScanner = () => this.closeTelnetScanner();
        window.startTelnetScanNetwork = () => this.startTelnetScanNetwork();
        window.updateTelnetScanStartState = () => this.updateTelnetScanStartState();

        // If we have a backend, initiate sync connection immediately
        if (this.hasBackend) {
            this.connectToBackend().catch(err => {
                console.log("Remote Mirror: Backend not available yet, will retry on interaction.");
            });
        }

        this.init();
    }

    get isConnected() {
        return this._isConnected;
    }

    set isConnected(val) {
        this._isConnected = val;
    }

    get isConnecting() {
        return this._isConnecting;
    }

    get isBrowserRuntime() {
        return !this.isElectron && !this.isCordova;
    }

    init() {
        const saved = this.loadSettings();
        if (saved) {
            if (saved.webserialBaud && document.getElementById('baud-webserial')) document.getElementById('baud-webserial').value = saved.webserialBaud;
            if (saved.usbBaud && document.getElementById('baud-node')) document.getElementById('baud-node').value = saved.usbBaud;
            const interval = document.getElementById('duet-poll-interval');
            if (interval && Number.isFinite(saved.duetPollInterval)) {
                interval.value = saved.duetPollInterval;
                if (interval.checkValidity()) this.duetPollInterval = interval.valueAsNumber;
                else interval.value = interval.defaultValue;
            }
            if (saved.telnetIp && document.getElementById('ip-telnet')) document.getElementById('ip-telnet').value = saved.telnetIp;
            if (saved.telnetPort && document.getElementById('port-telnet')) document.getElementById('port-telnet').value = saved.telnetPort;
            if (saved.websocketUrl && document.getElementById('url-websocket')) {
                document.getElementById('url-websocket').value = saved.websocketUrl;
            }
        }
        const savedConnectionType = this._getSavedConnectionType(saved);

        // Intercept connect button click
        if (this.btnConnect) {
            this.btnConnect.onclick = () => {
                if (this.isConnected || this.isConnecting) {
                    this.disconnect();
                } else if (this._isDirectMode) {
                    this.connect();
                } else {
                    this.toggleModal();
                }
            };
        }

        // Initialize WebSerial listeners
        this.webSerial.on('connect', () => this.handleConnect());
        this.webSerial.on('disconnect', () => this.handleDisconnect());
        this.webSerial.on('line', line => this.handleSerialLine(line));
        this.webSerial.on('error', (err) => this.emit('error', err));
        this.webSerial.on('sent', line => {
            if (!/^M587\s/i.test(line)) this.emit('sent', line);
        });
        this.webSerial.on('command-result', (result) => {
            if (result.command === 'M408 S0') this.duetSerialPollPending = false;
            if (this.isDuetSerial && /^G5[4-9]$/i.test(result.command)) {
                this.sendCommand('M409 K"move.workplaceNumber"').catch(error => this.emit('error', error));
            }
            this.emit('command-result', result);
        });

        // Always listen for deviceready - cordova.js loads asynchronously
        // so window.cordova is not defined at constructor time.
        document.addEventListener("deviceready", () => {
            console.log("Cordova deviceready fired!");
            this.isCordova = true;
            this.hasBackend = true;
            this._isDirectMode = false;
            this.initCordova();

            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            const wsTab = document.getElementById('tab-websocket');
            const wsSerialTab = document.getElementById('tab-webserial');
            if (usbTab) usbTab.classList.remove('hidden');
            if (telnetTab) telnetTab.classList.remove('hidden');
            if (wsTab) wsTab.classList.add('hidden');
            if (wsSerialTab) wsSerialTab.classList.add('hidden');

            this.setConnectionType(savedConnectionType || 'usb');

            // Auto-discover grblHAL Telnet devices on local network
            setTimeout(() => {
                this._discoverTelnetDevices().then(devices => {
                    // Never steal an active (e.g. USB) session: only auto-connect
                    // when the user hasn't already connected.
                    if (this.isConnected || this.isConnecting) {
                        console.log("Skipping Telnet auto-connect: already connected/connecting");
                        return;
                    }
                    if (devices.length === 1) {
                        console.log("Auto-discovered 1 Telnet device:", devices[0]);
                        this._autoConnectTelnet(devices[0]);
                    } else if (devices.length > 1) {
                        console.log("Auto-discovered multiple Telnet devices:", devices);
                        this._showDiscoveredDevices(devices);
                    } else {
                        console.log("No Telnet devices discovered on network");
                    }
                });
            }, 2000);
        }, false);

        // UI initialization based on hosting environment
        if (this.isElectron) {
            const tb = document.getElementById('electron-title-bar');
            if (tb) tb.classList.remove('hidden');
            this.setConnectionType(savedConnectionType || 'usb');
        }

        if (this.isElectron || this.isCordova) {
            const wsSerialTab = document.getElementById('tab-webserial');
            const wsTab = document.getElementById('tab-websocket');
            if (wsSerialTab) wsSerialTab.classList.add('hidden');
            if (wsTab) wsTab.classList.add('hidden');
        }

        if (this.isCordova) {
            // Cordova context detected synchronously (file:// before deviceready):
            // show native tabs immediately and default to USB so the modal never
            // opens with zero -- or two -- highlighted tabs.
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.remove('hidden');
            if (telnetTab) telnetTab.classList.remove('hidden');
            this.setConnectionType(savedConnectionType || 'usb');
        }

        if (this.isBrowserRuntime) {
            // Browser runtime uses native WebSerial unless SD mode exposes controller WebSocket.
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.add('hidden');
            if (telnetTab) telnetTab.classList.add('hidden');

            this.setConnectionType('webserial');

            // Probe for SD card mode: if grblHAL's WebSocket responds on port 81,
            // we're being served from the controller's own filesystem
            this._probeSDMode();
        }
    }

    saveSettings() {
        if (typeof localStorage === 'undefined') return;
        try {
            const settings = {
                connectionType: this.type,
                webserialBaud: document.getElementById('baud-webserial')?.value,
                usbPort: document.getElementById('port-node')?.value,
                usbBaud: document.getElementById('baud-node')?.value,
                telnetIp: document.getElementById('ip-telnet')?.value,
                duetPollInterval: this.duetPollInterval,
                telnetPort: document.getElementById('port-telnet')?.value,
                websocketUrl: document.getElementById('url-websocket')?.value
            };
            localStorage.setItem('cnc_connection_settings', JSON.stringify(settings));
        } catch (e) {
            console.error("Error saving connection settings:", e);
        }
    }

    loadSettings() {
        if (typeof localStorage === 'undefined') return null;
        try {
            const stored = localStorage.getItem('cnc_connection_settings');
            if (stored) return JSON.parse(stored);
        } catch (e) {
            console.error("Error loading connection settings:", e);
        }
        return null;
    }

    _getSavedConnectionType(saved = null) {
        const settings = saved || this.loadSettings();
        const type = settings?.connectionType;
        if (!type) return null;

        if (this.isElectron || this.isCordova) {
            return ['usb', 'telnet'].includes(type) ? type : null;
        }

        if (this.isBrowserRuntime) {
            return ['webserial', 'websocket'].includes(type) ? type : null;
        }

        return null;
    }

    toggleModal() {
        if (this.isBrowserRuntime && !this.isConnected && !this._isDirectMode) {
            this.setConnectionType('webserial');
            return this.connect();
        }
        if (!this.modalController) return;
        // In direct mode only allow closing, never opening the modal
        if (this._isDirectMode && !this.modalController.isOpen()) return;
        this.modalController.toggle();

        if (this.modalController.isOpen()) {
            // On native shells the WebSerial/WebSocket tabs are hidden â€” never
            // leave the modal highlighting a hidden tab. Coerce to USB.
            if ((this.isElectron || this.isCordova) && (this.type === 'webserial' || this.type === 'websocket')) {
                this.type = 'usb';
            }
            this.setConnectionType(this.type);
        }

        // If showing USB tab and in Electron, refresh ports
        if (this.modalController.isOpen() && this.type === 'usb' && this.isElectron) {
            this.refreshNodePorts();
        }

        // Auto-hide connection tabs that don't apply to current platform
        if (this.isBrowserRuntime) {
            const usbTab = document.getElementById('tab-usb');
            const telnetTab = document.getElementById('tab-telnet');
            if (usbTab) usbTab.classList.add('hidden');
            if (telnetTab) telnetTab.classList.add('hidden');
            if (this.type !== 'websocket') {
                this.setConnectionType('webserial');
            }
        } else if (this.isElectron || this.isCordova) {
            const wsSerialTab = document.getElementById('tab-webserial');
            const wsTab = document.getElementById('tab-websocket');
            if (wsSerialTab) wsSerialTab.classList.add('hidden');
            if (wsTab) wsTab.classList.add('hidden');
        }

        if (this.isElectron) {
            const tb = document.getElementById('electron-title-bar');
            if (tb) tb.classList.remove('hidden');
        }
    }

    setConnectionType(type) {
        this.type = type;
        this.updateStreamingDescription();

        // Enforce exactly one highlighted tab: clear stale .active classes
        // first (e.g. left over on a now-hidden tab), then highlight only the
        // selected visible tab. Without this the modal can show two green tabs.
        const allTabBtns = document.querySelectorAll('#connection-modal .connection-modal__tabs .tab-btn');
        allTabBtns.forEach(btn => btn.classList.remove('active'));

        // Update Tabs
        ['webserial', 'usb', 'telnet', 'websocket'].forEach(t => {
            const tab = document.getElementById(`tab-${t}`);
            const config = document.getElementById(`config-${t}`);
            if (!tab || !config) return;

            if (t === type) {
                tab.classList.add('active');
                config.classList.remove('hidden');

                if (type === 'usb' && this.isCordova) {
                    const portContainer = document.getElementById('usb-port-container');
                    if (portContainer) portContainer.classList.add('hidden');
                } else if (type === 'usb') {
                    const portContainer = document.getElementById('usb-port-container');
                    if (portContainer) portContainer.classList.remove('hidden');
                }
            } else {
                tab.classList.remove('active');
                config.classList.add('hidden');
            }
        });

        if (type === 'usb' && this.isElectron) {
            this.refreshNodePorts().catch(() => {});
        }

        this.saveSettings();
    }

    updateStreamingDescription() {
        const description = document.getElementById('run-job-streaming-description');
        if (!description) return;

        description.textContent = this.type === 'webserial'
            ? 'Stream lines directly from your browser'
            : 'Stream lines directly from the application';
    }

    async _probeSDMode() {
        const url = `ws://${window.location.hostname}:81/ws`;
        let ws;
        try {
            await new Promise((resolve, reject) => {
                ws = new WebSocket(url);
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error('timeout'));
                }, 1500);
                ws.onopen = () => {
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                };
                ws.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error('connection failed'));
                };
            });
            // Probe succeeded â€” we're in SD card mode
            this.setConnectionType('websocket');
            const wsUrlInput = document.getElementById('url-websocket');
            if (wsUrlInput) wsUrlInput.value = url;
            this.httpBaseUrl = window.location.origin;
            setTimeout(() => this.connect(), 300);
        } catch {
            // Probe failed â€” regular web mode, stay on webserial
        }
    }

    connectToBackend() {
        if (this._connecting) return this._connecting;
        this._connecting = new Promise((resolve, reject) => {
            // If hostname is empty (e.g., file:// or some edge cases), default to localhost
            const host = window.location.hostname || 'localhost';
            const port = this.isElectron ? window.location.port : '8081';
            const wsUrl = `ws://${host}:${port}`;

            console.log("Remote Mirror: Syncing with backend at", wsUrl);

            this.backendWs = new WebSocket(wsUrl);

            this.backendWs.onopen = () => {
                console.log("Remote Mirror: Success. Session Sync active.");
                this._connecting = null;
                resolve();
            };

            this.backendWs.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                this.handleBackendMessage(msg);
            };

            this.backendWs.onerror = (err) => {
                console.error("Backend WS Error:", err);
                reject(err);
            };

            this.backendWs.onclose = () => {
                console.log("Backend WS Closed");
                this.backendWs = null;
                this._connecting = null;
                if (this.type !== 'webserial' && this.isConnected) {
                    this.handleDisconnect();
                }
            };
        });
        return this._connecting;
    }

    initCordova() {
        // Check for TCP Socket plugin (cordova-plugin-socket-tcp)
        try {
            var SocketMod = cordova.require('cordova-plugin-socket-tcp.Socket');
            this.CordovaSocket = SocketMod;
            console.log("Cordova TCP Socket Plugin Ready");
        } catch (e) {
            if (window.Socket) {
                this.CordovaSocket = window.Socket;
                console.log("Cordova TCP Socket Plugin Ready (global)");
            } else {
                console.log("Cordova TCP Socket plugin not available â€” Telnet will be disabled");
            }
        }

        if (!window.serial) {
            console.warn("Cordova Serial plugin not available â€” USB disabled");
            return;
        }

        console.log("Cordova Serial Plugin Ready");

        // Cordova Serial registration
        window.serial.registerReadCallback(
            (data) => {
                const view = new Uint8Array(data);
                if (this.rawModeCallback) {
                    this.rawModeCallback(view);
                } else {
                    const decoded = new TextDecoder().decode(view);
                    this._backendBuffer = (this._backendBuffer || '') + decoded;
                    const lines = this._backendBuffer.split('\n');
                    this._backendBuffer = lines.pop(); // Keep partial line
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed) {
                            this.flowControl.processLine(trimmed);
                            this.handleSerialLine(trimmed);
                        }
                    });
                }
            },
            (err) => {
                console.error("Cordova Serial Read Error:", err);
                const errMsg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                this.emit('error', new Error("Serial Read Error: " + errMsg));
            }
        );
    }

    handleBackendMessage(msg) {
        switch (msg.type) {
            case 'ports':
                this.emit('ports', msg.data || []);
                const select = document.getElementById('port-node');
                if (select) {
                    const ports = (msg.data || []).filter(p => {
                        const path = (p.path || '').toUpperCase();
                        return path !== 'COM1' && path !== 'COM2';
                    });
                    select.innerHTML = ports.map(p => `<option value="${p.path}">${p.friendlyName || p.path}</option>`).join('');
                    const saved = this.loadSettings();
                    if (saved && saved.usbPort && ports.some(p => p.path === saved.usbPort)) {
                        select.value = saved.usbPort;
                    }
                }
                break;
            case 'connected':
                this.flowControl.reset();
                this.handleConnect();
                break;
            case 'disconnected':
                this.flowControl.reset();
                this.handleDisconnect();
                break;
            case 'data':
                let bytes;
                if (msg.encoding === 'base64') {
                    const binaryString = atob(msg.data);
                    bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                } else {
                    bytes = new TextEncoder().encode(msg.data);
                }

                if (this.rawModeCallback) {
                    // console.log("Raw Mode Data Received:", bytes.length, "bytes");
                    this.rawModeCallback(bytes);
                } else {
                    const decoded = new TextDecoder().decode(bytes);
                    this._backendBuffer = (this._backendBuffer || '') + decoded;
                    const lines = this._backendBuffer.split('\n');
                    this._backendBuffer = lines.pop();
                    lines.forEach(line => {
                        const trimmed = line.trim();
                        if (trimmed) {
                            // Update flow control
                            this.flowControl.processLine(trimmed);
                            if (this.type === 'usb') this.handleSerialLine(trimmed);
                            else this.emit('line', trimmed);
                        }
                    });
                }
                break;
            case 'syncStatus':
                console.log("Syncing status from backend:", msg.status);
                // We'll use this to populate UI for new clients
                if (msg.status.gcode.content) {
                    // Avoid recursive loadGCode calls
                    if (window.loadGCode) window.loadGCode(msg.status.gcode.content, msg.status.gcode.filename, true);
                }

                if (msg.status.comms.connected) {
                    if (msg.status.comms.type) {
                        this.type = msg.status.comms.type;
                        window.setConnectionType(this.type);
                    }
                    if (!this.isConnected) {
                        this.handleConnect();
                    }
                } else {
                    this._syncHttpBaseUrl();
                }
                break;
            case 'gcodeLoaded':
                console.log("Remote G-Code Loaded:", msg.filename);
                if (window.loadGCode) window.loadGCode(msg.content, msg.filename, true);
                break;
            case 'statusUpdate':
                // Mirror status updates to UI modules
                if (msg.path.startsWith('machine.')) {
                    if (window.droHandler) {
                        const field = msg.path.split('.')[1];
                        if (field === 'status') {
                            if (window.droHandler.updateStatus) window.droHandler.updateStatus(msg.value);
                        } else if (field === 'wpos' || field === 'mpos') {
                            if (window.droHandler.updateDRO) {
                                // Synthetic update for mirrored clients
                                window.droHandler.updateDRO(msg.value, field === 'mpos');
                            }
                        }
                    }
                }
                if (msg.path.startsWith('job.')) {
                    if (window.jobController) {
                        if (msg.path === 'job.active') {
                            if (msg.value) window.jobController.startJobUI();
                            else window.jobController.resetJobUI();
                        } else if (msg.path === 'job.pct') {
                            window.jobController.updateJobProgressUI(msg.value, `Remote Job Progress`);
                        }
                    }
                }
                break;
            case 'scanTelnetProgress':
                this._setTelnetScanProgress(msg.percent, msg.message || `Scanning network... ${msg.percent}%`);
                break;
            case 'scanTelnetFound':
                this._appendDiscoveredDevice(msg.ip);
                break;
            case 'scanTelnetResult':
                const portInput2 = document.getElementById('port-telnet');
                const port2 = parseInt(portInput2?.value) || 23;
                this._handleScanResult(msg.devices || [], port2);
                break;
            case 'error':
                this._setConnectingState(false);
                this.emit('error', new Error(msg.message));
                break;
            case 'firmwareFlashLog':
            case 'firmwareFlashProgress':
            case 'firmwareFlashComplete':
            case 'firmwareFlashError':
                this.emit('firmware', msg);
                break;
        }
    }

    async refreshNodePorts() {
        if (this._connecting) await this._connecting;
        if (!this.backendWs) await this.connectToBackend();
        if (this.backendWs && this.backendWs.readyState === WebSocket.OPEN) {
            this.backendWs.send(JSON.stringify({ type: 'listPorts' }));
        }
    }

    _showConnectingStatus(msg) {
        const dot = document.getElementById('connection-dot');
        const text = document.getElementById('connection-text');
        if (dot) {
            dot.classList.remove('bg-green-500', 'bg-red-500');
            dot.classList.add('bg-yellow-400');
        }
        if (text) text.textContent = msg || 'Connecting...';
    }

    _setConnectingState(isConnecting, message = 'Connecting...') {
        this._isConnecting = isConnecting;

        if (isConnecting) {
            this._showConnectingStatus(message);
        }

        const modalBtn = document.getElementById('btn-modal-connect');
        if (modalBtn) {
            modalBtn.textContent = isConnecting ? 'Connecting...' : 'Connect';
            modalBtn.disabled = isConnecting;
            modalBtn.classList.toggle('opacity-50', isConnecting);
            modalBtn.classList.toggle('pointer-events-none', isConnecting);
        }

        if (!this.btnConnect) return;

        if (isConnecting) {
            this.btnConnect.innerHTML = '<i data-lucide="x-circle"></i> Disconnect';
            if (window.lucide) {
                lucide.createIcons({ root: this.btnConnect });
            }
            this.btnConnect.className = "btn btn-secondary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0 !bg-yellow-500 !text-secondary-dark hover:!bg-yellow-400";
        } else if (!this.isConnected) {
            this.btnConnect.textContent = 'Connect';
            this.btnConnect.className = "btn btn-primary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0";
        }
    }

    _clearConnectingStatus() {
        // Restored by handleConnect/handleDisconnect via uiManager
    }

    async connect() {
        if (this.type === 'telnet') return this.connectDuet();

        this.saveSettings();
        
        if (this.type === 'webserial') {
            if (this.isConnecting || this.isConnected) return;
            const baud = parseInt(document.getElementById('baud-webserial').value);
            this._setConnectingState(true);
            try {
                await this.webSerial.connect(baud);
                this.modalController.hide();
            } catch (error) {
                const message = error.name === 'NotFoundError'
                    ? 'No serial port selected. Choose the Duet USB port to connect.'
                    : error.name === 'SecurityError' || !navigator.serial
                        ? 'USB access is unavailable here. Open this page directly in Chrome or Edge, or use the desktop app.'
                        : `Could not open the Duet USB port: ${error.message}`;
                window.showToast?.(message, 'plug-zap', 'error');
            } finally {
                this._setConnectingState(false);
            }
        } else if (this.type === 'usb') {
            if (!this.backendWs && !this.isCordova) await this.connectToBackend();
            const portEl = document.getElementById('port-node');
            const baudEl = document.getElementById('baud-node');
            const port = portEl?.value || '';
            const baud = parseInt(baudEl?.value) || 115200;
            this._setConnectingState(true, `Opening ${port || 'USB port'}...`);

            if (this.isCordova) {
                const serialApi = (typeof serial !== 'undefined') ? serial : window.serial;
                if (!serialApi) {
                    this._setConnectingState(false);
                    this.emit('error', new Error("USB serial plugin not available. Reinstall the app or use WiFi/Ethernet instead."));
                    return;
                }
                // vid/pid are decimal; driver must match the chip (native default is CdcAcm).
                const supportedDevices = [
                    { vid: 7504, pid: 24812, name: 'Duet USB' },
                    { vid: 1155, pid: 22336, name: 'STM32' },
                    { vid: 12346, pid: 16385, name: 'ESP32-S3' },
                    { vid: 1027, pid: 24577, name: 'FTDI', driver: 'FtdiSerialDriver' }
                ];

                const tryConnect = (index) => {
                    if (index >= supportedDevices.length) {
                        this._setConnectingState(false);
                        this.emit('error', new Error("No supported USB device found or permission denied."));
                        return;
                    }

                    const device = supportedDevices[index];
                    console.log(`Trying Cordova USB Permission for: ${device.name} (VID: ${device.vid}, PID: ${device.pid})`);

                    // Safety net: the native permission callback must always fire.
                    // If it doesn't (e.g. broadcast lost), advance instead of
                    // hanging the UI in "Connecting..." forever.
                    let attemptSettled = false;
                    const watchdog = setTimeout(() => {
                        if (attemptSettled) return;
                        attemptSettled = true;
                        console.warn(`Cordova USB attempt [${device.name}] timed out after 15s, trying next...`);
                        tryConnect(index + 1);
                    }, 15000);

                    serialApi.requestPermission(
                        { vid: device.vid, pid: device.pid, ...(device.driver ? { driver: device.driver } : {}) },
                        () => {
                            if (attemptSettled) return;
                            attemptSettled = true;
                            clearTimeout(watchdog);
                            serialApi.open(
                                { baudRate: baud, sleepOnPause: false },
                                () => {
                                    console.log(`Cordova Serial Open Success [${device.name}]`);
                                    this.flowControl.reset();
                                    this.handleConnect();
                                },
                                (err) => {
                                    console.error(`Cordova Serial Open Error [${device.name}]:`, err);
                                    const errStr = String((typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err)).toLowerCase();
                                    // If "No device found", try the next one in the list
                                    if (errStr.includes("no device") || errStr.includes("not found")) {
                                        tryConnect(index + 1);
                                    } else {
                                        this._setConnectingState(false);
                                        const errMsg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                                        this.emit('error', new Error("Can't open port: " + errMsg));
                                    }
                                }
                            );
                        },
                        (err) => {
                            console.warn(`Cordova USB Permission Denied/Next [${device.name}]:`, err);
                            // Device might not be plugged in, or it might be the wrong one. Try next.
                            if (attemptSettled) return;
                            attemptSettled = true;
                            clearTimeout(watchdog);
                            tryConnect(index + 1);
                        });
                };

                tryConnect(0);
            } else {
                this.backendWs.send(JSON.stringify({
                    type: 'connect',
                    connectionType: 'usb',
                    port: port,
                    baud: baud
                }));
            }
        } else if (this.type === 'telnet') {
            const ip = document.getElementById('ip-telnet').value;
            const port = parseInt(document.getElementById('port-telnet').value) || 23;
            this._setConnectingState(true, `Connecting to ${ip}:${port}...`);
            if (this.isCordova) {
                await this._connectCordovaTelnet(ip, port);
            } else {
                if (!this.backendWs) await this.connectToBackend();
                this.backendWs.send(JSON.stringify({
                    type: 'connect',
                    connectionType: 'telnet',
                    ip: ip,
                    port: port
                }));
            }
        } else if (this.type === 'websocket') {
            if (this.isCordova) {
                this.emit('error', new Error('WebSocket is not supported on Cordova (HTTPS restricts ws://). Please use Telnet instead.'));
                this.modalController?.hide();
                return;
            }
            const url = document.getElementById('url-websocket').value || `ws://${window.location.hostname}:81/ws`;
            this._setConnectingState(true, `Connecting to ${url}...`);

            let connectionTimedOut = false;
            const connectTimeout = setTimeout(() => {
                if (this.directWs && this.directWs.readyState !== WebSocket.OPEN) {
                    connectionTimedOut = true;
                    this.directWs.close();
                    this.directWs = null;
                    const dot = document.getElementById('connection-dot');
                    const text = document.getElementById('connection-text');
                    if (dot) {
                        dot.classList.remove('bg-yellow-400');
                        dot.classList.add('bg-red-500');
                    }
                    if (text) text.textContent = 'Connection timed out';
                    this._setConnectingState(false);
                    this.emit('error', new Error(`WebSocket connection to ${url} timed out after 10s. Check that the IP is correct and the controller is reachable.`));
                }
            }, 10000);

            try {
                this.directWs = new WebSocket(url);
            } catch (e) {
                clearTimeout(connectTimeout);
                const dot = document.getElementById('connection-dot');
                const text = document.getElementById('connection-text');
                if (dot) {
                    dot.classList.remove('bg-yellow-400');
                    dot.classList.add('bg-red-500');
                }
                if (text) text.textContent = 'Connection Error';
                const isHttps = window.location.protocol === 'https:' || window.location.protocol === 'file:';
                if (isHttps && url.startsWith('ws://')) {
                    this.emit('error', new Error(`Cannot use ws:// from HTTPS page. Try Telnet instead: connect to the same IP on port 23.`));
                } else {
                    const wsErr = (typeof e === 'string') ? e : (e && e.message) ? e.message : JSON.stringify(e);
                    this.emit('error', new Error(`Invalid WebSocket URL: ${wsErr}`));
                }
                this._setConnectingState(false);
                this.modalController?.hide();
                return;
            }

            this.directWs.onopen = () => {
                clearTimeout(connectTimeout);
                console.log("Direct WebSocket Connected to grblHAL");
                try {
                    const wsUrl = new URL(url);
                    this.httpBaseUrl = `http://${wsUrl.hostname}`;
                    console.log("Derived HTTP Base URL:", this.httpBaseUrl);
                } catch (e) {
                    console.error("Failed to derive HTTP URL from WebSocket URL:", url);
                }
                this.flowControl.reset();
                this.handleConnect();
            };

            this.directWs.onmessage = (event) => {
                if (event.data instanceof Blob) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const view = new Uint8Array(reader.result);
                        if (this.rawModeCallback) {
                            this.rawModeCallback(view);
                        } else {
                            const decoded = new TextDecoder().decode(view);
                            this._handleDirectWsData(decoded);
                        }
                    };
                    reader.readAsArrayBuffer(event.data);
                } else if (typeof event.data === 'string') {
                    this._handleDirectWsData(event.data);
                }
            };

            this.directWs.onerror = (err) => {
                if (connectionTimedOut) return;
                clearTimeout(connectTimeout);
                console.error("Direct WebSocket Error:", err);
                const dot = document.getElementById('connection-dot');
                const text = document.getElementById('connection-text');
                if (dot) {
                    dot.classList.remove('bg-yellow-400');
                    dot.classList.add('bg-red-500');
                }
                if (text) text.textContent = 'WebSocket Error';
                this._setConnectingState(false);
                this.emit('error', new Error("WebSocket connection failed. Make sure the controller is powered on and reachable."));
            };

            this.directWs.onclose = (event) => {
                clearTimeout(connectTimeout);
                console.log("Direct WebSocket Closed (code: " + event.code + ")");
                if (this.isConnected) this.handleDisconnect();
            };
        }
        this.modalController?.hide();
    }

    _handleDirectWsData(decoded) {
        this._backendBuffer = (this._backendBuffer || '') + decoded;
        const lines = this._backendBuffer.split('\n');
        this._backendBuffer = lines.pop(); // Keep partial line
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed) {
                this.flowControl.processLine(trimmed);
                this.emit('line', trimmed);
            }
        });
    }

    async _connectCordovaTelnet(host, port) {
        if (!this.CordovaSocket) {
            this.emit('error', new Error("TCP Socket plugin not available. Cannot connect via Telnet."));
            return;
        }

        this._showConnectingStatus(`Connecting to ${host}:${port} (Telnet)...`);

        return new Promise((resolve, reject) => {
            const socket = new this.CordovaSocket();
            let settled = false;
            const connectionTimeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { socket.close(); } catch (e) {}
                const error = new Error(`Telnet connection to ${host}:${port} timed out.`);
                console.error(error.message);
                this._setConnectingState(false);
                this.emit('error', error);
                reject(error);
            }, 10000);

            const fail = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(connectionTimeout);
                reject(error);
            };

            socket.onData = (data) => {
                const decoded = new TextDecoder().decode(data);
                console.log("Telnet RX:", JSON.stringify(decoded));
                this._backendBuffer = (this._backendBuffer || '') + decoded;
                const lines = this._backendBuffer.split('\n');
                this._backendBuffer = lines.pop();
                lines.forEach(line => {
                    const trimmed = line.trim();
                    if (trimmed) {
                        this.flowControl.processLine(trimmed);
                        this.emit('line', trimmed);
                    }
                });
            };

            socket.onError = (err) => {
                const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                console.error("Cordova Telnet Error payload:", JSON.stringify(err));
                console.error("Cordova Telnet Error msg:", msg);
                if (!this.isConnected) {
                    const error = new Error(msg);
                    this._setConnectingState(false);
                    fail(error);
                } else {
                    this.emit('error', new Error("Telnet error: " + msg));
                }
            };

            socket.onClose = (hasError) => {
                console.log("Cordova Telnet Closed (hasError:", hasError, ")");
                this._cordovaTelnetSocket = null;
                if (this.isConnected) this.handleDisconnect();
            };

            socket.open(host, port, () => {
                this._cordovaTelnetSocket = socket;
                console.log("Cordova Telnet Connected, waiting 2s for board to stabilize...");
                this.flowControl.reset();
                try {
                    const probe = new TextEncoder().encode('\r\n?\r\n');
                    socket.write(probe, () => {}, (err) => {
                        console.warn("Cordova Telnet probe write failed:", err);
                    });
                } catch (err) {
                    console.warn("Cordova Telnet probe failed:", err);
                }
                setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(connectionTimeout);
                    console.log("Cordova Telnet delay complete, activating connection");
                    this.handleConnect();
                    resolve();
                }, 2000);
            }, (err) => {
                const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                console.error("Cordova Telnet Open failed:", msg);
                this.emit('error', new Error("Telnet connection failed: " + msg));
                this._setConnectingState(false);
                fail(new Error(msg));
            });
        });
    }

    handleSerialLine(line) {
        if (this.isDuetSerial) {
            const address = /^(?:Network is enabled,.*actual IP address:|Network running, IP address\s*=)\s*((?:\d{1,3}\.){3}\d{1,3})\s*$/i.exec(line)?.[1];
            const input = document.getElementById('ip-telnet');
            if (address === '0.0.0.0' && /configured IP address:\s*0\.0\.0\.0/i.test(line)) {
                this.emit('line', 'Duet is waiting for a DHCP address. Check the network cable and router, then select Duet Network Info again.');
            }
            if (address && address !== '0.0.0.0' && input && !input.value.trim()) {
                input.value = address;
                this.saveSettings();
            }
        }
        if (/^FIRMWARE_NAME:\s*RepRapFirmware/i.test(line)) {
            this.isDuetSerial = true;
            this.duetFirmwareInfo = {
                version: /FIRMWARE_VERSION:\s*(\S+)/i.exec(line)?.[1],
                board: /ELECTRONICS:\s*(.*?)(?:\s+FIRMWARE_DATE:|$)/i.exec(line)?.[1]
            };
            window.sdMounted = false;
            window.syncSdUploadBtn?.();
            window.uiManager?.syncFirmwareUI('duet');
            this.sendCommand('M409 K"move.workplaceNumber"').catch(error => this.emit('error', error));
        }
        if (this.isDuetSerial && line.startsWith('{')) {
            let status;
            try { status = JSON.parse(line); } catch { /* Console output */ }
            if (status?.key === 'move.workplaceNumber') { this.updateDuetWorkplace(status.result); return; }
            if (status?.status && Array.isArray(status.machine) && Array.isArray(status.pos)) {
                if (this.type !== 'webserial') this.duetSerialPollPending = false;
                this.updateDuetStatus({ ...status, coords: { machine: status.machine, xyz: status.pos } });
                return;
            }
        }
        this.emit('line', line);
    }

    async connectDuet() {
        if (this.isConnecting || this.isConnected) return;
        this._setConnectingState(true);
        let client;
        let sessionOpened = false;
        try {
            const request = window.electron?.duetRequest ? async (url, options) => {
                const { signal, ...serializable } = options;
                const { status, body } = await window.electron.duetRequest(url, serializable);
                return new Response(body, { status });
            } : async (url, options) => {
                try {
                    return await fetch(url, options);
                } catch (error) {
                    if (!(error instanceof TypeError)) throw error;
                    const alternative = this.isCordova ? 'Try USB in the Android app.' : 'Try USB with Web Serial.';
                    throw new Error(
                        'The app could not reach the Duet over HTTP. Check the address and the controller’s allowed web origin. ' +
                        'Electron supports direct HTTP. ' + alternative,
                        { cause: error }
                    );
                }
            };
            const address = document.getElementById('ip-telnet').value.trim();
            if (!address) throw new Error('Enter the Duet address before connecting over HTTP.');
            client = new DuetHttp(address, request);
            await client.connect(document.getElementById('duet-password').value || 'reprap');
            sessionOpened = true;
            const status = await client.call('status', { type: 2 });
            if (!status.coords?.machine || !status.coords?.xyz) throw new Error('Duet did not return machine coordinates');
            this.duetFirmwareInfo = {
                version: status.firmwareVersion,
                board: status.firmwareName,
                machineConfig: status.name
            };
            this.duet = client;
            this.saveSettings();
            this.modalController.hide();
            this.handleConnect();
            this.updateDuetStatus(status);
            this.pollDuet(client);
        } catch (error) {
            if (sessionOpened && this.duet === client) {
                this.disconnect();
            } else if (sessionOpened) {
                await client.call('disconnect').catch(() => {});
            }
            this._setConnectingState(false);
            this.emit('error', error);
        }
    }

    updateDuetStatus(status) {
        this.duetState = status.status;
        document.getElementById('duet-recover-job').disabled = !this.duet || status.status !== 'I';
        const offsetZ = status.params?.babystep ?? status.babystep;
        document.getElementById('duet-z-offset').textContent = Number.isFinite(offsetZ) ? offsetZ.toFixed(3) + ' mm' : '—';
        for (const button of document.querySelectorAll('#duet-z-adjustment button')) {
            button.disabled = !['I', 'P'].includes(this.duetState) || !Number.isFinite(offsetZ);
        }

        if (Number.isInteger(status.mountedVolumes)) {
            const mounted = Boolean(status.mountedVolumes & 1);
            if (window.sdMounted !== mounted) {
                window.sdMounted = mounted;
                window.syncSdUploadBtn?.();
            }
        }
        document.getElementById('duet-restart').hidden = status.status !== 'S';
        const state = { I: 'Idle', O: 'Off', P: 'Run', A: 'Hold:0', D: 'Hold:1', H: 'Alarm', S: 'Alarm', B: 'Run' }[status.status] || 'Unknown';
        const { machine, xyz } = status.coords;
        const offset = machine.map((value, index) => value - xyz[index]);
        const feed = status.speeds?.requested ?? 0;
        const override = status.params?.speedFactor ?? status.sfactor;
        if (Number.isFinite(override)) this.duetFeedOverride = override;
        const overrideField = Number.isFinite(override) ? '|Ov:' + override : '';
        const homed = status.coords.axesHomed ?? status.homed;
        const homingField = Array.isArray(homed)
            ? '|H:1,' + homed.slice(0, 6).reduce((mask, value, index) => mask | ((value ? 1 : 0) << index), 0)
            : '';
        const probe = status.sensors?.probeValue ?? status.probe;
        const threshold = status.probe?.threshold;
        let probeField = '';
        if (status.probe?.type && Number.isFinite(probe) && Number.isFinite(threshold)) {
            probeField = '|Pn:' + (probe >= threshold ? 'P' : '');
        } else if (this.isDuetSerial && /^(0|1000)$/.test(String(probe))) {
            probeField = '|Pn:' + (Number(probe) === 1000 ? 'P' : '');
        }
        this.duetProbeKnown = probeField !== '';
        this.emit('line', '<' + state + '|MPos:' + machine.join(',') + '|WCO:' + offset.join(',') + '|FS:' + feed + ',0' + overrideField + homingField + probeField + '>');
    }

    async readDuetNetwork() {
        if (!this.isConnected || !this.isDuetSerial || this.duetAxisWrite) return;
        const generation = this._connectionGeneration;
        const fields = document.getElementById('duet-network-form').elements;
        try {
            const network = await this.readDuetSerialModel('network');
            if (this._connectionGeneration !== generation) return;
            const link = network?.interfaces?.[0];
            fields.hostname.placeholder = network?.hostname || '';
            fields.address.placeholder = link?.actualIP || '';
            fields.gateway.placeholder = link?.gateway || '';
            fields.netmask.placeholder = link?.subnet || '';
        } catch {
            // The USB connection can still be used to enter new settings.
        }
    }

    saveDuetNetwork(form) {
        const firmware = this.duetFirmwareInfo;
        const board = firmware?.board || '';
        const wifi = /Duet(?: 2)? WiFi\b/i.test(board);
        if (!this.isConnected || !this.isDuetSerial || !(wifi || /Duet Ethernet/i.test(board))) return;
        const { enabled, mode, ssid, password, address, gateway, netmask, hostname } = form.elements;
        const state = enabled.value;
        const modeValue = mode.value;
        const ip = address.value.trim();
        const network = wifi ? ssid.value : '';
        const secret = wifi ? password.value : '';
        const configureWifi = wifi && !!(network || secret || modeValue);
        const router = gateway.value.trim();
        const mask = netmask.value.trim();
        const host = hostname.value.trim();
        const validIp = value => /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(value) &&
            value.split('.').every(octet => Number(octet) <= 255);
        if (state !== '0' && modeValue === 'static' && (!validIp(ip) || ip === '0.0.0.0')) {
            window.reporter.showAlert('Network Settings', 'Enter a valid static IPv4 address.');
            return;
        }
        if (host && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) {
            window.reporter.showAlert('Network Settings', 'Enter a hostname using letters, numbers, and hyphens.');
            return;
        }
        if (state !== '0' && (router || mask) &&
            (modeValue !== 'static' || (router && !validIp(router)) || (mask && !validIp(mask)))) {
            window.reporter.showAlert('Network Settings', 'Select Static and enter valid IPv4 values for the gateway and netmask.');
            return;
        }
        if (state !== '0' && configureWifi &&
            (!network || !secret || !modeValue || /[";\x00-\x1f\x7f]/.test(network + secret))) {
            window.reporter.showAlert('Wi-Fi Settings', 'Enter an SSID and password without quotation marks or semicolons, and select an address mode.');
            return;
        }
        if (!state && !modeValue && !configureWifi && !host) return;
        const message = state === '0' ? 'Disable this network interface?' :
            configureWifi ? 'Save this Wi-Fi network on the Duet and connect to it?' :
            modeValue === 'dhcp' ? 'Use DHCP for this session? The HTTP address field will be cleared until the Duet reports an address.' :
            modeValue === 'static' ? 'Use ' + ip + ' and the selected network settings for this session?' :
            state ? 'Enable networking with the settings already on the controller?' : 'Apply the hostname for this session?';
        window.reporter.showConfirm('Apply Network Settings', message, async () => {
            if (!this.isConnected || !this.isDuetSerial || this.duetFirmwareInfo !== firmware) return;
            password.value = '';
            const httpAddress = document.getElementById('ip-telnet');
            httpAddress.value = '';
            this.saveSettings();
            window.switchTab('console-view');
            try {
                if (host) await this.sendCommand('M550 P"' + host + '"');
                if (state === '0') {
                    await this.sendCommand('M552 S0');
                    return;
                }
                if (configureWifi) {
                    const send = async command => {
                        if (!this.isConnected || !this.isDuetSerial || this.duetFirmwareInfo !== firmware) {
                            throw new Error('Controller changed');
                        }
                        const result = await this.sendCommandWithAck(command);
                        if (!/^ok\b/i.test(result.response)) throw new Error('Command rejected');
                    };
                    const staticOptions = modeValue === 'static' ?
                        ' I' + ip + (router ? ' J' + router : '') + (mask ? ' K' + mask : '') : '';
                    await send('M552 S0');
                    await send('M587 S"' + network + '" P"' + secret + '"' + staticOptions);
                    await send('M552 S1 P"' + network + '"');
                } else if (state || modeValue) {
                    const target = modeValue === 'dhcp' ? ' P0.0.0.0' : modeValue === 'static' ? ' P' + ip : '';
                    await this.sendCommand('M552 S1' + target);
                    if (mask) await this.sendCommand('M553 P' + mask);
                    if (router) await this.sendCommand('M554 P' + router);
                }
                await this.sendCommand('M552');
            } catch {
                this.emit('error', new Error('The Duet did not confirm the network settings. Check the connection and try again.'));
            }
        });
    }

    probeDuetAxis(form, panel) {
        if (this.duetProbePending) return;
        const duet = this.duet;
        const [height, offset, feed] = ['height', 'offset', 'feed'].map(name => panel?.[name] ?? form?.elements[name]?.valueAsNumber);
        const direction = panel?.direction ?? form?.elements.direction?.value ?? 'Z-';
        const axis = direction[0];
        const corner = panel?.corner ?? form?.elements.corner?.value;
        const geometry = Object.fromEntries(['width', 'depth', 'xOffset', 'yOffset', 'diameter'].map(
            name => [name, form?.elements[name]?.valueAsNumber]
        ));
        const side = axis !== 'Z';
        const travel = panel?.travel ?? (side ? form?.elements.distance?.valueAsNumber : height - offset + 10);
        const sign = direction[1] === '-' ? -1 : 1;
        const title = corner ? 'Probe Corner' : 'Probe ' + axis;
        const reporter = window.reporter;
        if (!duet) {
            reporter.showAlert('Duet Z Probe', 'Connect to the Duet over HTTP to run the probe.');
            return;
        }
        if (!panel && corner && (!['FL', 'FR', 'BL', 'BR'].includes(corner) ||
            !Object.values(geometry).every(Number.isFinite) || geometry.diameter <= 0 ||
            geometry.xOffset < 0 || geometry.xOffset >= geometry.width ||
            geometry.yOffset < 0 || geometry.yOffset >= geometry.depth)) {
            reporter.showAlert(title, 'Enter the block dimensions, edge offsets within those dimensions, and a positive cutter diameter.');
            return;
        }
        if (!['X+', 'X-', 'Y+', 'Y-', 'Z-'].includes(direction) ||
            ![travel, offset, feed].every(Number.isFinite) || travel <= 0 || feed <= 0 ||
            (!panel && !side && (height <= 0 || offset < 0 || offset > height)) ||
            (panel && (!Number.isFinite(panel.retract) || panel.retract <= 0))) {
            if (side) {
                reporter.showAlert(title, 'Enter a positive travel and feed, and the work coordinate at contact.');
                return;
            }
            reporter.showAlert('Duet Z Probe', 'Enter a positive block height and feed. The Z offset at contact must be between zero and the block height.');
            return;
        }
        const approach = side ? direction : 'down';
        const message = corner
            ? `Confirm the probe is connected and the tool is positioned as shown for corner ${corner}. This replaces /sys/probe.g and moves Z, X, and Y at ${feed} mm/min.`
            : `Confirm the block is connected and the tool is positioned for probing. This replaces /sys/probe.g and probes ${approach} up to ${travel} mm at ${feed} mm/min, setting ${axis} to ${offset} mm on contact.`;
        reporter.showConfirm(title, message,
            async () => {
                if (this.duetProbePending || this.duet !== duet) return;
                this.duetProbePending = true;
                try {
                    const checkProbe = async () => {
                        const status = await duet.call('status', { type: 2 });
                        const reading = status.sensors?.probeValue;
                        const threshold = status.probe?.threshold;
                        if (this.duet !== duet) throw new Error('Duet connection changed during probe setup.');
                        if (status.status !== 'I' || !status.coords?.axesHomed?.[2]) {
                            throw new Error('The Duet must be idle with Z homed before probing.');
                        }
                        if (side && !status.coords.axesHomed['XYZ'.indexOf(axis)]) {
                            throw new Error(`Home ${axis} before probing this face.`);
                        }
                        if (corner && (!status.coords.axesHomed[0] || !status.coords.axesHomed[1])) {
                            throw new Error('Home X and Y before probing a corner.');
                        }
                        if (status.currentTool !== -1 || status.tools?.some(tool => tool.number === 49)) {
                            throw new Error('Probing requires no active tool and an unused tool slot 49.');
                        }
                        if (!status.probe?.type || !Number.isFinite(reading) || !Number.isFinite(threshold)) {
                            throw new Error('The Duet did not report a configured probe input.');
                        }
                        if (reading >= threshold) throw new Error('The probe is already triggered.');
                    };
                    await checkProbe();
                    const routine = corner
                        ? panel ? duetOutsideCornerRoutine(panel)
                            : duetCornerProbeRoutine({ ...geometry, corner, height, zOffset: offset, feed })
                        : duetProbeRoutine(axis, sign * travel, feed, offset, -sign * (panel?.retract ?? 5));
                    const name = '0:/sys/probe.g';
                    await duet.call('upload', { name }, new TextEncoder().encode(routine));
                    const saved = await duet.call('download', { name });
                    if (new TextDecoder().decode(saved) !== routine) {
                        throw new Error('The saved probe routine did not match. Probing was cancelled.');
                    }
                    await checkProbe();
                    await duet.send('M98 P"probe.g"');
                } catch (error) {
                    this.emit('error', error);
                } finally {
                    this.duetProbePending = false;
                }
            });
    }

    async readDuetSpindles() {
        const output = document.getElementById('duet-spindle-status');
        const duet = this.duet;
        if (!duet) {
            output.textContent = 'Connect over HTTP to read spindle status.';
            return;
        }
        try {
            const { result } = await duet.call('model', { key: 'spindles', flags: 'v' });
            if (this.duet !== duet) return;
            const rows = result.flatMap((spindle, index) =>
                spindle?.state && spindle.state !== 'unconfigured'
                    ? ['Spindle ' + index + ': ' + spindle.state + ', ' + spindle.current + ' RPM (set ' + spindle.active + ' RPM)']
                    : []
            );
            output.textContent = rows.join('\n') || 'No spindles configured.';
        } catch (error) {
            if (this.duet === duet) output.textContent = error.message;
        }
    }

    refreshDuetAxes() {
        if (this.duetAxisWrite) return;
        if (document.querySelector('#duet-axis-rows [data-edited]')) {
            const duet = this.duet;
            window.reporter.showConfirm('Discard unsaved settings?',
                'Refresh reloads controller values and discards your unsaved edits.',
                () => { if (this.duet === duet) return this.readDuetAxes(); }, undefined, 'Discard and Refresh');
            return;
        }
        return this.readDuetAxes();
    }

    updateDuetSaveButton() {
        const poll = document.getElementById('duet-poll-interval');
        document.getElementById('duet-save-settings').disabled = !!this.duetAxisWrite ||
            (!document.querySelector('#duet-axis-rows [data-edited]') &&
                poll.valueAsNumber === (this.duetPollInterval ?? 500));
    }

    setDuetAxisPreset(select) {
        if (!select.value || !(this.duet || this.isDuetSerial) || this.duetAxisWrite) return;
        const limits = select.value.split(',');
        for (const input of document.querySelectorAll('#duet-axis-rows input')) {
            const index = 'XYZ'.indexOf(input.dataset.axis);
            if (index < 0 || input.dataset.key === 'stepsPerMm') continue;
            input.value = input.dataset.key === 'min' ? '0' : limits[index];
            input.oninput();
        }
        select.value = '';
    }

    saveDuetAxes() {
        const duet = this.duet;
        const serial = this.isDuetSerial && this.isConnected;
        const generation = this._connectionGeneration;
        const current = () => this.isConnected && this._connectionGeneration === generation && this.duet === duet;
        const rows = document.getElementById('duet-axis-rows');
        const output = document.getElementById('duet-axis-settings');
        const save = document.getElementById('duet-save-settings');
        const inputs = [...rows.querySelectorAll('input')];
        const edits = inputs.filter(input => input.closest('tr').hasAttribute('data-edited'));
        const poll = document.getElementById('duet-poll-interval');
        const interval = poll.valueAsNumber;
        if ((!duet && !serial) || this.duetAxisWrite || !poll.reportValidity()) return;
        if (!edits.length) {
            this.setDuetPollInterval(poll);
            this.updateDuetSaveButton();
            return;
        }
        for (const input of inputs) {
            const { axis, key } = input.dataset;
            const min = inputs.find(item => item.dataset.axis === axis && item.dataset.key === 'min');
            const max = inputs.find(item => item.dataset.axis === axis && item.dataset.key === 'max');
            if (!input.checkValidity() || (key === 'stepsPerMm' && input.valueAsNumber <= 0) ||
                (min && max && min.valueAsNumber >= max.valueAsNumber)) {
                output.textContent = 'Enter valid axis values. Steps per mm must be positive and minimum travel must be below maximum travel.';
                return;
            }
        }
        const changes = edits.map(input => ({ input, ...input.dataset, next: input.valueAsNumber }));
        const extendsRange = ({ key, next, original }) =>
            (key === 'min' && next < Number(original)) || (key === 'max' && next > Number(original));
        changes.sort((a, b) => Number(extendsRange(b)) - Number(extendsRange(a)));
        window.reporter.showConfirm('Save Duet Settings',
            serial ? 'Apply the edited axis values for this session?' :
                'Apply the edited axis values and save them to the WorkBee startup files?',
            async () => {
                if (!current() || this.duetAxisWrite ||
                    poll.valueAsNumber !== interval ||
                    changes.some(({ input, next }) => !input.isConnected || input.valueAsNumber !== next)) return;
                const write = {};
                this.duetAxisWrite = write;
                save.disabled = true;
                poll.disabled = true;
                inputs.forEach(input => { input.disabled = true; });
                try {
                    const status = serial ? { status: this.duetState } : await duet.call('status', { type: 3 });
                    if (status.status !== 'I' || status.filePosition > 0) {
                        throw new Error('The Duet must be powered and idle to change axis settings.');
                    }
                    const files = serial ? [] : await this.prepareDuetAxisFiles(duet, changes);
                    for (const [index, { input, axis, key, code, next }] of changes.entries()) {
                        if (!current()) return;
                        output.textContent = `Writing ${input.getAttribute('aria-label')} (${index + 1} of ${changes.length})…`;
                        const command = code + ' ' + axis + next;
                        if (serial) {
                            const reply = await this.sendCommandWithAck(command);
                            if (!/^ok\b/i.test(reply.response)) throw new Error('The Duet rejected ' + input.getAttribute('aria-label') + '.');
                        } else {
                            await duet.send(command);
                        }
                        let verified = false;
                        for (let attempt = 0; attempt < 5 && current(); attempt++) {
                            const result = serial ? await this.readDuetSerialModel('move.axes') :
                                (await duet.call('model', { key: 'move.axes', flags: 'v' })).result;
                            const live = result.find(item => item.letter === axis)?.[key];
                            if (Number.isFinite(live) && Math.abs(live - next) < 0.0001) {
                                if (serial && current()) {
                                    input.dataset.original = String(next);
                                    input.oninput();
                                }
                                verified = true;
                                break;
                            }
                            await new Promise(resolve => setTimeout(resolve, 150));
                        }
                        if (!verified) throw new Error('Could not verify ' + input.getAttribute('aria-label') + '. Refresh before retrying.');
                    }
                    for (const [index, { name, original, updated, edits }] of files.entries()) {
                        output.textContent = `Saving ${name.split('/').pop()} (${index + 1} of ${files.length})…`;
                        const read = async () => new TextDecoder().decode(await duet.call('download', { name }));
                        if (await read() !== original) throw new Error(name + ' changed during Save. Review it before retrying.');
                        if (!current()) return;
                        if (original !== updated) await duet.call('upload', { name }, new TextEncoder().encode(updated));
                        if (!current()) return;
                        if (await read() !== updated) throw new Error('Could not verify ' + name + '. Review it before retrying.');
                        if (!current()) return;
                        for (const { input, next } of edits) {
                            input.dataset.original = String(next);
                            input.oninput();
                        }
                    }
                    this.setDuetPollInterval(poll);
                    output.textContent = serial ? 'Axis settings verified for this session.' :
                        'Settings verified on the controller and saved to the startup files.';
                } catch (error) {
                    if (current()) output.textContent = error.message;
                } finally {
                    if (this.duetAxisWrite === write) {
                        this.duetAxisWrite = null;
                        poll.disabled = false;
                        inputs.forEach(input => { input.disabled = false; });
                        this.updateDuetSaveButton();
                    }
                }
            });
    }

    async prepareDuetAxisFiles(duet, changes) {
        const files = [];
        for (const [file, codes] of [
            ['config-axes-limits.g', ['M208 S1', 'M208 S0']],
            ['config-axes-calibration.g', ['M92']]
        ]) {
            const edits = changes.filter(change => codes.includes(change.code));
            if (!edits.length) continue;
            const name = '0:/sys/' + file;
            const original = new TextDecoder().decode(await duet.call('download', { name }));
            let updated = original;
            for (const { axis, code, next } of edits) {
                const command = code.split(' ')[0];
                let matches = 0;
                updated = updated.replace(new RegExp('^([ \\t]*' + command + '[ \\t]+)([^;\\r\\n]*)([^\\r\\n]*)', 'gim'),
                    (line, prefix, parameters, comment) => {
                        if (command === 'M208') {
                            const mode = parameters.match(/(?:^|\s)S([01])(?=\s|$)/i)?.[1] ?? '0';
                            if (mode !== code.at(-1)) return line;
                        }
                        const parameter = new RegExp('(^|[ \\t])' + axis + '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?=[ \\t]|$)', 'gi');
                        return prefix + parameters.replace(parameter, (_, separator) => {
                            matches++;
                            return separator + axis + next;
                        }) + comment;
                    });
                if (matches !== 1) throw new Error('Expected one ' + command + ' value for ' + axis + ' in ' + file + '.');
            }
            files.push({ name, original, updated, edits });
        }
        return files;
    }

    readDuetSerialModel(key) {
        return new Promise((resolve, reject) => {
            const finish = (error, result) => {
                clearTimeout(timer);
                this.off('line', onLine);
                this.off('disconnect', onDisconnect);
                if (error) reject(error);
                else resolve(result);
            };
            const onLine = line => {
                if (!line.startsWith('{')) return;
                let reply;
                try { reply = JSON.parse(line); } catch { return; }
                if (reply.key === key) finish(null, reply.result);
            };
            const onDisconnect = () => finish(new Error('Duet disconnected.'));
            const timer = setTimeout(() => finish(new Error('The Duet did not return ' + key + '.')), 3000);
            this.on('line', onLine);
            this.on('disconnect', onDisconnect);
            this.sendCommand('M409 K"' + key + '" F"v"').catch(finish);
        });
    }

    async readDuetAxes() {
        if (this.duetAxisWrite) return;
        const output = document.getElementById('duet-axis-settings');
        const duet = this.duet;
        const serial = this.isDuetSerial && this.isConnected;
        const generation = this._connectionGeneration;
        if (!duet && !serial) {
            output.textContent = 'Connect to the Duet to read axis settings.';
            return;
        }
        try {
            const result = serial ? await this.readDuetSerialModel('move.axes') :
                (await duet.call('model', { key: 'move.axes', flags: 'v' })).result;
            if (this._connectionGeneration !== generation) return;
            const primaryAxes = ['X', 'Y', 'Z'].map(letter => result.find(axis => axis.letter === letter));
            if (window.troubleshooting?.lastHomingMask == null &&
                primaryAxes.every(axis => typeof axis?.homed === 'boolean')) {
                const homingMask = primaryAxes.reduce((mask, axis, index) => mask | (Number(axis.homed) << index), 0);
                window.troubleshooting?.updateHoming(homingMask);
            }
            const rows = document.getElementById('duet-axis-rows');
            rows.replaceChildren();
            for (const axis of result) {
                if (!/^[A-Z]$/.test(axis.letter)) continue;
                for (const [key, code, label, unit] of [
                    ['min', 'M208 S1', 'Minimum travel', 'mm'],
                    ['max', 'M208 S0', 'Maximum travel', 'mm'],
                    ['stepsPerMm', 'M92', 'Steps per mm', 'steps/mm']
                ]) {
                    const gangedY = axis.letter === 'U' && axis.visible === false && result.some(item => item.letter === 'Y');
                    if (!Number.isFinite(axis[key]) || (gangedY && key !== 'stepsPerMm')) continue;
                    const row = document.getElementById('duet-axis-row').content.firstElementChild.cloneNode(true);
                    const [command, description, value, units] = row.cells;
                    command.textContent = code.split(' ')[0];
                    row.dataset.duetAxisGroup = (gangedY ? 'Y' : axis.letter) + '-axis';
                    description.textContent = gangedY ? 'Ganged Y-motor travel resolution' :
                        axis.letter + (key === 'stepsPerMm' ? '-axis travel resolution' : '-axis ' + label.toLowerCase());
                    units.textContent = unit;
                    const input = value.querySelector('input');
                    input.value = axis[key];

                    input.dataset.original = input.value;
                    Object.assign(input.dataset, { axis: axis.letter, key, code });
                    input.setAttribute('aria-label', description.textContent);
                    input.oninput = () => {
                        const edited = input.valueAsNumber !== Number(input.dataset.original);
                        row.toggleAttribute('data-edited', edited);
                        row.classList.toggle('bg-yellow-50', edited);
                        this.updateDuetSaveButton();
                    };
                    rows.append(row);
                }
            }
            window.uiManager?.renderDuetSettingsGroup();
            this.updateDuetSaveButton();
            output.textContent = '';
        } catch (error) {
            output.textContent = error.message;
        }
    }

    async adjustDuetZ(delta) {
        if (!this.isConnected || !(this.duet || this.isDuetSerial) || !['I', 'P'].includes(this.duetState)) return;
        if (delta !== -0.05 && delta !== 0.05) return;
        try {
            await this.sendCommand('M290 S' + delta);
        } catch (error) {
            this.emit('error', error);
        }
    }

    async restartDuet() {
        if (!this.isConnected || this.duetState !== 'S') return;
        try {
            await this.sendCommand('M999');
        } catch (error) {
            this.emit('error', error);
        }
    }

    updateDuetWorkplace(number) {
        const selector = document.getElementById('wcs-select');
        if (selector && Number.isInteger(number) && number >= 0 && number < 6) {
            selector.value = 'G' + (54 + number);
        }
    }

    setDuetPollInterval(input) {
        if (!input.checkValidity() || !Number.isFinite(input.valueAsNumber)) {
            input.value = this.duetPollInterval ?? 500;
            return;
        }
        this.duetPollInterval = input.valueAsNumber;
        this.saveSettings();
    }

    async pollDuet(client) {
        try {
            const status = await client.call('status', { type: 2 });
            if (this.duet !== client) return;
            this.updateDuetStatus(status);
            const workplace = await client.call('model', { key: 'move.workplaceNumber' });
            if (this.duet !== client) return;
            const selector = document.getElementById('wcs-select');
            if (selector && Number.isInteger(workplace.result) && workplace.result >= 0 && workplace.result < 6) {
                selector.value = 'G' + (54 + workplace.result);
            }
            const job = await client.call('status', { type: 3 });
            if (this.duet !== client) return;
            const jobActive = ['P', 'A', 'D', 'R'].includes(job.status) || job.filePosition > 0;
            if (jobActive && Number.isFinite(job.fractionPrinted)) {
                if (!this.duetJobFile) {
                    // Keep reporting job progress if the optional filename lookup fails.
                    const file = await client.call('model', { key: 'job.file.fileName' }).catch(() => null);
                    if (this.duet !== client) return;
                    this.duetJobFile = typeof file?.result === 'string' ? file.result : null;
                }
                window.dispatchEvent(new CustomEvent('sd-status', {
                    detail: { pct: Math.min(100, Math.max(0, job.fractionPrinted)), filename: this.duetJobFile }
                }));
            } else if (!jobActive) {
                this.duetJobFile = undefined;
                if (window.jobController?.sdJobActive) window.dispatchEvent(new Event('sd-job-complete'));
            }
            if (this.duetReplySequence !== status.seq) {
                const reply = await client.call('reply');
                if (this.duet !== client) return;
                this.duetReplySequence = status.seq;
                for (const line of reply.trim().split('\n').filter(Boolean)) this.emit('line', line.trim());
            }
            if (this.duet === client) this.duetTimer = setTimeout(() => this.pollDuet(client), this.duetPollInterval ?? 500);
        } catch (error) {
            if (this.duet !== client) return;
            this.disconnect();
            this.emit('error', error);
        }
    }

    disconnect() {
        if (this.duet) {
            const client = this.duet;
            this.duet = null;
            this.duetReplySequence = undefined;
            clearTimeout(this.duetTimer);
            this.handleDisconnect();
            return client.call('disconnect').catch(() => {});
        }

        this._setConnectingState(false);

        if (this.type === 'webserial') {
            this.webSerial.disconnect();
        } else if (this.type === 'websocket' && this.directWs) {
            this.directWs.close();
            this.directWs = null;
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            this._cordovaTelnetSocket.close();
            this._cordovaTelnetSocket = null;
            this.handleDisconnect();
        } else if (this.isCordova && window.serial) {
            try {
                window.serial.close(() => {}, () => {});
            } catch (e) {
                console.warn("Cordova Serial close failed:", e);
            }
            this.handleDisconnect();
        } else if (this.backendWs) {
            this.backendWs.send(JSON.stringify({ type: 'disconnect' }));
        }
    }

    _keepAwake(enable) {
        try {
            if (enable && window.plugins && window.plugins.insomnia) {
                window.plugins.insomnia.keepAwake();
            } else if (window.plugins && window.plugins.insomnia) {
                window.plugins.insomnia.allowSleepAgain();
            }
        } catch (e) {}
    }

    _syncHttpBaseUrl() {
        if (this.isConnected && this.type === 'telnet' && this.hasBackend) {
            this.httpBaseUrl = window.location.origin;
            return;
        }

        if (this.type !== 'websocket') {
            this.httpBaseUrl = null;
        }
    }

    clearPendingState() {
        this._backendBuffer = '';
        this._statusRequests = [];
        this.lastStatusWasFull = false;
        this.flowControl.reset();
        if (this.webSerial?.clearPendingState) {
            this.webSerial.clearPendingState();
        }
    }

    handleConnect() {
        this._setConnectingState(false);
        this.clearPendingState();
        this.isGrblHAL = false;
        this.supportsProbeStatus = false;
        this.isConnected = true;
        this._syncHttpBaseUrl();
        this.emit('connect');
        this._keepAwake(true);
        const sidebar = document.getElementById('machine-sidebar');
        if (sidebar && !sidebar.classList.contains('open')) {
            sidebar.classList.add('open');
            const overlay = document.getElementById('machine-sidebar-overlay');
            if (overlay) overlay.classList.remove('hidden');
        }
    }

    handleDisconnect() {
        this.duetAxisWrite = null;
        document.getElementById('duet-axis-rows')?.replaceChildren();
        for (const id of ['duet-axis-settings', 'duet-spindle-status']) {
            const output = document.getElementById(id);
            if (output) output.textContent = '';
        }
        this.isDuetSerial = false;
        this.duetSerialPollPending = false;
        this.duetFirmwareInfo = null;
        this.duetFeedOverride = undefined;
        this.duetState = undefined;
        if (window.droHandler) window.droHandler.homedMask = null;
        window.troubleshooting?.updateHoming(null);
        this.duetProbeKnown = false;
        this.duetJobFile = undefined;
        this._setConnectingState(false);
        this._connectionGeneration++;
        this.clearPendingState();
        this.isGrblHAL = false;
        this.supportsProbeStatus = false;
        this.isConnected = false;
        window.jobController?.handleDisconnect();
        this._syncHttpBaseUrl();
        this.emit('disconnect');
        this._keepAwake(false);
    }

    // --- Data Transmission ---

    // A write completing is not a controller acknowledgement. Correlate replies
    // with the transport's FIFO, including commands sent by other app features.
    sendCommandWithAck(command, { timeoutMs = 10000 } = {}) {
        const notSent = message => Promise.reject(Object.assign(new Error(message), { notSent: true }));
        if (!this.isConnected) return notSent('Controller disconnected');
        if (this._ackRequest) return notSent('Another acknowledged command is pending');
        const buffer = this.type === 'webserial' ? this.webSerial : this.flowControl;
        if (!buffer.isDrained()) return notSent('Controller is busy; wait for pending commands to finish');
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.off('command-result', onResult);
                this.off('disconnect', onDisconnect);
                this.off('error', onError);
                this.off('line', onReset);
                this._ackRequest = null;
                if (error) reject(error); else resolve(result);
            };
            const onResult = (result) => {
                if (result.command === command) finish(null, result);
            };
            const onDisconnect = () => finish(new Error('Controller disconnected; write outcome unknown'));
            const onError = () => finish(new Error('Connection error; write outcome unknown'));
            const onReset = (line) => {
                if (/^(Grbl|grblHAL|ALARM:)/i.test(line)) finish(new Error('Controller reset or alarm; write outcome unknown'));
            };
            const timer = setTimeout(() => finish(new Error('Controller acknowledgement timed out; write outcome unknown')), timeoutMs);
            this._ackRequest = { command };
            this.on('command-result', onResult);
            this.on('disconnect', onDisconnect);
            this.on('error', onError);
            this.on('line', onReset);
            Promise.resolve().then(() => {
                if (!settled && this.isConnected) return this.sendCommand(command);
            }).catch(error => finish(error));
        });
    }

    async sendCommand(line) {
        if (this.duet || this.isDuetSerial) {
            const code = String(line).trim();
            const command = code && duetCommand(code);
            if (!command) return;
            if (code.startsWith('$F=') && window.jobController?._hasActiveJob()) {
                this.emit('error', new Error('Wait for the current job to finish before starting another SD file.'));
                return;
            }
            if (/^\$(?:H|J=)/i.test(code) && this.duetState !== 'I') {
                this.emit('error', new Error('The Duet must be powered and idle to jog or home'));
                return;
            }
            if (this.duet) {
                await this.duet.send(command);
                this.emit('sent', code);
            } else {
                for (const commandLine of command.split('\n')) {
                    if (this.type === 'webserial') await this.webSerial.sendCommand(commandLine);
                    else await this.flowControl.sendCommand(commandLine);
                }
            }
            return;
        }

        // Extended commands require positive identification from $I.
        if (!this.isGrblHAL && /^\$(?:F|E[AEGS]|I\+|PINS|PINSTATE|SPINDLE|TLR|TPW|H[XYZABC])/i.test(String(line).trim())) return;

        if (typeof line === 'string' && line.trim().toUpperCase() === '$X') {
            this.clearPendingState();
        }

        if (this.type === 'webserial') {
            await this.webSerial.sendCommand(line);
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.isCordova && window.serial) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        } else if (this.backendWs) {
            await this.flowControl.sendCommand(line);
            this.emit('sent', line);
        }
    }

    async sendRealtime(char) {
        if (this.duet || this.isDuetSerial) {
            const delta = { '\x91': 10, '\x92': -10 }[char];
            if (char === '\x90' || delta !== undefined) {
                if (delta !== undefined && !Number.isFinite(this.duetFeedOverride)) return;
                const value = char === '\x90' ? 100 : Math.max(10, Math.min(200, this.duetFeedOverride + delta));
                try { await this.sendCommand('M220 S' + value); }
                catch (error) { this.emit('error', error); }
                return;
            }
        }
        if (this.duet || this.isDuetSerial) {
            const command = { '!': 'M25', '~': 'M24' }[char];
            if (command) {
                try { await this.sendCommand(command); }
                catch (error) { this.emit('error', error); }
            }
            return;
        }

        if ((char === '\x87' || char === '\x80') && !this.isGrblHAL) char = '?';

        if (char === '?' || char === '\x87' || char === '\x80') {
            this._statusRequests ||= [];
            this._statusRequests.push({ full: char === '\x87', at: Date.now() });
        }

        if (char === '\x18') {
            this.clearPendingState();
        }

        // Extended realtime commands are single bytes, even above 0x7F.
        const bytes = Uint8Array.of(char.charCodeAt(0));
        if (this.type === 'webserial') {
            await this.webSerial.sendRealtime(char);
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            this.directWs.send(bytes);
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            console.log("Telnet TX realtime:", JSON.stringify(char));
            this._cordovaTelnetSocket.write(bytes, () => {
                console.log("Telnet TX realtime success");
            }, (err) => {
                const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                console.error("Telnet Realtime TX Error:", msg);
            });
        } else if (this.isCordova && window.serial) {
            if (this._cordovaWriting) return;
            this._cordovaWriting = true;

            const hexChar = bytes[0].toString(16).padStart(2, '0');
            await new Promise((resolve) => {
                window.serial.writeHex(hexChar, resolve, (err) => {
                    console.error("Cordova Serial TX Error:", err);
                    resolve();
                });
            });
            this._cordovaWriting = false;
        } else if (this.backendWs) {
            const base64 = btoa(char);
            this.backendWs.send(JSON.stringify({ type: 'write', data: base64, encoding: 'base64' }));
        }
    }

    async writeRaw(data) {
        if (this.type === 'webserial') {
            await this.webSerial.writeRaw(data);
        } else if (this.type === 'websocket' && this.directWs && this.directWs.readyState === WebSocket.OPEN) {
            this.directWs.send(new Uint8Array(data));
        } else if (this.type === 'telnet' && this.isCordova && this._cordovaTelnetSocket) {
            const bytes = new Uint8Array(data);
            console.log("Telnet TX writeRaw:", bytes.length, "bytes");
            await new Promise((resolve) => {
                this._cordovaTelnetSocket.write(bytes, () => {
                    console.log("Telnet TX writeRaw success");
                    resolve();
                }, (err) => {
                    const msg = (typeof err === 'string') ? err : (err && err.message) ? err.message : JSON.stringify(err);
                    console.error("Telnet Raw TX Error:", msg);
                    resolve();
                });
            });
        } else if (this.isCordova && window.serial) {
            const generation = this._connectionGeneration;
            while (this._cordovaWriting) {
                await new Promise(r => setTimeout(r, 2));
                if (generation !== this._connectionGeneration) return;
            }
            if (!this.isConnected) return;
            this._cordovaWriting = true;

            const bytes = new Uint8Array(data);
            let hexCmd = "";
            for (let i = 0; i < bytes.length; i++) {
                hexCmd += bytes[i].toString(16).padStart(2, '0');
            }
            await new Promise((resolve) => {
                window.serial.writeHex(hexCmd, resolve, (err) => {
                    console.error("Cordova Serial TX Error:", err);
                    resolve();
                });
            });
            this._cordovaWriting = false;
        } else if (this.backendWs) {
            // Efficiently convert Uint8Array to Base64
            const bytes = new Uint8Array(data);
            // Using fromCodePoint or apply on fromCharCode is faster for small/medium chunks
            const binary = String.fromCharCode.apply(null, bytes);
            const base64 = btoa(binary);
            this.backendWs.send(JSON.stringify({ type: 'write', data: base64, encoding: 'base64' }));
        }
    }

    setRawHandler(callback) {
        this.rawModeCallback = callback;
        if (this.type === 'webserial') {
            this.webSerial.setRawHandler(callback);
        }
    }

    // --- Event Emitter ---
    on(event, callback) {
        if (this.listeners[event]) this.listeners[event].push(callback);
    }

    removeListener(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    off(event, callback) {
        this.removeListener(event, callback);
    }

    emit(event, data) {
        if (event === 'connect' || (event === 'error' && !this.isConnected)) {
            const transport = ['usb', 'webserial', 'websocket', 'telnet'].includes(this.type) ? this.type : 'other';
            const medium = transport === 'usb' || transport === 'webserial' ? 'USB' : 'unknown';
            if (event === 'connect') this.analyticsNetworkMedium = undefined;
            window.appAnalytics?.('connection outcome', {
                transport,
                medium,
                outcome: event === 'connect' ? 'connected' : 'error while disconnected'
            });
        }
        if (event === 'line' && this.isConnected && this.isGrblHAL && !this.analyticsNetworkMedium &&
            ['telnet', 'websocket'].includes(this.type) && typeof data === 'string') {
            const wifiMode = /^\$73\s*=\s*(\d+)$/.exec(data.trim());
            if (wifiMode) {
                this.analyticsNetworkMedium = Number(wifiMode[1]) === 0 ? 'Ethernet' : 'Wi-Fi';
                window.appAnalytics?.('network medium detected', {
                    transport: this.type, medium: this.analyticsNetworkMedium
                });
            }
        }
        if (event === 'line' && typeof data === 'string' && data.startsWith('<')) {
            const now = Date.now();
            this._statusRequests = (this._statusRequests || []).filter(request => now - request.at < 5000);
            this.lastStatusWasFull = this._statusRequests.shift()?.full || false;
        }
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    getConnectionSnapshot() {
        if (this.type === 'usb') {
            return {
                type: 'usb',
                port: document.getElementById('port-node')?.value || null,
                baud: parseInt(document.getElementById('baud-node')?.value) || 115200
            };
        }

        if (this.type === 'webserial') {
            return {
                type: 'webserial',
                baud: parseInt(document.getElementById('baud-webserial')?.value) || 115200
            };
        }

        if (this.type === 'telnet') {
            return {
                type: 'telnet',
                ip: document.getElementById('ip-telnet')?.value || null,
                port: parseInt(document.getElementById('port-telnet')?.value) || 23
            };
        }

        if (this.type === 'websocket') {
            return {
                type: 'websocket',
                url: document.getElementById('url-websocket')?.value || null
            };
        }

        return { type: this.type };
    }

    _isPrivateIPv4(ip) {
        return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
    }

    _deriveSubnetCandidates(networkInfo) {
        const seen = new Set();
        const candidates = [];

        for (const entry of networkInfo || []) {
            const address = typeof entry === 'string' ? entry : entry.address;
            const name = typeof entry === 'string' ? '' : (entry.name || '');
            const netmask = typeof entry === 'string' ? '' : (entry.netmask || '');
            if (!address || !/^\d+\.\d+\.\d+\.\d+$/.test(address)) continue;
            if (netmask === '255.255.255.255') continue;

            const subnet = address.split('.').slice(0, 3).join('.');
            if (seen.has(subnet)) continue;
            seen.add(subnet);

            let score = 0;
            if (this._isPrivateIPv4(address)) score += 100;
            if (netmask === '255.255.255.0') score += 20;
            if (/tailscale|hyper-v|vethernet|virtualbox|vmware|docker|wsl/i.test(name)) score -= 100;
            if (/^169\.254\./.test(address)) score -= 100;
            if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) score -= 80;

            candidates.push({
                subnet,
                address,
                name,
                label: name ? `${subnet}.x (${address} via ${name})` : `${subnet}.x (${address})`,
                score
            });
        }

        candidates.sort((a, b) => b.score - a.score || a.subnet.localeCompare(b.subnet));
        return candidates;
    }

    async _getPreferredScanSubnets() {
        if (this.isElectron && window.electron?.getNetworkInfo) {
            try {
                const info = await window.electron.getNetworkInfo();
                const candidates = this._deriveSubnetCandidates(info);
                if (candidates.length) return candidates;
            } catch (e) {
                console.error('Failed to enumerate network interfaces for scan:', e);
            }
        }

        try {
            const localIP = await this._getLocalIP();
            if (localIP && this._isPrivateIPv4(localIP)) {
                const subnet = localIP.split('.').slice(0, 3).join('.');
                return [{
                    subnet,
                    address: localIP,
                    name: this.isCordova ? 'Device Network' : 'Local Network',
                    label: `${subnet}.x (${localIP} inferred)`,
                    score: 50
                }];
            }
        } catch (e) {
            console.error('Failed to infer local IP for scan:', e);
        }

        if (window.location.hostname !== 'localhost'
            && window.location.hostname !== '127.0.0.1'
            && /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname)
            && this._isPrivateIPv4(window.location.hostname)) {
            const subnet = window.location.hostname.split('.').slice(0, 3).join('.');
            return [{
                subnet,
                address: window.location.hostname,
                name: 'Current Host',
                label: `${subnet}.x (${window.location.hostname} current host)`,
                score: 40
            }];
        }

        return [
            { subnet: '192.168.0', label: '192.168.0.x', score: 0 },
            { subnet: '192.168.1', label: '192.168.1.x', score: 0 },
            { subnet: '192.168.4', label: '192.168.4.x', score: 0 },
            { subnet: '10.0.0', label: '10.0.0.x', score: 0 }
        ];
    }

    // --- Network Scanner ---
    async scanNetwork() {
        const resultsDiv = document.getElementById('scan-results');
        const statusDiv = document.getElementById('scan-status');
        const btn = document.getElementById('btn-scan-network');

        if (this._scanning) return;
        this._scanning = true;

        btn.disabled = true;
        btn.classList.add('opacity-50');
        resultsDiv.innerHTML = '';
        resultsDiv.classList.remove('hidden');
        statusDiv.classList.remove('hidden');

        // Common subnets to try
        let subnets = ['192.168.1', '192.168.0', '192.168.4', '10.0.0'];

        // Try to detect local subnet if in Electron or non-localhost web
        if (this.isElectron && window.electron.getNetworkInfo) {
            try {
                const ips = await window.electron.getNetworkInfo();
                ips.forEach(item => {
                    const ip = typeof item === 'string' ? item : item.address;
                    const parts = ip.split('.');
                    if (parts.length === 4) {
                        parts.pop();
                        const subnet = parts.join('.');
                        if (!subnets.includes(subnet)) subnets.unshift(subnet);
                    }
                });
            } catch (e) { console.error("Scanner subnet detection failed:", e); }
        } else if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname)) {
            const parts = window.location.hostname.split('.');
            parts.pop();
            const subnet = parts.join('.');
            if (!subnets.includes(subnet)) subnets.unshift(subnet);
        }

        const found = [];
        const checkIP = async (ip) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 800);
                // We check for /sdfiles?action=list which is a core Plugin_WebUI endpoint
                const resp = await fetch(`http://${ip}/sdfiles?action=list`, { signal: controller.signal }).catch(() => null);
                clearTimeout(timeoutId);

                if (resp && resp.ok) {
                    try {
                        const data = await resp.json();
                        // grblHAL Plugin_WebUI returns specific JSON structure
                        if (data && data.status === 'ok' && data.files !== undefined) {
                            return { ip, name: 'grblHAL Controller' };
                        }
                    } catch (e) { }
                }
            } catch (e) { }
            return null;
        };

        // Parallel scan with limited concurrency
        const concurrency = 15;
        for (const subnet of subnets) {
            statusDiv.textContent = `Scanning ${subnet}.x...`;
            const tasks = [];
            for (let i = 1; i < 255; i++) {
                const ip = `${subnet}.${i}`;
                tasks.push((async () => {
                    const res = await checkIP(ip);
                    if (res) {
                        found.push(res);
                        this._addScanResult(res);
                    }
                })());

                if (tasks.length >= concurrency) {
                    await Promise.all(tasks);
                    tasks.length = 0;
                }
            }
            await Promise.all(tasks);
        }

        this._scanning = false;
        btn.disabled = false;
        btn.classList.remove('opacity-50');
        statusDiv.classList.add('hidden');

        if (found.length === 0) {
            resultsDiv.innerHTML = '<div class="text-[10px] text-grey text-center py-2">No controllers found.</div>';
        }
    }

    _addScanResult(res) {
        const resultsDiv = document.getElementById('scan-results');
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between p-1.5 hover:bg-white rounded cursor-pointer transition-colors border-b border-grey-light last:border-b-0 group';
        div.innerHTML = `
            <div class="flex flex-col">
                <span class="text-xs font-bold text-secondary-dark">${res.ip}</span>
                <span class="text-[9px] text-grey uppercase font-bold text-primary">${res.name}</span>
            </div>
            <i data-lucide="chevron-right" style="width:14px;height:14px"></i>
        `;
        div.onclick = () => {
            const urlInput = document.getElementById('url-websocket');
            if (urlInput) {
                urlInput.value = `ws://${res.ip}:81/ws`;
            }
            const telnetIpInput = document.getElementById('ip-telnet');
            if (telnetIpInput) {
                telnetIpInput.value = res.ip;
            }
            // Auto-hide results
            resultsDiv.classList.add('hidden');
        };
        resultsDiv.appendChild(div);
    }

    // --- Cordova Telnet auto-discovery ---

    async openTelnetScanner() {
        const btn = document.getElementById('btn-scan-telnet');
        if (btn) btn.disabled = true;
        this._setTelnetScanMode(true);
        this._resetTelnetScanUI('Select a network adapter to begin scanning.');
        await this._populateTelnetSubnetOptions();
        this.updateTelnetScanStartState();
        if (btn) btn.disabled = false;
    }

    async scanTelnetNetwork() {
        return this.openTelnetScanner();
    }

    updateTelnetScanStartState() {
        const startBtn = document.getElementById('btn-start-telnet-scan');
        const subnetSelect = document.getElementById('discover-subnet-select');
        if (!startBtn || !subnetSelect) return;
        const canStart = !!subnetSelect.value;
        startBtn.disabled = !canStart;
        startBtn.classList.toggle('opacity-50', !canStart);
        startBtn.classList.toggle('pointer-events-none', !canStart);
    }

    _setTelnetScanMode(enabled) {
        const ipWrap = document.getElementById('telnet-manual-ip-wrap');
        const portWrap = document.getElementById('telnet-manual-port-wrap');
        const panel = document.getElementById('discover-panel');
        const btn = document.getElementById('btn-scan-telnet');
        const connectBtn = document.getElementById('btn-modal-connect');

        if (ipWrap) ipWrap.classList.toggle('hidden', enabled);
        if (portWrap) portWrap.classList.toggle('hidden', enabled);
        if (panel) panel.classList.toggle('hidden', !enabled);
        if (connectBtn) connectBtn.classList.toggle('hidden', enabled);

        if (btn) {
            btn.innerHTML = enabled
                ? '<i data-lucide="keyboard" style="width:14px;height:14px"></i> MANUAL ENTRY'
                : '<i data-lucide="search" style="width:14px;height:14px"></i> SCAN NETWORK';
            btn.onclick = enabled
                ? () => this.closeTelnetScanner()
                : () => this.openTelnetScanner();
        }
    }

    closeTelnetScanner() {
        this._setTelnetScanMode(false);
        const btn = document.getElementById('btn-scan-telnet');
        const startBtn = document.getElementById('btn-start-telnet-scan');
        if (btn) btn.disabled = false;
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    }

    async startTelnetScanNetwork() {
        const btn = document.getElementById('btn-scan-telnet');
        const startBtn = document.getElementById('btn-start-telnet-scan');
        const portInput = document.getElementById('port-telnet');
        const port = parseInt(portInput?.value) || 23;
        const subnetSelect = document.getElementById('discover-subnet-select');
        const selectedSubnet = subnetSelect?.value || '';

        if (!selectedSubnet) {
            this._setTelnetScanStatus('Select a network adapter before starting the scan.');
            return;
        }

        if (btn) btn.disabled = true;
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.classList.add('opacity-50', 'pointer-events-none');
        }
        this._resetTelnetScanUI(`Starting scan on port ${port}...`);
        if (subnetSelect) subnetSelect.value = selectedSubnet;
        this._setTelnetScanProgress(0, `Scanning ${selectedSubnet}.x on port ${port}...`);

        if (this.isCordova && this.CordovaSocket) {
            const devices = await this._discoverTelnetDevices(port, selectedSubnet);
            this._handleScanResult(devices, port);
        } else if (this.isElectron) {
            if (!this.backendWs) await this.connectToBackend();
            this.backendWs.send(JSON.stringify({ type: 'scanTelnet', port, subnet: selectedSubnet }));
        } else {
            this._setTelnetScanStatus('Telnet scanning unavailable on this platform');
            this._setTelnetScanProgress(null);
            if (btn) btn.disabled = false;
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.classList.remove('opacity-50', 'pointer-events-none');
            }
        }
    }

    _handleScanResult(devices, port) {
        const btn = document.getElementById('btn-scan-telnet');
        const startBtn = document.getElementById('btn-start-telnet-scan');
        if (btn) btn.disabled = false;
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
        this._setTelnetScanProgress(devices.length > 0 ? 100 : null);

        if (devices.length > 0) {
            this._setTelnetScanStatus(`Found ${devices.length} grblHAL devices on port ${port}`);
            this._showDiscoveredDevices(devices);
        } else {
            this._setTelnetScanStatus(`No grblHAL devices found on port ${port}`);
            this._showDiscoveredDevices([]);
        }
    }

    _getTelnetScanEls() {
        return {
            panel: document.getElementById('discover-panel'),
            status: document.getElementById('discover-status'),
            subnetWrap: document.getElementById('discover-subnet-wrap'),
            subnetSelect: document.getElementById('discover-subnet-select'),
            progressWrap: document.getElementById('discover-progress-wrap'),
            progressBar: document.getElementById('discover-progress-bar'),
            container: document.getElementById('discovered-devices'),
            list: document.getElementById('discovered-list')
        };
    }

    _resetTelnetScanUI(statusText = '') {
        const { panel, status, progressWrap, progressBar, container, list } = this._getTelnetScanEls();
        if (panel) panel.classList.remove('hidden');
        if (status) status.textContent = statusText;
        if (progressWrap) progressWrap.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
        if (container) container.classList.add('hidden');
        if (list) list.innerHTML = '';
    }

    async _populateTelnetSubnetOptions() {
        const { panel, subnetWrap, subnetSelect } = this._getTelnetScanEls();
        if (!subnetSelect) return null;

        const candidates = await this._getPreferredScanSubnets();
        subnetSelect.innerHTML = [
            '<option value="">Select Network Adapter</option>',
            ...candidates.map(candidate =>
            `<option value="${candidate.subnet}">${candidate.label}</option>`
            )
        ].join('');

        if (panel) panel.classList.remove('hidden');
        if (subnetWrap) subnetWrap.classList.remove('hidden');

        return candidates[0]?.subnet || null;
    }

    _setTelnetScanStatus(text) {
        const { panel, status } = this._getTelnetScanEls();
        if (panel) panel.classList.remove('hidden');
        if (status) status.textContent = text;
    }

    _setTelnetScanProgress(percent, text = null) {
        const { panel, status, progressWrap, progressBar } = this._getTelnetScanEls();
        if (panel) panel.classList.remove('hidden');
        if (text && status) status.textContent = text;
        if (percent === null || percent === undefined) {
            if (progressWrap) progressWrap.classList.add('hidden');
            if (progressBar) progressBar.style.width = '0%';
            return;
        }
        if (progressWrap) progressWrap.classList.remove('hidden');
        if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }

    async _getLocalIP() {
        return new Promise((resolve) => {
            try {
                const pc = new RTCPeerConnection({ iceServers: [] });
                pc.createDataChannel('');
                pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
                let resolved = false;
                pc.onicecandidate = (ice) => {
                    if (resolved) return;
                    if (!ice || !ice.candidate || !ice.candidate.candidate) {
                        if (!resolved) { pc.close(); resolve(null); resolved = true; }
                        return;
                    }
                    const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(ice.candidate.candidate);
                    if (m) {
                        const ip = m[1];
                        if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
                            resolved = true;
                            pc.close();
                            resolve(ip);
                        }
                    }
                };
                setTimeout(() => { if (!resolved) { pc.close(); resolve(null); resolved = true; } }, 2000);
            } catch (e) {
                resolve(null);
            }
        });
    }

    async _discoverTelnetDevices(port, subnetOverride = null) {
        if (!this.isCordova || !this.CordovaSocket) return [];

        port = port || 23;
        this._setTelnetScanStatus(`Scanning network on port ${port}...`);
        this._setTelnetScanProgress(0);

        const devices = [];

        // Step 1: Try saved IP first (fast path, with longer timeout)
        const saved = this.loadSettings();
        if (saved && saved.telnetIp) {
            this._setTelnetScanStatus(`Checking ${saved.telnetIp}...`);
            const found = await this._checkTelnetPortSequential(saved.telnetIp, port, 2000);
            if (found) {
                devices.push(found);
                return devices;
            }
        }

        // Step 2: Detect local subnet via WebRTC
        let localIP = null;
        try {
            localIP = await this._getLocalIP();
        } catch (e) {}

        const subnets = [];
        if (subnetOverride) {
            subnets.push(subnetOverride);
        } else if (localIP) {
            const parts = localIP.split('.');
            subnets.push(parts.slice(0, 3).join('.'));
        } else {
            subnets.push('192.168.0', '192.168.1', '192.168.4', '10.0.0');
        }

        // Step 3: Sequential TCP scan (plugin tracks by port, so only one connection at a time)
        for (const subnet of subnets) {
            devices.push(...await this._tcpScanSubnetSequential(subnet, port, subnets.length, (ip) => {
                this._appendDiscoveredDevice(ip);
            }));
        }

        return devices;
    }

    async _tcpScanSubnetSequential(subnet, port, subnetCount, onFound = null) {
        if (!this.CordovaSocket) return [];
        const found = [];
        const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
        for (let i = 0; i < ips.length; i++) {
            const pct = Math.round(((i + 1) / ips.length) * 100);
            this._setTelnetScanProgress(pct, `Scanning ${subnet}.x  ${pct}%  (port ${port})`);
            const result = await this._checkTelnetPortSequential(ips[i], port, 700);
            if (result && !found.includes(result)) {
                found.push(result);
                if (onFound) onFound(result);
            }
        }
        return found;
    }

    async _checkTelnetPortSequential(ip, port, timeout) {
        return new Promise((resolve) => {
            let resolved = false;
            let socket;
            try {
                socket = new this.CordovaSocket();
            } catch (e) {
                resolve(null);
                return;
            }

            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try { socket.close(); } catch (e) {}
                    resolve(null);
                }
            }, timeout);

            const finish = (found) => {
                if (!resolved) {
                    clearTimeout(timer);
                    resolved = true;
                    try { socket.close(); } catch (e) {}
                    resolve(found ? ip : null);
                }
            };

            socket.onData = (data) => {
                if (!resolved) {
                    const text = new TextDecoder().decode(data);
                    if (
                        text.includes('GrblHAL') ||
                        text.includes('grbl') ||
                        text.includes('Ooznest') ||
                        text.includes('ok') ||
                        text.includes('<') ||
                        text.includes('[MSG:')
                    ) {
                        finish(true);
                    }
                }
            };

            socket.onError = () => {
                if (!resolved) { clearTimeout(timer); resolved = true; resolve(null); }
            };

            socket.onClose = () => {
                if (!resolved) { clearTimeout(timer); resolved = true; resolve(null); }
            };

            socket.open(ip, port, () => {
                try {
                    const probe = new TextEncoder().encode('\r\n?\r\n');
                    socket.write(probe, () => {}, () => {});
                } catch (e) {}
            }, (err) => {
                if (!resolved) { clearTimeout(timer); resolved = true; resolve(null); }
            });
        });
    }

    _autoConnectTelnet(ip) {
        if (this.isConnected || this.isConnecting) {
            console.log("Skipping Telnet auto-connect to", ip, ": already connected/connecting");
            return;
        }
        console.log("Auto-connecting Telnet to", ip);
        const ipInput = document.getElementById('ip-telnet');
        const portInput = document.getElementById('port-telnet');
        if (ipInput) ipInput.value = ip;
        if (portInput) portInput.value = '23';

        this.type = 'telnet';
        this.saveSettings();
        this.modalController?.hide();
        this._showConnectingStatus(`Auto-connecting to ${ip}:23 (Telnet)...`);
        if (this.isCordova) {
            this._connectCordovaTelnet(ip, 23).catch(err => {
                console.error("Telnet auto-connect failed:", err);
            });
        } else {
            if (!this.backendWs) {
                this.connectToBackend().then(() => {
                    this.backendWs.send(JSON.stringify({ type: 'connect', connectionType: 'telnet', ip, port: 23 }));
                }).catch(err => {
                    console.error("Telnet auto-connect failed:", err);
                });
            } else {
                this.backendWs.send(JSON.stringify({ type: 'connect', connectionType: 'telnet', ip, port: 23 }));
            }
        }
    }

    _showDiscoveredDevices(devices) {
        const container = document.getElementById('discovered-devices');
        const list = document.getElementById('discovered-list');
        const statusEl = document.getElementById('discover-status');
        if (!container || !list) return;

        list.innerHTML = '';
        container.classList.remove('hidden');

        if (devices.length === 0) {
            const div = document.createElement('div');
            div.className = 'text-[10px] text-grey text-center py-2';
            div.textContent = 'No devices found.';
            list.appendChild(div);
            return;
        }

        for (const ip of devices) {
            this._appendDiscoveredDevice(ip);
        }
    }

    _appendDiscoveredDevice(ip) {
        if (!ip) return;
        const container = document.getElementById('discovered-devices');
        const list = document.getElementById('discovered-list');
        if (!container || !list) return;

        const existing = list.querySelector(`[data-ip="${ip}"]`);
        if (existing) return;

        const empty = Array.from(list.children).find(node => node.textContent === 'No devices found.');
        if (empty) empty.remove();

        container.classList.remove('hidden');

        const div = document.createElement('div');
        div.dataset.ip = ip;
        div.className = 'flex items-center justify-between gap-3 p-2 hover:bg-white rounded transition-colors border-b border-grey-light last:border-b-0';
        div.innerHTML = `
            <div class="flex flex-col min-w-0">
                <span class="text-xs font-bold text-secondary-dark">${ip}</span>
            </div>
            <button class="btn btn-primary h-8 px-3 text-[10px] font-bold shrink-0">Connect</button>
        `;
        div.querySelector('button')?.addEventListener('click', () => {
            const ipInput = document.getElementById('ip-telnet');
            if (ipInput) ipInput.value = ip;
            this._autoConnectTelnet(ip);
        });
        list.appendChild(div);
    }
}
