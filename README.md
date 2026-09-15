# GRIOT OS

Strategic Intelligence & Execution Agent for SpeakPower, Tonninyira, CuePointe, UBF/FoB and future projects.

## Included in v0.1

- Shared strategic brain and decision protocol
- Project-specific context
- Specialized agent routing
- Evidence discipline: fact / inference / hypothesis / recommendation / unknown
- Persistent local memory and decision logs
- Approval endpoint for future execution actions
- OpenAI-compatible model adapter
- FastAPI backend with Swagger docs

## Run locally

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000/docs

## Architecture direction

SQLite is the local fallback. Production memory should use Supabase/Postgres, with repositories, analytics, web research and brand tools connected through explicit, least-privilege execution tools and approval gates.
