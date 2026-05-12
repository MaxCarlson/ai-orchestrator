/**
 * System Stats, LM Studio, and Logs view functions.
 * Extracted from app.js lines 2258-3725.
 * Globals remain in app.js.
 */
// System Stats View
async function loadSystemStats() {
    await Promise.all([loadDockerStats(), loadDbStats(), loadLmstudioStats()]);
}

async function loadDatabaseView() {
    const statusEl = document.getElementById('db-query-status');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/db-queries');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load database queries');
        }
        renderDbProjects(payload.projects || []);
        renderDbTasks(payload.tasks || []);
        renderDbMemories(payload.memories || []);
        renderDbCodeChunks(payload.code_chunks || []);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading database view:', error);
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
    }
}

function switchDbView(viewKey) {
    const buttons = document.querySelectorAll('.subnav-btn');
    const views = document.querySelectorAll('.db-view');
    buttons.forEach((button) => {
        button.classList.toggle('active', button.dataset.dbView === viewKey);
    });
    views.forEach((view) => {
        view.classList.toggle('active', view.dataset.dbView === viewKey);
    });
    if (viewKey === 'schema') {
        loadDbSchema();
    }
    if (viewKey === 'trends') {
        loadDbTrends();
    }
}

function switchSystemView(viewKey, initial = false) {
    currentSystemView = viewKey || 'stats';
    const buttons = document.querySelectorAll('.subnav-btn[data-system-view]');
    const views = document.querySelectorAll('.system-view');
    buttons.forEach((button) => {
        button.classList.toggle('active', button.dataset.systemView === currentSystemView);
    });
    views.forEach((view) => {
        view.classList.toggle('active', view.dataset.systemView === currentSystemView);
    });
    if (!initial) {
        logUiEvent('system_view_switch', { view: currentSystemView });
    }
    switch (currentSystemView) {
        case 'stats':
            loadSystemStats();
            break;
        case 'database':
            loadDatabaseView();
            switchDbView('queries');
            break;
        case 'lmstudio':
            loadLmstudioView();
            break;
        case 'logs':
            loadLogsView();
            break;
        default:
            loadSystemStats();
            break;
    }
}

function startSystemMeter() {
    const update = async () => {
        const cpuEl = document.getElementById('meter-cpu');
        const ramEl = document.getElementById('meter-ram');
        const gpuEl = document.getElementById('meter-gpu');
        if (!cpuEl || !ramEl || !gpuEl) return;
        try {
            const response = await fetch('/api/system/telemetry');
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload.detail || 'Telemetry failed');
            }
            cpuEl.textContent = payload.cpu_percent !== null ? `${payload.cpu_percent.toFixed(0)}%` : '—';
            if (payload.mem_total_mb) {
                ramEl.textContent = `${payload.mem_used_mb}/${payload.mem_total_mb} MB`;
            } else {
                ramEl.textContent = '—';
            }
            if (payload.gpu && payload.gpu.length) {
                const gpu = payload.gpu[0];
                const util = gpu.utilization !== null ? `${gpu.utilization}%` : '—';
                const mem = gpu.mem_total_mb ? `${gpu.mem_used_mb}/${gpu.mem_total_mb} MB` : '';
                gpuEl.textContent = mem ? `${util} (${mem})` : util;
            } else {
                gpuEl.textContent = '—';
            }
        } catch (error) {
            cpuEl.textContent = '—';
            ramEl.textContent = '—';
            gpuEl.textContent = '—';
        }
    };
    update();
    setInterval(update, 5000);
}

async function loadDbSchema() {
    const statusEl = document.getElementById('db-schema-status');
    if (statusEl) statusEl.textContent = 'Loading...';
    try {
        const response = await fetch('/api/system/db-schema');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Schema failed');
        }
        dbSchemaCache = payload;
        renderDbSchema(payload);
        if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        if (statusEl) statusEl.textContent = `Error: ${error.message}`;
    }
}

function renderDbSchema(payload) {
    const graph = document.getElementById('db-schema-graph');
    const legend = document.getElementById('db-schema-legend');
    if (!graph || !payload) return;
    const dbSelect = document.getElementById('db-schema-database');
    const scope = dbSelect ? dbSelect.value : 'core';
    const tables = (payload.tables || []).filter((table) => table.group === scope);
    const edges = (payload.edges || []).filter((edge) => edge.group === scope);

    const width = 900;
    const height = 520;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(centerX, centerY) - 90;
    const angleStep = tables.length ? (Math.PI * 2) / tables.length : 0;

    const positioned = tables.map((table, index) => {
        const angle = index * angleStep - Math.PI / 2;
        const x = centerX + radius * Math.cos(angle);
        const y = centerY + radius * Math.sin(angle);
        return { ...table, x, y };
    });

    const nodeByName = {};
    positioned.forEach((table) => {
        nodeByName[table.name] = table;
    });

    const edgeSvg = edges.map((edge) => {
        const source = nodeByName[edge.from];
        const target = nodeByName[edge.to];
        if (!source || !target) return '';
        return `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" class="schema-edge"/>`;
    }).join('');

    const nodeSvg = positioned.map((table) => `
        <g class="schema-node">
            <circle cx="${table.x}" cy="${table.y}" r="48"></circle>
            <text x="${table.x}" y="${table.y - 6}" text-anchor="middle">${table.label}</text>
            <text x="${table.x}" y="${table.y + 14}" text-anchor="middle" class="schema-sub">${table.name}</text>
        </g>
    `).join('');

    graph.innerHTML = `
        <rect width="100%" height="100%" rx="24" ry="24" class="schema-bg"></rect>
        ${edgeSvg}
        ${nodeSvg}
    `;

    if (legend) {
        legend.innerHTML = (payload.groups || [])
            .map((group) => `<span class="legend-pill">${group.label}</span>`)
            .join('');
    }
}

