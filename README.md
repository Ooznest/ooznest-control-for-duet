# Ooznest Control Duet

Ooznest Control for legacy WorkBee CNC machines running Duet3D RepRapFirmware. It uses the Ooznest Control interface for the console, DROs, job preview, macros and machine controls.

## Connect

- **Electron** — Enter the controller's LAN address for HTTP, or select its USB serial port. The Windows bench controller appeared as COM22.
- **Browser** — Run the web build from localhost or a secure origin and choose Web Serial in a supported browser. Direct HTTP requires browser access to the local network and a firmware CORS setting that accepts the app's origin.
- **Cordova** — Use the platform build scripts. See the verification notes for device coverage.

Use USB for the console, live position, and initial network setup. Use HTTP for SD card browsing and editing, the full SD job controls, the Duet Settings table, and guided probing.

## Build locally

Run `npm install` to install dependencies. On Windows, launch the app from the repository root with `& .\node_modules\electron\dist\electron.exe .`. On other platforms, run `npm start`.

[Bench results and checks that require additional hardware](docs/duet-verification.md)

## First network connection over USB

Connect using USB and select **Duet Network Info**. The Console shows the network status and current IP. On Duet Ethernet, **Enable Ethernet** starts the interface with its existing settings. When the board reports an IP, the app fills the HTTP address field if it is empty. Disconnect USB, select the HTTP connection, and use that address.

- **Ethernet with DHCP** — Connect the network cable to a router and select **Use DHCP** over USB. If the Console reports that the Duet is waiting for an address, select **Duet Network Info** again after the router has assigned one. To keep the change after a restart, update the existing Ethernet configuration on the SD card.
- **Ethernet with an existing static address** — Select **Enable Ethernet** over USB to bring up the existing configuration. Use **Duet Network Info** to confirm the IP before switching to HTTP. Once connected over HTTP, open **SD Card**, browse to `/sys`, and open the WorkBee network configuration file in the editor if you need to review its startup settings.
- **Wi-Fi** — Put the Wi-Fi module in idle mode with `M552 S0`. Register the network with `M587 S"SSID" P"password"` over USB, then send `M552 S1` and check the IP with `M552`. Store the enable command in the controller's startup configuration if needed. Keep the network credentials out of the startup files and any shared console logs.

[Duet3D networking guide](https://docs.duet3d.com/User_manual/Machine_configuration/Networking)
