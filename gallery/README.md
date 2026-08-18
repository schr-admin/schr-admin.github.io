# Escher Blocks Gallery

This directory is the published content source for the Escher Blocks Gallery.
The app reads `manifest.json`; paths inside the manifest are relative to this
directory. Bundled app content uses the same document and item shape.

## Layout

```text
gallery/
├── manifest.json
├── items/
├── schema/manifest.schema.json
├── scripts/validate-gallery.mjs
└── tests/validate-gallery.test.mjs
```

## Adding official content

1. Choose a permanent canonical id: `draw-<slug>` or `rec-<slug>`.
2. Add the `.schr` payload and PNG thumbnail under `items/` using that id.
3. Add the manifest entry. `bytes` is the exact `.schr` byte count.
4. Run `npm test` from this directory.
5. Open a pull request. CI must pass before publication.

Canonical ids are permanent override keys. Renaming an id publishes a new item
rather than updating the existing one.