async function loadDbTrends() {
    const statusEl = document.getElementById('db-trends-status');
    if (statusEl) statusEl.textContent = 'Loading...';
    try {
        const response = await fetch('/api/system/db-trends');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Trends failed');
        }
        dbTrendsCache = payload;
        renderDbTrends(payload);
        if (statusEl) statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
        if (statusEl) statusEl.textContent = `Error: ${error.message}`;
    }
}

function renderDbTrends(payload) {
    const container = document.getElementById('db-trends-projects');
    if (!container || !payload) return;
    const projects = payload.projects || [];
    container.innerHTML = projects.map((project) => `
        <label class="checkbox-inline">
            <input type="checkbox" class="db-trends-project" data-project-id="${project.id}" checked>
            ${project.name}
        </label>
    `).join('');
    container.querySelectorAll('.db-trends-project').forEach((input) => {
        input.addEventListener('change', () => renderDbTrendsChart(payload));
    });
    renderDbTrendsChart(payload);
}

function setDbTrendsSelection(selectAll) {
    document.querySelectorAll('.db-trends-project').forEach((input) => {
        input.checked = selectAll;
    });
    renderDbTrendsChart(dbTrendsCache);
}

function renderDbTrendsChart(payload) {
    const canvas = document.getElementById('db-trends-canvas');
    if (!canvas || !payload) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const selectedIds = Array.from(document.querySelectorAll('.db-trends-project'))
        .filter((input) => input.checked)
        .map((input) => input.dataset.projectId);
    const projects = (payload.projects || []).filter((project) => selectedIds.includes(project.id));
    if (!projects.length) {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('Select at least one project to view trends.', 20, 30);
        return;
    }

    const metrics = ['tasks', 'memories', 'code_chunks'];
    const colors = ['#3b82f6', '#10b981', '#f59e0b'];
    const maxValue = Math.max(
        ...projects.map((project) => Math.max(project.tasks, project.memories, project.code_chunks)),
        1
    );
    const padding = 40;
    const chartWidth = canvas.width - padding * 2;
    const chartHeight = canvas.height - padding * 2;
    const groupWidth = chartWidth / projects.length;
    const barWidth = Math.min(34, (groupWidth - 16) / metrics.length);

    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Project counts', padding, padding - 12);

    projects.forEach((project, index) => {
        const baseX = padding + index * groupWidth + 8;
        metrics.forEach((metric, metricIndex) => {
            const value = project[metric] || 0;
            const barHeight = (value / maxValue) * chartHeight;
            ctx.fillStyle = colors[metricIndex];
            ctx.fillRect(baseX + metricIndex * (barWidth + 6), padding + (chartHeight - barHeight), barWidth, barHeight);
        });
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(project.name.slice(0, 10), baseX, padding + chartHeight + 18);
    });

    metrics.forEach((metric, index) => {
        ctx.fillStyle = colors[index];
        ctx.fillRect(padding + index * 110, canvas.height - 18, 12, 12);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(metric.replace('_', ' '), padding + index * 110 + 18, canvas.height - 8);
    });
}

// LM Studio View
async function loadLmstudioView() {
    const statusEl = document.getElementById('lmstudio-page-status');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    await Promise.all([loadLmstudioStatus(), loadLmstudioModels(), loadLmstudioLoaded()]);
    if (statusEl) {
        statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
}

async function loadLmstudioStatus() {
    const statusEl = document.getElementById('lmstudio-server-status');
    try {
        const response = await fetch('/api/lmstudio/status');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Status failed');
        }
        const text = payload.stdout || payload.detail || 'unknown';
        if (statusEl) {
            statusEl.textContent = text.includes('ON') ? 'online' : text || 'unknown';
        }
    } catch (error) {
        if (statusEl) {
            statusEl.textContent = 'offline';
        }
    }
}

async function loadLmstudioModels() {
    const listEl = document.getElementById('lmstudio-models-list');
    try {
        const response = await fetch('/api/lmstudio/models');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Models failed');
        }
        const models = payload || [];
        const countEl = document.getElementById('lmstudio-available-count');
        if (countEl) {
            countEl.textContent = models.length;
        }
        renderLmstudioModels(listEl, models);
        // Populate load-model dropdown using safe DOM methods
        const loadSel = document.getElementById('lmstudio-load-select');
        if (loadSel) {
            const prev = loadSel.value;
            while (loadSel.firstChild) loadSel.removeChild(loadSel.firstChild);
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '— select a model —';
            loadSel.appendChild(placeholder);
            models.filter(m => m.type === 'llm' || !m.type).forEach((m) => {
                const key = m.modelKey || m.key || m.path || '';
                const quant = m.quantization && m.quantization.name ? ` ${m.quantization.name}` : '';
                const params = m.paramsString ? ` (${m.paramsString}${quant})` : '';
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = `${m.displayName || key}${params}`;
                if (key === prev) opt.selected = true;
                loadSel.appendChild(opt);
            });
        }
    } catch (error) {
        if (listEl) {
            listEl.textContent = 'Failed to load models';
        }
    }
}

async function loadLmstudioLoaded() {
    const listEl = document.getElementById('lmstudio-loaded-list');
    try {
        const response = await fetch('/api/lmstudio/loaded');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Loaded models failed');
        }
        const models = payload || [];
        const countEl = document.getElementById('lmstudio-loaded-count');
        if (countEl) {
            countEl.textContent = models.length;
        }
        renderLmstudioLoaded(listEl, models);
        // Populate unload-model dropdown using safe DOM methods
        const unloadSel = document.getElementById('lmstudio-unload-select');
        if (unloadSel) {
            const prev = unloadSel.value;
            while (unloadSel.firstChild) unloadSel.removeChild(unloadSel.firstChild);
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = models.length ? '— select a loaded model —' : '(no models loaded)';
            unloadSel.appendChild(placeholder);
            models.forEach((m) => {
                const id = m.identifier || m.id || m.modelKey || '';
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = id;
                if (id === prev) opt.selected = true;
                unloadSel.appendChild(opt);
            });
        }
    } catch (error) {
        if (listEl) {
            listEl.textContent = 'Failed to load loaded models';
        }
    }
}

