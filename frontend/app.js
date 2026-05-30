/**
 * app.js — DocuChat frontend logic
 *
 * Vanilla JS. Communicates with the FastAPI backend at /api/*.
 * Handles file upload (click + drag-and-drop), document listing,
 * chat send/receive, and dynamic message rendering with source citations.
 */

const API_BASE = "";   // same origin — backend serves this file

// ============================================================
// DOM refs
// ============================================================

const dropZone        = document.getElementById("dropZone");
const fileInput       = document.getElementById("fileInput");
const uploadStatus    = document.getElementById("uploadStatus");
const uploadStatusText= document.getElementById("uploadStatusText");
const uploadSpinner   = document.getElementById("uploadSpinner");
const refreshDocsBtn  = document.getElementById("refreshDocsBtn");
const docList         = document.getElementById("docList");
const docListEmpty    = document.getElementById("docListEmpty");
const chatHistory     = document.getElementById("chatHistory");
const typingIndicator = document.getElementById("typingIndicator");
const questionInput   = document.getElementById("questionInput");
const sendBtn         = document.getElementById("sendBtn");
const statusDot       = document.getElementById("statusDot");

// ============================================================
// State
// ============================================================

let isSending = false;

// ============================================================
// Utility helpers
// ============================================================

/**
 * Escape HTML entities to prevent XSS when injecting raw text into innerHTML.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Auto-resize textarea to fit content (up to max-height set via CSS).
 */
function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

/**
 * Scroll the chat history panel to the bottom.
 */
function scrollToBottom() {
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

/**
 * Show or hide the upload status bar with a message.
 */
function showUploadStatus(message, showSpinner = true) {
  uploadStatusText.textContent = message;
  uploadSpinner.style.display = showSpinner ? "block" : "none";
  uploadStatus.hidden = false;
}

function hideUploadStatus() {
  uploadStatus.hidden = true;
}

// ============================================================
// Health check
// ============================================================

async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (res.ok) {
      statusDot.classList.add("online");
      statusDot.title = "API is online";
    } else {
      statusDot.classList.add("error");
      statusDot.title = "API returned an error";
    }
  } catch {
    statusDot.classList.add("error");
    statusDot.title = "Cannot reach API";
  }
}

// ============================================================
// Document management
// ============================================================

/**
 * Fetch the list of indexed documents from the backend and render them.
 */
async function loadDocuments() {
  try {
    const res  = await fetch(`${API_BASE}/api/documents`);
    const data = await res.json();
    renderDocList(data.documents || []);
  } catch (err) {
    console.error("Failed to load documents:", err);
  }
}

/**
 * Render the document list in the sidebar.
 */
function renderDocList(docs) {
  // Clear everything except the empty-state item
  const items = docList.querySelectorAll(".doc-item");
  items.forEach(el => el.remove());

  if (!docs || docs.length === 0) {
    docListEmpty.hidden = false;
    return;
  }

  docListEmpty.hidden = true;

  docs.forEach(doc => {
    const li = document.createElement("li");
    li.className = "doc-item";
    li.dataset.filename = doc.filename;
    li.innerHTML = `
      <div class="doc-item-info">
        <div class="doc-item-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div>
          <div class="doc-item-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</div>
          <div class="doc-item-chunks">${doc.chunk_count} chunk${doc.chunk_count !== 1 ? "s" : ""}</div>
        </div>
      </div>
      <button class="doc-delete-btn" data-filename="${escapeHtml(doc.filename)}" title="Remove ${escapeHtml(doc.filename)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/>
          <path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    `;
    docList.appendChild(li);
  });
}

/**
 * Delete a document by filename.
 */
async function deleteDocument(filename) {
  if (!confirm(`Remove "${filename}" from the index?`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/documents/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      await loadDocuments();
      appendSystemMessage(`"${filename}" removed from the index.`);
    } else {
      const err = await res.json().catch(() => ({}));
      appendSystemMessage(`Error removing document: ${err.detail || res.statusText}`, true);
    }
  } catch (err) {
    appendSystemMessage(`Network error: ${err.message}`, true);
  }
}

// ============================================================
// File upload
// ============================================================

/**
 * Upload a File object to /api/upload and refresh the document list.
 */
async function uploadFile(file) {
  if (!file) return;

  const allowed = [".pdf", ".txt"];
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!allowed.includes(ext)) {
    showUploadStatus("Only PDF and TXT files are supported.", false);
    setTimeout(hideUploadStatus, 3000);
    return;
  }

  showUploadStatus(`Uploading "${file.name}"…`);

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res  = await fetch(`${API_BASE}/api/upload`, { method: "POST", body: formData });
    const data = await res.json();

    if (res.ok) {
      showUploadStatus(`✓ ${data.message}`, false);
      await loadDocuments();
      appendSystemMessage(`"${file.name}" is ready — ask me anything about it.`);
    } else {
      showUploadStatus(`✗ ${data.detail || "Upload failed."}`, false);
    }
  } catch (err) {
    showUploadStatus(`✗ Network error: ${err.message}`, false);
  }

  setTimeout(hideUploadStatus, 4000);
}

// ============================================================
// Chat
// ============================================================

/**
 * Send a question to /api/chat and render the response.
 */
