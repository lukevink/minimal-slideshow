# Minimal Photo Slideshow

I was looking for a minimal slideshow with modern animations like Apple’s screensavers, with grids and moving photo layouts. So I brought those animations to your Home Assistant dashboard.

Minimal Photo Slideshow includes six animation styles, an optional clock, and a visual editor. It uses individual photo files.

- **Origami:** folding transitions between ratio-aware layouts, interspersed with individual photo changes.
- **Sliding Panels:** stationary photographs revealed through moving masks. Panels do not fly across neighboring images.
- **Shifting Tiles:** one or two tiles shrink away, neighboring tiles slide into the gaps, and replacements bounce in from the screen edges. Cropped photos can pan inside their tiles.
- **Floating:** large floating photographs.
- **Ken Burns:** slow, uniform zoom and pan with dissolves.
- **Standard Fade:** a simple dissolve.

Photos retain their original proportions. Grid modes crop to fill; they prefer photos matching the screen orientation for a single full-screen image. These are independent implementations inspired by the Apple screensavers, not Apple's code or exact replicas.

## Install with HACS

1. In HACS, add `https://github.com/lukevink/minimal-slideshow` as a **Dashboard** custom repository.
2. Download the card and reload the browser. If HACS did not add the resource, add `/hacsfiles/minimal-slideshow/minimal-slideshow.js` as a JavaScript module in **Settings → Dashboards → Resources**.
3. Add **Minimal Photo Slideshow** to a dashboard. All normal options are available in the visual editor.
4. For iCloud, Google Photos, Immich, PhotoPrism, Synology, UGREEN, Nextcloud, Ente, local folders or Home Assistant Media Source, install [Minimal Slideshow integration](https://github.com/lukevink/minimal-slideshow-integration). Select its album in the card editor.

Manual install: copy `dist/minimal-slideshow.js` to `/config/www/` and add `/local/minimal-slideshow.js` as a JavaScript module. Load only one copy of this card, including any older `minimal-photo-slideshow.js` or `origami-album-card.js` resource.

The integration creates **Next Image**, **Previous Image** and **Restart** button entities for automations. Commands affect open cards displaying the corresponding source; Previous restores up to 30 session-history frames.

The two repositories install independently. The card can also display a list of image URLs without the integration.

## Full-screen view

Create a **Panel (single card)** view and add:

```yaml
title: Photos
path: photos
type: panel
cards:
  - type: custom:minimal-photo-slideshow
    source: minimal_slideshow
    effect: origami
    interval: 8
    duration: 1800
    clock: true
    clock_position: bottom-left
    clock_font: system
    clock_size: 112
    show_date: true
    time_format: auto
```

The default height subtracts Home Assistant's header height. If an external kiosk tool hides the header without updating that variable, set `height: 100dvh`. For an ordinary dashboard card, use a fixed height such as `height: 500px`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `source` | `minimal_slideshow` | Integration photo source; `origami_photos` supports older local installations. |
| `album_id` | First configured album | Choose an integration album in the editor. |
| `images` | None | List of image URLs; overrides the integration source. |
| `effect` | `origami` | `origami`, `sliding_panels`, `shifting_tiles`, `floating`, `ken_burns`, `fade`. |
| `interval` | `8` | Hold time/movement pace in seconds, 2–120. Transitions add their own duration. |
| `duration` | `1800` | Transition duration in milliseconds, 250–6000. |
| `height` | Viewport less header | Any CSS height, e.g. `100dvh` or `500px`. |
| `clock` | `false` | Show a clock. |
| `clock_position` | `bottom-left` | `top-left`, `top-right`, `bottom-left`, `bottom-right`. Clock and date share the chosen edge. |
| `clock_font` | `system` | `system`, `sans`, `rounded`, `serif`, `mono`, `custom`. |
| `custom_font` | System font | Installed CSS font family when `clock_font: custom`; fonts are not downloaded. |
| `clock_size` | `112` | Maximum font size in pixels, 40–240; scales down on narrow screens. |
| `time_format` | `auto` | `auto`, `"12"`, or `"24"`. Uses the Home Assistant language/time zone. |
| `show_date` | `false` | Small date below the clock. |
| `home_path` | None | Optional local dashboard path to open when tapped. |

Local images example:

```yaml
type: custom:minimal-photo-slideshow
effect: fade
height: 500px
images:
  - /local/photos/landscape.jpg
  - /local/photos/portrait.jpg
```

External image hosts must allow cross-origin requests (CORS). Images under `/local` are publicly reachable on your Home Assistant address; use the authenticated integration for album photos. Never put Apple account credentials or signed private image links into a shared dashboard configuration.

## Automation separation

The card does **not** control Fully Kiosk, tablet power, proximity detection, idle timing, or room-dependent navigation. Keep those in your own Home Assistant automations or kiosk controller. There is no “Photos before tablet screen off” setting. A tap emits the bubbling `minimal-slideshow-tap` browser event; `home_path` optionally provides simple navigation. Setting `tap_action: none` disables both.

## Development and release

```sh
npm test
npm run build
python3 -m http.server 8767
```

Open `http://localhost:8767/tests/preview.html`; click **Test all styles**, **Test masks & tiles**, and **Test HA controls**. The preview uses synthetic images, never family photos. Source and the HACS distribution file are committed together. CI checks geometry tests and matching build output.

For release, push the repository, let validation complete, then publish a GitHub release tagged `v1.2.0`. The release workflow attaches `minimal-slideshow.js`. Custom-repository installation works independently of inclusion in the default HACS catalog. Default catalog inclusion requires a separate [HACS submission](https://www.hacs.dev/docs/publish/start/).

## License

MIT. No Apple screensaver code or assets are included.

## Inspiration

Inspired by Apple’s photo screensavers and [Eyal Gal’s Album Slideshow](https://github.com/eyalgal/album_slideshow), whose photo-source support helped shape this project.
