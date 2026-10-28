# Stash on Unraid

Stash is a single container - no database service, no companion containers.
Everything (SQLite database, photos, AI model cache) lives in one appdata
folder, so backups are just backing up `/mnt/user/appdata/stash`.

## Install

### Community Applications (once listed)

1. Apps tab, search **Stash**, install.
2. Open **WebUI** (port 8080), create the first household account.
3. Go to **Labels** to print your first QR batch.

### Manual install (template not in CA yet)

Copy `stash.xml` onto your flash drive's user-template folder, then install
from the Docker tab:

1. Copy `unraid/stash.xml` to
   `/boot/config/plugins/dockerMan/templates-user/stash.xml`
   (e.g. `cp stash.xml /boot/config/plugins/dockerMan/templates-user/`
   over SSH, or drop it on the `flash` share at
   `config/plugins/dockerMan/templates-user/`).
2. Docker tab -> **Add Container** -> the **Template** dropdown now lists
   **Stash**. Pick it, adjust the port/appdata if needed, Apply.
3. Open the WebUI on port 8080.

Alternatively, fill the fields by hand in **Add Container**: repository
`ghcr.io/graphichealer/stash:latest`, bridge network, port `8080`, path
`/mnt/user/appdata/stash` -> `/data` (RW), `TZ` variable, and
`--add-host=host.docker.internal:host-gateway` in Extra Parameters (lets the
optional AI provider URL reach services on the Unraid host, e.g. Ollama at
`http://host.docker.internal:11434/v1`).

## Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| WebUI port | `8080` | Remap freely - nothing else depends on it |
| `/data` path | `/mnt/user/appdata/stash` | DB + photos + models. Back this up |
| `TZ` | `UTC` | Digest "time of day" uses this |
| `BETTER_AUTH_SECRET` | auto | Optional; persisted in the db if blank |
| `STASH_NO_ML` | unset | `1` disables embeddings/photo similarity |

## Notes

- **Memory:** ~150-200MB idle. Photo similarity (CLIP) loads lazily on the
  first photo upload or photo search and adds ~300MB once warm - the model
  downloads once (~150MB) into the appdata folder. `STASH_NO_ML=1` skips it.
- **Permissions:** the container fixes `/data` ownership itself at startup,
  so `nobody:users` appdata is fine.
- **AI providers:** configure an OpenAI-compatible endpoint in Settings.
  Ollama in another container? Use `http://<container-name>:11434/v1`.
  Ollama on the Unraid host? `http://host.docker.internal:11434/v1`.
- **Updates:** Unraid's normal container update flow. Tagged releases
  (`ghcr.io/graphichealer/stash:0.1.1` etc.) exist if you prefer pinning.
- **Home Assistant users:** this app also ships as an HA add-on - see the
  repo README's Home Assistant section.