function renderLmstudioModels(container, models) {
    if (!container) {
        return;
    }
    if (!models.length) {
        container.innerHTML = '<div class="empty-state">No models found</div>';
        return;
    }
    const rows = models.map((model) => {
        const display = model.displayName || model.name || model.model_name || model.modelKey || model.key || model.path || '—';
        const params = model.paramsString || model.params || '—';
        const quant = model.quantization?.name || model.quantization || '—';
        const context = model.maxContextLength || model.context_length || '—';
        const modelKey = model.modelKey || model.key || model.path || '—';
        return `
            <div class="data-row six-col">
                <div>${display}</div>
                <div>${model.type || model.category || '—'}</div>
                <div>${params}</div>
                <div>${quant}</div>
                <div>${context}</div>
                <div class="mono muted">${modelKey}</div>
            </div>
        `;
    }).join('');
    container.innerHTML = `
        <div class="data-row header six-col">
            <div>Name</div>
            <div>Type</div>
            <div>Params</div>
            <div>Quant</div>
            <div>Context</div>
            <div>Key</div>
        </div>
        ${rows}
    `;
}

function renderLmstudioLoaded(container, models) {
    if (!container) {
        return;
    }
    if (!models.length) {
        container.innerHTML = '<div class="empty-state">No loaded models</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header four-col">
            <div>ID</div>
            <div>Model</div>
            <div>Context</div>
            <div>GPU</div>
        </div>
        ${models.map((model) => `
            <div class="data-row four-col">
                <div>${model.identifier || model.id || '—'}</div>
                <div>${model.model || model.name || model.modelKey || '—'}</div>
                <div>${model.context_length || model.ctx || '—'}</div>
                <div>${model.gpu || model.gpu_offload || '—'}</div>
            </div>
        `).join('')}
    `;
}

async function handleLmstudioLoad(event) {
    event.preventDefault();
    const statusEl = document.getElementById('lmstudio-load-status');
    const modelKey = document.getElementById('lmstudio-load-select')?.value.trim();
    if (!modelKey) {
        if (statusEl) statusEl.textContent = 'Select a model first.';
        return;
    }
    const gpuVal = document.getElementById('lmstudio-load-gpu')?.value || '';
    const payload = {
        path: modelKey,
        identifier: document.getElementById('lmstudio-load-identifier')?.value.trim() || undefined,
        gpu: gpuVal || undefined,
        context_length: Number(document.getElementById('lmstudio-load-ctx')?.value || 0) || undefined,
        ttl: Number(document.getElementById('lmstudio-load-ttl')?.value || 0) || undefined,
        yes: true,
    };
    if (statusEl) statusEl.textContent = 'Loading… (this may take a minute)';
    try {
        const response = await fetch('/api/lmstudio/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Load failed');
        }
        if (statusEl) statusEl.textContent = 'Load complete.';
        await loadLmstudioLoaded();
    } catch (error) {
        if (statusEl) statusEl.textContent = `Load failed: ${error.message}`;
    }
}

async function handleLmstudioUnload(event) {
    event.preventDefault();
    const statusEl = document.getElementById('lmstudio-unload-status');
    const unloadAll = Boolean(document.getElementById('lmstudio-unload-all')?.checked);
    const identifier = document.getElementById('lmstudio-unload-select')?.value.trim();
    if (!identifier && !unloadAll) {
        if (statusEl) statusEl.textContent = 'Select a model or choose Unload all.';
        return;
    }
    if (!window.confirm(unloadAll ? 'Unload ALL models?' : `Unload "${identifier}"?`)) return;
    const payload = {
        identifier: unloadAll ? undefined : identifier,
        all: unloadAll,
    };
    if (statusEl) statusEl.textContent = 'Unloading…';
    try {
        const response = await fetch('/api/lmstudio/unload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Unload failed');
        }
        if (statusEl) statusEl.textContent = 'Unload complete.';
        await loadLmstudioLoaded();
    } catch (error) {
        if (statusEl) statusEl.textContent = `Unload failed: ${error.message}`;
    }
}

// ── HuggingFace model search ──────────────────────────────────────────────────

// Type-tag keyword map for client-side model filtering
const HF_TYPE_TAGS = {
    thinking:  ['thinking', 'reasoning', 'r1', 'o1', 'qwq', 'skywork-o'],
    tool:      ['tool-use', 'tool_use', 'function-calling', 'agentic', 'agent'],
    vision:    ['vision', 'multimodal', 'image-text-to-text', 'visual'],
    code:      ['code', 'coding', 'starcoder', 'codellama', 'deepseek-coder'],
    instruct:  ['instruct', 'chat', 'it', 'instruction'],
};

function _hfModelMatchesType(model, typeFilter) {
    if (!typeFilter) return true;
    const keywords = HF_TYPE_TAGS[typeFilter] || [];
    const haystack = [
        model.id || '',
        ...(model.tags || []),
        ...(model.pipeline_tag ? [model.pipeline_tag] : []),
    ].join(' ').toLowerCase();
    return keywords.some(kw => haystack.includes(kw));
}

function _hfModelSizeGb(model) {
    // Sum the sizes of GGUF files listed in siblings
    const siblings = model.siblings || [];
    let total = 0;
    siblings.forEach(f => {
        if (f.rfilename && f.rfilename.endsWith('.gguf') && f.size) {
            total += f.size;
        }
    });
    return total > 0 ? total / 1073741824 : null;  // bytes → GB
}

async function handleLmstudioHfSearch() {
    const query = document.getElementById('lmstudio-hf-query')?.value.trim();
    const sort = document.getElementById('lmstudio-hf-sort')?.value || 'downloads';
    const maxGb = parseFloat(document.getElementById('lmstudio-hf-maxgb')?.value || '0') || 0;
    const typeFilter = document.getElementById('lmstudio-hf-type')?.value || '';
    const statusEl = document.getElementById('lmstudio-hf-status');
    const resultsEl = document.getElementById('lmstudio-hf-results');

    if (!query) {
        if (statusEl) statusEl.textContent = 'Enter a search term.';
        return;
    }
    if (statusEl) statusEl.textContent = 'Searching HuggingFace…';
    while (resultsEl && resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);

    try {
        const params = new URLSearchParams({
            search: query,
            filter: 'gguf',
            sort,
            direction: '-1',
            limit: '30',
            full: 'true',
        });
        const resp = await fetch(`https://huggingface.co/api/models?${params}`);
        if (!resp.ok) throw new Error(`HuggingFace API error ${resp.status}`);
        let models = await resp.json();

        // Client-side filters
        if (typeFilter) models = models.filter(m => _hfModelMatchesType(m, typeFilter));
        if (maxGb > 0) {
            models = models.filter(m => {
                const gb = _hfModelSizeGb(m);
                return gb === null || gb <= maxGb;
            });
        }

        if (statusEl) statusEl.textContent = `${models.length} result${models.length !== 1 ? 's' : ''}`;
        if (!models.length) {
            if (resultsEl) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.textContent = 'No matching GGUF models found.';
                resultsEl.appendChild(empty);
            }
            return;
        }
        models.forEach(m => resultsEl && resultsEl.appendChild(_renderHfModelCard(m)));
    } catch (err) {
        if (statusEl) statusEl.textContent = `Search failed: ${err.message}`;
    }
}

