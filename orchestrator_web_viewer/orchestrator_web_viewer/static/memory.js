/**
 * Memory and project-document view functions.
 * Depends on globals defined in app.js and legacy memory helpers in system.js.
 */

const KNOWLEDGE_SCOPE_PROJECT = 'project';
const KNOWLEDGE_SCOPE_GLOBAL = 'global';

function currentKnowledgeScope() {
    const select = document.getElementById('knowledge-source-scope');
    return select?.value || KNOWLEDGE_SCOPE_PROJECT;
}

function resolveKnowledgeScopeId(statusElementId = 'knowledge-source-upload-status') {
    const scope = currentKnowledgeScope();
    if (scope === KNOWLEDGE_SCOPE_GLOBAL) {
        return GLOBAL_RAG_PROJECT_ID;
    }
    return getSelectedProjectOrWarn(statusElementId);
}

function setKnowledgeScopeStatus(message = '') {
    const statusEl = document.getElementById('knowledge-source-scope-status');
    if (!statusEl) return;
    if (currentKnowledgeScope() === KNOWLEDGE_SCOPE_GLOBAL) {
        statusEl.textContent = message || 'Global scope selected. Uploads and search target the shared global RAG.';
        return;
    }
    statusEl.textContent = message || (selectedProject
        ? 'Selected project scope.'
        : 'Select a project or switch to Global.');
}

function getSelectedProjectOrWarn(statusElementId = 'project-source-upload-status') {
    if (selectedProject) {
        return selectedProject;
    }
    const statusEl = document.getElementById(statusElementId);
    if (statusEl) {
        statusEl.textContent = 'Select a project first.';
    }
    return null;
}

async function loadMemoryView() {
    if (window.ServiceStatus && window.ServiceStatus.orchestrator === 'offline') {
        const unavailable = document.getElementById('memory-unavailable');
        const content = document.getElementById('memory-content');
        if (unavailable) unavailable.style.display = 'block';
        if (content) content.style.display = 'none';
        return;
    }
    const unavailable = document.getElementById('memory-unavailable');
    const content = document.getElementById('memory-content');
    if (unavailable) unavailable.style.display = 'none';
    if (content) content.style.display = '';
    await Promise.all([loadMemoryStats(), loadProjectTextSources()]);
    await loadKnowledgeSourcesPanel();
    if (memorySemanticActive && memorySemanticResults.length) {
        renderMemoryItems(memorySemanticResults);
    } else {
        await loadMemoryItems();
    }
}

async function loadEmbeddingsView() {
    await loadGlobalEmbeddingStats();
    await loadAstProgress();
    if (!astProgressTimer) {
        astProgressTimer = setInterval(loadAstProgress, 5000);
    }
}

async function loadProjectTextSources() {
    const projectId = selectedProject;
    const container = document.getElementById('project-sources-list');
    if (!container) return;
    if (!projectId) {
        container.innerHTML = '<div class="empty-state">Select a project to manage sources.</div>';
        return;
    }
    container.innerHTML = '<div class="loading">Loading project sources...</div>';
    try {
        const response = await fetch(`/api/memory/sources/${projectId}`);
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load sources');
        }
        renderProjectTextSources(payload.sources || []);
    } catch (error) {
        container.innerHTML = `<div class="error-message">${error.message}</div>`;
    }
}

