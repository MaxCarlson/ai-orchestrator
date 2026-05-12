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

// ---------------------------------------------------------------------------
// Embeddings view — project selector + per-project chunks/search/browse
// ---------------------------------------------------------------------------

const EMBED_PAGE_SIZE = 50;

const _embedBrowse = { projectId: null, chunkType: 'text', page: 0, total: 0 };

async function loadEmbeddingsView() {
    await _loadEmbedProjectOptions();
    const select = document.getElementById('embed-project-select');
    _onEmbedProjectChange(select?.value || '__global__');
}

async function _loadEmbedProjectOptions() {
    const select = document.getElementById('embed-project-select');
    if (!select) return;
    const prev = select.value;
    while (select.options.length > 1) select.remove(1);
    try {
        const response = await fetch('/api/projects');
        if (!response.ok) return;
        const payload = await response.json();
        const projects = payload.projects || payload || [];
        projects.forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.id || p.project_id || p.name;
            opt.textContent = p.name || p.id || p.project_id;
            select.appendChild(opt);
        });
        if (prev && Array.from(select.options).some((o) => o.value === prev)) {
            select.value = prev;
        }
    } catch (_e) { /* fall back to global */ }
}

function _onEmbedProjectChange(projectId) {
    const projectPanel = document.getElementById('embed-project-panel');
    const globalPanel = document.getElementById('embed-global-panel');
    if (!projectPanel || !globalPanel) return;
    if (!projectId || projectId === '__global__') {
        projectPanel.classList.add('hidden');
        globalPanel.classList.remove('hidden');
        loadGlobalEmbeddingStats();
        loadAstProgress();
        if (!astProgressTimer) {
            astProgressTimer = setInterval(loadAstProgress, 5000);
        }
    } else {
        projectPanel.classList.remove('hidden');
        globalPanel.classList.add('hidden');
        _setEmbedChunkStats(0, 0, 0);
        _clearContainer('embed-search-results');
        _clearContainer('embed-browse-results');
        _loadEmbedChunkStats(projectId);
    }
}

function _clearContainer(id) {
    const el = document.getElementById(id);
    if (el) while (el.firstChild) el.removeChild(el.firstChild);
}

function _setPlaceholder(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = text;
    el.appendChild(div);
}

async function _loadEmbedChunkStats(projectId) {
    const statusEl = document.getElementById('embed-project-status');
    if (statusEl) statusEl.textContent = 'Loading…';
    try {
        const [textResp, codeResp] = await Promise.all([
            fetch(`/api/memory/text-chunks/${encodeURIComponent(projectId)}?limit=1&offset=0`),
            fetch(`/api/memory/text-chunks/${encodeURIComponent(projectId)}?limit=1&offset=0&chunk_type=code`),
        ]);
        let textTotal = 0;
        let codeTotal = 0;
        if (textResp.ok) {
            const d = await textResp.json();
            textTotal = d.total ?? d.count ?? (d.chunks || []).length;
        }
        if (codeResp.ok) {
            const d = await codeResp.json();
            codeTotal = d.total ?? d.count ?? (d.chunks || []).length;
        }
        _setEmbedChunkStats(textTotal + codeTotal, codeTotal, textTotal);
        if (statusEl) statusEl.textContent = '';
    } catch (e) {
        if (statusEl) statusEl.textContent = `Error: ${e.message}`;
    }
}

function _setEmbedChunkStats(total, code, text) {
    [['embed-chunk-total', total], ['embed-chunk-code', code], ['embed-chunk-text', text]].forEach(([id, v]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
    });
}