function _renderHfModelCard(model) {
    const card = document.createElement('div');
    card.className = 'lms-model-card';

    const sizeGb = _hfModelSizeGb(model);
    const sizeText = sizeGb !== null ? `${sizeGb.toFixed(1)} GB` : 'size unknown';
    const dl = (model.downloads || 0).toLocaleString();
    const tags = (model.tags || []).filter(t => ['instruct','chat','code','vision','tool-use','thinking','reasoning'].some(k => t.toLowerCase().includes(k)));

    const nameEl = document.createElement('div');
    nameEl.className = 'lms-card-name';
    nameEl.textContent = model.id || '—';
    card.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'lms-card-meta';
    metaEl.textContent = `${sizeText} · ${dl} downloads`;
    card.appendChild(metaEl);

    if (tags.length) {
        const tagsEl = document.createElement('div');
        tagsEl.className = 'lms-card-tags';
        tags.slice(0, 5).forEach(t => {
            const badge = document.createElement('span');
            badge.className = 'tag-badge';
            badge.textContent = t;
            tagsEl.appendChild(badge);
        });
        card.appendChild(tagsEl);
    }

    const btn = document.createElement('button');
    btn.className = 'secondary-btn';
    btn.textContent = 'Download via LM Studio';
    btn.addEventListener('click', () => _downloadHfModel(model.id || ''));
    card.appendChild(btn);

    return card;
}

async function _downloadHfModel(modelId) {
    const statusEl = document.getElementById('lmstudio-hf-status');
    if (!window.confirm(`Download "${modelId}" via LM Studio? This will use lms get and may take a while.`)) return;
    if (statusEl) statusEl.textContent = `Downloading ${modelId}… (check LM Studio for progress)`;
    try {
        const response = await fetch('/api/lmstudio/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_name: modelId, gguf: true, yes: true }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Download failed');
        }
        if (statusEl) statusEl.textContent = `Download started for ${modelId}.`;
        setTimeout(loadLmstudioModels, 3000);
    } catch (err) {
        if (statusEl) statusEl.textContent = `Download failed: ${err.message}`;
    }
}

async function handleLmstudioServer(action) {
    const statusEl = document.getElementById('lmstudio-server-status-text');
    if (statusEl) statusEl.textContent = `${action}...`;
    try {
        const response = await fetch(`/api/lmstudio/server/${action}`, { method: 'POST' });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail?.detail || result.detail || 'Server command failed');
        }
        if (statusEl) statusEl.textContent = `Server ${action} complete.`;
        await loadLmstudioStatus();
    } catch (error) {
        if (statusEl) statusEl.textContent = `Server ${action} failed: ${error.message}`;
    }
}

async function loadDockerStats() {
    const statusEl = document.getElementById('docker-status');
    const listEl = document.getElementById('docker-list');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/docker');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load docker info');
        }
        const containers = payload.containers || [];
        const countEl = document.getElementById('stat-docker-containers');
        if (countEl) {
            countEl.textContent = containers.length;
        }
        renderDockerList(listEl, containers);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading docker stats:', error);
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
        if (listEl) {
            listEl.innerHTML = '<div class="error">Docker stats unavailable</div>';
        }
    }
}

async function loadDbStats() {
    const statusEl = document.getElementById('db-status');
    const listEl = document.getElementById('db-list');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/db');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load database stats');
        }
        updateDbSummary(payload);
        renderDbList(listEl, payload);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading db stats:', error);
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
        if (listEl) {
            listEl.innerHTML = '<div class="error">Database stats unavailable</div>';
        }
    }
}

async function loadLmstudioStats() {
    const statusEl = document.getElementById('lmstudio-status');
    const listEl = document.getElementById('lmstudio-list');
    if (statusEl) {
        statusEl.textContent = 'Loading...';
    }
    try {
        const response = await fetch('/api/system/lmstudio');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load LM Studio');
        }
        const statusElCard = document.getElementById('stat-lmstudio-status');
        if (statusElCard) {
            statusElCard.textContent = payload.server || 'unknown';
        }
        renderLmstudioList(listEl, payload);
        if (statusEl) {
            statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
        }
    } catch (error) {
        console.error('Error loading LM Studio status:', error);
        const statusElCard = document.getElementById('stat-lmstudio-status');
        if (statusElCard) {
            statusElCard.textContent = 'offline';
        }
        if (statusEl) {
            statusEl.textContent = `Error: ${error.message}`;
        }
        if (listEl) {
            listEl.innerHTML = '<div class="error">LM Studio unavailable</div>';
        }
    }
}

