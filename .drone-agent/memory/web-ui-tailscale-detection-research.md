---
key: web-ui-tailscale-detection-research
tags:
  - coordinator
  - web-ui
  - tailscale
  - auth
  - research
created: 2026-06-30T23:08:00.922Z
updated: 2026-06-30T23:08:00.922Z
---

The coordinator web UI's auth bypass for tailscale connections currently uses only an IP range check (100.64.0.0/10 CGNAT range). This should be revisited later to research best practices for tailscale detection — possible improvements include checking for tailscale-specific headers, using the tailscale local API, or other more robust methods.