# Stache

Self-hosted, photo-first home inventory for people who won't fill in forms.
"Where is my stuff?" - snap a photo, drop the thing in a bin, scan the bin's
QR label. No names required, no categories, no forms.

## Using the add-on

1. Install and start the add-on.
2. Click **Open Web UI** (or visit `http://<your-ha-host>:8080`).
3. Create the first household account.
4. Head to **Labels** to print your first QR batch.

The web app runs on port 8080 (remappable on the add-on Configuration tab).
All data - SQLite database, photos, and the AI model cache - lives in the
add-on's data storage and survives updates.

## Home Assistant integration

Once running, open Stache's **Settings** page for ready-made URLs:

- **Out sensor** - a `rest` sensor endpoint exposing out/unaccounted counts,
  item names, low stock, and expiring warranties.
- **Digest webhook** - trigger a bundled "things still out" notification
  from any automation.

### Example REST sensor

```yaml
sensor:
  - platform: rest
    resource: "http://<your-ha-host>:8080/api/webhooks/out-sensor?token=TOKEN"
    name: "Stache Still Out"
    value_template: "{{ value_json.total }}"
    json_attributes:
      - items
```

The token URL is shown in Stache Settings - copy it from there.

## Optional AI

All AI is off by default. Configure an OpenAI-compatible endpoint
(Ollama, LM Studio, hosted) in Settings for suggested names, OCR,
photo similarity, and pile splitting. To save memory on small hosts,
set `STACHE_NO_ML=1` via the environment to disable local embeddings.
