# Stache on Unraid

Stache is a single container - no database service, no companion containers.
Everything (SQLite database, photos, AI model cache) lives in one appdata
folder, so backups are just backing up `/mnt/user/appdata/stache`.

## Install

### Community Applications (once listed)

1. Apps tab, search **Stache**, install.
2. Open **WebUI** (port 8080), create the first household account.
3. Go to **Labels** to print your first QR batch.

### Manual install (template not in CA yet)

Copy `my-stache.xml` onto your flash drive's user-template folder, then
install from the Docker tab:

1. Copy `unraid/my-stache.xml` to
   `/boot/config/plugins/dockerMan/templates-user/my-stache.xml`
   (e.g. `cp my-stache.xml /boot/config/plugins/dockerMan/templates-user/`
   over SSH, or drop it on the `flash` share at
   `config/plugins/dockerMan/templates-user/`).
   Keep the `my-` prefix - dockerMan treats user templates without it badly.
2. Docker tab -> **Add Container** -> the **Template** dropdown now lists
   **Stache**. Pick it, adjust the port/appdata if needed, Apply.
3. Open the WebUI on port 8080.

Alternatively, fill the fields by hand in **Add Container**: repository
`ghcr.io/graphichealer/stache:latest`, bridge network, port `8080`, path
`/mnt/user/appdata/stache` -> `/data` (RW), `TZ` variable, and
`--add-host=host.docker.internal:host-gateway` in Extra Parameters (lets the
optional AI provider URL reach services on the Unraid host, e.g. Ollama at
`http://host.docker.internal:11434/v1`).

## Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| WebUI port | `8080` | Remap freely - nothing else depends on it |
| `/data` path | `/mnt/user/appdata/stache` | DB + photos + models. Back this up |
| `TZ` | `UTC` | Digest "time of day" uses this |
| `BETTER_AUTH_SECRET` | auto | Optional; persisted in the db if blank |
| `STACHE_ML_LEVEL` | `2` | `0` disables ML, `1` light Florence-2, `2` SmolVLM2 (default), `3` Moondream2 |
| `STACHE_BASE_URL` | unset | Public `https://` URL behind a reverse proxy - enables Secure cookies and fixes label/webhook links |
| `STACHE_TRUST_PROXY` | unset | `1` behind a reverse proxy so real client IPs are trusted |

## Notes

- **Memory:** ~200MB idle. Photo similarity (CLIP) loads lazily on the first
  photo upload or search - once warm the app sits around 450-550MB; the model
  downloads once into the appdata folder. `STACHE_ML_LEVEL=0` skips it entirely.
- **Permissions:** the container fixes `/data` ownership itself at startup,
  so `nobody:users` appdata is fine.
- **AI providers:** configure an OpenAI-compatible endpoint in Settings.
  Ollama in another container? Use `http://<container-name>:11434/v1`.
  Ollama on the Unraid host? `http://host.docker.internal:11434/v1`.
- **Updates:** Unraid's normal container update flow. Tagged releases
  (`ghcr.io/graphichealer/stache:0.1.1` etc.) exist if you prefer pinning.
- **Home Assistant users:** this app also ships as an HA add-on - see the
  repo README's Home Assistant section.
