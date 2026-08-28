# Django backend (experimental)

This directory contains a **partial** Django REST Framework parallel implementation.

## Status
- **Not** the primary production backend.
- The supported runtime is Express (`server.ts` + `server/`).
- Models/views here may drift from the Express domain and PostgreSQL schema.

## Recommendation
- For production and new features, use the Express modules under `../server/`.
- Keep this tree only if you plan to finish and cut over to Django; otherwise treat it as archived reference code.
