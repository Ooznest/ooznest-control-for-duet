# Duet verification

Bench controller: Duet Ethernet, RepRapFirmware 3.3, COM22 at 115200 baud.

- Ethernet API: connected, listed SD contents, created and deleted a temporary folder, and verified a temporary upload/download byte for byte. A dwell-only SD job ran and reported progress on a 0–100 scale even though machine status was Off.
- USB serial: verified firmware identification, machine and work position readback, a feed override change and restoration, and emergency stop followed by controller restart.
- Pause/stop: a dwell-only job paused and stopped on the bench. Resume did not advance while machine status was Off. Repeat with controller power and check Pause, Resume, and Stop from the app.
- Desktop: the Electron bench suite passed over Ethernet and COM22. Visually inspected macro startup and open/close. Verified Ethernet feed override, WCS selection and restoration, visible SD job progress, and editing and saving a temporary system file to its original path. Over COM22, verified firmware identification, live status, and feed override change and restoration.
- Browser: verify HTTP from the intended hosting origin and Web Serial through the browser picker. The Windows COM22 test only establishes board-side behavior.
- Powered machine: verify jog distance and direction, homing and endstops, probe contact and failure handling, Z adjustment, spindle behavior where configured, and power-loss recovery. The bare board cannot establish those physical outcomes.
- Android: debug APK built and cold-launched on the emulator. Cordova fired deviceready and the WebView finished loading. The emulator had no route to the bench Ethernet IP. Verify Ethernet and USB on a physical Android device.

The earlier Windows package cold-launched with a fresh Electron profile using a system-assigned loopback port. That changed the renderer origin on each launch, making saved settings and macros inaccessible from subsequent launches. The source build now uses loopback port 8082. Two launches with the same fresh Electron profile returned the same test value from renderer storage. The rebuilt unpacked Windows app passed the same two-launch storage check. The installer was rebuilt successfully.
For powered checks, record the machine model, firmware version, axis homing results, measured jog distance per axis, and probe results for each supported routine. Test pause, resume, stop, and power-loss recovery with a dry-run SD job and record the reported job state and position after each action.
A live request to the bench Duet with Origin http://localhost:8000 returned HTTP 200 and status JSON, with no Access-Control-Allow-Origin header. COM22 was present during this check. Electron HTTP remains usable through its native bridge.
The browser connection dialog calls navigator.serial.requestPort(), then runs the shared M115 identification and RepRapFirmware status path after the port opens. To verify in Chrome or Edge, close any app connection to COM22, select it in the Web Serial picker, and check that the app shows RepRapFirmware and updates the DROs.
A fresh launch of the rebuilt Windows package discovered COM22, identified RepRapFirmware 3.3 on Duet Ethernet, and received live status. The test disconnected and closed its Electron instance.