function renderDockerList(container, items) {
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No containers found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header">
            <div>Name</div>
            <div>Status</div>
            <div>Image</div>
            <div>Ports</div>
            <div>Memory</div>
        </div>
        ${items.map((item) => {
            const ports = (item.ports || []).join(', ') || '—';
            const mem = formatMemory(item.mem_usage_bytes, item.mem_limit_bytes);
            return `
                <div class="data-row">
                    <div>${item.name}</div>
                    <div>${item.status}</div>
                    <div>${item.image}</div>
                    <div>${ports}</div>
                    <div>${mem}</div>
                </div>
            `;
        }).join('')}
    `;
}

function renderDbList(container, payload) {
    if (!container) {
        return;
    }
    container.innerHTML = `
        <div class="data-row header two-col">
            <div>Metric</div>
            <div>Value</div>
        </div>
        <div class="data-row two-col"><div>Projects</div><div>${payload.projects}</div></div>
        <div class="data-row two-col"><div>Tasks</div><div>${payload.tasks}</div></div>
        <div class="data-row two-col"><div>Task Links</div><div>${payload.task_links}</div></div>
        <div class="data-row two-col"><div>Memory Items</div><div>${payload.memory_items}</div></div>
        <div class="data-row two-col"><div>Code Chunks</div><div>${payload.code_chunks}</div></div>
        <div class="data-row two-col"><div>Project Tracking</div><div>${payload.project_tracking}</div></div>
        <div class="data-row two-col"><div>DB Size</div><div>${formatBytes(payload.db_size_bytes)}</div></div>
        <div class="data-row two-col"><div>DB Version</div><div>${payload.db_version || '—'}</div></div>
    `;
}

function renderLmstudioList(container, payload) {
    if (!container) {
        return;
    }
    const models = payload.models || [];
    if (!models.length) {
        container.innerHTML = '<div class="empty-state">No models reported</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>ID</div>
            <div>Owned By</div>
            <div>Object</div>
        </div>
        ${models.map((model) => `
            <div class="data-row three-col">
                <div>${model.id || '—'}</div>
                <div>${model.owned_by || '—'}</div>
                <div>${model.object || '—'}</div>
            </div>
        `).join('')}
    `;
}

