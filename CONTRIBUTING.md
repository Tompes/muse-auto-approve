# Contributing

Thank you for helping. This project is small on purpose and holds itself to a high bar: it approves security prompts on someone's behalf, so a subtle bug is a real problem. Please read [docs/architecture.md](docs/architecture.md) first, especially the invariants.

## Ground rules

- **No dependencies.** Not at run time, not for development. The extension loads unpacked, and the tooling is Node's built-in test runner.
- **Every change keeps `npm run verify` green.** That means syntax, JSON and whitespace checks, and 100% line, branch and function coverage of `extension/lib/` and `extension/content.js`.
- **Tests describe behavior.** Name a test after the property it pins ("turning the switch off stops the batch before the next submission"), not after the function it calls. When you fix a bug, first add the test that fails without the fix.
- **Unreachable code is removed, not ignored.** If a branch cannot be reached, restructure the code. Coverage-ignore comments are not accepted.
- **Keep the invariants.** A change that weakens one needs a clear reason in the pull request and tests for the new behavior.

## Style

- Two-space indentation, single quotes, semicolons, lines of at most 120 characters (`.editorconfig`).
- Each file starts with a comment that says what it is responsible for and what it assumes.
- Comment the *why*: a constraint, an invariant, a browser quirk. Do not narrate what the next line does.
- User-visible text goes in `extension/_locales/*/messages.json`, never in code. Stored events hold message codes, not text.
- `lib/page-rpc.mjs`: everything `museRpc` uses must be declared inside it; it is serialized into the page.

## Icons

`extension/icons/icon-{16,32,48,128}.png` are derived from the source artwork `assets/logo.png`, which stays outside `extension/` so it is not shipped. They are cropped to the artwork, centered on a square transparent canvas (about 94% fill at 16 and 32 px, 90% at 48 and 128 px) and downscaled in halving steps. When the artwork changes, regenerate all four and check the 16 px icon in the toolbar on light and dark themes.

## Adding a language

1. Copy `extension/_locales/en` to a new directory named with a [Chrome locale code](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales), for example `ja`.
2. Translate every `message`. Keep `$1`, `$2` placeholders; their order in the sentence may change.
3. Set `localeCode` to the directory name and `languageName` to the language's own name.
4. Add the directory to `LOCALES` in `extension/lib/i18n.mjs`.

`npm test` checks keys, placeholders and the locale list.

## Releasing

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. It runs the full checks, builds a ZIP and a signed CRX with `scripts/package.mjs`, and publishes them with SHA-256 checksums and the matching `CHANGELOG.md` section.

The CRX signing key decides the extension ID. Create it once, store it as the `CRX_PRIVATE_KEY` secret of a `release` environment, and keep an offline backup: losing it means every later release is a different extension.

```sh
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out muse-auto-approve.pem
gh secret set CRX_PRIVATE_KEY --env release < muse-auto-approve.pem
```

Never commit the key; `.gitignore` excludes `*.pem`. To cut a release, bump the version in `extension/manifest.json`, `package.json` and `package-lock.json`, add a `CHANGELOG.md` section, merge, then:

```sh
git tag v0.3.0 && git push origin v0.3.0
```

The workflow refuses to publish if the tag and the manifest version differ, or if the key is missing.

The CRX writer is a small, dependency-free implementation of Chrome's CRX3 format (`scripts/lib/crx.mjs`). Given the same archive and key it produces byte-for-byte the same file as Chrome's own packer, and `tests/fixtures/chrome-packed.crx`, packed by Chrome, pins the format.

## Release checklist

Automated tests cannot reach real Chrome or Muse. Before tagging a release, load the unpacked extension and verify by hand:

- [ ] **Check connection** reports the pending count from a background Muse tab while another site is in front.
- [ ] A network approval is approved within a second, with **live push** shown as the trigger.
- [ ] Turning the switch on shows the risk confirmation; Cancel and Escape leave it off.
- [ ] Turning the switch off stops further approvals.
- [ ] After **Reload** in `chrome://extensions`, approvals keep working without reloading the Muse page, and the page console shows no "Extension context invalidated" error.
- [ ] The popup renders in English and Simplified Chinese, in light and dark mode.
- [ ] `manifest.json` and `package.json` versions match and `CHANGELOG.md` has an entry.

## Reporting problems

Open an issue with the Chrome version, what you expected, what happened and the status shown in the popup. For anything with security impact, follow [SECURITY.md](SECURITY.md) instead.