## Feature gaps
Over HTTP, the app offers Z probing and manually positioned X/Y single-face probing. Generated commands for all four side directions were checked in tests. Powered contact, offsets, and retract still need verification. Automatic corner probing uses the legacy WorkBee approach and clearance sequence. Tests checked the generated commands for all four orientations and the Electron bench confirmed that the Off, unhomed board rejects the form before any upload. On a powered WorkBee, verify the starting position, clearance between faces, the measured XYZ work offsets, and the abort behavior on a missed touch. The USB Network Info action reports the board IP in the Console. The USB Enable Ethernet button uses the existing IP configuration. USB setup offers DHCP and a session-only static IPv4 address. Persistent Ethernet configuration and Wi-Fi provisioning remain manual. The available test board is Ethernet only.
The Electron captures show the Ooznest Control layout, the macro dialog open, and the workspace after closing it. The fresh-profile bench test separately asserted that the dialog starts closed.
The fresh-profile captures were visually reviewed: startup shows the analytics consent dialog with the 3D Preview behind it and no macro dialog, Create New Macro is visible on demand, and the later Console capture has no modal overlay. Ethernet and COM22 assertions passed in that run before the launcher timed out on exit.
Duet Settings can edit and reset the WorkBee limits and calibration files through the SD editor and apply the saved files when the controller is powered and idle. Live axis and spindle readback passed. Applying changed limits and calibration, then checking persistence after restart, still needs a powered test. The latest Ethernet and COM22 bench run exited with code 0 with screenshot capture disabled.
Enable Ethernet passed in Electron over COM22 with the interface already enabled. In a separate direct COM22 test, disabling and re-enabling the interface restored HTTP at the original configured IP. Wi-Fi provisioning remains manual.
The unpacked Windows build from 765186d enabled a disabled Ethernet interface through the app over COM22 and restored HTTP at the original configured address. The current installer completed a per-user install on Windows. A fresh launch of the installed app received live status over COM22, disconnected USB, then received live status over Ethernet HTTP.
The Electron suite verified the full handoff: it cleared the HTTP address, read the board IP over COM22, verified the new field value, waited for USB disconnect, and connected over HTTP using the discovered address.
Legacy probing reference: WorkBee-Control/src/components/panels/TouchProbePanel.vue uses M585 with a temporary tool for each axis. The corner sequence probes Z first, then clears the block and approaches its X and Y faces. Side offsets depend on the selected corner, block geometry and cutter radius. Porting the legacy sequence requires stopping on each failed touch before setting the corresponding work offset or moving to the next face.
The Duet Ethernet accepted the temporary DHCP command over COM22 but still reported 0.0.0.0 after six seconds. The original static address was restored and HTTP verified. The desktop confirmation and pending-address message passed simulated checks. Verify lease acquisition on a DHCP-enabled network.
Local two-line read-only macros passed in Electron over both transports. Ethernet accepted M115 and M552 in order. COM22 returned firmware acknowledgements for both commands in order.
The Grbl-style Duet Settings table displayed live axis values over HTTP. Editing enabled Save, confirmation on the Off controller blocked the write, and Refresh restored the controller value. Verify a successful write and readback on a powered idle controller.
The installed Windows build from 9c1624d loaded 12 live axis settings over Ethernet on opening Settings. The source bench suite also verified that tab changes preserve edits and that cancelling Refresh preserves them. Powered idle write and readback remain open.
The rebuilt unpacked Windows app restored the saved 850 ms Duet polling interval after a clean restart with the same profile.
With the packaged Electron window hidden, a 1200 ms HTTP polling setting produced two observed status request gaps of 2009 ms and 2003 ms against the bench Duet. This confirms repeated live requests with the setting applied in the UI. Foreground polling cadence still needs a timed comparison against the default.
With Electron background throttling disabled, the hidden source app recorded live request gaps of 1141 and 1149 ms at a 500 ms setting, and 1867 and 1387 ms at 1200 ms. The comparison missed its 250 ms minimum separation by 12 ms. These are end-to-end gaps, including HTTP and reply handling. The polling interval is a delay after each update completes.
The Electron bench suite clicked Load Current Job during a dwell-only Duet SD job, verified the active file opened in 3D Preview, observed progress clear, and deleted the temporary file. COM22 checks also passed in the same run.
After the dwell-only SD job completed, the Electron bench suite clicked Unload G-code, verified the editor and selected SD path cleared, and downloaded the original file again to confirm it remained on the card.
The latest Electron run passed the Ethernet SD job checks, including the warning when Unload G-code is clicked during a running job and successful unload after completion. The same run then timed out waiting for COM22 firmware identification or status.
The full Electron source bench suite passed with the serial identification retry in place. It verified HTTP, then connected to COM22, identified RepRapFirmware and received live status. The run did not record whether the first identification request or its retry succeeded.
The rebuilt unpacked Windows app cold-launched with a fresh profile. The macro dialog was closed at startup and both Load Current Job and Unload G-code were present. The latest full HTTP and COM22 run used the source app.
Set Static IP passed in Electron over COM22 with the existing address 192.168.251.2. The app confirmed the setting, read the address back over USB, filled the HTTP field and reconnected over Ethernet. A change to a different address and persistence after restart were outside this check.
Chrome loaded the browser app from localhost. Web Serial Connect closed the in-app dialog, but automation did not observe a native device chooser or a connected state. Electron COM22 remains the verified serial path.
The bare Ethernet board reports Off, all axes unhomed, no active tool, and probe reading 0 with threshold 500. The Z probe preflight requires Idle and Z homed before uploading or running probe.g. Verify actual contact, work offset, and retract with a powered machine and connected probe block.
The Electron bench suite confirmed that the Z Probe action rejected the Off, unhomed Duet before attempting an SD upload or G-code submission. HTTP and COM22 checks passed in the same run. Physical contact, offset and retract remain pending.
The latest Windows installer completed in a temporary directory. Its installed app.asar had the same SHA-256 hash as the unpacked app that passed the fresh-profile startup check.
The latest checks ran from node_modules/electron/dist/electron.exe against the source tree. Load & View displayed the selected SD file and waited for Run confirmation. Run Directly executed the dwell-only fixture. The active job preview recovered after a simulated filename request failure. Both transports displayed Off on the bare board, and an injected unknown state disabled jogging.

