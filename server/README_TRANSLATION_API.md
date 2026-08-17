# Translation API

This backend provides an API to update a vachana's `translation` field directly inside:

- `public/data/authors/<authorFile>.json`

## Endpoints

### 1) Get author file (raw JSON)
`GET /api/authors/:authorFile`

- `authorFile` is the filename present under `public/data/authors/`.

### 2) Update translation for a vachana
`PUT /api/authors/:authorFile/vachanas/:vachanaNumber/translation`

Body:
```json
{
  "translation": "some text" 
}
```

- `translation` must be a string or `null`.
- `vachanaNumber` must match the vachana `number` inside the author JSON.

## Notes
- Uses an atomic write (write tmp then rename) to reduce the chance of file corruption.
- Prevents path traversal by using `basename()` on the `authorFile`.

