# roboclub-robot

Firmware, website and DNS configuration for RoboClub, the robotics club of Westbrook Institute of Technology, Pune.

## Layout

- `firmware/`: ESP32 firmware, built with PlatformIO.
- `website/`: club website, including the team registration form.
- `dns/`: zone file for witroboclub.example.
- `scripts/flash.sh`: flashes the robot.
- `docs/DEPLOY.md`: how to build and deploy the firmware.
- `docs/BOM.md`: drivetrain bill of materials.

## Getting started

1. Install PlatformIO.
2. Run `pio run -e esp32dev` inside `firmware/`.
3. Read `docs/DEPLOY.md` before flashing the competition robot.
