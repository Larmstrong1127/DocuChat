"""
rag.py — RAG pipeline for DocuChat.

Handles PDF parsing, text chunking, embedding, ChromaDB storage,
and Claude-powered retrieval-augmented generation.
"""

import os
import uuid
from io import BytesIO
from collections import defaultdict
from typing import Optional

import chromadb
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer
from pypdf import PdfReader
import anthropic
from dotenv import load_dotenv

load_dotenv()


class RAGPipeline:
    """End-to-end RAG pipeline: ingest, embed, store, retrieve, generate."""

    def __init__(self):
        # ChromaDB persistent client
        self.chroma_client = chromadb.PersistentClient(
            path="./chroma_db",
            settings=Settings(anonymized_telemetry=False),
        )

        # Embedding model (runs locally)
        print("Loading embedding model (all-MiniLM-L6-v2)…")
        self.embedder = SentenceTransformer("all-MiniLM-L6-v2")
        print("Embedding model ready.")

        # Anthropic client
        self.anthropic_client = anthropic.Anthropic(
            api_key=os.environ.get("ANTHROPIC_API_KEY")
        )

        # Vector collection with cosine similarity
        self.collection = self.chroma_client.get_or_create_collection(
            name="documents",
            metadata={"hnsw:space": "cosine"},
        )

    # ------------------------------------------------------------------
    # Text utilities
    # ------------------------------------------------------------------

    def chunk_text(
        self,
        text: str,
        chunk_size: int = 600,
        overlap: int = 100,
    ) -> list[str]:
        """
        Sliding-window chunker.

        Splits `text` into overlapping chunks of approximately `chunk_size`
        characters with `overlap` characters shared between consecutive chunks.
        Chunks shorter than 50 characters are discarded.
        """
        chunks: list[str] = []
        start = 0
        text_len = len(text)

        while start < text_len:
            end = min(start + chunk_size, text_len)
            chunk = text[start:end].strip()
            if len(chunk) >= 50:
                chunks.append(chunk)
            if end == text_len:
                break
            start += chunk_size - overlap  # slide forward with overlap

        return chunks

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    def parse_pdf(self, file_bytes: bytes) -> str:
        """
        Extract all text from a PDF given its raw bytes.

        Returns the full document text with pages joined by newlines.
        """
        reader = PdfReader(BytesIO(file_bytes))
        pages: list[str] = []
        for page in reader.pages:
            page_text = page.extract_text() or ""
            pages.append(page_text)
        return "\n".join(pages)

    # ------------------------------------------------------------------
    # Core pipeline actions
    # ------------------------------------------------------------------

    def ingest(self, file_bytes: bytes, filename: str) -> dict:
        """
        Full ingestion pipeline: parse → chunk → embed → store.

        Parameters
        ----------
        file_bytes : raw bytes of the uploaded file (PDF or plain text).
        filename   : original filename, used as source metadata.

        Returns
        -------
        dict with doc_id, filename, and chunks_stored count.
        """
        # Determine file type and extract text
        if filename.lower().endswith(".pdf"):
            text = self.parse_pdf(file_bytes)
        else:
            # Treat as plain text (UTF-8)
            text = file_bytes.decode("utf-8", errors="replace")

        # Chunk
        chunks = self.chunk_text(text)
        if not chunks:
            raise ValueError(f"No usable text could be extracted from '{filename}'.")

        # Unique document identifier
        doc_id = str(uuid.uuid4())

        # Embed all chunks in one batch
        embeddings: list[list[float]] = self.embedder.encode(chunks).tolist()

        # Build ChromaDB inputs
        ids = [f"{doc_id}_chunk_{i}" for i in range(len(chunks))]
        metadatas = [
            {"source": filename, "doc_id": doc_id, "chunk_index": i}
            for i in range(len(chunks))
        ]

        self.collection.add(
            embeddings=embeddings,
            documents=chunks,
            ids=ids,
            metadatas=metadatas,
        )

        return {
            "doc_id": doc_id,
            "filename": filename,
            "chunks_stored": len(chunks),
        }

    def list_documents(self) -> list[dict]:
        """
        Return a list of ingested documents with their chunk counts.

        Queries all metadata in the collection and aggregates by source filename.
        """
        result = self.collection.get(include=["metadatas"])
        metadatas = result.get("metadatas") or []

        # Aggregate chunk counts per filename
        chunk_counts: dict[str, int] = defaultdict(int)
        for meta in metadatas:
            source = meta.get("source", "unknown")
            chunk_counts[source] += 1

        return [
            {"filename": fname, "chunk_count": count}
            for fname, count in chunk_counts.items()
        ]

    def query(self, question: str, n_results: int = 5) -> dict:
        """
        Retrieve relevant chunks and generate a grounded answer via Claude.

        Steps:
          1. Embed the question.
          2. Query ChromaDB for the top-n most similar chunks.
          3. Build a numbered context string.
          4. Call Claude claude-3-5-haiku-20241022 with retrieval-grounded system prompt.
          5. Return the answer, unique source filenames, and chunk metadata.

        Returns
        -------
        dict with keys: answer (str), sources (list[str]), chunks (list[dict]).
        """
        # 1. Embed question
        question_embedding: list[float] = self.embedder.encode([question]).tolist()[0]

        # 2. Vector search
        results = self.collection.query(
            query_embeddings=[question_embedding],
            n_results=n_results,
            include=["documents", "metadatas", "distances"],
        )

        retrieved_docs: list[str] = results["documents"][0]
        retrieved_metas: list[dict] = results["metadatas"][0]
        retrieved_distances: list[float] = results["distances"][0]

        # 3. Build numbered context
        context_parts: list[str] = []
        for idx, (doc, meta) in enumerate(zip(retrieved_docs, retrieved_metas), start=1):
            source = meta.get("source", "unknown")
            context_parts.append(f"[{idx}] (Source: {source})\n{doc}")
        context_string = "\n\n---\n\n".join(context_parts)

        # 4. Call Claude
        system_prompt = (
            "You are DocuChat, an AI assistant that answers questions strictly based on "
            "the provided document context. Your answers must be grounded in the context "
            "below — do not fabricate information or draw on outside knowledge.\n\n"
            "When you reference information, cite the source chunk using its bracketed "
            "number, e.g. [1], [2][3]. If the context does not contain enough information "
            "to answer the question, say so clearly rather than guessing.\n\n"
            "Be concise, accurate, and helpful."
        )

        user_message = (
            f"Context from uploaded documents:\n\n{context_string}\n\n"
            f"---\n\nQuestion: {question}"
        )

        response = self.anthropic_client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1024,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
        )

        answer_text: str = response.content[0].text

        # 5. Assemble output
        unique_sources: list[str] = list(
            dict.fromkeys(m.get("source", "unknown") for m in retrieved_metas)
        )

        chunks_out: list[dict] = [
            {
                "text": doc,
                "source": meta.get("source", "unknown"),
                "relevance_score": round(1 - dist, 4),
            }
            for doc, meta, dist in zip(retrieved_docs, retrieved_metas, retrieved_distances)
        ]

        return {
            "answer": answer_text,
            "sources": unique_sources,
            "chunks": chunks_out,
        }

    def delete_document(self, filename: str) -> dict:
        """
        Remove all chunks belonging to `filename` from the collection.

        Returns
        -------
        dict with deleted (bool) and filename (str).
        """
        # Retrieve all IDs whose metadata source matches the filename
        result = self.collection.get(
            where={"source": filename},
            include=["metadatas"],
        )
        ids_to_delete: list[str] = result.get("ids") or []

        if ids_to_delete:
            self.collection.delete(ids=ids_to_delete)

        return {"deleted": True, "filename": filename}