function renderSourceCards(sources = [], containerId = 'project-sources-list', projectId = selectedProject) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!sources.length) {
        container.innerHTML = '<div class="empty-state">No sources indexed for this scope.</div>';
        return;
    }
    container.innerHTML = sources.map((source) => `
        <div class="memory-card">
            <div class="memory-content"><strong>${source.source_label}</strong></div>
            <div class="memory-meta">
                <span>Type: ${source.source_type}</span>
                <span>Status: ${source.status}</span>
                <span>Chunks: ${source.chunk_count ?? 0}</span>
                <span>Method: ${source.ingest_method}</span>
                <span>Created: ${new Date(source.created_at).toLocaleString()}</span>
            </div>
            <div class="memory-meta">
                <span>File: ${source.original_filename || '—'}</span>
                <span>MIME: ${source.mime_type || '—'}</span>
            </div>
            <div class="memory-actions">
                <button onclick="handleProjectSourceReingest('${source.id}', '${projectId}')">Reingest</button>
                <button onclick="handleProjectSourceReplacePrompt('${source.id}', '${projectId}')">Replace</button>
                <button class="danger-btn" onclick="handleProjectSourceDelete('${source.id}', '${projectId}')">Delete</button>
            </div>
        </div>
    `).join('');
}

function renderProjectTextSources(sources = []) {
    renderSourceCards(sources, 'project-sources-list', selectedProject);
}

async function loadKnowledgeSourcesPanel() {
    setKnowledgeScopeStatus();
    const scopeId = resolveKnowledgeScopeId('knowledge-source-upload-status');
    const container = document.getElementById('knowledge-sources-list');
    if (!container) return;
    if (!scopeId) {
        container.innerHTML = '<div class="empty-state">Select a project or choose Global.</div>';
        return;
    }
    container.innerHTML = '<div class="loading">Loading knowledge sources...</div>';
    try {
        const response = await fetch(`/api/memory/sources/${scopeId}`);
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load sources');
        }
        renderSourceCards(payload.sources || [], 'knowledge-sources-list', scopeId);
    } catch (error) {
        container.innerHTML = `<div class="error-message">${error.message}</div>`;
    }
}

async function handleProjectSourceUpload(event) {
    event.preventDefault();
    const projectId = getSelectedProjectOrWarn();
    if (!projectId) return;
    const fileInput = document.getElementById('project-source-files');
    const statusEl = document.getElementById('project-source-upload-status');
    const replaceEl = document.getElementById('project-source-replace');
    const dedupeEl = document.getElementById('project-source-dedupe');
    const conversationFormatEl = document.getElementById('project-source-conversation-format');
    const files = Array.from(fileInput?.files || []);
    if (!files.length) {
        if (statusEl) statusEl.textContent = 'Choose at least one file.';
        return;
    }
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    formData.append('replace_existing', String(Boolean(replaceEl?.checked)));
    formData.append('dedupe_by_hash', String(Boolean(dedupeEl?.checked)));
    formData.append('reindex_if_same_name', 'true');
    if (conversationFormatEl?.value.trim()) {
        formData.append('conversation_format', conversationFormatEl.value.trim());
    }
    if (statusEl) statusEl.textContent = 'Uploading...';
    try {
        const response = await fetch(`/api/memory/upload-files/${projectId}`, {
            method: 'POST',
            body: formData,
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Upload failed');
        }
        const failed = (payload.results || []).filter((entry) => entry.status === 'failed');
        if (statusEl) {
            statusEl.textContent = failed.length
                ? `${failed.length} file(s) failed.`
                : `Indexed ${payload.count || files.length} file(s).`;
        }
        if (fileInput) fileInput.value = '';
        await Promise.all([loadProjectTextSources(), runProjectTextSearch(false)]);
    } catch (error) {
        if (statusEl) statusEl.textContent = `Upload failed: ${error.message}`;
    }
}

async function handleProjectSourceDelete(sourceId, scopeId = null) {
    const projectId = scopeId || getSelectedProjectOrWarn();
    if (!projectId) return;
    if (!window.confirm('Delete this source and its indexed chunks?')) return;
    try {
        const response = await fetch(`/api/memory/sources/${projectId}/${sourceId}`, { method: 'DELETE' });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Delete failed');
        }
        await Promise.all([loadProjectTextSources(), loadKnowledgeSourcesPanel(), runProjectTextSearch(false), runKnowledgeSourceSearch(false)]);
    } catch (error) {
        window.alert(`Delete failed: ${error.message}`);
    }
}