async function runEmbedSearch() {
    const select = document.getElementById('embed-project-select');
    const projectId = select?.value;
    if (!projectId || projectId === '__global__') return;
    const queryEl = document.getElementById('embed-search-query');
    const typeEl = document.getElementById('embed-search-type');
    const resultsEl = document.getElementById('embed-search-results');
    const query = queryEl?.value.trim() || '';
    if (!query) { _setPlaceholder('embed-search-results', 'Enter a search query.'); return; }
    _setPlaceholder('embed-search-results', 'Searching…');
    try {
        const response = await fetch(`/api/memory/text-search/${encodeURIComponent(projectId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, top_k: 10, use_reranker: false, table: typeEl?.value || 'text_chunks' }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Search failed');
        _renderEmbedChunkList(payload.results || [], 'embed-search-results', true);
    } catch (e) {
        _setPlaceholder('embed-search-results', `Error: ${e.message}`);
    }
}

async function loadEmbedBrowse(page) {
    const select = document.getElementById('embed-project-select');
    const projectId = select?.value;
    if (!projectId || projectId === '__global__') return;
    const typeEl = document.getElementById('embed-browse-type');
    const chunkType = typeEl?.value || 'text';
    const offset = page * EMBED_PAGE_SIZE;
    _setPlaceholder('embed-browse-results', 'Loading…');
    try {
        const params = new URLSearchParams({ limit: EMBED_PAGE_SIZE, offset });
        if (chunkType) params.set('chunk_type', chunkType);
        const response = await fetch(`/api/memory/text-chunks/${encodeURIComponent(projectId)}?${params}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Failed to load chunks');
        const chunks = payload.chunks || payload.results || [];
        const total = payload.total ?? payload.count ?? chunks.length;
        const totalPages = Math.max(1, Math.ceil(total / EMBED_PAGE_SIZE));
        _embedBrowse.projectId = projectId;
        _embedBrowse.chunkType = chunkType;
        _embedBrowse.page = page;
        _embedBrowse.total = total;
        const countEl = document.getElementById('embed-browse-count');
        const pageEl = document.getElementById('embed-browse-page');
        const prevBtn = document.getElementById('embed-browse-prev');
        const nextBtn = document.getElementById('embed-browse-next');
        if (countEl) countEl.textContent = `${total} total`;
        if (pageEl) pageEl.textContent = `Page ${page + 1} / ${totalPages}`;
        if (prevBtn) prevBtn.disabled = page === 0;
        if (nextBtn) nextBtn.disabled = page >= totalPages - 1;
        _renderEmbedChunkList(chunks, 'embed-browse-results', false);
    } catch (e) {
        _setPlaceholder('embed-browse-results', `Error: ${e.message}`);
    }
}

function _renderEmbedChunkList(items, containerId, showSimilarity) {
    const container = document.getElementById(containerId);
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No results.';
        container.appendChild(empty);
        return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'memory-card';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'memory-content';
        const raw = item.content || item.text || '';
        const snippet = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
        const pre = document.createElement('pre');
        pre.className = 'memory-snippet';
        pre.textContent = snippet;
        contentDiv.appendChild(pre);

        const metaDiv = document.createElement('div');
        metaDiv.className = 'memory-meta';

        const addMeta = (label, value) => {
            if (!value) return;
            const span = document.createElement('span');
            span.textContent = `${label}: ${value}`;
            metaDiv.appendChild(span);
        };
        addMeta('Type', item.chunk_type);
        addMeta('Source', item.source_label || item.original_filename || item.file_path);
        if (item.header_context) addMeta('Header', item.header_context);
        if (showSimilarity && item.similarity !== undefined) {
            addMeta('Similarity', Number(item.similarity).toFixed(3));
        }

        card.appendChild(contentDiv);
        card.appendChild(metaDiv);
        frag.appendChild(card);
    });
    container.appendChild(frag);
}

async function handleProjectEmbedSubmit(event) {
    event.preventDefault();
    const select = document.getElementById('embed-project-select');
    const projectId = select?.value;
    if (!projectId || projectId === '__global__') return;
    const modeEl = document.getElementById('project-embed-mode');
    const forceEl = document.getElementById('project-embed-force');
    const statusEl = document.getElementById('project-embed-status');
    if (statusEl) statusEl.textContent = 'Starting re-index…';
    try {
        const response = await fetch(`/api/project-tracking/${encodeURIComponent(projectId)}/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: modeEl?.value || 'auto', force: Boolean(forceEl?.checked) }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail || 'Re-index failed');
        if (statusEl) statusEl.textContent = payload.message || 'Re-index started.';
    } catch (e) {
        if (statusEl) statusEl.textContent = `Error: ${e.message}`;
    }
}

function setupEmbeddingsControls() {
    const projectSelect = document.getElementById('embed-project-select');
    if (projectSelect) {
        projectSelect.addEventListener('change', (e) => _onEmbedProjectChange(e.target.value));
    }
    document.getElementById('embed-refresh-btn')?.addEventListener('click', loadEmbeddingsView);
    document.getElementById('embed-search-btn')?.addEventListener('click', runEmbedSearch);
    document.getElementById('embed-search-query')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runEmbedSearch();
    });
    document.getElementById('embed-browse-btn')?.addEventListener('click', () => loadEmbedBrowse(0));
    document.getElementById('embed-browse-prev')?.addEventListener('click', () => loadEmbedBrowse(_embedBrowse.page - 1));
    document.getElementById('embed-browse-next')?.addEventListener('click', () => loadEmbedBrowse(_embedBrowse.page + 1));
    document.getElementById('project-embed-form')?.addEventListener('submit', handleProjectEmbedSubmit);
}