async function sendMessage(question) {
  if (!question.trim() || isSending) return;

  isSending = true;
  sendBtn.disabled = true;
  questionInput.value = "";
  autoResizeTextarea(questionInput);

  // Render user bubble
  renderMessage("user", question);
  scrollToBottom();

  // Show typing indicator
  typingIndicator.hidden = false;
  scrollToBottom();

  try {
    const res  = await fetch(`${API_BASE}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ question, n_results: 5 }),
    });

    typingIndicator.hidden = true;

    if (res.ok) {
      const data = await res.json();
      renderMessage("assistant", data.answer, data.sources, data.chunks);
    } else {
      const err = await res.json().catch(() => ({}));
      renderMessage("assistant", `Error: ${err.detail || res.statusText}`);
    }
  } catch (err) {
    typingIndicator.hidden = true;
    renderMessage("assistant", `Network error: ${err.message}`);
  }

  scrollToBottom();
  isSending   = false;
  sendBtn.disabled = false;
  questionInput.focus();
}

// ============================================================
// Message rendering
// ============================================================

/**
 * Render a chat message bubble into the chat history.
 *
 * @param {string} role        "user" | "assistant"
 * @param {string} text        Message text (may contain [1][2] citations)
 * @param {string[]} sources   Optional array of source filenames
 * @param {Object[]} chunks    Optional array of retrieved chunk objects
 */
function renderMessage(role, text, sources = [], chunks = []) {
  const msgEl = document.createElement("div");
  msgEl.className = `message ${role}`;

  const roleLabel = role === "user" ? "You" : "DocuChat";

  // Highlight citation markers like [1][2] in assistant messages
  const formattedText = role === "assistant"
    ? escapeHtml(text).replace(/\[(\d+)\]/g, '<span class="source-chip">[$1]</span>')
    : escapeHtml(text);

  let sourcesHtml = "";
  if (sources && sources.length > 0) {
    const chips = sources
      .map(s => `<span class="source-chip">${escapeHtml(s)}</span>`)
      .join("");
    sourcesHtml = `<div class="sources-row">${chips}</div>`;
  }

  let chunksHtml = "";
  const chunkId = `chunks-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (chunks && chunks.length > 0 && role === "assistant") {
    const chunkCards = chunks.map((c, i) => `
      <div class="chunk-card">
        <div class="chunk-card-header">
          <span class="chunk-source">[${i + 1}] ${escapeHtml(c.source)}</span>
          <span class="chunk-score">Score: ${(c.relevance_score * 100).toFixed(1)}%</span>
        </div>
        <div class="chunk-text">${escapeHtml(c.text)}</div>
      </div>
    `).join("");

    chunksHtml = `
      <button class="chunks-toggle" data-target="${chunkId}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        View ${chunks.length} source chunk${chunks.length !== 1 ? "s" : ""}
      </button>
      <div class="chunks-list" id="${chunkId}" hidden>${chunkCards}</div>
    `;
  }

  msgEl.innerHTML = `
    <div class="message-role">${escapeHtml(roleLabel)}</div>
    <div class="message-bubble">${formattedText}</div>
    ${sourcesHtml}
    ${chunksHtml}
  `;

  chatHistory.appendChild(msgEl);
}

/**
 * Render a system/info message (not a chat bubble).
 */
function appendSystemMessage(text, isError = false) {
  const el = document.createElement("div");
  el.style.cssText = `
    font-size: 12px;
    color: ${isError ? "var(--red)" : "var(--text-muted)"};
    text-align: center;
    padding: 4px 0;
    font-style: italic;
  `;
  el.textContent = text;
  chatHistory.appendChild(el);
  scrollToBottom();
}

// ============================================================
// Drag-and-drop
// ============================================================

function setupDragAndDrop() {
  // Prevent browser default file-open behavior for drag events on the whole page
  ["dragenter", "dragover", "dragleave", "drop"].forEach(evt => {
    document.body.addEventListener(evt, e => e.preventDefault());
  });

  dropZone.addEventListener("dragenter", e => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", e => {
    // Only remove class when leaving the zone itself, not its children
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove("drag-over");
    }
  });

  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  // Click to open file picker
  dropZone.addEventListener("click", () => fileInput.click());

  // Keyboard accessibility
  dropZone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) {
      uploadFile(file);
      fileInput.value = ""; // allow re-uploading same file
    }
  });
}

// ============================================================
// Delegated event listeners for dynamically rendered elements
// ============================================================

/**
 * Handle clicks on dynamically added delete buttons and chunks toggle buttons.
 * Using delegation on parent containers avoids re-binding on every render.
 */
docList.addEventListener("click", e => {
  const deleteBtn = e.target.closest(".doc-delete-btn");
  if (deleteBtn) {
    const filename = deleteBtn.dataset.filename;
    if (filename) deleteDocument(filename);
  }
});

chatHistory.addEventListener("click", e => {
  const toggleBtn = e.target.closest(".chunks-toggle");
  if (toggleBtn) {
    const targetId = toggleBtn.dataset.target;
    const chunksList = document.getElementById(targetId);
    if (!chunksList) return;

    const isOpen = !chunksList.hidden;
    chunksList.hidden = isOpen;
    toggleBtn.classList.toggle("open", !isOpen);
    toggleBtn.querySelector("span") && void 0; // no-op; text is fixed
  }
});

// ============================================================
// Input events
// ============================================================

questionInput.addEventListener("input", () => {
  autoResizeTextarea(questionInput);
});

questionInput.addEventListener("keydown", e => {
  // Send on Enter; Shift+Enter inserts a newline
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const q = questionInput.value.trim();
    if (q) sendMessage(q);
  }
});

sendBtn.addEventListener("click", () => {
  const q = questionInput.value.trim();
  if (q) sendMessage(q);
});

refreshDocsBtn.addEventListener("click", () => loadDocuments());

// ============================================================
// Init
// ============================================================

(async function init() {
  setupDragAndDrop();
  await checkHealth();
  await loadDocuments();
})();
