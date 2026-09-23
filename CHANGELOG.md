# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [0.3.0] - 2026-09-23

First public release.

### Added

- A "run at your own risk" confirmation every time automatic approval is turned on, with an extra warning when the broad scope is selected.
- Real-time handling through Muse's own `approvals.snapshot` and `task.status` push events.
- All eligible approvals are handled in one pass.
- A 30-second background scan that works even if the page's content script is gone.
- Muse tabs are protected from Chrome's memory saver while the extension is on; a fully unloaded Muse tab is reloaded.
- Content scripts are re-attached to open Muse tabs after the extension is reloaded.
- The popup shows when the last automatic check ran and warns when checks stop.
- English and Simplified Chinese, with a language switch in the popup.
- Architecture, protocol and contribution documentation; CI; 100% test coverage gate.
- Release workflow: pushing a `v*` tag publishes a ZIP, a signed CRX and checksums to GitHub Releases. CI builds an unsigned ZIP for every push.

### Changed

- Renamed to "Auto Approve for Muse" ("Muse 自动审批" in Chinese) so the name says what it does and does not read as an official Muse product.
- The switch is changed only by the user. Failures are shown and retried after 60 seconds instead of turning the extension off.
- The connection check looks for Muse tabs in the background instead of only the current tab.
- Redesigned popup, with light and dark themes, the project logo as the extension icon, and a color scheme taken from the logo.

### Fixed

- "Extension context invalidated" errors from content scripts left behind by an extension reload.
- Page calls that never return no longer block all later runs; they time out after 15 seconds.
- The check that the conversation did not switch mid-decision now compares against the transport captured at the start, not whatever the provider holds later.
- Malformed entries in a request's decision options are skipped instead of failing the whole list.

## [0.2.0]

Unreleased prototype: silent approval through the page's RPC connection.
