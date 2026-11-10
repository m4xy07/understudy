---
title: Tech review - robot controller board
date: 2026-07-03
author: Priya Nair
author_email: priya.nair@westbrook.example
---

# Tech review: robot controller board

## Decision

We are moving the robot controller from the Arduino Mega to the ESP32.

## Why

- The ESP32 has built-in Wi-Fi, so we can flash firmware over the air instead of plugging in a USB cable.
- The Arduino Mega ran out of RAM for the PID loop.
- ESP32 dev boards cost less than a Mega plus a Wi-Fi shield.

## Options considered

- Stay on the Arduino Mega and add a Wi-Fi shield. Rejected: still short on RAM.
- Raspberry Pi Pico W. Rejected: nobody on the team has used it, and our motor library is Arduino-only.
- ESP32. Chosen.

## Next steps

- Port the motor and PID code to the ESP32 by the end of July.
