---
version: "0.1.2"
level: pair
processes:
  design: pair
  implementation: pair
  testing: pair
  documentation: pair
  review: pair
  deployment: pair
components:
  client/public/icon.svg: none
  client/public/logo-mono.svg: none
---

This format is based on [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2).

## Notes

- Stache is built by a human (product direction, requirements, hardware
  testing, review) pairing with an AI agent (Devin, Cognition) that writes
  most of the code. The human understands the internals and reviews every
  change; nothing ships without the human testing it on real devices.
- `client/public/icon.svg` and `client/public/logo-mono.svg` were both
  hand-made by the human in Inkscape.