async function handleProjectSourceReingest(sourceId, scopeId = null) {
    const projectId = scopeId || getSelectedProjectOrWarn();
    if (!projectId) return;
    try {
        const response = await fetch(`/api/memory/sources/${projectId}/${sourceId}/reingest`, { method: 'POST' });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Reingest failed');
        }
        await Promise.all([loadProjectTextSources(), loadKnowledgeSourcesPanel(), runProjectTextSearch(false), runKnowledgeSourceSearch(false)]);
    } catch (error) {
        window.alert(`Reingest failed: ${error.message}`);
    }
}

function handleProjectSourceReplacePrompt(sourceId, scopeId = null) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.onchange = async () => {
        const file = picker.files?.[0];
        if (!file) return;
        const projectId = scopeId || getSelectedProjectOrWarn();
        if (!projectId) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
            const response = await fetch(`/api/memory/sources/${projectId}/${sourceId}/replace`, {
                method: 'POST',
                body: formData,
            });
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.detail || 'Replace failed');
            }
            await Promise.all([loadProjectTextSources(), loadKnowledgeSourcesPanel(), runProjectTextSearch(false), runKnowledgeSourceSearch(false)]);
        } catch (error) {
            window.alert(`Replace failed: ${error.message}`);
        }
    };
    picker.click();
}

