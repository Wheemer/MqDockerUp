# Changelog

## 2.0.0 - 2026-06-15

### Changed

- Established MqDockerUp Wheemer Edition as the maintained Home Assistant focused fork.
- Scoped Home Assistant discovery, state topics, command topics, and update payloads by container so duplicate image/tag deployments remain distinct.
- Routed Home Assistant update installs through container-aware command topics and payloads while keeping legacy flat MQTT command topics for compatibility.
- Reworked Docker container updates to wait for image pulls, publish progress, recreate containers with their original runtime settings, start the replacement, refresh discovery/state, and clean stale discovery topics.
- Updated modern Home Assistant MQTT update payload handling, including non-legacy progress fields and availability payloads.
- Hardened config loading, database startup, logging paths, Docker image packaging, and startup behavior for containerized installs.
- Updated dependencies and GitHub Actions, added Dependabot coverage for npm, GitHub Actions, and Docker, and enabled Dependabot security updates.

### Fixed

- Fixed command collisions when several containers use the same image and tag.
- Fixed update entities targeting the wrong container in duplicate-image deployments.
- Fixed digest-pinned and registry-port image reference handling.
- Fixed non-legacy Home Assistant update progress payload crashes.
- Fixed stale discovery cleanup so current update entities are not cleared accidentally.

### Validation

- `npm run ci`
- `npm run build`
- `npm audit --omit=dev`
- `docker build -t mqdockerup:test .`
- `actionlint`