## Run the Windows bench suite from source

The bench Duet startup file was read over HTTP and confirmed to include config-network.g. On WorkBee configurations that load `/sys/config-network.g` at startup, review that file in SD Card → System → Edit over HTTP to make Ethernet settings persistent. The USB setup controls apply session settings. This workflow still needs a restart and HTTP reconnection test with a changed address.

From the Duet repository in PowerShell, with dependencies installed and the bench Duet reachable at 192.168.251.2 and COM22:

```powershell
$profile = Join-Path $env:TEMP ("duet-bench-" + [guid]::NewGuid())
$electron = Start-Process (Resolve-Path 'node_modules/electron/dist/electron.exe') -ArgumentList @('duet-ui-check.cjs', '--duet-ui-check', ('--user-data-dir="' + $profile + '"')) -WindowStyle Hidden -PassThru
if (!$electron.WaitForExit(80000)) {
    Stop-Process -Id $electron.Id -ErrorAction SilentlyContinue
    throw 'Duet bench Electron did not exit within 80 seconds.'
}
$electron.ExitCode
```

Exit code 0 means the checks passed. The default run captures startup and macro screenshots. Set `$env:DUET_BENCH_SKIP_SCREENSHOTS='1'` to run the checks without refreshing those captures.
RepRapFirmware 3.3 ProbeTool uses signed R as the relative travel limit for M585. The axis value sets the temporary tool offset. All generated Z, X/Y and corner touches use signed R. Verify actual direction and travel on a powered machine before relying on these routines.
RRF 3.3 checks for an already-triggered probe before each M585 move and reports an error after a missed touch. Source references: https://github.com/Duet3D/RepRapFirmware/blob/3.3/src/GCodes/GCodes3.cpp and https://github.com/Duet3D/RepRapFirmware/blob/3.3/src/GCodes/GCodes4.cpp. Verify the macro stops on the first failed touch and leaves no temporary tool active on the powered machine.

The source Electron suite passed with a fresh profile at 1280 × 850. The three desktop captures were visually checked: startup shows 3D Preview with no macro dialog, Add Macro opens the dialog, and the close button returns to the Macros tab with no overlay. Ethernet and COM22 assertions passed in the same run.

The Electron suite checks that Power Loss Resume is visible but disabled while the Duet reports Off, and that spindle status reports no configured spindles on this board. A powered controller with a saved recovery file and a configured spindle is needed to test the active paths. Continuous jogging stays hidden offline and over HTTP. COM22 also suppresses it when the profile carries a saved continuous-jog preference.