async function runProjectTextSearch(announce = true) {
    const projectId = selectedProject;
    const statusEl = document.getElementById('project-text-search-status');
    const queryEl = document.getElementById('project-text-search-query');
    const rerankerEl = document.getElementById('project-text-search-reranker');
    const topkEl = document.getElementById('project-text-search-topk');
    const query = queryEl?.value.trim() || '';
    if (!projectId) {
        renderProjectTextSearchResults([]);
        if (statusEl && announce) statusEl.textContent = 'Select a project first.';
        return;
    }
    if (!query) {
        renderProjectTextSearchResults([]);
        if (statusEl && announce) statusEl.textContent = 'Enter a query.';
        return;
    }
    if (statusEl && announce) statusEl.textContent = 'Searching...';
    try {
        const response = await fetch(`/api/memory/text-search/${projectId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                top_k: Number(topkEl?.value || 8),
                use_reranker: Boolean(rerankerEl?.checked),
                table: 'text_chunks',
            }),
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Search failed');
        }
        renderProjectTextSearchResults(payload.results || []);
        if (statusEl && announce) statusEl.textContent = `Found ${payload.count || 0} results.`;
    } catch (error) {
        if (statusEl && announce) statusEl.textContent = `Search failed: ${error.message}`;
    }
}

function renderProjectTextSearchResults(results = []) {
    const container = document.getElementById('project-text-search-results');
    if (!container) return;
    if (!results.length) {
        container.innerHTML = '<div class="empty-state">No project text results yet.</div>';
        return;
    }
    container.innerHTML = results.map((item) => `
        <div class="memory-card">
            <div class="memory-content">${renderMemorySnippet(item.content)}</div>
            <div class="memory-meta">
                <span>Source: ${item.source_label || item.original_filename || item.file_path}</span>
                <span>Type: ${item.chunk_type}</span>
                <span>Header: ${item.header_context || '—'}</span>
                ${item.similarity !== undefined ? `<span>Similarity: ${Number(item.similarity).toFixed(3)}</span>` : ''}
            </div>
        </div>
    `).join('');
}

function handleProjectTextSearch(event) {
    event.preventDefault();
    runProjectTextSearch(true);
}

async function handleKnowledgeSourceUpload(event) {
    event.preventDefault();
    const scopeId = resolveKnowledgeScopeId('knowledge-source-upload-status');
    if (!scopeId) return;
    const fileInput = document.getElementById('knowledge-source-files');
    const statusEl = document.getElementById('knowledge-source-upload-status');
    const replaceEl = document.getElementById('knowledge-source-replace');
    const dedupeEl = document.getElementById('knowledge-source-dedupe');
    const conversationFormatEl = document.getElementById('knowledge-source-conversation-format');
    const files = Array.from(fileInput?.files || []);
    if (!files.length) {
        if (statusEl) statusEl.textContent = 'Choose at least one file.';
        return;
    }
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    formData.append('replace_existing', String(Boolean(replaceEl?.checked)));
    formData.append('dedupe_by_hash', String(Boolean(dedupeEl?.checked)));
    formData.append('reindex_if_same_name', 'true');
    if (conversationFormatEl?.value.trim()) {
        formData.append('conversation_format', conversationFormatEl.value.trim());
    }
    if (statusEl) statusEl.textContent = 'Uploading...';
    try {
        const response = await fetch(`/api/memory/upload-files/${scopeId}`, {
            method: 'POST',
            body: formData,
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Upload failed');
        }
        const failed = (payload.results || []).filter((entry) => entry.status === 'failed');
        if (statusEl) {
            statusEl.textContent = failed.length
                ? `${failed.length} file(s) failed.`
                : `Indexed ${payload.count || files.length} file(s).`;
        }
        if (fileInput) fileInput.value = '';
        await Promise.all([loadKnowledgeSourcesPanel(), runKnowledgeSourceSearch(false)]);
    } catch (error) {
        if (statusEl) statusEl.textContent = `Upload failed: ${error.message}`;
    }
}

async function runKnowledgeSourceSearch(announce = true) {
    const scopeId = resolveKnowledgeScopeId('knowledge-source-search-status');
    const statusEl = document.getElementById('knowledge-source-search-status');
    const queryEl = document.getElementById('knowledge-source-search-query');
    const rerankerEl = document.getElementById('knowledge-source-search-reranker');
    const topkEl = document.getElementById('knowledge-source-search-topk');
    const query = queryEl?.value.trim() || '';
    if (!scopeId) {
        renderKnowledgeSourceSearchResults([]);
        if (statusEl && announce) statusEl.textContent = 'Select a project or choose Global.';
        return;
    }
    if (!query) {
        renderKnowledgeSourceSearchResults([]);
        if (statusEl && announce) statusEl.textContent = 'Enter a query.';
        return;
    }
    const table = scopeId === GLOBAL_RAG_PROJECT_ID ? 'global_text_chunks' : 'text_chunks';
    if (statusEl && announce) statusEl.textContent = 'Searching...';
    try {
        const response = await fetch(`/api/memory/text-search/${scopeId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                top_k: Number(topkEl?.value || 8),
                use_reranker: Boolean(rerankerEl?.checked),
                table,
            }),
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Search failed');
        }
        renderKnowledgeSourceSearchResults(payload.results || []);
        if (statusEl && announce) statusEl.textContent = `Found ${payload.count || 0} results.`;
    } catch (error) {
        if (statusEl && announce) statusEl.textContent = `Search failed: ${error.message}`;
    }
}

function renderKnowledgeSourceSearchResults(results = []) {
    const container = document.getElementById('knowledge-source-search-results');
    if (!container) return;
    if (!results.length) {
        container.innerHTML = '<div class="empty-state">No search results yet.</div>';
        return;
    }
    container.innerHTML = results.map((item) => `
        <div class="memory-card">
            <div class="memory-content">${renderMemorySnippet(item.content)}</div>
            <div class="memory-meta">
                <span>Source: ${item.source_label || item.original_filename || item.file_path}</span>
                <span>Type: ${item.chunk_type}</span>
                <span>Header: ${item.header_context || '—'}</span>
                ${item.similarity !== undefined ? `<span>Similarity: ${Number(item.similarity).toFixed(3)}</span>` : ''}
            </div>
        </div>
    `).join('');
}

function handleKnowledgeSourceSearch() {
    runKnowledgeSourceSearch(true);
}
