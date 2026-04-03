/**
 * Memory and Embeddings view functions.
 * Extracted from app.js. Globals remain in app.js.
 */

// Memory View
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
    await loadMemoryStats();
    if (memorySemanticActive && memorySemanticResults.length) {
        renderMemoryItems(memorySemanticResults);
        return;
    }
    await loadMemoryItems();
}

// Embeddings View
async function loadEmbeddingsView() {
    await loadGlobalEmbeddingStats();
    await loadAstProgress();
    if (!astProgressTimer) {
        astProgressTimer = setInterval(loadAstProgress, 5000);
    }
}
