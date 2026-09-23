# Security policy

This extension approves security prompts automatically, so its bugs can have security consequences. Please report them privately.

## Reporting

Use GitHub's **Report a vulnerability** (private security advisory) on this repository. Include what an attacker can do, the steps to reproduce, and the version. You should get a reply within a week.

Please do not open a public issue for a vulnerability.

## What counts

In scope, for example:

- An approval that should not be made is made: wrong type for the selected scope, a scope wider than the server offered, a request in another conversation, or any approval while the switch is off.
- Another website, or content inside a Muse conversation, can make the extension approve something or read data through it.
- The extension exposes approval contents, gateway addresses, credentials or other data outside the Muse page.

Out of scope:

- The consequences of approvals the user configured the extension to make. Choosing **All supported types** is documented to approve checkout and outgoing content.
- Muse changing its private protocol so that the extension stops working.

## Trust model

- The Muse page (`https://muse.ai`) is trusted: it already holds the user's session.
- Page content can forge the `wake` message the content script listens for. A wake only triggers a run, which re-reads and re-validates everything through RPC, so forging it gains nothing.
- The extension accepts messages only from itself, and `tick` messages only from Muse tabs. It has no externally connectable interface and no web-accessible resources.
