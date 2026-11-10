# Deploying firmware to the robot

## Build

Every push to `main` runs `.github/workflows/deploy.yml`. GitHub Actions builds the ESP32 firmware with PlatformIO and attaches `firmware.bin` to a GitHub release.

## Network

Flash from the lab laptop while it is connected to the robot's Wi-Fi access point `RoboClub-AP`.
The access point uses password=RoboAP#Lab3-2026 (change it after the competition).

## Flash

1. Download `firmware.bin` from the latest GitHub release.
2. Run `./scripts/flash.sh --ota 192.168.4.1` from the lab laptop.
3. `flash.sh` reads the `OTA_PASSWORD` environment variable before it uploads.

## Verify

Open the serial monitor at 115200 baud and check that the boot banner shows the new version number, then run the 30-second motor test from the bench menu.