function renderDbProjects(items) {
    const container = document.getElementById('db-projects-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No projects found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>Name</div>
            <div>Status</div>
            <div>Created</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${item.name}</div>
                <div>${item.status}</div>
                <div>${new Date(item.created_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function renderDbTasks(items) {
    const container = document.getElementById('db-tasks-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No tasks found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>Title</div>
            <div>Status</div>
            <div>Created</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${item.title}</div>
                <div>${item.status}</div>
                <div>${new Date(item.created_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function renderDbMemories(items) {
    const container = document.getElementById('db-memories-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No memories found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>ID</div>
            <div>Created By</div>
            <div>Created</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${String(item.memory_id).slice(0, 8)}…</div>
                <div>${item.created_by}</div>
                <div>${new Date(item.created_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function renderDbCodeChunks(items) {
    const container = document.getElementById('db-code-list');
    if (!container) {
        return;
    }
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No code chunks found</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>File</div>
            <div>Symbol</div>
            <div>Updated</div>
        </div>
        ${items.map((item) => `
            <div class="data-row three-col">
                <div>${item.file_path}</div>
                <div>${item.symbol_name}</div>
                <div>${new Date(item.updated_at).toLocaleString()}</div>
            </div>
        `).join('')}
    `;
}

function updateDbSummary(payload) {
    const projectsEl = document.getElementById('stat-db-projects');
    const tasksEl = document.getElementById('stat-db-tasks');
    const memoryEl = document.getElementById('stat-db-memory');
    if (projectsEl) {
        projectsEl.textContent = payload.projects ?? 0;
    }
    if (tasksEl) {
        tasksEl.textContent = payload.tasks ?? 0;
    }
    if (memoryEl) {
        memoryEl.textContent = payload.memory_items ?? 0;
    }
}

function formatBytes(value) {
    if (value === null || value === undefined) {
        return '—';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Number(value);
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatMemory(usage, limit) {
    if (!usage || !limit) {
        return '—';
    }
    return `${formatBytes(usage)} / ${formatBytes(limit)}`;
}

async function loadMemoryStats() {
    try {
        const stats = await fetch('/api/memory/stats').then(r => r.json());
        document.getElementById('memory-total').textContent = stats.total || 0;
        const topCategory = (stats.by_category && stats.by_category[0]) ? stats.by_category[0].category : '—';
        document.getElementById('memory-top-category').textContent = topCategory || '—';
        const latest = stats.latest ? new Date(stats.latest.created_at).toLocaleString() : '—';
        document.getElementById('memory-latest').textContent = latest;
    } catch (error) {
        console.error('Error loading memory stats:', error);
    }
}

async function loadMemoryItems() {
    const params = new URLSearchParams({ limit: 50 });
    if (memorySearchTerm) {
        params.append('search', memorySearchTerm);
    }

    try {
        const items = await fetch(`/api/memory/items?${params.toString()}`).then(r => r.json());
        renderMemoryItems(items);
    } catch (error) {
        console.error('Error loading memory items:', error);
        const container = document.getElementById('memory-list');
        container.innerHTML = '<div class="error">Failed to load memory items</div>';
    }
}

async function handleMemorySemanticSearch() {
    const queryInput = document.getElementById('memory-semantic-query');
    const projectInput = document.getElementById('memory-semantic-project');
    const topkInput = document.getElementById('memory-semantic-topk');
    const statusEl = document.getElementById('memory-semantic-status');

    const query = queryInput ? queryInput.value.trim() : '';
    if (!query) {
        if (statusEl) {
            statusEl.textContent = 'Enter a search query first.';
        }
        return;
    }

    const payload = {
        query,
        top_k: Number(topkInput?.value || 8),
    };
    const projectId = projectInput ? projectInput.value.trim() : '';
    if (projectId) {
        payload.project_id = projectId;
    }

    logUiEvent('memory_semantic_search', { query, project_id: projectId || null });
    if (statusEl) {
        statusEl.textContent = 'Searching...';
    }

    try {
        const response = await fetch('/api/memory/search-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const results = await response.json();
        if (!response.ok) {
            throw new Error(results.detail || 'Search failed');
        }
        memorySemanticActive = true;
        memorySemanticResults = results;
        renderMemoryItems(results);
        if (statusEl) {
            statusEl.textContent = `Found ${results.length} matches.`;
        }
    } catch (error) {
        console.error('Error running semantic search:', error);
        if (statusEl) {
            statusEl.textContent = `Search failed: ${error.message}`;
        }
    }
}

async function handleMemoryAdd(event) {
    event.preventDefault();
    const contentInput = document.getElementById('memory-add-content');
    const projectInput = document.getElementById('memory-add-project');
    const categoriesInput = document.getElementById('memory-add-categories');
    const createdByInput = document.getElementById('memory-add-created-by');
    const statusEl = document.getElementById('memory-add-status');

    const content = contentInput ? contentInput.value.trim() : '';
    if (!content) {
        if (statusEl) {
            statusEl.textContent = 'Content is required.';
        }
        return;
    }

    const payload = { content };
    const projectId = projectInput ? projectInput.value.trim() : '';
    if (projectId) {
        payload.project_id = projectId;
    }
    const categoriesRaw = categoriesInput ? categoriesInput.value.trim() : '';
    if (categoriesRaw) {
        payload.categories = categoriesRaw.split(',').map((c) => c.trim()).filter(Boolean);
    }
    const createdBy = createdByInput ? createdByInput.value.trim() : '';
    if (createdBy) {
        payload.created_by = createdBy;
    }

    logUiEvent('memory_add', { project_id: projectId || null });
    if (statusEl) {
        statusEl.textContent = 'Adding...';
    }

    try {
        const response = await fetch('/api/memory/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(normalizeErrorDetail(result.detail) || 'Add failed');
        }
        if (statusEl) {
            statusEl.textContent = `Added memory ${result.memory_id?.slice(0, 8) || ''}`;
        }
        if (contentInput) {
            contentInput.value = '';
        }
        await loadMemoryStats();
        await loadMemoryItems();
    } catch (error) {
        console.error('Error adding memory:', error);
        if (statusEl) {
            statusEl.textContent = `Add failed: ${error.message}`;
        }
    }
}

async function handleMemoryIndex(event) {
    event.preventDefault();
    const projectInput = document.getElementById('memory-index-project');
    const repoInput = document.getElementById('memory-index-repo');
    const modelInput = document.getElementById('memory-index-model');
    const forceInput = document.getElementById('memory-index-force');
    const statusEl = document.getElementById('memory-index-status');

    const projectId = projectInput ? projectInput.value.trim() : '';
    if (!projectId) {
        if (statusEl) {
            statusEl.textContent = 'Project ID is required.';
        }
        return;
    }

    const payload = {
        force_reindex: Boolean(forceInput?.checked),
        ...approvalMetadata('webui-memory-code-index'),
    };
    const repoPath = repoInput ? repoInput.value.trim() : '';
    if (repoPath) {
        payload.repo_path = repoPath;
    }
    const modelId = modelInput ? modelInput.value.trim() : '';
    if (modelId) {
        payload.model_id = modelId;
    }

    logUiEvent('memory_index', { project_id: projectId, repo_path: repoPath || null });
    if (statusEl) {
        statusEl.textContent = 'Queuing...';
    }

    try {
        const response = await fetch(`/api/memory/code-index/${projectId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Index queue failed');
        }
        if (statusEl) {
            statusEl.textContent = `Queued ${result.task_id?.slice(0, 8) || 'job'}.`;
        }
    } catch (error) {
        console.error('Error queueing code index:', error);
        if (statusEl) {
            statusEl.textContent = `Queue failed: ${error.message}`;
        }
    }
}

function renderMemoryItems(items) {
    const container = document.getElementById('memory-list');
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-state">No memory entries found</div>';
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="memory-card">
            <div class="memory-content">${renderMemorySnippet(item.content)}</div>
            <div class="memory-meta">
                <span>ID: ${item.memory_id.slice(0, 8)}…</span>
                <span>Project: ${item.project_id || '—'}</span>
                ${item.scope ? `<span>Scope: ${item.scope}</span>` : ''}
                <span>Created: ${new Date(item.created_at).toLocaleString()}</span>
                <span>Feedback: ${item.user_feedback ?? 0}</span>
                ${item.similarity !== undefined ? `<span>Similarity: ${item.similarity.toFixed(3)}</span>` : ''}
            </div>
            <div class="memory-tags">
                ${(item.categories || []).map(cat => `<span class="memory-tag">${cat}</span>`).join('')}
            </div>
            <div class="memory-actions">
                <button onclick="handleMemoryFeedback('${item.memory_id}', 1)">👍 Good</button>
                <button onclick="handleMemoryFeedback('${item.memory_id}', -1)">👎 Bad</button>
                <button onclick="handleMemoryDelete('${item.memory_id}')">🗑️ Delete</button>
            </div>
        </div>
    `).join('');
}

function renderGlobalMemoryItems(items) {
    const container = document.getElementById('global-search-results');
    if (!container) return;
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-state">No global memory entries found</div>';
        return;
    }

    container.innerHTML = items.map(item => `
        <div class="memory-card">
            <div class="memory-content">${renderMemorySnippet(item.content)}</div>
            <div class="memory-meta">
                <span>ID: ${item.memory_id.slice(0, 8)}…</span>
                <span>Scope: Global</span>
                <span>Created: ${new Date(item.created_at).toLocaleString()}</span>
                <span>Feedback: ${item.user_feedback ?? 0}</span>
                ${item.similarity !== undefined ? `<span>Similarity: ${item.similarity.toFixed(3)}</span>` : ''}
            </div>
            <div class="memory-tags">
                ${(item.categories || []).map(cat => `<span class="memory-tag">${cat}</span>`).join('')}
            </div>
        </div>
    `).join('');
}

async function handleMemoryDelete(memoryId) {
    if (!confirm('Delete this memory entry?')) {
        return;
    }
    logUiEvent('memory_delete', { memory_id: memoryId });
    try {
        const response = await fetch(`/api/memory/items/${memoryId}`, { method: 'DELETE' });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.detail || 'Delete failed');
        }
        loadMemoryItems();
        loadMemoryStats();
    } catch (error) {
        console.error('Error deleting memory:', error);
        alert('Failed to delete memory: ' + error.message);
    }
}

async function handleMemoryFeedback(memoryId, delta) {
    logUiEvent('memory_feedback', { memory_id: memoryId, delta });
    try {
        const response = await fetch('/api/memory/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memory_id: memoryId, feedback: delta })
        });
        if (!response.ok) {
            const result = await response.json();
            throw new Error(result.detail || 'Feedback update failed');
        }
        loadMemoryItems();
    } catch (error) {
        console.error('Error updating feedback:', error);
        alert('Failed to update feedback: ' + error.message);
    }
}

async function handleGlobalEmbeddingSubmit(event) {
    event.preventDefault();
    const statusEl = document.getElementById('global-embed-status');
    const pathsInput = document.getElementById('global-embed-paths');
    const modeSelect = document.getElementById('global-embed-mode');
    const codeModelInput = document.getElementById('global-embed-code-model');
    const textModelInput = document.getElementById('global-embed-text-model');
    const forceToggle = document.getElementById('global-embed-force');

    const rawPaths = pathsInput ? pathsInput.value.split('\n') : [];
    const repoPaths = rawPaths.map(line => line.trim()).filter(Boolean);
    if (repoPaths.length === 0) {
        if (statusEl) statusEl.textContent = 'Enter at least one repository path.';
        return;
    }

    const payload = {
        repo_paths: repoPaths,
        mode: modeSelect ? modeSelect.value : 'auto',
        force_reindex: forceToggle ? forceToggle.checked : false,
        ...approvalMetadata('webui-memory-global-index'),
    };
    if (codeModelInput && codeModelInput.value.trim()) {
        payload.code_model_id = codeModelInput.value.trim();
    }
    if (textModelInput && textModelInput.value.trim()) {
        payload.text_model_id = textModelInput.value.trim();
    }

    logUiEvent('global_embedding_start', { repo_paths: repoPaths, mode: payload.mode });
    if (statusEl) statusEl.textContent = 'Queueing...';

    try {
        const response = await fetch('/api/memory/global/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Unable to queue global embedding');
        }
        if (statusEl) statusEl.textContent = `Queued ${result.task_id?.slice(0, 8) || 'job'}.`;
        await loadGlobalEmbeddingStats();
    } catch (error) {
        console.error('Error queueing global embedding:', error);
        if (statusEl) statusEl.textContent = `Queue failed: ${error.message}`;
    }
}

async function handleGlobalSearch() {
    const queryInput = document.getElementById('global-search-query');
    const query = queryInput ? queryInput.value.trim() : '';
    if (!query) {
        return;
    }
    logUiEvent('global_memory_search', { query });
    try {
        const response = await fetch('/api/memory/global/search-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, top_k: 8 }),
        });
        const results = await response.json();
        if (!response.ok) {
            throw new Error(results.detail || 'Global search failed');
        }
        renderGlobalMemoryItems(results);
    } catch (error) {
        console.error('Error searching global memory:', error);
        const container = document.getElementById('global-search-results');
        if (container) {
            container.innerHTML = `<div class="error">Search failed: ${error.message}</div>`;
        }
    }
}

async function loadGlobalEmbeddingStats() {
    try {
        const response = await fetch('/api/memory/global/stats');
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.detail || 'Failed to load global stats');
        }
        const totalEl = document.getElementById('global-embedding-total');
        if (totalEl) totalEl.textContent = payload.total ?? 0;
        const ratioEl = document.getElementById('global-embedding-ratio');
        if (ratioEl) ratioEl.textContent = (payload.overall_frequency_ratio ?? 0).toFixed(2);
        renderGlobalTopUsed(payload.top_used || []);
    } catch (error) {
        console.error('Error loading global embedding stats:', error);
    }
}

async function loadAstProgress() {
    const statusEl = document.getElementById('ast-progress-status');
    const metaEl = document.getElementById('ast-progress-meta');
    const fileEl = document.getElementById('ast-progress-file');
    try {
        const response = await fetch('/api/memory/embedding-runs?status=running&limit=1');
        const runs = await response.json();
        if (!response.ok) {
            throw new Error(runs.detail || 'Failed to load embedding runs');
        }
        const run = Array.isArray(runs) && runs.length ? runs[0] : null;
        renderAstProgress(run);
        if (statusEl) {
            statusEl.textContent = run ? `Running ${run.mode?.toUpperCase() || ''}` : 'Idle';
        }
        if (metaEl) {
            metaEl.textContent = run ? `Target: ${run.target} · Started ${formatTimeSince(run.started_at)}` : 'No active embedding run.';
        }
        if (fileEl) {
            const currentFile = run?.stats?.progress?.current_file;
            fileEl.textContent = currentFile ? `Now parsing: ${currentFile}` : '';
        }
    } catch (error) {
        if (statusEl) statusEl.textContent = 'Unavailable';
        if (metaEl) metaEl.textContent = 'Unable to read AST progress.';
        if (fileEl) fileEl.textContent = '';
        renderAstProgress(null);
    }
}

function renderAstProgress(run) {
    const canvas = document.getElementById('ast-progress-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!run || !run.stats || !run.stats.progress) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('No active AST parse.', 20, 30);
        return;
    }

    const progress = run.stats.progress || {};
    const astOk = progress.ast_success || 0;
    const astFail = progress.ast_failure || 0;
    const processed = progress.files_processed || 0;
    const total = progress.files_total || 0;
    const maxAst = Math.max(astOk, astFail, 1);
    const padding = 24;
    const width = canvas.width - padding * 2;
    const height = canvas.height - padding * 2;

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('AST success vs fail', padding, padding - 6);

    const barWidth = 80;
    const okHeight = (astOk / maxAst) * (height - 40);
    const failHeight = (astFail / maxAst) * (height - 40);
    const baseY = padding + (height - 40);
    ctx.fillStyle = '#10b981';
    ctx.fillRect(padding, baseY - okHeight, barWidth, okHeight);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(padding + barWidth + 24, baseY - failHeight, barWidth, failHeight);

    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`OK: ${astOk}`, padding, baseY + 18);
    ctx.fillText(`Fail: ${astFail}`, padding + barWidth + 24, baseY + 18);

    const progressY = padding + height - 10;
    const ratio = total ? processed / total : 0;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.fillRect(padding + 220, progressY - 8, width - 240, 8);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(padding + 220, progressY - 8, (width - 240) * ratio, 8);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`Files: ${processed}/${total || '—'}`, padding + 220, progressY - 14);
}

function renderGlobalTopUsed(items) {
    const container = document.getElementById('global-embedding-top');
    if (!container) return;
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No global embeddings yet</div>';
        return;
    }
    container.innerHTML = `
        <div class="data-row header three-col">
            <div>Memory ID</div>
            <div>Accesses</div>
            <div>Created</div>
        </div>
        ${items.map(item => `
            <div class="data-row three-col">
                <div>${String(item.memory_id).slice(0, 8)}…</div>
                <div>${item.access_count ?? 0}</div>
                <div>${item.created_at ? new Date(item.created_at).toLocaleDateString() : '—'}</div>
            </div>
        `).join('')}
    `;
}

function renderMemorySnippet(content) {
    const value = content || '';
    const snippet = value.slice(0, 400);
    return `${escapeHtml(snippet)}${value.length > 400 ? '…' : ''}`;
}

function escapeHtml(text = '') {
    return text.replace(/[&<>'"]/g, (char) => {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        };
        return map[char] || char;
    });
}

// Logs View
async function loadLogsView() {
    logUiEvent('logs_view_load', {
        min_level: logViewerSettings.minLevel,
        include_access: logViewerSettings.includeAccess,
    });
    await Promise.all([loadLogConfig(), loadLogEntries()]);
}

async function loadLogConfig() {
    const targetSelect = document.getElementById('server-log-target');
    const levelSelect = document.getElementById('server-log-level');
    if (!targetSelect || !levelSelect) {
        return;
    }
    try {
        const config = await fetch('/api/logs/levels').then(r => r.json());
        if (Array.isArray(config.available_levels) && config.available_levels.length > 0) {
            levelSelect.innerHTML = config.available_levels.map(level => `
                <option value="${level}">${level.charAt(0)}${level.slice(1).toLowerCase()}</option>
            `).join('');
        }
        if (Array.isArray(config.loggers) && config.loggers.length > 0) {
            const previousTarget = targetSelect.value;
            targetSelect.innerHTML = config.loggers.map(entry => `
                <option value="${entry.name}">${entry.name} (${entry.level})</option>
            `).join('');
            const selectedEntry = config.loggers.find(entry => entry.name === previousTarget) || config.loggers[0];
            if (selectedEntry) {
                targetSelect.value = selectedEntry.name;
                levelSelect.value = selectedEntry.level || logViewerSettings.minLevel;
            }
        }
    } catch (error) {
        console.error('Error loading log level metadata:', error);
    }
}

async function loadLogEntries() {
    const params = new URLSearchParams({
        limit: '500',
        min_level: logViewerSettings.minLevel,
    });
    if (logViewerSettings.includeAccess) {
        params.append('include_access', 'true');
    }
    try {
        const response = await fetch(`/api/logs?${params.toString()}`);
        const data = await response.json();
        renderLogEntries(data.logs || []);
    } catch (error) {
        console.error('Error loading logs:', error);
        const container = document.getElementById('logs-output');
        if (container) {
            container.innerHTML = '<div class="error">Failed to load logs</div>';
        }
    }
}

function renderLogEntries(entries) {
    const container = document.getElementById('logs-output');
    if (!container) {
        return;
    }
    if (!entries || entries.length === 0) {
        container.innerHTML = '<div class="empty-state">No log entries</div>';
        return;
    }
    container.innerHTML = entries.map(entry => {
        const timestamp = entry.timestamp
            ? new Date(entry.timestamp).toLocaleTimeString()
            : new Date().toLocaleTimeString();
        const loggerName = escapeHtml(entry.logger || 'unknown');
        const message = escapeHtml(entry.message || '');
        const level = (entry.level || 'INFO').toUpperCase();
        return `
            <div class="log-entry level-${level}">
                <div class="log-meta">
                    <span>${timestamp}</span>
                    <span>${level}</span>
                    <span class="log-source">${loggerName}</span>
                </div>
                <div class="log-message">${message}</div>
            </div>
        `;
    }).join('');
}

async function applyServerLogLevel() {
    const loggerSelect = document.getElementById('server-log-target');
    const levelSelect = document.getElementById('server-log-level');
    const status = document.getElementById('log-level-status');
    if (!loggerSelect || !levelSelect) {
        return;
    }
    const payload = {
        logger_name: loggerSelect.value || 'root',
        level: levelSelect.value || 'INFO',
    };
    logUiEvent('logs_level_change', payload);
    try {
        const response = await fetch('/api/logs/level', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.detail || 'Failed to update log level');
        }
        if (status) {
            status.textContent = `Set ${result.name} to ${result.level}`;
        }
        await loadLogConfig();
    } catch (error) {
        console.error('Error updating log level:', error);
        if (status) {
            status.textContent = `Error: ${error.message}`;
        }
    }
}
