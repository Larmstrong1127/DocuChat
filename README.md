# DocuChat — RAG-Powered Document Q&A

Upload a PDF or text file, ask questions about it, and get grounded answers with source citations — powered by ChromaDB vector search and Claude.

---

## Architecture

```
                         INGESTION PIPELINE
                         ==================

  PDF / TXT File
       │
       ▼
  ┌─────────┐
  │  Parser │  (pypdf for PDF, UTF-8 decode for TXT)
  └────┬────┘
       │  raw text
       ▼
  ┌─────────┐
  │ Chunker │  (sliding window, 600 chars, 100 overlap)
  └────┬────┘
       │  text chunks
       ▼
  ┌──────────┐
  │ Embedder │  (all-MiniLM-L6-v2, 384-dim vectors)
  └────┬─────┘
       │  dense vectors
       ▼
  ┌──────────┐
  │ ChromaDB │  (persistent, cosine similarity space)
  └──────────┘


                         QUERY PIPELINE
                         ==============

  User Question
       │
       ▼
  ┌──────────┐
  │ Embedder │  (same model — question → vector)
  └────┬─────┘
       │  question vector
       ▼
  ┌──────────┐
  │ ChromaDB │  (ANN search → top-N chunks + scores)
  └────┬─────┘
       │  retrieved chunks
       ▼
  ┌────────────────┐
  │ Context Builder│  (numbered context string [1][2]…)
  └───────┬────────┘
          │  context + question
          ▼
  ┌────────────────────────────┐
  │  Claude (claude-3-5-haiku) │  (grounded answer + citations)
  └────────────────────────────┘
          │
          ▼
      Answer + Sources + Chunk Metadata
```

---

## Tech Stack

| Layer            | Technology                         | Purpose                                      |
|------------------|------------------------------------|----------------------------------------------|
| Backend API      | FastAPI + Uvicorn                  | REST endpoints, file upload, async serving   |
| Vector Store     | ChromaDB (persistent)              | Stores and queries document embeddings       |
| Embedding Model  | sentence-transformers (MiniLM-L6)  | Converts text chunks and queries to vectors  |
| LLM              | Anthropic Claude (Haiku 3.5)       | Generates grounded answers from context      |
| PDF Parsing      | pypdf                              | Extracts text from uploaded PDF files        |
| Frontend         | Vanilla HTML / CSS / JavaScript    | Single-page app, no framework dependencies  |

---

## Setup & Installation

### Prerequisites
- Python 3.10 or higher
- An Anthropic API key ([get one here](https://console.anthropic.com/))

### Steps

```bash
# 1. Clone / download the project
cd docuchat

# 2. Create and activate a virtual environment
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

# 3. Install backend dependencies
cd backend
pip install -r requirements.txt

# 4. Configure environment variables
copy .env.example .env          # Windows
# cp .env.example .env          # macOS / Linux

# 5. Open .env and add your Anthropic API key
#    ANTHROPIC_API_KEY=sk-ant-...

# 6. Start the server
python main.py
```

### Open the app

Navigate to **http://localhost:8000** in your browser.

The first startup downloads the `all-MiniLM-L6-v2` embedding model (~90 MB) from HuggingFace — this only happens once and is cached locally.

### Try it with the sample document

```bash
# The sample dental guide is in sample_docs/dental_guide.txt
# Upload it via the browser UI or use curl:
curl -F "file=@../sample_docs/dental_guide.txt" http://localhost:8000/api/upload
```

Then ask questions like:
- *"What CDT code is used for an adult cleaning?"*
- *"How long does a composite filling last?"*
- *"When is pre-authorization required?"*

---

## Key Concepts

### Chunking Strategy
Long documents are split into overlapping 600-character windows with 100-character overlap between consecutive chunks. Overlap preserves context at chunk boundaries — without it, a sentence split across two chunks could appear in neither search result for a relevant query.

### Why Embeddings Instead of Keyword Search
Keyword search matches exact terms. Embedding-based (semantic) search maps text to high-dimensional vectors where similar meanings cluster together — so a query for *"tooth removal"* correctly retrieves chunks about *"extraction"* even with no word overlap. The `all-MiniLM-L6-v2` model produces 384-dimensional vectors and runs entirely locally with no API cost.

### Cosine Similarity
ChromaDB is configured with `hnsw:space = cosine`. Cosine similarity measures the angle between two vectors rather than their magnitude, making it robust to documents of varying length. A relevance score of 1.0 means identical direction (perfect match); 0.0 means orthogonal (unrelated).

### RAG vs. Fine-Tuning
Fine-tuning bakes knowledge into model weights — it is expensive, requires large datasets, and produces stale knowledge the moment documents change. Retrieval-Augmented Generation keeps the LLM's weights frozen and instead supplies fresh, specific context at inference time. This makes RAG ideal for dynamic document collections, enterprise knowledge bases, and situations where source attribution is required.

---

## Project Structure

```
docuchat/
├── backend/
│   ├── main.py          — FastAPI app, routes, static file mount
│   ├── rag.py           — RAGPipeline class (parse, chunk, embed, query)
│   ├── requirements.txt — Python dependencies
│   └── .env.example     — Environment variable template
├── frontend/
│   ├── index.html       — Single-page app shell
│   ├── style.css        — Dark theme, responsive layout
│   └── app.js           — Vanilla JS: upload, chat, drag-drop
├── sample_docs/
│   └── dental_guide.txt — 700-word dental patient guide for testing
└── README.md
```

---

## API Reference

| Method   | Endpoint                        | Description                              |
|----------|---------------------------------|------------------------------------------|
| `GET`    | `/api/health`                   | Health check                             |
| `POST`   | `/api/upload`                   | Upload and ingest a PDF or TXT file      |
| `GET`    | `/api/documents`                | List all indexed documents               |
| `POST`   | `/api/chat`                     | Ask a question (RAG query)               |
| `DELETE` | `/api/documents/{filename}`     | Remove a document from the index         |

---

## Developer

Built by **Landon Armstrong** — [github.com/Larmstrong1127](https://github.com/Larmstrong1127)