The latest source Electron run exited with code 0 after verifying HTTP, COM22, and the final Offline state. In the SD Card tab, a temporary system file with an apostrophe and ampersand was renamed to a name containing a space, listed again, and downloaded with matching contents. A separate live HTTP check renamed a nonempty folder and confirmed that a duplicate destination leaves both files intact. The Electron suite used the local binary.

Windows reported USB VID 1D50 and PID 60EC for COM22. The Cordova permission list and Android attach filter include that pair. The Cordova read callback forwards complete serial lines to the same firmware detector used by desktop USB. On a physical Android device, verify attach, permission, firmware identification, live position updates and disconnect.

Cordova currently uses WebView fetch for Duet HTTP. The Android navigation allowlist does not supply CORS headers on the controller response. The bench Duet returned no Access-Control-Allow-Origin for the tested localhost origin. Android Ethernet remains unverified and may require a controller origin setting or a native HTTP bridge.

The bare board continued to report Off while it held a paused test file open. Cleanup confirmed the active filename before stopping and deleting that fixture. The source Electron suite passed over HTTP and COM22 with the powered Pause/Stop test gated on controller state. Stop feedback during an active dwell-only job is covered separately. Resume and controller-confirmed Pause/Stop still require a powered test.
Troubleshooting → Info displayed the Duet Ethernet board and firmware version identified over COM22 in the live Electron suite. The same run passed HTTP checks and explicitly skipped powered Pause/Stop because the board reported Off.

The fresh Duet checkout starts at original Ooznest Control commit f19be69. Its initial port commit 8902dc2 matched the previously tested Duet tree exactly. A fresh-profile run from that checkout reused the installed Electron binary and dependencies and exited with code 0 after macro startup, open and close, HTTP, and COM22 checks. This run used screenshot capture disabled after a capture-enabled attempt hit the overall timeout. Powered Pause/Stop was skipped because the board reported Off.

The capture-enabled fresh checkout run saved duet-startup.png, duet-macro-open.png and duet-macro-closed.png before the bench timeout. Visual review confirmed the 1280 × 850 Electron window opens on 3D Preview with the macro dialog closed, Add Macro opens the styled dialog, and closing it returns to the Macros tab with no overlay. The separate run with screenshot capture disabled verified the live Ethernet and COM22 workflows.

A fresh npm install completed in the Duet fork. The fork then ran the source bench suite using its own Electron 25.9.8 binary and dependencies. Startup, macro open and close, HTTP and COM22 passed, and the runner exited with code 0. Screenshot capture was disabled for this run. The report skipped powered Pause/Stop because the controller reported Off.

The original Probe panel is used on Duet. Its Surfaces and Outside Corner controls use the HTTP probe routine and check controller state before uploading. In Electron, both controls rejected the Off board before upload or motion. Automated checks cover all four Outside Corner orientations and abort-before-offset handling after each missed touch. Repeat with a powered WorkBee and its probe block to verify physical contact, offsets, travel and cleanup. The same Electron run reached COM22 but Windows denied access to the port, so it did not verify the revised USB flows.

The latest source Electron bench run passed fresh-profile startup and macro open/close assertions, the Ethernet workflow, COM22 firmware identification and status, and the HTTP reconnect using the USB-discovered address. It exited with code 0 with screenshots disabled. Powered Pause/Stop was skipped because the controller reported Off.

## Current source checkout

The fork descends from Ooznest Control f19be69. The capture-enabled source Electron run exited with code 0. The startup capture shows 3D Preview with the macro dialog closed. Add Macro opened the styled dialog and closing it returned to Macros. The same run passed HTTP and COM22, including reconnecting over HTTP with the USB-discovered address.

Remaining checks on a powered WorkBee: measure jog direction and distance, verify homing and endstops, test probe contact and missed-touch cleanup, check Z babystepping and a configured spindle, apply axis settings and verify them after restart, and exercise Pause, Resume, Stop and power-loss recovery with a dry-run SD job. The bench board reports Off. Wi-Fi provisioning and DHCP lease acquisition require suitable network hardware. Browser HTTP and physical Android transports remain unverified.
