"""
main.py — FastAPI server for DocuChat.

Exposes REST endpoints for document ingestion, retrieval-augmented chat,
document management, and health checks. Serves the frontend as static files.
"""

import os
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from rag import RAGPipeline

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="DocuChat API",
    description="RAG-powered document Q&A backend using ChromaDB and Claude.",
    version="1.0.0",
)

# Allow all origins (suitable for local dev; tighten for production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Global pipeline instance (initialised once at startup)
# ---------------------------------------------------------------------------

print("=" * 60)
print("  DocuChat — starting up")
print("=" * 60)
print("Initialising RAG pipeline…")
rag = RAGPipeline()
print("RAG pipeline ready.")
print("=" * 60)

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    question: str
    n_results: int = 5


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health():
    """Simple health check."""
    return {"status": "ok", "service": "DocuChat API"}


@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    """
    Accept a PDF or plain-text file upload, run the full ingestion pipeline,
    and return metadata about the stored document.
    """
    allowed_types = {
        "application/pdf",
        "text/plain",
        "text/x-plain",
        "application/octet-stream",
    }

    # Permissive content-type check (browsers send varied MIME types)
    content_type = file.content_type or ""
    filename = file.filename or "upload"

    if not (
        content_type in allowed_types
        or filename.lower().endswith((".pdf", ".txt"))
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{content_type}'. Upload a PDF or .txt file.",
        )

    file_bytes = await file.read()
    if len(file_bytes) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        result = rag.ingest(file_bytes, filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Ingestion error: {exc}")

    return {
        "success": True,
        "message": (
            f"'{filename}' ingested successfully — "
            f"{result['chunks_stored']} chunks stored."
        ),
        "doc_id": result["doc_id"],
        "filename": result["filename"],
        "chunks_stored": result["chunks_stored"],
    }


@app.get("/api/documents")
async def list_documents():
    """Return all currently indexed documents with their chunk counts."""
    try:
        documents = rag.list_documents()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Error listing documents: {exc}")

    return {"documents": documents}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """
    Answer a question using retrieval-augmented generation.

    Retrieves the top-n relevant chunks from ChromaDB and sends them to
    Claude as context, returning a grounded answer with source citations.
    """
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question must not be empty.")

    # Guard: ensure there are documents to query
    documents = rag.list_documents()
    if not documents:
        raise HTTPException(
            status_code=400,
            detail="No documents have been indexed yet. Upload a file first.",
        )

    n = max(1, min(request.n_results, 20))  # clamp between 1 and 20

    try:
        result = rag.query(request.question, n_results=n)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Query error: {exc}")

    return result


@app.delete("/api/documents/{filename:path}")
async def delete_document(filename: str):
    """Remove all chunks for the given filename from the vector store."""
    try:
        result = rag.delete_document(filename)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Delete error: {exc}")

    return {
        "success": result["deleted"],
        "message": f"'{filename}' removed from the index.",
        "filename": filename,
    }


# ---------------------------------------------------------------------------
# Static frontend — mount AFTER API routes so /api/* takes priority
# ---------------------------------------------------------------------------

_frontend_dir = Path(__file__).parent.parent / "frontend"
if _frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_dir), html=True), name="frontend")
else:
    print(f"Warning: frontend directory not found at {_frontend_dir}")

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
